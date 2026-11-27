import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    deliveryLedgerForSnapshot,
    deliveryRecordId,
    deriveDeliveryState,
    listDeliveryLedger,
    readDeliveryRecord,
    reconcileDeliveryRecord,
    recoverDeliverySession,
} from '../com.github.copilot/extensions/speckit-companion/delivery-ledger.mjs';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';

async function loadExtension() {
    if (!globalThis.__copilotJoined?.length) await import('../com.github.copilot/extensions/speckit-companion/extension.mjs');
    return globalThis.__copilotJoined[0];
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SESSION_1 = '11111111-1111-4111-8111-111111111111';
const SESSION_2 = '22222222-2222-4222-8222-222222222222';

function makeGitRepo(t, remote = 'https://github.com/acme/widget.git') {
    const base = mkdtempSync(join(tmpdir(), 'speckit-ledger-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const origin = join(base, 'origin.git');
    const root = join(base, 'repo');
    mkdirSync(origin, { recursive: true });
    mkdirSync(root, { recursive: true });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(origin, 'init', '--bare', '-b', 'main');
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test User');
    mkdirSync(join(root, 'specs', '001-roster'), { recursive: true });
    writeFileSync(join(root, 'specs', '001-roster', 'spec.md'), '# Roster\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'init');
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '-u', 'origin', 'main');
    git(root, 'remote', 'set-head', 'origin', 'main');
    git(root, 'remote', 'set-url', 'origin', remote);
    const rev = git(root, 'rev-parse', 'HEAD');
    return { base, root, rev, git: (...args) => git(root, ...args) };
}

describe('durable delivery ledger', () => {
    it('creates deterministic hash-suffixed IDs and validates canonical URLs without storing local cwd', t => {
        const { root, rev } = makeGitRepo(t);
        const id1 = deliveryRecordId('spec', 'specs/001-roster');
        const id2 = deliveryRecordId('spec', 'specs/001-roster');
        const idBug = deliveryRecordId('bug', 'specs/001-roster');
        assert.equal(id1, id2);
        assert.notEqual(id1, idBug);
        assert.match(id1, /^spec-[a-z0-9-]+-[a-f0-9]{8}$/);

        const saved = reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            path: 'specs/001-roster/spec.md',
            baseBranch: 'main',
            baseRevision: rev,
            branch: 'feat/001-roster',
            issue: { number: 42 },
            pr: { number: 77, draft: true, checks: 'pending' },
            session: { sessionId: SESSION_1, name: 'Roster cloud', url: `ghapp://sessions/${SESSION_1}`, status: 'active' },
        });

        assert.equal(saved.repository, 'acme/widget');
        assert.equal(saved.issue.url, 'https://github.com/acme/widget/issues/42');
        assert.equal(saved.pr.url, 'https://github.com/acme/widget/pull/77');
        assert.equal(saved.state, 'pr-open');
        assert.equal(saved.autonomyMode, 'gated');

        const rawOnDisk = JSON.parse(readFileSync(join(root, '.speckit-companion', 'delivery', `${saved.id}.json`), 'utf8'));
        assert.equal('cwd' in rawOnDisk, false);
        assert.equal('cwd' in (rawOnDisk.session ?? {}), false);
        assert.equal(rawOnDisk.schema, 1);

        assert.throws(() => reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            issue: { number: 42, url: 'https://github.com/other/repo/issues/42' },
        }), /Issue URL must match/);

        assert.throws(() => reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            pr: { number: 77, url: 'https://evil.example/acme/widget/pull/77' },
        }), /Pull request URL must match/);

        assert.throws(() => reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            session: { sessionId: SESSION_1, url: `https://example.invalid/${SESSION_1}` },
        }), /canonical ghapp:\/\/sessions\/<id>/);

        assert.throws(() => reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            repository: 'evil/other',
        }), /does not match/);

        assert.throws(() => reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            branch: 'main',
        }), /separate from the base branch/);
    });

    it('enforces single-active-session invariants, cross-item collisions, and CAS revisions', t => {
        const { root, rev } = makeGitRepo(t);
        const first = reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            baseBranch: 'main',
            baseRevision: rev,
            session: { sessionId: SESSION_1, name: 'Roster 1', url: `ghapp://sessions/${SESSION_1}`, status: 'active' },
        });
        assert.equal(first.state, 'assigned');

        // Same item cannot silently swap active session without recovery
        assert.throws(() => reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            session: { sessionId: SESSION_2, name: 'Roster 2', url: `ghapp://sessions/${SESSION_2}`, status: 'active' },
        }), /already has an active session/);

        // Another item cannot claim the same active session
        assert.throws(() => reconcileDeliveryRecord(root, {
            kind: 'bug',
            id: 'bug-timeout',
            session: { sessionId: SESSION_1, name: 'Reuse active', url: `ghapp://sessions/${SESSION_1}`, status: 'idle' },
        }), /already assigned/);

        // Stale CAS revision is rejected
        assert.throws(() => reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            detail: 'Stale write',
            expectedRevision: '0'.repeat(64),
        }), /This record changed/i);

        // Recovering marks the old session expired and appends to supersededSessions while preserving branch/PR/issue
        reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            branch: 'feat/001-roster',
            issue: { number: 12 },
            pr: { number: 19, state: 'open' },
        });
        const recovered = recoverDeliverySession(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            expiredSessionId: SESSION_1,
            reason: 'Cloud sandbox timed out after 7 days.',
        });
        assert.equal(recovered.state, 'expired');
        assert.equal(recovered.session.status, 'expired');
        assert.equal(recovered.supersededSessions.length, 1);
        assert.equal(recovered.supersededSessions[0].sessionId, SESSION_1);
        assert.equal(recovered.branch, 'feat/001-roster');
        assert.equal(recovered.pr.number, 19);
        assert.equal(recovered.issue.number, 12);

        // Replacement session is now accepted on the recovered record
        const replaced = reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: 'specs/001-roster',
            session: { sessionId: SESSION_2, name: 'Roster resumed', url: `ghapp://sessions/${SESSION_2}`, status: 'active' },
        });
        assert.equal(replaced.session.sessionId, SESSION_2);
        assert.equal(replaced.supersededSessions.length, 1);
        assert.equal(replaced.branch, 'feat/001-roster');
        assert.equal(replaced.state, 'pr-open');
    });

    it('derives delivery states accurately and filters out foreign repository records', t => {
        const { root } = makeGitRepo(t);
        assert.equal(deriveDeliveryState({}), 'queued');
        assert.equal(deriveDeliveryState({ session: { status: 'idle' } }), 'assigned');
        assert.equal(deriveDeliveryState({ session: { status: 'active' }, branch: 'feat/001-roster' }), 'in-progress');
        assert.equal(deriveDeliveryState({ session: { status: 'expired' }, pr: { state: 'open' } }), 'expired');
        assert.equal(deriveDeliveryState({ gate: { status: 'awaiting-decision' }, pr: { state: 'open' } }), 'awaiting-gate');
        assert.equal(deriveDeliveryState({ pr: { state: 'merged' } }), 'merged');
        assert.equal(deriveDeliveryState({ gate: { status: 'blocked' } }), 'blocked');

        // Manually write a foreign record into .speckit-companion/delivery/ and ensure it is ignored
        const dir = join(root, '.speckit-companion', 'delivery');
        mkdirSync(dir, { recursive: true });
        const foreignId = deliveryRecordId('spec', 'specs/009-foreign');
        writeFileSync(join(dir, `${foreignId}.json`), JSON.stringify({
            schema: 1,
            id: foreignId,
            repository: 'someone/else',
            item: { kind: 'spec', id: 'specs/009-foreign' },
            autonomyMode: 'gated',
            state: 'queued',
            updatedAt: new Date().toISOString(),
        }));

        const listed = listDeliveryLedger(root);
        assert.equal(listed.records.length, 0);
        assert.equal(listed.errors.length, 1);
        assert.match(listed.errors[0], /foreign delivery record/i);
        assert.deepEqual(deliveryLedgerForSnapshot(root), []);
    });

    it('hydrates prior assignment from durable ledger across restarts and exposes HTTP + canvas actions', async t => {
        const { base, root, rev } = makeGitRepo(t);
        const workspacePath = join(base, 'session-state');
        mkdirSync(workspacePath, { recursive: true });

        const prevWorkspace = globalThis.__copilotWorkspacePath;
        const prevOnSend = globalThis.__copilotOnSend;
        const prevLog = globalThis.__copilotLog;
        const prompts = [];
        globalThis.__copilotWorkspacePath = workspacePath;
        globalThis.__copilotOnSend = options => prompts.push(options.prompt);
        globalThis.__copilotLog = () => {};
        t.after(() => {
            globalThis.__copilotWorkspacePath = prevWorkspace;
            globalThis.__copilotOnSend = prevOnSend;
            globalThis.__copilotLog = prevLog;
        });

        const config = await loadExtension();
        const canvas = config.canvases.find(c => c.id === 'speckit-spec-board');
        const action = (name, instanceId, input = {}) =>
            canvas.actions.find(a => a.name === name).handler({ instanceId, input, session: { workingDirectory: root } });

        const open = async instanceId => {
            const ctx = { instanceId, input: null, session: { workingDirectory: root } };
            const opened = await canvas.open(ctx);
            t.after(() => canvas.onClose(ctx));
            const token = new URL(opened.url).searchParams.get('token');
            const api = (path, body) => fetch(new URL(path, opened.url), {
                method: body ? 'POST' : 'GET',
                headers: { 'x-speckit-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
            });
            return {
                url: opened.url,
                api,
                snapshot: async () => (await api('/api/snapshot')).json(),
                ledger: async () => (await api('/api/delivery/ledger')).json(),
                post: (path, body) => api(path, body),
            };
        };

        const reqId = () => prompts.at(-1)?.match(/^SpecKit Companion dedicated work request: ([0-9a-f-]+)/)?.[1];

        const board1 = await open('ledger-board-1');
        const preview = await (await board1.api(`/api/dedicated-work?kind=spec&id=${encodeURIComponent('specs/001-roster')}`)).json();
        const startRes = await board1.post('/api/dedicated-work', {
            kind: 'spec',
            id: 'specs/001-roster',
            version: preview.version,
            expectedRoot: root,
        });
        assert.equal(startRes.status, 202);
        const reqId1 = reqId();
        action('claim_dedicated_work', 'ledger-board-1', { requestId: reqId1 });
        action('finish_dedicated_work', 'ledger-board-1', {
            requestId: reqId1,
            baseRevision: rev,
            branch: 'feat/001-roster',
            issue: { number: 5 },
            pr: { number: 9, draft: true, checks: 'pending' },
            session: { sessionId: SESSION_1, name: 'Cloud roster', url: `ghapp://sessions/${SESSION_1}`, activity: 'idle' },
        });

        // Durable ledger file now exists on disk and in /api/delivery/ledger + snapshot
        const ledger1 = await board1.ledger();
        assert.equal(ledger1.records.length, 1);
        assert.equal(ledger1.records[0].branch, 'feat/001-roster');
        assert.equal(ledger1.records[0].pr.number, 9);
        assert.equal(ledger1.records[0].session.sessionId, SESSION_1);
        assert.equal((await board1.snapshot()).deliveryLedger.length, 1);

        // Simulate switching devices / clearing session-local board.json completely
        const boardJson = join(workspacePath, 'speckit-companion', 'board.json');
        if (existsSync(boardJson)) rmSync(boardJson, { force: true });

        // Open a brand new session workspace pointing to the same repo
        const workspacePath2 = join(base, 'session-state-device-2');
        mkdirSync(workspacePath2, { recursive: true });
        globalThis.__copilotWorkspacePath = workspacePath2;
        const board2 = await open('ledger-board-2');
        const preview2 = await (await board2.api(`/api/dedicated-work?kind=spec&id=${encodeURIComponent('specs/001-roster')}`)).json();

        // Start dedicated work again: should hydrate prior active session from durable ledger!
        const startRes2 = await board2.post('/api/dedicated-work', {
            kind: 'spec',
            id: 'specs/001-roster',
            version: preview2.version,
            expectedRoot: root,
        });
        assert.equal(startRes2.status, 202);
        const reqId2 = reqId();
        const claimed2 = action('claim_dedicated_work', 'ledger-board-2', { requestId: reqId2 });
        assert.equal(claimed2.assignedSession.sessionId, SESSION_1);
        assert.equal(claimed2.existingBranch, 'feat/001-roster');
        assert.equal(claimed2.existingPr.number, 9);
        assert.equal(claimed2.existingIssue.number, 5);

        // Finish request 2 as blocked because SESSION_1 expired, then recover via action
        action('finish_dedicated_work', 'ledger-board-2', { requestId: reqId2, blocked: 'Session expired on remote host.' });
        const recovered = action('recover_delivery_session', 'ledger-board-2', {
            kind: 'spec',
            id: 'specs/001-roster',
            expiredSessionId: SESSION_1,
            reason: 'Expired on remote host.',
        });
        assert.equal(recovered.state, 'expired');

        // Starting dedicated work after recovery should carry recoveredFrom + branch/PR and allow SESSION_2
        const startRes3 = await board2.post('/api/dedicated-work', {
            kind: 'spec',
            id: 'specs/001-roster',
            version: preview2.version,
            expectedRoot: root,
        });
        assert.equal(startRes3.status, 202);
        const reqId3 = reqId();
        const claimed3 = action('claim_dedicated_work', 'ledger-board-2', { requestId: reqId3 });
        assert.equal(claimed3.assignedSession, null);
        assert.equal(claimed3.recoveredFrom.sessionId, SESSION_1);
        assert.equal(claimed3.existingBranch, 'feat/001-roster');

        action('finish_dedicated_work', 'ledger-board-2', {
            requestId: reqId3,
            baseRevision: rev,
            session: { sessionId: SESSION_2, name: 'Resumed roster', url: `ghapp://sessions/${SESSION_2}`, activity: 'busy' },
        });
        const finalRecord = readDeliveryRecord(root, 'spec', 'specs/001-roster');
        assert.equal(finalRecord.session.sessionId, SESSION_2);
        assert.equal(finalRecord.supersededSessions.length, 1);
        assert.equal(finalRecord.supersededSessions[0].sessionId, SESSION_1);
        assert.equal(finalRecord.branch, 'feat/001-roster');
        assert.equal(finalRecord.pr.number, 9);

        // Direct reconcile_delivery action updates PR checks & state
        const reconciled = action('reconcile_delivery', 'ledger-board-2', {
            kind: 'spec',
            id: 'specs/001-roster',
            pr: { number: 9, state: 'merged', draft: false, checks: 'passing' },
        });
        assert.equal(reconciled.state, 'merged');
        assert.equal(reconciled.pr.checks, 'passing');
    });

    it('supports /api/delivery/sync-prompt and emits SSE delivery events', async t => {
        const { root, rev } = makeGitRepo(t);
        const sent = [];
        const srv = await createSpecServer({
            root,
            workingDirectory: root,
            instanceId: 'sse-ledger',
            send: async prompt => { sent.push(prompt); return true; },
        });
        t.after(() => srv.close());
        const token = new URL(srv.url).searchParams.get('token');

        const syncRes = await fetch(new URL('/api/delivery/sync-prompt', srv.url), {
            method: 'POST',
            headers: { 'x-speckit-token': token, 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRoot: root, kind: 'spec', id: 'specs/001-roster' }),
        });
        assert.equal(syncRes.status, 200);
        assert.equal(sent.length, 1);
        assert.match(sent[0], /reconcile_delivery/);
        assert.match(sent[0], /acme\/widget/);

        const recRes = await fetch(new URL('/api/delivery/reconcile', srv.url), {
            method: 'POST',
            headers: { 'x-speckit-token': token, 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRoot: root, kind: 'spec', id: 'specs/001-roster', baseRevision: rev, branch: 'feat/001-roster' }),
        });
        assert.equal(recRes.status, 200);
        const rec = await recRes.json();
        assert.equal(rec.branch, 'feat/001-roster');
        const snap = await (await fetch(new URL('/api/snapshot', srv.url), { headers: { 'x-speckit-token': token } })).json();
        assert.equal(snap.deliveryLedger.length, 1);
    });
});
