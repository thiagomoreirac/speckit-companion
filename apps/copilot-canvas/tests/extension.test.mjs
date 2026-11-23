import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANVAS_DESCRIPTION, OPEN_NOTE, SYSTEM_RULE } from '../com.github.copilot/extensions/speckit-companion/prompts.mjs';

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

describe('routing board commands to a selected child session', () => {
    it('uses the exact session-management message target and never falls back to the parent chat', async () => {
        const [canvas] = (await loadExtension()).canvases;
        const workspace = mkdtempSync(join(tmpdir(), 'canvas-child-session-state-'));
        const parent = mkdtempSync(join(tmpdir(), 'canvas-child-parent-'));
        const child = mkdtempSync(join(tmpdir(), 'canvas-child-repo-'));
        mkdirSync(join(child, '.git'));
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
            const run = await post('/api/run', { expectedRoot: child, spec: '101-selected', command: 'plan' });
            assert.equal(run.status, 200, await run.clone().text());
            const result = await run.json();
            assert.equal(result.targetSessionId, 'child-session');
            assert.equal(routed.length, 1);
            assert.equal(routed[0].targetSessionId, 'child-session');
            assert.equal(routed[0].message, result.prompt);
            assert.equal(parentSends, 0);

            const phase = await post('/api/custom-step', { expectedRoot: child, spec: '101-selected', step: 'design' });
            assert.equal(phase.status, 200, await phase.clone().text());
            assert.equal(routed.at(-1).targetSessionId, 'child-session');
            const details = await fetch(new URL('/api/spec?id=101-selected', base), { headers });
            assert.equal((await details.json()).customPhases[0].run.status, 'unobserved');

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
