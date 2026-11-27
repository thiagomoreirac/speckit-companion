import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANVAS_DESCRIPTION, OPEN_NOTE, SYSTEM_RULE } from '../com.github.copilot/extensions/speckit-companion/prompts.mjs';
import { rootSelection } from '../com.github.copilot/extensions/speckit-companion/workspace.mjs';

// extension.mjs joins a Copilot session on import, so it is loaded once against the stub SDK (tests/sdk-stub) and we read what it registered.
async function loadExtension() {
    if (!globalThis.__copilotJoined?.length) await import('../com.github.copilot/extensions/speckit-companion/extension.mjs');
    assert.equal(globalThis.__copilotJoined.length, 1, 'joins exactly one session');
    return globalThis.__copilotJoined[0];
}

describe('what the extension tells the agent about opening the board', () => {
    it('appends the stop rule to the system message and declares the canvas in the same words', async () => {
        const config = await loadExtension();
        assert.deepEqual(config.systemMessage, { mode: 'append', content: SYSTEM_RULE });
        const [canvas] = config.canvases;
        assert.equal(canvas.id, 'speckit-spec-board');
        assert.equal(canvas.description, CANVAS_DESCRIPTION);
        assert.match(canvas.description, /only asks to open it, show it and stop/);
        assert.match(canvas.description, /do not read, test or implement any spec until they ask/);
    });

    it('says the same thing in the rule, the description and the open result', () => {
        assert.match(SYSTEM_RULE, /^If the user only asks to open the SpecKit Companion canvas, open it and stop: do not read, test or implement any spec until they ask\./);
        assert.ok(CANVAS_DESCRIPTION.endsWith('do not read, test or implement any spec until they ask.'));
        assert.match(OPEN_NOTE, /wait for the user's next instruction/);
    });

    it('does not stop the agent from running a /speckit command the board sends', () => {
        assert.match(SYSTEM_RULE, /A message that starts with a \/speckit command is a request to run that command, or the skill of that name, so run it\.$/);
    });

    it('opens with the wait note in its status and accepts a null input', async () => {
        const config = await loadExtension();
        const [canvas] = config.canvases;
        assert.deepEqual(canvas.inputSchema.type, ['object', 'null']);
        const result = await canvas.open({ instanceId: 'test-1', input: null, session: { workingDirectory: process.cwd() } });
        try {
            assert.equal(result.title, 'SpecKit Companion');
            assert.ok(result.status.endsWith(OPEN_NOTE));
            assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
        } finally {
            await canvas.onClose({ instanceId: 'test-1' });
        }
    });
});

describe('how the board learns that a chat turn started and ended', () => {
    it('shows a sent step as running through an idle that is not its own, and stops when its own turn ends', async () => {
        const [canvas] = (await loadExtension()).canvases;
        const root = mkdtempSync(join(tmpdir(), 'canvas-ext-'));
        mkdirSync(join(root, 'specs/001-x'), { recursive: true });
        writeFileSync(join(root, 'specs/001-x/spec.md'), '# X\n');
        const fire = (type, data) => globalThis.__copilotHandlers[type]({ type, data });
        const ctx = { instanceId: 'test-idle', session: { workingDirectory: root } };
        const action = name => canvas.actions.find(a => a.name === name).handler;
        const plan = async () => (await action('list_specs')({ ...ctx, input: {} })).specs[0].steps.plan;
        await canvas.open({ ...ctx, input: null });
        try {
            fire('user.message', { content: 'something the user typed earlier' });
            const { prompt } = await action('run_step')({ ...ctx, input: { spec: '001-x', command: 'plan' } });
            assert.equal(await plan(), 'in-progress');
            fire('session.idle', {});
            assert.equal(await plan(), 'in-progress', 'the earlier turn ending settles nothing');
            fire('user.message', { content: prompt });
            writeFileSync(join(root, 'specs/001-x/plan.md'), '# Plan\n\nStore the flag.\n');
            fire('session.idle', {});
            assert.equal(await plan(), 'completed', 'its own turn ending does, and the written plan.md reads as done');
        } finally {
            await canvas.onClose({ instanceId: 'test-idle' });
        }
    });
});

describe('preparing published dedicated work', () => {
    it('prepares distinct immutable work-item handoffs without starting, sending, or substituting work', async () => {
        const [canvas] = (await loadExtension()).canvases;
        const root = mkdtempSync(join(tmpdir(), 'canvas-work-handoff-'));
        const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
        const spec = 'specs/001-roster';
        const bug = '.speckit-companion/bug-triage/cancel.json';
        const idea = '.speckit-companion/idea-triage/status.json';
        const record = (id, status) => JSON.stringify({ schema: 1, id, captured: true, status, title: 'Review', description: 'Synthetic record' });
        const ctx = { instanceId: 'test-dedicated-work', session: { workingDirectory: root }, input: null };
        let opened = false;
        let sends = 0;
        globalThis.__copilotOnSend = () => { sends++; };
        globalThis.__copilotManagementMessage = () => { sends++; };
        try {
            mkdirSync(join(root, spec), { recursive: true });
            mkdirSync(join(root, '.speckit-companion', 'bug-triage'), { recursive: true });
            mkdirSync(join(root, '.speckit-companion', 'idea-triage'), { recursive: true });
            writeFileSync(join(root, spec, 'spec.md'), '# Roster\n');
            writeFileSync(join(root, bug), record('cancel', 'reviewing'));
            writeFileSync(join(root, idea), record('status', 'new'));
            git('init', '-q', '-b', 'pilot/desktop');
            git('config', 'user.email', 'test@example.invalid');
            git('config', 'user.name', 'Test');
            git('config', 'core.hooksPath', join(root, 'nonexistent-hooks'));
            git('config', 'commit.gpgsign', 'false');
            git('remote', 'add', 'origin', 'https://github.com/example/trailhead.git');
            git('add', '--', '.');
            git('commit', '-qm', 'Fixture');
            const baseRevision = git('rev-parse', 'HEAD');
            const track = 'refs/remotes/origin/pilot/desktop';
            git('update-ref', track, baseRevision);
            await canvas.open(ctx);
            opened = true;
            const prepare = input => canvas.actions.find(a => a.name === 'prepare_dedicated_work').handler({ ...ctx, input });
            assert.deepEqual(prepare({ kind: 'spec', id: spec }), {
                repository: 'example/trailhead', baseBranch: 'pilot/desktop', baseRevision,
                item: { kind: 'spec', id: spec, path: `${spec}/spec.md` },
                recordUrl: `https://github.com/example/trailhead/blob/${baseRevision}/${spec}/spec.md`,
            });
            assert.equal(prepare({ kind: 'bug', id: 'cancel' }).item.path, bug);
            assert.throws(() => prepare({ kind: 'spec', id: '001' }), /exact spec folder/);
            writeFileSync(join(root, idea), record('status', 'ready'));
            assert.throws(() => prepare({ kind: 'idea', id: 'status' }), /publish the Ready status/);
            git('add', '--', idea);
            git('commit', '-qm', 'Mark idea ready');
            assert.throws(() => prepare({ kind: 'bug', id: 'cancel' }), /not at its recorded origin branch tip/);
            git('update-ref', track, git('rev-parse', 'HEAD'));
            assert.equal(prepare({ kind: 'idea', id: 'status' }).item.path, idea);
            assert.equal(sends, 0);
        } finally {
            if (opened) await canvas.onClose(ctx);
            globalThis.__copilotOnSend = null;
            delete globalThis.__copilotManagementMessage;
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('starting dedicated work from the board', () => {
    const item = { kind: 'spec', id: 'specs/001-roster' };
    const remoteId = '98817a45-8ca5-4097-be5a-e8f275f16625';
    const remote = { sessionId: remoteId, name: 'Cloud roster', url: `ghapp://sessions/${remoteId}`, activity: 'idle' };
    async function setup(t, workItem = item) {
        const [canvas] = (await loadExtension()).canvases;
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'dedicated-picker-')));
        const root = join(base, 'repository');
        const workspace = join(base, 'session');
        if (workItem.kind === 'spec') {
            mkdirSync(join(root, workItem.id), { recursive: true });
            writeFileSync(join(root, workItem.id, 'spec.md'), '# Roster\n');
        } else {
            const dir = join(root, '.speckit-companion', 'bug-triage');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${workItem.id}.json`), JSON.stringify({
                schema: 1, id: workItem.id, captured: true, status: 'reviewing', title: 'Roster bug', description: 'Synthetic bug',
            }));
        }
        const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
        git('init', '-q', '-b', 'main');
        git('config', 'core.hooksPath', join(base, 'no-hooks'));
        git('remote', 'add', 'origin', 'https://github.com/example/roster.git');
        git('add', '--', '.');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Baseline');
        const baseRevision = git('rev-parse', 'HEAD');
        git('update-ref', 'refs/remotes/origin/main', baseRevision);
        const selection = rootSelection(workspace);
        const prompts = [];
        const peer = [];
        globalThis.__copilotWorkspacePath = workspace;
        globalThis.__copilotManagementList = async () => ({ sessions: [] });
        globalThis.__copilotOnSend = ({ prompt }) => prompts.push(prompt);
        globalThis.__copilotManagementMessage = message => { peer.push(message); return { accepted: true }; };
        const panels = new Map();
        t.after(async () => {
            for (const ctx of panels.values()) await canvas.onClose(ctx);
            globalThis.__copilotWorkspacePath = undefined;
            delete globalThis.__copilotManagementList;
            delete globalThis.__copilotOnSend;
            delete globalThis.__copilotManagementMessage;
            rmSync(base, { recursive: true, force: true });
        });
        async function open(instanceId, workingDirectory = root) {
            const ctx = { instanceId, input: null, session: { workingDirectory } };
            const { url } = await canvas.open(ctx);
            panels.set(instanceId, ctx);
            const api = (path, body) => fetch(new URL(path, url), {
                method: body ? 'POST' : 'GET',
                headers: { 'x-speckit-token': new URL(url).searchParams.get('token'), 'content-type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined,
            });
            return {
                url, api,
                preview: () => api(`/api/dedicated-work?kind=${workItem.kind}&id=${encodeURIComponent(workItem.id)}`),
                start: version => api('/api/dedicated-work', { ...workItem, expectedRoot: root, version }),
                snapshot: async () => (await api('/api/snapshot')).json(),
                action: (name, input) => canvas.actions.find(action => action.name === name).handler({ ...ctx, input }),
                close: async () => { await canvas.onClose(ctx); panels.delete(instanceId); },
            };
        }
        return { open, root, base, git, baseRevision, selection, prompts, peer,
            requestId: () => prompts.at(-1)?.match(/^SpecKit Companion dedicated work request: ([0-9a-f-]+)/)?.[1] };
    }

    it('claims one exact request across panels; publishes a verified local checkout without changing the selection', async t => {
        const { open, base, root, git, baseRevision, selection, prompts, peer, requestId } = await setup(t);
        const existing = { sessionId: 'current-child', name: 'Current child', cwd: root };
        selection.writeSessions([existing], root, { sessionId: existing.sessionId, name: existing.name });
        const first = await open('dedicated-local', base);
        const second = await open('dedicated-second', base);
        const { version, handoff } = await (await first.preview()).json();
        const secondVersion = (await (await second.preview()).json()).version;
        assert.equal(handoff.baseRevision, baseRevision);
        assert.equal(handoff.item.path, `${item.id}/spec.md`);
        assert.equal(prompts.length, 0);
        assert.equal((await first.start(secondVersion)).status, 400, 'preview belongs to this panel');
        assert.equal((await first.api('/api/dedicated-work', { ...item, expectedRoot: base, version })).status, 400);
        const requests = await Promise.all([first.start(version), second.start(secondVersion)]);
        for (const response of requests) {
            assert.equal(response.status, 202);
            assert.equal((await response.json()).status, 'requested');
        }
        assert.equal(prompts.length, 1);
        assert.equal(peer.length, 0, 'dedicated work goes to the coordinator, not the selected peer');
        const id = requestId();
        const claim = first.action('claim_dedicated_work', { requestId: id });
        assert.equal(claim.assignedSession, null);
        assert.deepEqual(claim.item, handoff.item);
        assert.throws(() => second.action('claim_dedicated_work', { requestId: id }), /already been claimed/);
        assert.deepEqual((await second.snapshot()).coordinatedSessions, [existing]);
        assert.throws(() => first.action('finish_dedicated_work', { requestId: id, session: remote, baseRevision: '0'.repeat(40) }), /starting revision/);
        assert.throws(() => first.action('finish_dedicated_work', { requestId: id, session: { ...remote, cwd: root }, baseRevision }), /separate branch/);
        const cwd = join(base, 'isolated');
        git('worktree', 'add', '-q', '-b', 'dedicated/roster', cwd, baseRevision);
        const child = { ...remote, name: 'Local roster', cwd };
        assert.equal(first.action('finish_dedicated_work', { requestId: id, session: child, baseRevision }).status, 'confirmed');
        const restored = await second.snapshot();
        assert.deepEqual(restored.coordinatedSessions, [existing, child]);
        assert.equal(restored.root, root);
        assert.equal(restored.boundSession.sessionId, existing.sessionId);
        await first.close();
        const reopened = await open('dedicated-local', base);
        assert.deepEqual((await reopened.snapshot()).coordinatedSessions, [existing, child]);
        assert.equal((await reopened.snapshot()).dedicatedWork[0].status, 'confirmed');
        await reopened.action('run_step', { spec: item.id, command: 'plan' });
        assert.equal(peer[0].targetSessionId, existing.sessionId);
        assert.equal(prompts.length, 1, 'ordinary Plan does not start another session');
    });

    it('keeps remote children open-only and refreshes a reuse without adding a duplicate or changing root', async t => {
        const { open, root, baseRevision, requestId } = await setup(t);
        const board = await open('dedicated-remote');
        const { version } = await (await board.preview()).json();
        await board.start(version);
        const confirm = session => board.action('finish_dedicated_work', { requestId: requestId(), session, baseRevision });
        assert.throws(() => confirm(remote), /Claim the exact outstanding request/);
        board.action('claim_dedicated_work', { requestId: requestId() });
        assert.throws(() => confirm({ ...remote, url: 'https://example.invalid/session' }), /canonical app link/);
        assert.throws(() => confirm({ ...remote, url: `${remote.url}?other=true` }), /canonical app link/);
        confirm(remote);
        assert.equal((await board.api('/api/root/coordinated', { sessionId: remoteId })).status, 400);
        await board.start(version);
        const reuse = board.action('claim_dedicated_work', { requestId: requestId() });
        assert.deepEqual(reuse.assignedSession, remote);
        assert.equal(reuse.assignedRevision, baseRevision);
        const wrongId = '005550b6-f36c-4d56-a6cd-81785f117f74';
        assert.throws(() => confirm({ ...remote, sessionId: wrongId, url: `ghapp://sessions/${wrongId}` }), /already assigned/);
        const refreshed = { ...remote, name: 'Verified roster', activity: 'busy' };
        confirm(refreshed);
        const snapshot = await board.snapshot();
        assert.deepEqual(snapshot.coordinatedSessions, [refreshed]);
        assert.equal(snapshot.root, root);
        assert.equal(snapshot.boundSession, null);
    });

    it('does not auto-follow the only runtime child while starting or confirming dedicated bug work', async t => {
        const { open, root, base, git, baseRevision, requestId } = await setup(t, { kind: 'bug', id: 'cancel' });
        const board = await open('dedicated-bug');
        const { version, handoff } = await (await board.preview()).json();
        assert.equal(handoff.item.path, '.speckit-companion/bug-triage/cancel.json');
        assert.equal((await board.start(version)).status, 202);
        const cwd = join(base, 'isolated');
        git('worktree', 'add', '-q', '-b', 'dedicated/bug', cwd, baseRevision);
        globalThis.__copilotManagementList = async () => ({
            sessions: [{ sessionId: remoteId, name: 'Dedicated bug', cwd, state: 'idle', parentSessionId: 'parent-session' }],
        });
        await board.api('/api/refresh', {});
        assert.equal((await board.snapshot()).children.length, 1);
        assert.equal((await board.snapshot()).root, root);
        board.action('claim_dedicated_work', { requestId: requestId() });
        board.action('finish_dedicated_work', { requestId: requestId(), session: { ...remote, name: 'Dedicated bug', cwd }, baseRevision });
        await board.api('/api/refresh', {});
        const confirmed = await board.snapshot();
        assert.equal(confirmed.coordinatedSessions[0].sessionId, remoteId);
        assert.equal(confirmed.root, root);
        assert.equal(confirmed.boundSession, null);
    });

    it('reports unavailable coordination without changing the picker and does not resend uncertain delivery', async t => {
        const { open, root, base, requestId, prompts } = await setup(t);
        const board = await open('dedicated-blocked');
        const { version } = await (await board.preview()).json();
        const emit = globalThis.__copilotOnSend;
        globalThis.__copilotOnSend = options => { emit(options); throw new Error('Acknowledgment lost'); };
        assert.equal((await (await board.start(version)).json()).status, 'delivering-unknown');
        await board.start(version);
        assert.equal(prompts.length, 1);
        const id = requestId();
        board.action('claim_dedicated_work', { requestId: id });
        board.action('finish_dedicated_work', { requestId: id, blocked: 'This host does not expose app coordination.' });
        const snapshot = await board.snapshot();
        assert.deepEqual(snapshot.coordinatedSessions, []);
        assert.equal(snapshot.root, root);
        assert.deepEqual(snapshot.dedicatedWork, [{ ...item, status: 'blocked', detail: 'This host does not expose app coordination.' }]);
        globalThis.__copilotWorkspacePath = undefined;
        const unsupported = await open('dedicated-unsupported');
        assert.match((await (await unsupported.preview()).json()).error, /requires a Copilot session/);
        assert.equal(prompts.length, 1);
        const gitless = await open('dedicated-unowned', base);
        assert.notEqual((await gitless.preview()).status, 200);
    });

    for (const local of [true, false]) {
        it(`in Chromium, ${local ? 'adds a local picker option without a reload, checkout switch, or PR' : 'shows a cloud session as a link, not a picker option'}`, async t => {
            const { chromium } = await import('playwright-core').catch(() => ({}));
            const browser = chromium && (await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null)
                ?? await chromium.launch({ headless: true }).catch(() => null));
            if (!browser) return t.skip('no Chrome to drive');
            t.after(() => browser.close());
            const { open, root, base, git, baseRevision, prompts, requestId } = await setup(t);
            const board = await open('dedicated-browser');
            const session = { ...remote };
            if (local) {
                session.name = 'Local roster';
                session.cwd = join(base, 'isolated');
                git('worktree', 'add', '-q', '-b', 'dedicated/roster', session.cwd, baseRevision);
            }
            const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
            t.after(() => page.close());
            page.setDefaultTimeout(10000);
            const pageErrors = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.goto(board.url, { waitUntil: 'domcontentloaded' });
            let navigations = 0;
            page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
            const picker = page.getByLabel('Coordinated session', { exact: true });
            assert.equal(await picker.locator('option').count(), 1);
            assert.equal(await picker.inputValue(), '');
            const initiate = page.getByRole('button', { name: 'Start dedicated work', exact: true });
            await initiate.click();
            const dialog = page.getByRole('dialog', { name: 'Start dedicated work' });
            await dialog.getByText(`${item.id}/spec.md`, { exact: true }).waitFor();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            assert.equal(prompts.length, 0);
            await initiate.click();
            const result = page.waitForResponse(response => response.url().endsWith('/api/dedicated-work') && response.request().method() === 'POST');
            await dialog.getByRole('button', { name: 'Start dedicated work' }).click();
            assert.equal((await (await result).json()).status, 'requested');
            await page.getByText('Requested. Waiting for the coordinator.').waitFor();
            assert.equal(await initiate.isDisabled(), true);
            assert.equal(await picker.locator('option').count(), 1);
            const id = requestId();
            board.action('claim_dedicated_work', { requestId: id });
            board.action('finish_dedicated_work', { requestId: id, session, baseRevision });
            if (local) {
                await page.getByText('Local roster is listed under Coordinated session.').waitFor();
                assert.equal(await picker.locator(`option[value="${session.sessionId}"]`).textContent(), 'Local roster · idle');
            } else {
                await page.getByText('Cloud roster is listed under Coordinated session as an Open session link.').waitFor();
                assert.equal(await page.getByRole('link', { name: 'Open session: Cloud roster' }).getAttribute('href'), session.url);
            }
            assert.equal(await picker.locator('option').count(), local ? 2 : 1);
            assert.equal(await picker.inputValue(), '');
            await page.locator('.detail-header').getByRole('heading', { name: 'Roster', exact: true }).waitFor();
            const snapshot = await board.snapshot();
            assert.equal(snapshot.root, root);
            assert.equal(snapshot.boundSession, null);
            assert.equal(navigations, 0);
            assert.deepEqual(pageErrors, []);
        });
    }
});

describe('routing ordinary board commands to a selected child session', () => {
    it('adds decisions to the selected spec step and never falls back to the parent chat', async () => {
        const [canvas] = (await loadExtension()).canvases;
        const workspace = mkdtempSync(join(tmpdir(), 'canvas-child-session-state-'));
        const parent = mkdtempSync(join(tmpdir(), 'canvas-child-parent-'));
        const child = mkdtempSync(join(tmpdir(), 'canvas-child-repo-'));
        const git = (...args) => execFileSync('git', ['--no-pager', ...args], { cwd: child, encoding: 'utf8', windowsHide: true }).trim();
        git('init', '-q', '-b', 'main');
        git('remote', 'add', 'origin', 'https://github.com/example/selected.git');
        mkdirSync(join(child, '.specify'));
        writeFileSync(join(child, '.specify', 'decisions.json'), JSON.stringify({
            schema: 1,
            decisions: [{ id: 'ADR-001', status: 'accepted', specs: ['specs/101-selected'], summary: 'Store the selection in the repository.' }],
        }));
        git('add', '.specify/decisions.json');
        git('-c', 'user.name=Canvas Test', '-c', 'user.email=canvas@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Accepted baseline');
        git('update-ref', 'refs/remotes/origin/main', 'HEAD');
        git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
        const revision = git('rev-parse', 'HEAD');
        mkdirSync(join(child, 'specs', '101-selected'), { recursive: true });
        writeFileSync(join(child, 'specs', '101-selected', 'spec.md'), '# Selected\n');
        writeFileSync(join(child, 'specs', '101-selected', '.spec-context.json'), JSON.stringify({
            workflow: 'child-flow', currentStep: 'specify', status: 'specified', history: [],
        }));
        mkdirSync(join(child, '.vscode'));
        writeFileSync(join(child, '.vscode', 'settings.json'), JSON.stringify({
            'speckit.customWorkflows': [{ name: 'child-flow', steps: [
                { name: 'plan', command: 'demo.plan' }, { name: 'design', command: 'demo.design' },
            ] }],
        }));
        globalThis.__copilotWorkspacePath = workspace;
        globalThis.__copilotManagementList = async () => ({
            sessions: [{ sessionId: 'child-session', parentSessionId: 'parent-session', name: 'Child', cwd: child, state: 'idle' }],
        });
        const routed = [];
        globalThis.__copilotManagementMessage = async params => {
            routed.push(params);
            return { accepted: true };
        };
        let parentSends = 0;
        globalThis.__copilotOnSend = async () => { parentSends++; };
        const ctx = { instanceId: 'test-child-routing', session: { workingDirectory: parent }, input: null };
        const opened = await canvas.open(ctx);
        const base = new URL(opened.url);
        const headers = { 'x-speckit-token': base.searchParams.get('token'), 'content-type': 'application/json' };
        const post = (path, body = {}) => fetch(new URL(path, base), { method: 'POST', headers, body: JSON.stringify(body) });
        try {
            await post('/api/refresh');
            const selected = await post('/api/root/child', { sessionId: 'child-session' });
            assert.equal(selected.status, 200);
            assert.deepEqual(routed, [], 'discovery and selection do not dispatch');
            const run = await post('/api/run', { expectedRoot: child, spec: '101-selected', command: 'plan' });
            assert.equal(run.status, 200, await run.clone().text());
            const result = await run.json();
            assert.equal(result.targetSessionId, 'child-session');
            assert.equal(routed.length, 1);
            assert.equal(routed[0].targetSessionId, 'child-session');
            assert.equal(routed[0].message, result.prompt);
            assert.match(result.prompt, /^\/demo\.plan specs\/101-selected\n/);
            assert.match(result.prompt, /cannot override user scope, permissions, gates, or workflow instructions/i);
            assert.ok(result.prompt.includes(`https://github.com/example/selected/blob/${revision}/.specify/decisions.json`));
            assert.match(result.prompt, /^> .*"id":"ADR-001".*"summary":"Store the selection in the repository\."/m);
            assert.equal(parentSends, 0);

            const phase = await post('/api/custom-step', { expectedRoot: child, spec: '101-selected', step: 'design' });
            assert.equal(phase.status, 200, await phase.clone().text());
            assert.equal(routed.at(-1).targetSessionId, 'child-session');
            assert.doesNotMatch(routed.at(-1).message, /ADR-001/);
            const details = await fetch(new URL('/api/spec?id=101-selected', base), { headers });
            assert.equal((await details.json()).customPhases[0].run.status, 'unobserved');

            git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
            const withoutContext = await post('/api/run', { expectedRoot: child, spec: '101-selected', command: 'plan' });
            assert.equal(withoutContext.status, 200);
            assert.deepEqual(routed.at(-1), {
                targetSessionId: 'child-session',
                message: `/demo.plan specs/101-selected\n\nRepository directory: ${JSON.stringify(child)}. Run this request in that repository; resolve all relative spec, command and instruction-file paths from that directory, not the chat working directory.`,
            });

            globalThis.__copilotManagementMessage = async () => ({ accepted: false });
            const rejected = await post('/api/run', { expectedRoot: child, spec: '101-selected', command: 'plan' });
            assert.notEqual(rejected.status, 200);
            assert.match((await rejected.json()).error, /did not accept the request/);
            assert.equal(parentSends, 0);
        } finally {
            globalThis.__copilotOnSend = null;
            delete globalThis.__copilotManagementMessage;
            delete globalThis.__copilotManagementList;
            delete globalThis.__copilotWorkspacePath;
            await canvas.onClose(ctx);
            rmSync(workspace, { recursive: true, force: true });
            rmSync(parent, { recursive: true, force: true });
            rmSync(child, { recursive: true, force: true });
        }
    });
});

describe('a turn that starts before the send returns', () => {
    it('is still the sent step\'s turn: its idle stops the step', async () => {
        const [canvas] = (await loadExtension()).canvases;
        const root = mkdtempSync(join(tmpdir(), 'canvas-ext-order-'));
        mkdirSync(join(root, 'specs/001-x'), { recursive: true });
        writeFileSync(join(root, 'specs/001-x/spec.md'), '# X\n');
        const fire = (type, data) => globalThis.__copilotHandlers[type]({ type, data });
        const ctx = { instanceId: 'test-order', session: { workingDirectory: root } };
        const action = name => canvas.actions.find(a => a.name === name).handler;
        const plan = async () => (await action('list_specs')({ ...ctx, input: {} })).specs[0].steps.plan;
        await canvas.open({ ...ctx, input: null });
        globalThis.__copilotOnSend = ({ prompt }) => fire('user.message', { content: prompt });
        try {
            await action('run_step')({ ...ctx, input: { spec: '001-x', command: 'plan' } });
            assert.equal(await plan(), 'in-progress');
            fire('session.idle', {});
            assert.equal(await plan(), 'not-started', 'the turn ended without a plan, and the step is no longer running');
        } finally {
            globalThis.__copilotOnSend = null;
            await canvas.onClose({ instanceId: 'test-order' });
        }
    });
});

describe('what the extension tells the agent about the board\'s actions', () => {
    const action = async (name) => (await loadExtension()).canvases[0].actions.find(a => a.name === name);

    it('tells the agent to list specs through the board instead of reading spec files', async () => {
        const { description } = await action('list_specs');
        assert.match(description, /^List the specs on the board/);
        assert.match(description, /Use this to answer any question about which specs exist or where they stand, instead of reading files under specs\//);
    });

    describe('terminal handoff', () => {
        it('opens the host terminal and reports host errors or an unavailable API', async () => {
            const [canvas] = (await loadExtension()).canvases;
            const root = mkdtempSync(join(tmpdir(), 'canvas-terminal-'));
            const ctx = { instanceId: 'test-terminal', session: { workingDirectory: root }, input: null };
            const opened = [];
            globalThis.__copilotCanvasRpc = { open: async input => { opened.push(input); } };
            const board = await canvas.open(ctx);
            const base = new URL(board.url);
            const token = base.searchParams.get('token');
            const post = () => fetch(new URL('/api/terminal', base), {
                method: 'POST', headers: { 'x-speckit-token': token, 'content-type': 'application/json' },
                body: JSON.stringify({ expectedRoot: root }),
            });
            try {
                assert.equal((await post()).status, 200);
                assert.deepEqual(opened, [{ canvasId: 'terminal', instanceId: 'companion-workspace-terminal', input: { title: 'Workspace terminal' } }]);
                globalThis.__copilotCanvasRpc.open = async () => { throw new Error('host rejected'); };
                const failed = await post();
                assert.notEqual(failed.status, 200);
                assert.match((await failed.json()).error, /could not open Terminal/);
            } finally {
                await canvas.onClose(ctx);
                delete globalThis.__copilotCanvasRpc;
            }
            const unavailable = await canvas.open({ ...ctx, instanceId: 'test-terminal-unavailable' });
            try {
                const url = new URL(unavailable.url);
                const response = await fetch(new URL('/api/settings', url), { headers: { 'x-speckit-token': url.searchParams.get('token') } });
                assert.equal((await response.json()).terminalAvailable, false);
            } finally {
                await canvas.onClose({ ...ctx, instanceId: 'test-terminal-unavailable' });
            }
        });
    });

    it('tells the agent to focus the board whenever the user names a spec', async () => {
        const { description } = await action('focus_spec');
        assert.match(description, /Call this whenever the user names a spec or asks to see, show or open one/);
        assert.match(description, /instead of reading its files under specs\//);
    });

    it('requires issue creation to go through the board confirmation', async () => {
        const run = await action('run_step');
        assert.ok(!run.inputSchema.properties.command.enum.includes('taskstoissues'));
        await assert.rejects(run.handler({ input: { spec: '001-x', command: 'taskstoissues' } }), /requires confirmation/);
    });
});
