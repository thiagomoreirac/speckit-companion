import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflowHost } from '../com.github.copilot/extensions/speckit-companion/workflow.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('Workflow Builder host', () => {
    let root;
    let host;

    before(() => {
        root = mkdtempSync(join(tmpdir(), 'canvas-workflow-'));
        const extension = join(root, '.specify', 'extensions', 'companion');
        mkdirSync(extension, { recursive: true });
        cpSync(join(repo, 'apps', 'speckit-extension'), extension, { recursive: true });
        host = createWorkflowHost({ send: async () => true });
    });

    after(() => rmSync(root, { recursive: true, force: true }));

    it('loads the real graph, edits a node and previews its build', async () => {
        const [result] = await host.run(root, { type: 'ready' });
        assert.equal(result.type, 'graph');
        assert.equal(result.graph.error, undefined);
        const step = result.graph.steps.find(s => s.phases?.some(p => p.nodes.length));
        assert.ok(step);
        const node = step.phases.find(p => p.nodes.length).nodes[0];
        const [read] = await host.run(root, { type: 'readNode', command: step.name, nodeId: node.id });
        assert.equal(read.type, 'nodeBody');
        const content = `${read.editable}\nA project instruction.\n`;
        await host.run(root, { type: 'saveNode', command: step.name, nodeId: node.id, body: content });
        const target = join(root, '.specify', 'companion', 'nodes', step.name, `${node.id}.md`);
        assert.match(readFileSync(target, 'utf8'), /A project instruction\./);
        await host.run(root, { type: 'saveNode', command: step.name, nodeId: node.id, body: `${content}Another instruction.\n` });
        assert.match(readFileSync(target, 'utf8'), /Another instruction\./);
        const report = (await host.run(root, { type: 'preview' })).find(m => m.type === 'buildReport');
        assert.equal(report.report.ok, true);
        assert.ok(report.report.commands > 0);
        assert.ok(report.report.changed.includes(step.name));
        await host.run(root, { type: 'addHook', command: step.name, anchor: node.id, when: 'after', hookType: 'prompt', value: 'Check the outcome.' });
        const [updated] = await host.run(root, { type: 'ready' });
        const edited = updated.graph.steps.find(s => s.name === step.name).phases.flatMap(p => p.nodes).find(n => n.id === node.id);
        assert.ok(edited.hooks.some(h => h.summary === 'Check the outcome.'));
        const [config] = await host.run(root, { type: 'openConfig' });
        assert.equal(config.readOnly, false);
        await host.run(root, { type: 'saveWorkflowFile', token: config.token, content: `${config.content}\n# Edited in the board\n` });
        assert.match(readFileSync(join(root, '.specify', 'companion.yml'), 'utf8'), /Edited in the board/);
        const restored = await host.run(root, { type: 'restoreNode', command: step.name, nodeId: node.id });
        const status = restored.find(m => m.type === 'status').status;
        assert.ok(status.undo.token);
        assert.match(status.detail, /workflow-backups/);
        await host.run(root, { type: 'undo', token: status.undo.token });
        assert.match(readFileSync(target, 'utf8'), /Another instruction\./);
        const built = (await host.run(root, { type: 'build' })).find(m => m.type === 'buildReport');
        assert.equal(built.report.ok, true);
        assert.ok(built.report.commands > 0);
    });

    describe('stock Workflow Builder', () => {
        it('draws a stock project without Companion installed', async () => {
            const root = mkdtempSync(join(tmpdir(), 'canvas-stock-workflow-'));
            try {
                const directory = join(root, '.specify', 'workflows', 'speckit');
                mkdirSync(directory, { recursive: true });
                writeFileSync(join(directory, 'workflow.yml'), 'workflow:\n  id: speckit\n  name: Stock\nsteps:\n  - id: specify\n    command: speckit.specify\n');
                const registry = join(root, '.specify', 'extensions.yml');
                writeFileSync(registry, 'hooks:\n  before_specify:\n  - extension: git\n    command: speckit.git.feature\n    enabled: true\n');
                const host = createWorkflowHost({ send: async () => true });
                const [result] = await host.run(root, { type: 'ready' });
                assert.equal(result.type, 'stock');
                assert.equal(result.view.workflows[0].name, 'Stock');
                assert.equal(result.view.steps[0].hooks[0].enabled, true);
                const [updated] = await host.run(root, { type: 'setStockHook', step: 'specify', when: 'before', index: 0, enabled: false });
                assert.equal(updated.view.steps[0].hooks[0].enabled, false);
                await assert.rejects(host.run(root, { type: 'setStockHook', step: 'specify', when: 'before', index: 0, enabled: 'true' }), /Invalid stock hook/);
                assert.match(readFileSync(registry, 'utf8'), /enabled: false/);
                const [file] = await host.run(root, { type: 'openStockFile', path: result.view.workflows[0].path });
                await assert.rejects(host.run(root, { type: 'saveWorkflowFile', token: 'wrong', content: 'bad' }), /not open for editing/);
                await host.run(root, { type: 'saveWorkflowFile', token: file.token, content: `${file.content}\n# Edited\n` });
                assert.match(readFileSync(join(directory, 'workflow.yml'), 'utf8'), /# Edited/);
                await assert.rejects(host.run(root, { type: 'openStockFile', path: '..\\outside' }), /not one this board drew/);
                const [reopened] = await host.run(root, { type: 'openStockFile', path: result.view.workflows[0].path });
                writeFileSync(join(directory, 'workflow.yml'), 'external change');
                await assert.rejects(host.run(root, { type: 'saveWorkflowFile', token: reopened.token, content: 'overwrite' }), /changed since it was opened/);
                assert.equal(readFileSync(join(directory, 'workflow.yml'), 'utf8'), 'external change');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });

    it('refuses to overwrite a node changed after opening', async () => {
        const [result] = await host.run(root, { type: 'ready' });
        const step = result.graph.steps.find(s => s.phases?.some(p => p.nodes.some(n => n.replaced)));
        const node = step.phases.flatMap(p => p.nodes).find(n => n.replaced);
        await host.run(root, { type: 'readNode', command: step.name, nodeId: node.id });
        const target = join(root, '.specify', 'companion', 'nodes', step.name, `${node.id}.md`);
        writeFileSync(target, 'Changed elsewhere', 'utf8');
        await assert.rejects(host.run(root, { type: 'saveNode', command: step.name, nodeId: node.id, body: 'New text' }), /changed since it was opened/);
        assert.equal(readFileSync(target, 'utf8'), 'Changed elsewhere');
    });

    it('can replace a whole step with an editable project document', async () => {
        const project = mkdtempSync(join(tmpdir(), 'canvas-replace-step-'));
        try {
            const extension = join(project, '.specify', 'extensions', 'companion');
            mkdirSync(extension, { recursive: true });
            cpSync(join(repo, 'apps', 'speckit-extension'), extension, { recursive: true });
            const host = createWorkflowHost({ send: async () => true });
            const [graph] = await host.run(project, { type: 'ready' });
            const step = graph.graph.steps.find(s => s.name === 'plan');
            const result = await host.run(project, { type: 'replaceStep', command: step.name });
            const updated = result.find(m => m.type === 'graph').graph.steps.find(s => s.name === step.name);
            assert.deepEqual(updated.phases.flatMap(p => p.nodes.map(n => n.id)), ['plan-ours']);
            assert.equal(result.find(m => m.type === 'fileEditor').readOnly, false);
            assert.match(readFileSync(join(project, '.specify', 'companion', 'nodes', 'plan', 'plan-ours.md'), 'utf8'), /kind: author/);
            const preview = (await host.run(project, { type: 'preview' })).find(m => m.type === 'buildReport');
            assert.equal(preview.report.ok, true);
            await host.run(project, { type: 'newWorkflow', from: '', name: 'custom' });
            const [custom] = await host.run(project, { type: 'ready' });
            assert.equal(custom.graph.workflows.active, 'custom');
        } finally {
            rmSync(project, { recursive: true, force: true });
        }
    });
});
