import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    autonomyPromptContext,
    DEFAULT_AUTONOMY_POLICY,
    FAIL_CLOSED_AUTONOMY_POLICY,
    readAutonomyPolicy,
    resolveAutonomyRequest,
} from '../com.github.copilot/extensions/speckit-companion/autonomy-policy.mjs';
import { reconcileDeliveryRecord } from '../com.github.copilot/extensions/speckit-companion/delivery-ledger.mjs';

async function loadExtension() {
    if (!globalThis.__copilotJoined?.length) await import('../com.github.copilot/extensions/speckit-companion/extension.mjs');
    return globalThis.__copilotJoined[0];
}

function makeRepo(t, { policy = null, setOriginHead = true } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'speckit-autonomy-'));
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
    mkdirSync(join(root, 'specs', '002-billing'), { recursive: true });
    writeFileSync(join(root, 'specs', '001-roster', 'spec.md'), '# Roster\n');
    writeFileSync(join(root, 'specs', '002-billing', 'spec.md'), '# Billing\n');
    if (policy !== null) {
        mkdirSync(join(root, '.specify'), { recursive: true });
        writeFileSync(join(root, '.specify', 'autonomy.json'), typeof policy === 'string' ? policy : JSON.stringify(policy, null, 2));
    }
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'init');
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '-u', 'origin', 'main');
    if (setOriginHead) git(root, 'remote', 'set-head', 'origin', 'main');
    git(root, 'remote', 'set-url', 'origin', 'https://github.com/acme/widget.git');
    const rev = git(root, 'rev-parse', 'HEAD');
    return { base, root, rev, git: (...args) => git(root, ...args) };
}

describe('autonomy policy (.specify/autonomy.json on origin/HEAD)', () => {
    it('returns safe default when .specify/autonomy.json is absent on verified origin/HEAD', t => {
        const { root, rev } = makeRepo(t);
        const result = readAutonomyPolicy(root);
        assert.equal(result.source, 'default');
        assert.equal(result.revision, rev);
        assert.equal(result.originUrl, null);
        assert.deepEqual(result.policy, DEFAULT_AUTONOMY_POLICY);
    });

    it('reads valid policy strictly from origin/HEAD and ignores untrusted working tree or branch edits', t => {
        const { root, rev, git } = makeRepo(t, {
            policy: {
                schema: 1,
                defaultMode: 'unattended',
                allowUnattended: true,
                allowAutoPr: true,
                allowAutoMerge: false,
                requiredGates: ['spec', 'pr'],
                allowedWriteScopes: ['trigger'],
                maxConcurrentSessions: 2,
                protectedPaths: ['.github/workflows/**', '.specify/autonomy.json'],
            },
        });
        const initial = readAutonomyPolicy(root);
        assert.equal(initial.source, 'origin-head');
        assert.equal(initial.originUrl, `https://github.com/acme/widget/blob/${rev}/.specify/autonomy.json`);
        assert.equal(initial.policy.defaultMode, 'unattended');
        assert.equal(initial.policy.maxConcurrentSessions, 2);
        assert.deepEqual(initial.policy.requiredGates, ['spec', 'pr']);

        // Tamper working tree & a local feature branch to try enabling auto-merge & 10 sessions
        git('checkout', '-b', 'feat/tamper');
        writeFileSync(join(root, '.specify', 'autonomy.json'), JSON.stringify({
            schema: 1,
            defaultMode: 'unattended',
            allowUnattended: true,
            allowAutoPr: true,
            allowAutoMerge: true,
            maxConcurrentSessions: 10,
        }));
        git('add', '.specify/autonomy.json');
        git('commit', '-m', 'attempt policy widening on feature branch');

        const afterTamper = readAutonomyPolicy(root);
        assert.equal(afterTamper.source, 'origin-head');
        assert.equal(afterTamper.policy.allowAutoMerge, false);
        assert.equal(afterTamper.policy.maxConcurrentSessions, 2);

        const quoted = autonomyPromptContext(afterTamper, 'unattended');
        assert.match(quoted, /quoted data from origin\/HEAD/);
        assert.match(quoted, /"allowAutoMerge":false/);
    });

    it('fails closed on invalid schema, inconsistent defaultMode, or unverified origin/HEAD', t => {
        const invalidRepo = makeRepo(t, { policy: '{"schema": 1, "defaultMode": "unattended", "allowUnattended": false}' });
        const invalid = readAutonomyPolicy(invalidRepo.root);
        assert.equal(invalid.source, 'fail-closed');
        assert.deepEqual(invalid.policy, FAIL_CLOSED_AUTONOMY_POLICY);
        assert.match(invalid.note, /schema 1/);

        const badJsonRepo = makeRepo(t, { policy: '{ not valid json' });
        const badJson = readAutonomyPolicy(badJsonRepo.root);
        assert.equal(badJson.source, 'fail-closed');
        assert.equal(badJson.policy.allowUnattended, false);

        const unverifiedRepo = makeRepo(t, { setOriginHead: false });
        const unverified = readAutonomyPolicy(unverifiedRepo.root);
        assert.equal(unverified.source, 'fail-closed');
        assert.equal(unverified.policy.allowUnattended, false);
        assert.match(unverified.note, /origin default branch could not be verified/);
    });

    it('enforces unattended permission and maxConcurrentSessions across HTTP and canvas actions', async t => {
        const { base, root, rev } = makeRepo(t, {
            policy: {
                schema: 1,
                defaultMode: 'gated',
                allowUnattended: true,
                allowAutoPr: true,
                allowAutoMerge: false,
                requiredGates: ['spec'],
                maxConcurrentSessions: 1,
            },
        });
        const workspacePath = join(base, 'ws');
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
        const ctx = { instanceId: 'autonomy-test', input: null, session: { workingDirectory: root } };
        const opened = await canvas.open(ctx);
        t.after(() => canvas.onClose(ctx));
        const token = new URL(opened.url).searchParams.get('token');
        const api = (path, body) => fetch(new URL(path, opened.url), {
            method: body ? 'POST' : 'GET',
            headers: { 'x-speckit-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const action = (name, input = {}) => canvas.actions.find(a => a.name === name).handler({ ...ctx, input });

        // Read-only action and HTTP route expose policy
        const policyAction = action('get_autonomy_policy');
        assert.equal(policyAction.source, 'origin-head');
        assert.equal(policyAction.policy.maxConcurrentSessions, 1);

        const policyHttp = await (await api('/api/autonomy-policy')).json();
        assert.equal(policyHttp.source, 'origin-head');
        assert.equal(policyHttp.policy.allowUnattended, true);

        // Requesting unattended mode includes unattended instructions + policy in prompt and claim
        const preview = await (await api(`/api/dedicated-work?kind=spec&id=${encodeURIComponent('specs/001-roster')}`)).json();
        assert.equal(preview.autonomyPolicy.source, 'origin-head');
        const startRes = await api('/api/dedicated-work', {
            kind: 'spec',
            id: 'specs/001-roster',
            version: preview.version,
            expectedRoot: root,
            autonomyMode: 'unattended',
        });
        assert.equal(startRes.status, 202);
        const startBody = await startRes.json();
        assert.equal(startBody.autonomyMode, 'unattended');
        assert.match(prompts.at(-1), /Unattended autonomy mode is active/);
        assert.match(prompts.at(-1), /speckit\.companion\.auto/);

        const reqId = prompts.at(-1).match(/^SpecKit Companion dedicated work request: ([0-9a-f-]+)/)[1];
        const claimed = action('claim_dedicated_work', { requestId: reqId });
        assert.equal(claimed.autonomyMode, 'unattended');
        assert.equal(claimed.autonomyPolicy.allowAutoPr, true);
        assert.equal(claimed.autonomyPolicy.allowAutoMerge, false);

        // Confirm session 1 -> now 1/1 active sessions in delivery ledger
        const sid1 = '33333333-3333-4333-8333-333333333333';
        action('finish_dedicated_work', {
            requestId: reqId,
            baseRevision: rev,
            session: { sessionId: sid1, name: 'Roster auto', url: `ghapp://sessions/${sid1}`, activity: 'busy' },
        });

        // Starting a SECOND spec while maxConcurrentSessions === 1 is blocked
        const preview2 = await (await api(`/api/dedicated-work?kind=spec&id=${encodeURIComponent('specs/002-billing')}`)).json();
        const blockedRes = await api('/api/dedicated-work', {
            kind: 'spec',
            id: 'specs/002-billing',
            version: preview2.version,
            expectedRoot: root,
            autonomyMode: 'gated',
        });
        assert.equal(blockedRes.status, 400);
        assert.match((await blockedRes.json()).error, /Concurrent session limit reached \(1\/1\)/);

        // Reusing spec 1 (same active session) is STILL allowed
        const reuseRes = await api('/api/dedicated-work', {
            kind: 'spec',
            id: 'specs/001-roster',
            version: preview.version,
            expectedRoot: root,
            autonomyMode: 'unattended',
        });
        assert.equal(reuseRes.status, 202);

        // Direct policy helper check when unattended is forbidden
        const strict = resolveAutonomyRequest({ source: 'origin-head', policy: { ...DEFAULT_AUTONOMY_POLICY, allowUnattended: false } }, 'gated');
        assert.equal(strict.autonomyMode, 'gated');
        assert.throws(
            () => resolveAutonomyRequest({ source: 'origin-head', policy: { ...DEFAULT_AUTONOMY_POLICY, allowUnattended: false } }, 'unattended'),
            /Unattended autonomy is disabled/,
        );

        // Silence unused import check
        assert.equal(typeof reconcileDeliveryRecord, 'function');
    });
});
