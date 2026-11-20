import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';
import { callSpecKit } from '../com.github.copilot/extensions/speckit-companion/workflow-actions.mjs';
import { createGitHubChanges } from '../com.github.copilot/extensions/speckit-companion/workflow-github.mjs';
import { CHARTER_CONFIG, CHARTER_STATE, CONSTITUTION, HOOK_PATH, NATIVE_HOOK_PATH, POLICY_PATH, readWorkflow } from '../com.github.copilot/extensions/speckit-companion/workflow-inventory.mjs';
import { ROADMAP_CONFIG, ROADMAP_PATH } from '../com.github.copilot/extensions/speckit-companion/workflow-roadmap.mjs';

const REGISTRY = '.specify/extensions/.registry';
function installWireframe(f) {
    const feature = 'specs/001-exports';
    const svg = `${feature}/wireframes/01-export.svg`;
    const report = `${feature}/wireframes/01-export.issues.md`;
    const drawing = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70"><title>Export panel</title><rect width="100" height="70" fill="navy"/></svg>';
    const pass = '# Export panel Review\n\n**Status:** PASS\n**Structural issues:** 0\n**Visual issues:** 0\n**Coverage issues:** 0\n\n## Issues\n';
    f.install('wireframe', { command: { name: 'speckit.wireframe.review' }, manifest: { extension: { version: '0.1.1' } } });
    f.registry.wireframe.version = '0.1.1';
    f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
    f.put(svg, drawing);
    f.put(report, pass);
    return { feature, svg, report, drawing, pass };
}

function installRoadmap(f) {
    f.install('roadmap', { command: { name: 'speckit.roadmap.write' }, manifest: { extension: { version: '0.1.1' } } });
    f.registry.roadmap.version = '0.1.1';
    f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
    const ledger = [
        '<!--', 'SYNC IMPACT REPORT', 'Version change: 1.2.3', '-->', '', '# Demo — Spec Roadmap', '',
        '## Vision & End States', '', 'A useful export.', '', '## Constraints & Decisions', '', 'Keep the interface simple.', '',
        '## Planned Specs', '', '### 001 — Export [status: planned]', '- **Description:** Export a board', '- **Outcome:** An exported file',
        '- **Scope (in):** The current board', '- **Spec dir:** specs/001-exports/', '',
        '### 002 — Import [status: deferred]', '- **Description:** Import a board', '- **Outcome:** A new board', '- **Scope (in):** One file', '',
        '## Open Questions', '', 'None.', '', '## Cross-Cutting Notes', '', 'Retain data on disk.', '',
        '**Version**: 1.2.3 | **Ratified**: 2026-01-03 | **Last Amended**: 2026-02-04', '',
    ].join('\r\n');
    f.put(ROADMAP_PATH, ledger);
    return ledger;
}

function installAgentAssign(f, feature) {
    const path = `${feature}/agent-assignments.yml`;
    const profile = '.claude/agents/hve-review.md';
    const content = '---\nname: hve-review\ndescription: Review task evidence\n---\n# Review';
    const assignment = { agents_scanned: [], assignments: { T001: { agent: 'default' }, T002: { agent: 'default', reason: 'Unchanged' } } };
    f.put(path, assignment);
    f.install('agent-assign', { manifest: { extension: { version: '1.1.0' } } });
    f.registry['agent-assign'].version = '1.1.0';
    f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
    f.put(profile, content);
    f.put('apm.lock.yaml', { dependencies: [{ repo_url: 'microsoft/hve-core', deployed_files: [profile],
        deployed_file_hashes: { [profile]: `sha256:${createHash('sha256').update(content).digest('hex')}` } }] });
    return { path, profile, content, assignment };
}

const hook = (extension, options = {}) => ({ extension, command: `speckit.${extension}.run`, optional: true, enabled: true, ...options });
const guidedDefinition = artifact => ({
    workflow: { id: 'guided', name: 'Guided publish', version: '1.0.0' },
    inputs: { verdict: { type: 'string', required: false } },
    steps: [
        { id: 'review', type: 'gate', message: 'Inspect the release evidence.', verdict_input: 'verdict', ...(artifact ? { show_file: artifact } : {}) },
        { id: 'attach-label', type: 'github', operation: 'add-label', target: 'issue', repository: 'acme/app', number: 12, label: 'shipped' },
    ],
});

function catalogFixture(f, installAllowed) {
    const path = '.specify/workflow-catalogs.yml';
    const id = 'catalog:workflow:delivery';
    const index = 'https://raw.githubusercontent.com/acme/fixtures/main/catalog.json';
    const url = `https://raw.githubusercontent.com/acme/fixtures/${'e'.repeat(40)}/gate.yml`;
    const body = JSON.stringify({ ...guidedDefinition(), workflow: { id: 'release-review', version: '1.0.0', name: 'Release review' },
        steps: [{ id: 'review', type: 'gate', message: 'Inspect the release.', verdict_input: 'verdict' }] });
    const digest = createHash('sha256').update(body).digest('hex');
    const configure = allowed => f.put(path, { catalogs: [{ name: 'delivery', url: index, priority: 20, install_allowed: allowed }] });
    configure(installAllowed);
    return { id, index, url, body, digest, configure, path };
}

function catalogZip(entry, text, extras = false) {
    return execFileSync(process.platform === 'win32' ? 'python' : 'python3',
        ['-I', '-S', '-c', 'import io,sys,zipfile\nout=io.BytesIO()\nwith zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:\n z.writestr(sys.argv[1],sys.stdin.buffer.read())\n if sys.argv[2]=="true": z.writestr("extra.txt","Not installed")\nsys.stdout.buffer.write(out.getvalue())', entry, String(extras)],
        { input: text });
}

function fixture(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'canvas-workflow-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const put = (path, value) => {
        const absolute = join(root, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, typeof value === 'string' ? value : JSON.stringify(value));
    };
    const registry = {};
    put('.specify/init-options.json', { speckit_version: '1.4.1.dev0', integration: 'copilot' });
    put(HOOK_PATH, { installed: [], hooks: {} });
    const packageFiles = (path, id, options = {}) => {
        const { extension, ...manifest } = options.manifest ?? {};
        put(`${path}/extension.yml`, {
            schema_version: '1.0', extension: { id, version: '1.0.0', name: id, description: 'Canvas test fixture', ...extension },
            requires: { speckit_version: '>=1.0.0' },
            provides: { commands: [{ name: `speckit.${id}.run`, file: 'commands/run.md', ...options.command }] },
            ...manifest,
        });
        put(`${path}/commands/run.md`, '# Fixture instructions');
    };
    const install = (id, { enabled = true, ...options } = {}) => {
        registry[id] = { enabled, version: '1.0.0', source: 'local' };
        put(REGISTRY, { schema_version: '1.0', extensions: registry });
        packageFiles(`.specify/extensions/${id}`, id, options);
    };
    const hooks = items => put(HOOK_PATH, { installed: Object.keys(registry), hooks: items });
    return { root, put, install, hooks, registry, packageFiles, graph: () => readWorkflow(root).graph };
}

async function serve(t, root, options = {}) {
    const server = await createSpecServer({ root, ...options });
    t.after(() => server.close());
    const api = async (path, body, expected = 200) => {
        const response = await fetch(new URL(`/api${path}`, server.url), {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'x-speckit-token': server.token, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json();
        assert.equal(response.status, expected, JSON.stringify(data).slice(0, 1000));
        return data;
    };
    return { api, url: server.url, focus: server.focus };
}

function routingFixture(t) {
    const f = fixture(t);
    const id = 'workflow:routed-review';
    const path = '.specify/workflows/routed-review/workflow.yml';
    const evidence = 'specs/001-exports/spec.md';
    const gate = (id, verdict_input) => ({ id, type: 'gate', message: `Review ${id}.`, verdict_input, show_file: evidence });
    const definition = {
        workflow: { id: 'routed-review', name: 'Routed review', version: '1.0.0' },
        inputs: {
            track: { type: 'string', required: true, description: 'Select the review track.', enum: ['standard', 'extended'] },
            detail: { type: 'string', enum: ['brief', 'full'], default: 'brief' },
            standard_verdict: { type: 'string' },
            extended_verdict: { type: 'string' },
            final_verdict: { type: 'string' },
        },
        steps: [
            { id: 'route', type: 'if', condition: "{{ inputs.track == 'extended' }}",
                then: [gate('extended', 'extended_verdict')], else: [gate('standard', 'standard_verdict')] },
            { id: 'check-detail', type: 'if', condition: "{{ inputs.detail == 'full' }}", then: [gate('final', 'final_verdict')] },
        ],
    };
    f.put('.specify/workflows/workflow-registry.json', { workflows: { 'routed-review': { enabled: true } } });
    f.put(path, definition);
    f.put(evidence, '# Feature Specification: Export board\n\nReview the export handoff.');
    return { f, id, path, definition, evidence };
}

describe('graph from a Spec Kit repository', () => {
    it('recognizes fan-out occurrences from a released native checkpoint', {
        skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 60_000,
    }, async t => {
        const f = fixture(t);
        const id = 'native-fan-out';
        f.put('.specify/workflows/workflow-registry.json', { workflows: { [id]: { enabled: true } } });
        f.put(`.specify/workflows/${id}/workflow.yml`, {
            schema_version: '1.0',
            workflow: { id, version: '1.0.0', name: 'Native fan-out' },
            steps: [{ id: 'check', type: 'fan-out', max_concurrency: 1, items: ['private-item-a', 'private-item-b'],
                step: { id: 'item', type: 'if', condition: false, then: [{ id: 'unused', type: 'gate', message: 'Not executed.' }] } },
            { id: 'gather', type: 'fan-in', wait_for: ['check'] }],
        });
        await callSpecKit(f.root, ['workflow', 'run', id]);
        const { api } = await serve(t, f.root);
        const graph = await api('/workflow');
        const records = graph.nodes.find(node => node.id === `workflow:${id}`).nativeRuns;
        assert.equal(records.length, 1);
        const [run] = records;
        assert.equal(run.status, 'completed');
        assert.deepEqual(run.steps.find(step => step.id === 'check').fanOut, { count: 2, concurrency: 1 });
        assert.deepEqual(run.steps.filter(step => step.fanOutItem).sort((a, b) => a.fanOutItem.index - b.fanOutItem.index)
            .map(({ id, status, fanOutItem }) => [id, status, fanOutItem]), [
            ['check:item:0', 'completed', { parent: 'check', index: 0 }],
            ['check:item:1', 'completed', { parent: 'check', index: 1 }],
        ]);
        assert.doesNotMatch(JSON.stringify(graph), /private-item/);
    });

    it('projects native checkpoints without exposing run inputs or outputs and inventories only linked feature evidence', async t => {
        const f = fixture(t);
        const feature = 'specs/001-exports';
        const proof = `${feature}/preview/wireflow.html`;
        f.put(`${feature}/spec.md`, '# Export\n\n[Decision](../../docs/adr/001-export.md)\n\n<!-- speckit-figma:section phase=spec -->\n## Figma Design Context\nA design decision.');
        f.put(`${feature}/plan.md`, '# Plan\n\n```\n<!-- speckit-figma:section phase=plan -->\n```');
        f.put(`${feature}/tasks.md`, '# Tasks\n\n- [ ] T001 Build export\n');
        const modelPath = `${feature}/data-model-diagram.mmd`;
        f.put(modelPath, ['erDiagram', '    Export {', '        UUID_string id PK',
            '        Job_nullable job FK "becomes the review input"', '    }', '    Export ||--o{ Record : contains',
            '    Record }|..o| Job : "tracks progress"'].join('\r\n'));
        const sequencePath = `${feature}/diagrams/sequence.mmd`;
        f.put(sequencePath, 'sequenceDiagram\n    actor A as Requester\n    A->>B: Read\n    B-->>A: Ready');
        f.put(proof, '<script>throw new Error("never run")</script>');
        f.put('docs/adr/001-export.md', '# Accepted decision');
        f.put('docs/adr/002-other.md', '# Unrelated decision');
        f.put(`${feature}/quality/report.md`, '# Quality evidence');
        f.install('reporter', { manifest: { 'x-companion': { specViews: [
            { phase: 'Quality review', path: 'quality/report.md', documents: ['spec', 'tasks', 'not-a-document'] },
            { phase: 'Not allowed', path: '../../docs/adr/002-other.md', documents: ['spec'] },
        ] } } });
        f.hooks({ after_tasks: [hook('reporter', { enabled: false })] });
        const agent = '.github/agents/technical-reviewer.agent.md', text = '---\nname: technical-reviewer\n---\n# Review';
        f.put(agent, text);
        f.put('apm.lock.yaml', { dependencies: [{ repo_url: 'microsoft/hve-core', deployed_files: [agent],
            deployed_file_hashes: { [agent]: `sha256:${createHash('sha256').update(text).digest('hex')}` } }] });
        f.put(`${feature}/agent-assignments.yml`, { assignments: { T001: { agent: 'technical-reviewer' }, T009: { agent: 'default' } } });
        f.put('.specify/workflows/workflow-registry.json', { workflows: { review: { enabled: true } } });
        f.put('.specify/workflows/review/workflow.yml', { workflow: { id: 'review', name: 'Release review', version: '1.0.0' },
            steps: [{ id: 'review', type: 'gate', message: 'Inspect the release.' }] });
        for (const [id, status, date] of [['old-run', 'completed', '2026-01-01'], ['waiting', 'paused', '2026-01-02']]) {
            f.put(`.specify/workflows/runs/${id}/state.json`, { run_id: id, workflow_id: 'review', status, updated_at: `${date}T00:00:00Z`,
                current_step_id: 'review', inputs: { token: 'private-test-input' },
                step_results: { review: { status, output: { on_reject: 'abort', choice: status === 'completed' ? 'Approve' : null,
                    show_file: status === 'completed' ? `${feature}/spec.md` : 'docs/adr/private-test-unlinked.md', token: 'private-test-output' } },
                    unrelated: { type: 'command', status: 'completed', output: { show_file: `${feature}/spec.md` } },
                    prototype: { type: 'gate', status: 'completed', output: { show_file: proof } },
                    private: { type: 'gate', status: 'completed', output: { show_file: `${feature}/drafts/private-test-unlinked.html` } } } });
        }
        f.put(`${feature}/drafts/private-test-unlinked.html`, '<p>Not in the evidence inventory</p>');
        const { api } = await serve(t, f.root);
        const graph = await api('/workflow');
        const workflow = graph.nodes.find(node => node.id === 'workflow:review');
        assert.deepEqual(workflow.nativeRuns.map(run => [run.id, run.status]), [['waiting', 'paused'], ['old-run', 'completed']]);
        assert.deepEqual(workflow.nativeRuns[0].steps, [{ id: 'review', status: 'paused', gate: true },
            { id: 'unrelated', status: 'completed', gate: false },
            { id: 'prototype', status: 'completed', gate: true, evidence: { feature: `feature:${feature}`, path: proof, featureArtifact: true } },
            { id: 'private', status: 'completed', gate: true }]);
        assert.equal(workflow.nativeRuns[0].gateWaiting, true);
        assert.equal(workflow.nativeRuns[1].steps[0].verdict, 'approve');
        assert.deepEqual(workflow.nativeRuns[1].steps[0].evidence, { feature: `feature:${feature}`, path: `${feature}/spec.md` });
        assert.doesNotMatch(JSON.stringify(graph), /private-test-(?:input|output|unlinked)/);
        const spec = await api(`/spec?id=${feature}`);
        assert.deepEqual(spec.figmaSections, ['spec']);
        assert.deepEqual(spec.documentHooks.tasks, [{ when: 'after', extension: 'reporter', command: 'speckit.reporter.run', enabled: false, optional: true }]);
        assert.deepEqual(new Set(spec.evidence.map(item => item.phase)), new Set(['Architecture', 'Data model', 'Prototypes', 'Decisions', 'Quality review']));
        assert.deepEqual(spec.evidence.find(item => item.phase === 'Quality review').documents, ['spec', 'tasks']);
        assert.deepEqual(spec.evidence.find(item => item.phase === 'Decisions').documents, ['spec']);
        assert.deepEqual(spec.assignments.assignments.map(row => [row.task, row.taskExists, row.import?.verified]), [['T001', true, true], ['T009', false, undefined]]);
        assert.match((await api(`/spec/evidence?id=${feature}&path=${proof}`)).text, /<script>/);
        const { model } = await api(`/spec/evidence?id=${feature}&path=${modelPath}`);
        assert.deepEqual(model.entities[0].attributes[1], { type: 'Job_nullable', name: 'job', keys: 'FK', note: 'becomes the review input' });
        assert.deepEqual(model.relationships, [
            { from: 'Export', to: 'Record', left: '1', right: '0..*', identifying: true, label: 'contains' },
            { from: 'Record', to: 'Job', left: '1..*', right: '0..1', identifying: false, label: 'tracks progress' },
        ]);
        assert.deepEqual((await api(`/spec/evidence?id=${feature}&path=${sequencePath}`)).sequence, {
            participants: [{ id: 'A', role: 'actor', label: 'Requester' }, { id: 'B', label: 'B' }],
            messages: [{ from: 'A', to: 'B', dashed: false, label: 'Read' }, { from: 'B', to: 'A', dashed: true, label: 'Ready' }],
        });
        for (const unsupported of [
            'sequenceDiagram\nA->>B: First\nalt stop\nB-->>A: No\nend',
            '%%{init: { "theme": "dark" }}%%\nsequenceDiagram\nA->>B: First',
        ]) {
            f.put(sequencePath, unsupported);
            const evidence = await api(`/spec/evidence?id=${feature}&path=${sequencePath}`);
            assert.equal(evidence.sequence, undefined);
            assert.equal(evidence.text, unsupported);
        }
        f.put(modelPath, 'erDiagram\nExport {\n    UUID_string id PK'); // Do not display a partial model.
        assert.equal((await api(`/spec/evidence?id=${feature}&path=${modelPath}`)).model, undefined);
        f.put(agent, `${text} edited`);
        assert.equal((await api(`/spec?id=${feature}`)).assignments.assignments[0].import.verified, false);
        for (const path of ['docs/adr/002-other.md', 'apm.lock.yaml', `${feature}/../../docs/adr/002-other.md`]) {
            await api(`/spec/evidence?id=${feature}&path=${encodeURIComponent(path)}`, undefined, 404);
        }
    });

    it('updates one reviewed task assignment and rejects a changed APM deployment at confirmation', async t => {
        const f = fixture(t);
        const feature = 'specs/001-exports';
        f.put(`${feature}/spec.md`, '# Export');
        f.put(`${feature}/tasks.md`, '# Tasks\n\n- [ ] T001 Build export\n- [ ] T002 Record evidence\n');
        const { path, profile, content, assignment } = installAgentAssign(f, feature);
        const { api } = await serve(t, f.root);
        const request = { operation: 'agent-assignment-edit', id: `feature:${feature}`, feature, task: 'T001',
            agent: 'hve-review', reason: 'Review the export evidence.' };
        const before = await api(`/spec?id=${feature}`);
        assert.deepEqual(before.assignments.editableAgents, [{ name: 'hve-review', path: profile }]);
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.paths, [path]);
        assert.match(preview.documentChange.after, /agent: hve-review/);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), JSON.stringify(assignment));
        f.put(profile, `${content} changed`);
        await api('/workflow/apply', { id: preview.id }, 400);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), JSON.stringify(assignment));
        f.put(profile, content);
        const reviewed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: reviewed.id });
        const after = await api(`/spec?id=${feature}`);
        assert.equal(after.assignments.assignments[0].agent, 'hve-review');
        assert.equal(after.assignments.assignments[0].import.harness, 'Claude Code');
        assert.equal(after.assignments.assignments[1].reason, 'Unchanged');
        assert.equal(readFileSync(join(f.root, profile), 'utf8'), content);
    });

    it('creates a first task assignment only after reviewing it and does not replace a concurrent assignment', async t => {
        const f = fixture(t);
        const feature = 'specs/001-exports';
        f.put(`${feature}/spec.md`, '# Export');
        f.put(`${feature}/tasks.md`, '# Tasks\n\n- [ ] T001 Build export\n');
        const { path, assignment } = installAgentAssign(f, feature);
        rmSync(join(f.root, path));
        const { api } = await serve(t, f.root);
        const request = { operation: 'agent-assignment-add', id: `feature:${feature}`, feature, task: 'T001',
            agent: 'hve-review', reason: 'Review the export evidence.' };
        const before = await api(`/spec?id=${feature}`);
        assert.equal(before.assignments.exists, false);
        assert.deepEqual(before.assignments.unassignedTasks, ['T001']);
        assert.deepEqual(before.assignments.imports.map(({ harness, verified, assignable }) => [harness, verified, assignable]),
            [['Claude Code', true, true]]);
        const run = await api('/workflow/preview', { operation: 'run', id: 'extension:agent-assign', command: 'speckit.agent-assign.run' }, 400);
        assert.match(run.error, /Agent Assign commands run in Claude Code/);
        const preview = await api('/workflow/preview', request);
        assert.equal(preview.documentChange.before, null);
        assert.equal(existsSync(join(f.root, path)), false);
        f.put(path, assignment);
        await api('/workflow/apply', { id: preview.id }, 409);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), JSON.stringify(assignment));
        rmSync(join(f.root, path));
        const reviewed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: reviewed.id });
        const after = await api(`/spec?id=${feature}`);
        assert.equal(after.assignments.exists, true);
        assert.deepEqual(after.assignments.unassignedTasks, []);
        assert.equal(after.assignments.assignments[0].agent, 'hve-review');
    });

    it('shows Copilot-only imports before assignments without offering Claude Code dispatch', async t => {
        const f = fixture(t);
        const feature = 'specs/001-exports';
        const file = '.github/agents/reviewer.agent.md';
        const content = '---\nname: reviewer\n---\n# Review';
        f.put(`${feature}/spec.md`, '# Export');
        f.put(`${feature}/tasks.md`, '# Tasks\n\n- [ ] T001 Build export\n');
        f.put(file, content);
        f.put('apm.lock.yaml', { dependencies: [{ repo_url: 'microsoft/hve-core', deployed_files: [file],
            deployed_file_hashes: { [file]: `sha256:${createHash('sha256').update(content).digest('hex')}` } }] });
        const { api } = await serve(t, f.root);
        const { assignments } = await api(`/spec?id=${feature}`);
        assert.equal(assignments.exists, false);
        assert.deepEqual(assignments.imports, [{ name: 'reviewer', path: file, harness: 'Copilot', available: true, verified: true, assignable: false }]);
        assert.deepEqual(assignments.unassignedTasks, []);
        rmSync(join(f.root, file));
        const missing = (await api(`/spec?id=${feature}`)).assignments.imports[0];
        assert.equal(missing.available, false);
        assert.equal(missing.verified, false);
    });

    it('does not stage an HVE import over an unsupported APM setup', async t => {
        const f = fixture(t);
        const feature = 'specs/001-exports';
        f.put(`${feature}/spec.md`, '# Export');
        f.put('apm.yaml', 'name: existing-project\n');
        const { api } = await serve(t, f.root);
        assert.equal((await api(`/spec?id=${feature}`)).canImportHve, false);
        const result = await api('/workflow/preview', { operation: 'agent-apm-import', id: `feature:${feature}`, feature }, 409);
        assert.match(result.error, /existing APM setup.*apm\.yaml/);
        assert.equal(readFileSync(join(f.root, 'apm.yaml'), 'utf8'), 'name: existing-project\n');
        assert.equal(existsSync(join(f.root, 'apm.lock.yaml')), false);
        rmSync(join(f.root, 'apm.yaml'));
        const initialized = 'name: existing-project\nversion: 1.0.0\ntargets:\n- copilot\ndependencies:\n  apm: []\n  mcp: []\n';
        for (const text of [
            initialized.replace('apm: []', 'apm: [acme/tool]'),
            initialized.replace('mcp: []', 'mcp: [custom-service]'),
            `${initialized}scripts:\n  prepare: echo hi\n`,
            initialized.replace('- copilot', '- copilot\n- claude'),
        ]) {
            f.put('apm.yml', text);
            assert.equal((await api(`/spec?id=${feature}`)).canImportHve, false);
            const preview = await api('/workflow/preview', { operation: 'agent-apm-import', id: `feature:${feature}`, feature }, 409);
            assert.match(preview.error, /Use APM directly/);
            assert.equal(readFileSync(join(f.root, 'apm.yml'), 'utf8'), text);
        }
        f.put('apm.yml', initialized);
        assert.equal((await api(`/spec?id=${feature}`)).canImportHve, true);
        f.put('apm.lock.yaml', '# Existing lock');
        assert.equal((await api(`/spec?id=${feature}`)).canImportHve, false);
    });

    it('imports only the reviewed pinned HVE files and refuses a concurrent profile', {
        skip: process.env.SPECKIT_CANVAS_TEST_APM !== '1', timeout: 90_000,
    }, async t => {
        const f = fixture(t);
        const feature = 'specs/001-exports';
        const profile = '.github/agents/functional-code-review.agent.md';
        const paths = ['apm.yml', 'apm.lock.yaml', profile];
        f.put(`${feature}/spec.md`, '# Export');
        f.put(`${feature}/tasks.md`, '# Tasks\n\n- [ ] T001 Build export\n');
        const { api } = await serve(t, f.root);
        const request = { operation: 'agent-apm-import', id: `feature:${feature}`, feature };
        const before = await api(`/spec?id=${feature}`);
        assert.equal(before.assignments, null);
        assert.equal(before.canImportHve, true);
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.paths, paths);
        assert.deepEqual(preview.documentChanges.map(doc => [doc.path, doc.before]), paths.map(path => [path, null]));
        assert.match(preview.documentChanges[1].after, /resolved_commit: e69486a5f809ede45c63c0a31358c12912bd5168/);
        assert.ok(paths.every(path => !existsSync(join(f.root, path))));
        f.put(profile, 'A concurrent profile');
        await api('/workflow/apply', { id: preview.id }, 409);
        assert.equal(readFileSync(join(f.root, profile), 'utf8'), 'A concurrent profile');
        assert.equal(existsSync(join(f.root, 'apm.lock.yaml')), false);
        rmSync(join(f.root, profile));
        const confirmed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: confirmed.id });
        for (const { path, after } of confirmed.documentChanges) assert.equal(readFileSync(join(f.root, path), 'utf8'), after);
        for (const path of ['apm_modules', '.apm-local', '.gitignore', '.github/hooks', '.github/mcp.json', `${feature}/agent-assignments.yml`]) {
            assert.equal(existsSync(join(f.root, path)), false, path);
        }
        const detail = await api(`/spec?id=${feature}`);
        assert.equal(detail.canImportHve, false);
        assert.deepEqual(detail.assignments.imports.map(({ harness, verified, assignable }) => [harness, verified, assignable]),
            [['Copilot', true, false]]);
    });

    it('adds the pinned reviewer to an initialized APM manifest without rewriting its metadata', {
        skip: process.env.SPECKIT_CANVAS_TEST_APM !== '1', timeout: 90_000,
    }, async t => {
        const f = fixture(t);
        const feature = 'specs/001-exports';
        f.put(`${feature}/spec.md`, '# Export');
        const manifest = ['name: existing-project', 'version: 1.2.3', 'description: Local notes', 'author: Developer',
            '# Project targets', 'targets:', '- copilot', 'dependencies:', '  apm: [] # Pending first dependency',
            '  mcp: []', 'includes: auto', 'scripts: {}', ''].join('\r\n');
        f.put('apm.yml', manifest);
        const { api } = await serve(t, f.root);
        const request = { operation: 'agent-apm-import', id: `feature:${feature}`, feature };
        assert.equal((await api(`/spec?id=${feature}`)).canImportHve, true);
        const proposal = await api('/workflow/preview', request);
        const [manifestChange, lockChange, profileChange] = proposal.documentChanges;
        const dependency = 'microsoft/hve-core/.github/agents/code-review/functional-code-review.agent.md';
        assert.equal(manifestChange.before, manifest);
        assert.equal(manifestChange.after,
            manifest.replace('apm: [] # Pending first dependency', `apm: # Pending first dependency\r\n    - ${dependency}#e69486a5f809ede45c63c0a31358c12912bd5168`));
        assert.equal(readFileSync(join(f.root, 'apm.yml'), 'utf8'), manifest);
        assert.equal(existsSync(join(f.root, lockChange.path)), false);
        const concurrent = manifest.replace('Local notes', 'Changed notes');
        f.put('apm.yml', concurrent);
        const stale = await api('/workflow/apply', { id: proposal.id }, 409);
        assert.match(stale.error, /APM manifest changed/);
        assert.equal(readFileSync(join(f.root, 'apm.yml'), 'utf8'), concurrent);
        assert.equal(existsSync(join(f.root, profileChange.path)), false);
        const reviewed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: reviewed.id });
        for (const { path, after } of reviewed.documentChanges) assert.equal(readFileSync(join(f.root, path), 'utf8'), after);
        assert.equal((await api(`/spec?id=${feature}`)).assignments.imports[0].verified, true);
        assert.equal(existsSync(join(f.root, 'apm_modules')), false);
    });

    it('shows every requested participant with distinct roles, provenance and artifact lanes', t => {
        const { graph, install } = fixture(t);
        for (const id of ['intake', 'preview', 'wireframe', 'figma', 'figma-starter', 'illustrate', 'data-model-diagram']) install(id);
        const result = graph();
        const byId = new Map(result.nodes.map(node => [node.id, node]));
        for (const id of ['companion', 'pdac', 'pdac-product', 'charter', 'roadmap', 'spec-status', 'okr', 'prespec', 'adrkit', 'epic',
            'ghp', 'project', 'figma-starter', 'figma', 'intake', 'preview', 'wireframe', 'illustrate', 'data-model-diagram', 'agent-assign', 'docguard']) {
            const node = byId.get(`extension:${id}`);
            assert.ok(node.source && node.phase && node.authority && node.inputs.length && node.outputs.length, id);
            assert.ok(result.edges.some(edge => edge.target === node.id && edge.source === node.stage));
            assert.equal(node.state, node.installed ? 'enabled' : 'proposed');
        }
        assert.deepEqual(result.findings.filter(item => item.code === 'artifact-writers'), []);
        assert.notEqual(byId.get('extension:figma-starter').outputs[0], byId.get('extension:figma').outputs[0]);
    });

    it('keeps authorities singular and marks duplicate commands, artifact writers, missing references and cycles', t => {
        const f = fixture(t);
        for (const id of ['pdac', 'pdac-product', 'roadmap', 'spec-status', 'adrkit', 'charter', 'ghp', 'project']) f.install(id);
        f.install('another-product', { command: { aliases: ['speckit-pdac-product-run'] }, manifest: { 'x-companion': {
            authority: 'Canonical product definition', effect: 'local-write', writes: 'Accepted product definition', requires: ['missing-provider'],
        } } });
        for (const [id, authority] of [['shadow-roadmap', 'Durable roadmap'], ['another-adr', 'Accepted ADRs'], ['another-constitution', 'Constitution composition']]) {
            f.install(id, { manifest: { 'x-companion': { authority, effect: 'local-write' } } });
        }
        f.install('product-reporter', { manifest: { 'x-companion': { effect: 'local-write', requires: 'another-product' } } });
        f.put('.specify/workflows/workflow-registry.json', { workflows: { release: { name: 'Release' } } });
        f.put('.specify/workflows/release/workflow.yml', { workflow: { id: 'release' }, steps: [
            { id: 'check', depends_on: 'ship', command: 'speckit.not-installed' },
            { id: 'ship', depends_on: 'check', type: 'github' },
        ] });
        f.hooks({ after_tasks: [hook('ghp'), hook('project')] });
        const graph = f.graph();
        const has = (code, id) => graph.findings.some(item => item.code === code && (!id || item.nodeIds.includes(id)));
        for (const id of ['pdac-product', 'roadmap', 'adrkit', 'charter', 'ghp', 'project']) assert.ok(has('authority-conflict', `extension:${id}`), id);
        for (const code of ['artifact-writers', 'missing-dependency', 'duplicate-command', 'cycle', 'broken-reference', 'unapproved-external-step', 'unguarded-hook']) assert.ok(has(code), code);
        assert.ok(has('blocked-prerequisite', 'extension:product-reporter'));
        const projectHook = graph.edges.find(edge => edge.owner === 'extension:project' && edge.kind === 'hook');
        assert.equal(projectHook.source, 'stage:tasks');
        assert.equal(projectHook.target, 'extension:project');
        assert.equal(projectHook.effect, 'external-write');
        assert.equal(projectHook.approval, 'confirm');
        assert.equal(projectHook.status, 'blocked');
    });

    it('distinguishes disjoint design folders but flags overlapping artifact globs', t => {
        const f = fixture(t);
        f.install('preview', { manifest: { 'x-companion': { writes: 'specs/*/previews/*.svg' } } });
        f.install('wireframe', { manifest: { 'x-companion': { writes: 'specs/*/wireframes/*.svg' } } });
        assert.ok(!f.graph().findings.some(item => item.code === 'artifact-writers'));
        f.install('illustrate', { manifest: { 'x-companion': { writes: 'specs/**/wireframes/review-*.svg' } } });
        assert.ok(f.graph().findings.some(item => item.code === 'artifact-writers' &&
            item.nodeIds.includes('extension:wireframe') && item.nodeIds.includes('extension:illustrate') &&
            !item.nodeIds.includes('extension:preview')));
    });

    it('does not waive governance approval based on an installed command name and version', t => {
        const f = fixture(t);
        f.install('roadmap', { manifest: {
            extension: { version: '0.1.1' },
            provides: { commands: ['brief', 'write'].map(verb => ({ name: `speckit.roadmap.${verb}`, file: 'commands/run.md' })) },
        } });
        f.registry.roadmap.version = '0.1.1';
        f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
        f.hooks({
            before_implement: [hook('roadmap', { command: 'speckit.roadmap.brief' })],
            after_constitution: [hook('roadmap', { command: 'speckit.roadmap.write' })],
        });
        const { edges, findings } = f.graph();
        const brief = edges.find(edge => edge.id === 'hook:before_implement:0');
        assert.equal(brief.approval, 'confirm');
        const unguarded = findings.filter(item => item.code === 'unguarded-hook');
        assert.deepEqual(unguarded.flatMap(item => item.edgeIds).sort(), ['hook:after_constitution:0', 'hook:before_implement:0']);
    });

    it('does not present malformed, missing or incompatible installations as healthy', t => {
        const f = fixture(t);
        f.install('companion');
        f.install('preview', { manifest: { requires: { speckit_version: '>=999.0.0' } } });
        f.install('intake');
        f.put('.specify/extensions/companion/extension.yml', 'extension: [malformed');
        rmSync(join(f.root, '.specify/extensions/intake/extension.yml'));
        const graph = f.graph();
        for (const [key, state] of [['companion', 'blocked'], ['preview', 'incompatible'], ['intake', 'missing']]) {
            const node = graph.nodes.find(item => item.id === `extension:${key}`);
            assert.equal(node.state, state);
            assert.equal(node.healthStatus, 'blocked');
        }
    });

    it('marks bundle pins on dependency edges and distinguishes recorded substitutions from drift', t => {
        const f = fixture(t);
        f.install('git', { manifest: { extension: { version: '1.0.2' } } });
        f.registry.git.version = '1.0.2';
        f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
        const path = '.specify/bundle-records.json';
        const component = { kind: 'extensions', id: 'git', version: '1.0.0' };
        const record = {
            bundle_id: 'pinned', version: '1.0.0', contributed_components: [], required_components: [component],
        };
        const source = 'extension:git', target = 'bundle:pinned';
        const writeRecord = values => f.put(path, { schema_version: '1.0', bundles: [{ ...record, ...values }] });
        const inspect = ({ code, severity, status }) => {
            const graph = f.graph();
            const edge = graph.edges.find(item => item.source === source && item.target === target);
            assert.match(edge.label, /1\.0\.0/);
            assert.equal(edge.status, status);
            assert.ok(graph.findings.some(item =>
                item.code === code && item.severity === severity && item.edgeIds.includes(edge.id) && item.nodeIds.includes(target)));
        };
        writeRecord({});
        inspect({ code: 'bundle-pin-drift', severity: 'blocked', status: 'blocked' });
        writeRecord({ installed_versions: { 'extensions:git': '1.0.2' } });
        inspect({ code: 'bundle-pin-substitution', severity: 'advisory', status: 'advisory' });
        f.install('git');
        assert.ok(!f.graph().findings.some(item => item.code.startsWith('bundle-pin-')));
    });

    it('distinguishes integration event overrides from inherited native declarations', t => {
        const f = fixture(t);
        const handler = { command: 'speckit.reporter.run', matcher: 'Shell', timeout: 15 };
        f.install('reporter', { manifest: { 'x-companion': { effect: 'local-write' }, events: {
            post_tool_use: { command: 'reporter.run' },
        } } });
        f.put(NATIVE_HOOK_PATH, { integrations: {
            claude: { events: { stop: handler } },
            copilot: { events: { post_tool_use: [handler, { command: 'speckit.missing.run' }] } },
        } });
        const graph = f.graph();
        const declared = graph.edges.find(edge => edge.id === 'native:reporter:post_tool_use:0');
        const overrides = graph.edges.filter(edge => edge.nativeLayer === 'override');
        assert.deepEqual([declared.source, declared.command, declared.active], ['stage:implement', handler.command, true]);
        assert.match(declared.description, /stale generated agent settings/);
        assert.deepEqual(overrides.map(edge => [edge.source, edge.owner, edge.order, edge.status]), [
            ['stage:implement', 'extension:reporter', 0, 'blocked'],
            ['stage:implement', 'native-events:copilot', 1, 'blocked'],
        ]);
        assert.equal(overrides[0].condition, 'Shell');
        assert.equal(overrides[0].timeout, 15);
        assert.ok(!graph.findings.some(finding => finding.code === 'parallel-hooks' && finding.edgeIds.includes(declared.id)));

        f.put(NATIVE_HOOK_PATH, { integrations: { copilot: { events: { stop: { ...handler, timeout: 0 } } } } });
        const malformed = f.graph();
        assert.ok(malformed.edges.some(edge => edge.id === declared.id && edge.active));
        assert.ok(!malformed.edges.some(edge => edge.nativeLayer === 'override'));
        assert.ok(malformed.findings.some(finding => finding.path === NATIVE_HOOK_PATH && finding.severity === 'blocked'));
    });

    it('checks nested Claude markers without exposing settings or confusing user hooks for generated ones', t => {
        const f = fixture(t);
        f.put('.specify/integration.json', { version: '1.4.1', integration: 'claude' });
        f.put(NATIVE_HOOK_PATH, { integrations: { claude: { events: {} } } });
        const path = '.claude/settings.json';
        const user = { type: 'command', command: 'user-only-command' };
        const generated = { type: 'command', command: 'generated-command', __speckit_event__: true };
        f.put(path, { env: { EXAMPLE: 'private-test-value' }, hooks: { Stop: [{ hooks: [user, generated] }] } });
        const graph = f.graph();
        const warning = graph.findings.find(item => item.code === 'native-event-suppression-pending');
        assert.deepEqual([warning.path, warning.severity, warning.nodeIds], [path, 'advisory', ['native-events:claude']]);
        assert.doesNotMatch(JSON.stringify(graph), /private-test-value|user-only-command|generated-command/);
        assert.ok(!graph.nodes.some(node => node.artifacts.includes(path)));

        f.put(path, { hooks: { Stop: [{ hooks: [user] }] } });
        assert.ok(!f.graph().findings.some(item => item.path === path));
        f.put(path, '{"hooks":');
        assert.ok(f.graph().findings.some(item => item.code === 'native-event-settings-unverified' && item.path === path));
    });

    it('shows the latest Spec Kit workflow run without exposing its persisted inputs', t => {
        const f = fixture(t);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { release: { name: 'Release' } } });
        f.put('.specify/workflows/release/workflow.yml', { workflow: { id: 'release' },
            steps: [{ id: 'review', type: 'gate', message: 'Review release' }] });
        for (const [run_id, status, updated_at] of [['run-a', 'paused', '2026-01-02T00:00:00Z'], ['run-z', 'completed', '2026-01-01T00:00:00Z']]) {
            f.put(`.specify/workflows/runs/${run_id}/state.json`,
                { run_id, workflow_id: 'release', status, updated_at, current_step_id: 'review', inputs: { internal: 'not-for-inventory' } });
        }
        const graph = f.graph();
        const node = graph.nodes.find(item => item.id === 'workflow:release');
        assert.deepEqual([node.lastRunId, node.lastRunStatus, node.lastRunStep], ['run-a', 'paused', 'review']);
        assert.doesNotMatch(JSON.stringify(graph), /not-for-inventory|runs\/run-a\/state\.json/);
    });

    it('shows only the active Companion recipe hooks and includes their source and declared order', t => {
        const f = fixture(t);
        f.install('companion');
        const select = workflow => f.put('.specify/companion.yml', {
            workflow, commands: { plan: { hooks: { after: { check: { type: 'prompt', text: 'Default hook' } } } } },
        });
        const recipe = '.specify/companion/workflows/review.yml';
        select('review');
        f.put(recipe, { commands: { plan: { hooks: { before: { handoff: [
            { type: 'prompt', text: 'Inspect the review', background: true },
            { type: 'skill', ref: 'review' },
        ] } } } } });
        const hooks = () => f.graph().edges.filter(edge => edge.kind === 'embedded-hook');
        assert.deepEqual(hooks().map(edge => [edge.hook, edge.path, edge.runOrder, edge.background]), [
            ['before.plan.handoff', recipe, 1, true], ['before.plan.handoff', recipe, 2, false],
        ]);
        assert.ok(f.graph().nodes.find(node => node.id === 'extension:companion').artifacts.includes(recipe));
        select('shipped');
        assert.deepEqual(hooks(), []);
        select('missing');
        assert.ok(f.graph().findings.some(finding => finding.code === 'missing-companion-recipe'));
    });

    it('does not present unavailable workflow steps or unresolved commands as ready', t => {
        const f = fixture(t);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { release: { enabled: true } } });
        f.put('.specify/workflows/release/workflow.yml', { workflow: { id: 'release' }, steps: [
            { id: 'plan', command: 'speckit.plan' },
            { id: 'report', type: 'make-report' },
            { id: 'summary', type: 'prompt', prompt: 'Summarize' },
        ] });
        const graph = f.graph();
        const find = id => graph.nodes.find(node => node.id === id);
        assert.equal(find('workflow:release').healthStatus, 'blocked');
        assert.equal(find('workflow:release:plan').healthStatus, 'blocked');
        assert.equal(find('workflow:release:report').healthStatus, 'blocked');
        assert.equal(find('workflow:release:summary').effect, 'unknown');
        assert.ok(graph.findings.some(item => item.code === 'missing-step-package' && item.nodeIds.includes('workflow:release:report')));
        assert.ok(graph.edges.some(edge => edge.source === 'step-package:make-report' && edge.target === 'workflow:release:report' && edge.status === 'blocked'));
    });

    it('surfaces a GitHub write nested inside a conditional instead of marking the workflow read-only', t => {
        const f = fixture(t);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { release: { enabled: true } } });
        f.put('.specify/workflows/release/workflow.yml', { workflow: { id: 'release' }, steps: [
            { id: 'check', type: 'if', condition: 'true', then: [{ id: 'publish', type: 'github' }], else: [
                { id: 'review', type: 'gate', message: 'Inspect the release.' },
            ] },
        ] });
        const graph = f.graph();
        const workflow = graph.nodes.find(node => node.id === 'workflow:release');
        const publish = graph.nodes.find(node => node.id === 'workflow:release:check:publish');
        assert.deepEqual([workflow.effect, workflow.healthStatus, publish.approval], ['external-write', 'blocked', 'confirm']);
        assert.ok(graph.edges.some(edge => edge.source === 'workflow:release:check' && edge.target === publish.id &&
            edge.label === 'then' && edge.status === 'blocked'));
        assert.ok(graph.edges.some(edge => edge.target === 'workflow:release:check:review' && edge.label === 'else'));
    });
});

describe('workflow previews and confirmed changes', () => {
    it('registers only a confirmed standalone workflow at the pinned GitHub digest', async t => {
        const f = fixture(t);
        const key = 'release-review';
        const definition = {
            workflow: { id: key, name: 'Release review', version: '1.0.0' },
            inputs: { verdict: { type: 'string' } },
            steps: [{ id: 'release', type: 'gate', verdict_input: 'verdict', message: 'Review release notes.' }],
        };
        const raw = JSON.stringify(definition);
        const digest = value => createHash('sha256').update(value).digest('hex');
        const sha256 = digest(raw);
        const remoteUrl = `https://raw.githubusercontent.com/acme/fixtures/${'a'.repeat(40)}/workflow.yml`;
        const nextUrl = remoteUrl.replace('a'.repeat(40), 'c'.repeat(40));
        const source = `.speckit-companion/workflow-sources/${key}-${sha256}.yml`;
        const registry = '.specify/workflows/workflow-registry.json';
        const path = `.specify/workflows/${key}/workflow.yml`;
        const calls = [];
        let payload = raw;
        let discardResponse = false;
        const { api } = await serve(t, f.root, {
            workflowFetch: async (url, options) => {
                assert.ok([remoteUrl, nextUrl].includes(url));
                assert.equal(options.redirect, 'error');
                assert.equal(options.credentials, 'omit');
                if (discardResponse) throw new TypeError('Redirect refused');
                return new Response(payload);
            },
            workflowCli: async (root, args, probe) => {
                if (!probe && args[1] === 'add') {
                    assert.deepEqual(args.slice(0, 3), ['workflow', 'add', '--dev']);
                    assert.notEqual(args[3], join(f.root, source));
                    const contents = readFileSync(args[3], 'utf8');
                    assert.equal(contents, payload);
                    if (root === f.root) calls.push(args);
                    if (!process.env.SPECKIT_CANVAS_TEST_CLI) {
                        if (root === f.root) {
                            const prior = existsSync(join(f.root, registry)) ? JSON.parse(readFileSync(join(f.root, registry), 'utf8')).workflows[key] : null;
                            f.put(path, contents);
                            f.put(registry, { workflows: { [key]: { version: JSON.parse(contents).workflow.version, enabled: prior?.enabled ?? true, source: args[3] } } });
                        }
                        return 'Registered';
                    }
                }
                return process.env.SPECKIT_CANVAS_TEST_CLI ? callSpecKit(root, args, probe) : '--dev';
            },
            send: () => assert.fail('Registration must not dispatch the workflow'),
        });
        const request = { operation: 'install', kind: 'Workflows', key, remoteUrl, sha256 };
        await api('/workflow/preview', { ...request, remoteUrl: remoteUrl.replace('a'.repeat(40), 'main') }, 400);
        await api('/workflow/preview', { ...request, remoteUrl: remoteUrl.replace('raw.githubusercontent.com', 'example.com') }, 400);
        await api('/workflow/preview', { ...request, kind: 'Extensions' }, 400);
        await api('/workflow/preview', { ...request, key: 'other' }, 400);
        await api('/workflow/preview', { ...request, sha256: 'b'.repeat(64) }, 409);
        discardResponse = true;
        await api('/workflow/preview', request, 502);
        discardResponse = false;
        payload = 'x'.repeat(32 * 1024 + 1);
        await api('/workflow/preview', { ...request, sha256: digest(payload) }, 400);
        payload = raw;
        const first = await api('/workflow/preview', request);
        assert.ok(first.id, JSON.stringify(first.findings));
        assert.deepEqual(first.packageDefinition, { path, before: null, after: raw, url: remoteUrl, sha256 });
        assert.ok(first.paths.includes(source));
        assert.equal(existsSync(join(f.root, source)), false);
        payload = `${raw}\n`;
        await api('/workflow/apply', { id: first.id }, 409);
        assert.deepEqual(calls, []);
        assert.equal(existsSync(join(f.root, source)), false);
        payload = raw;
        const second = await api('/workflow/preview', request);
        const plugin = '.specify/workflows/steps/custom';
        f.put(`${plugin}/__init__.py`, 'raise RuntimeError("Must not load this fixture")');
        f.put(`${plugin}/step.yml`, { step: { type_key: 'custom', version: '1.0.0' } });
        await api('/workflow/apply', { id: second.id }, 400);
        assert.deepEqual(calls, []);
        rmSync(join(f.root, plugin), { recursive: true });
        const third = await api('/workflow/preview', request);
        const result = await api('/workflow/apply', { id: third.id });
        const registered = result.graph.nodes.find(node => node.id === `workflow:${key}`);
        assert.equal(registered?.state, 'enabled');
        assert.equal(registered.origin, remoteUrl);
        assert.ok(registered.artifacts.includes(`${source}.json`));
        assert.equal(readFileSync(join(f.root, path), 'utf8'), raw);
        const installedRegistry = JSON.parse(readFileSync(join(f.root, registry), 'utf8'));
        installedRegistry.workflows[key].enabled = false;
        f.put(registry, installedRegistry);
        definition.workflow.version = '1.1.0';
        payload = JSON.stringify(definition);
        const update = await api('/workflow/preview', { ...request, operation: 'update', id: registered.id, remoteUrl: nextUrl, sha256: digest(payload) });
        assert.ok(update.id, JSON.stringify(update.findings));
        assert.equal(update.packageDefinition.before, raw);
        assert.equal(update.packageDefinition.after, payload);
        const updated = (await api('/workflow/apply', { id: update.id })).graph.nodes.find(node => node.id === registered.id);
        assert.equal(updated.state, 'disabled');
        assert.equal(updated.version, '1.1.0');
        assert.equal(updated.origin, nextUrl);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), payload);
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
        assert.equal(calls.length, 2);
    });

    it('registers only a trusted, rechecked catalog release and records its provenance', {
        timeout: 240_000,
    }, async t => {
        const f = fixture(t);
        const { id, index, url, body, digest, configure, path } = catalogFixture(f, false);
        const calls = [];
        let version = '1.0.0';
        let advertisedDigest = digest;
        let workflowBytes = body;
        const fetchSource = async (target, options) => {
            calls.push(target);
            assert.equal(options.redirect, 'error');
            assert.equal(options.credentials, 'omit');
            if (target === index) return new Response(JSON.stringify({ workflows: {
                'release-review': { version, url, sha256: advertisedDigest, releases: {
                    '0.9.0': { url, sha256: `sha256:${digest}` },
                } },
                archive: { version: '1.0.0', url: url.replace('gate.yml', 'gate.zip'), sha256: digest },
                dependent: { version: '1.0.0', url, sha256: digest, requires: { workflows: ['other'] } },
            } }));
            assert.equal(target, url);
            return new Response(workflowBytes);
        };
        const installed = '.specify/workflows/release-review/workflow.yml';
        const executions = [];
        const real = process.env.SPECKIT_CANVAS_TEST_CLI === '1';
        const cli = async (root, args, probe) => {
            if (real) return callSpecKit(root, args, probe);
            if (probe) return '--dev';
            assert.deepEqual(args.slice(0, 3), ['workflow', 'add', '--dev']);
            assert.equal(readFileSync(args[3], 'utf8'), workflowBytes);
            executions.push(root);
            if (root === f.root) {
                f.put(installed, workflowBytes);
                f.put('.specify/workflows/workflow-registry.json', { workflows: { 'release-review': {
                    version, enabled: true, source: args[3],
                } } });
            }
            return 'Registered';
        };
        const { api } = await serve(t, f.root, { workflowCli: cli, workflowFetch: fetchSource });
        const browse = await api('/workflow/catalog', { id });
        assert.equal(browse.installAllowed, false);
        assert.deepEqual(browse.releases.map(({ key, version }) => [key, version]), [
            ['archive', '1.0.0'], ['release-review', '1.0.0'], ['release-review', '0.9.0'],
        ]);
        const request = { operation: 'install', kind: 'Workflows', key: 'release-review', catalogId: id,
            selection: browse.releases.find(release => release.key === 'release-review' && release.version === '1.0.0').selection };
        await api('/workflow/preview', request, 409);
        assert.deepEqual(calls, [index]);
        configure(true);
        await api('/workflow/preview', { ...request, remoteUrl: url }, 400);
        await api('/workflow/preview', { ...request, selection: browse.releases.find(release => release.version === '0.9.0').selection }, 400);
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.packageDefinition, { path: installed, before: null, after: body, url, sha256: digest,
            catalog: index, version: '1.0.0' });
        assert.equal(existsSync(join(f.root, installed)), false);
        version = '1.0.1';
        await api('/workflow/apply', { id: preview.id }, 409);
        version = '1.0.0';
        const approved = await api('/workflow/preview', request);
        workflowBytes += '\n';
        await api('/workflow/apply', { id: approved.id }, 409);
        workflowBytes = body;
        const noLongerTrusted = await api('/workflow/preview', request);
        configure(false);
        await api('/workflow/apply', { id: noLongerTrusted.id }, 409);
        configure(true);
        const final = await api('/workflow/preview', request);
        const applied = await api('/workflow/apply', { id: final.id });
        assert.equal(readFileSync(join(f.root, installed), 'utf8'), body);
        assert.equal(applied.graph.nodes.find(node => node.id === 'workflow:release-review').origin, url);
        const receipt = `.speckit-companion/workflow-sources/catalog-${request.selection}.json`;
        assert.ok(final.paths.includes(receipt));
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, receipt), 'utf8')), { catalog: index, id: 'release-review', version: '1.0.0', url, sha256: digest });
        assert.equal(JSON.parse(readFileSync(join(f.root, path), 'utf8')).catalogs[0].install_allowed, true);

        version = '1.0.1';
        workflowBytes = body.replace('1.0.0', version);
        advertisedDigest = createHash('sha256').update(workflowBytes).digest('hex');
        const { releases } = await api('/workflow/catalog', { id });
        const replacement = releases.find(release => release.key === 'release-review' && release.version === version);
        assert.deepEqual(replacement.installed, { id: 'workflow:release-review', version: '1.0.0' });
        const update = await api('/workflow/preview', { ...request, operation: 'update',
            id: replacement.installed.id, selection: replacement.selection });
        assert.equal(update.packageDefinition.before, body);
        assert.equal(update.packageDefinition.after, workflowBytes);
        const updated = await api('/workflow/apply', { id: update.id });
        assert.equal(updated.graph.nodes.find(node => node.id === 'workflow:release-review').version, version);
        assert.equal(readFileSync(join(f.root, installed), 'utf8'), workflowBytes);
        assert.equal(executions.filter(root => root === f.root).length, real ? 0 : 2);
    });

    it('previews a new empty native override and rejects it if a concurrent edit creates the file', async t => {
        const f = fixture(t);
        const id = 'native-events:copilot';
        const handler = { command: 'speckit.reporter.run', matcher: 'View' };
        f.install('reporter', { manifest: { extension: { effect: 'read-only' }, events: { post_tool_use: handler } } });
        const generated = '.github/hooks/speckit.json';
        const settings = { version: 1, hooks: { postToolUse: [{ type: 'command', __speckit_event__: true }] } };
        f.put(generated, settings);
        const { api } = await serve(t, f.root);
        const initial = await api('/workflow');
        assert.equal(initial.nodes.find(node => node.id === id).state, 'proposed');
        await api('/workflow/preview', { operation: 'native-override-add', id: 'native:reporter:post_tool_use:0' }, 400);
        const request = { operation: 'native-override-empty', id };
        const preview = await api('/workflow/preview', request);
        assert.ok(preview.id, JSON.stringify(preview.findings));
        assert.equal(preview.documentChange.before, null);
        assert.ok(preview.advisories.some(item => item.code === 'native-event-suppression-pending'));
        assert.equal(existsSync(join(f.root, NATIVE_HOOK_PATH)), false);
        const changedHook = preview.diff.edges.changed.find(item => item.before.id === 'native:reporter:post_tool_use:0');
        assert.deepEqual([changedHook.before.nativeConfiguration, changedHook.after.nativeConfiguration], ['inherited', 'replaced']);
        const concurrent = { integrations: { claude: { events: { stop: handler } } } };
        f.put(NATIVE_HOOK_PATH, concurrent);
        await api('/workflow/apply', { id: preview.id }, 409);
        assert.equal(readFileSync(join(f.root, NATIVE_HOOK_PATH), 'utf8'), JSON.stringify(concurrent));
        const reviewed = await api('/workflow/preview', request);
        const applied = await api('/workflow/apply', { id: reviewed.id });
        assert.equal(applied.graph.nodes.find(node => node.id === id).installed, true);
        assert.equal(readFileSync(join(f.root, NATIVE_HOOK_PATH), 'utf8'), reviewed.documentChange.after);
        assert.match(reviewed.documentChange.after, /copilot:\r?\n\s+events: \{\}/);
        assert.match(reviewed.documentChange.after, /claude:\r?\n\s+events:\r?\n\s+stop:\r?\n\s+command: speckit\.reporter\.run/);
        assert.equal(readFileSync(join(f.root, generated), 'utf8'), JSON.stringify(settings));
        assert.ok(applied.graph.findings.some(item => item.code === 'native-event-suppression-pending'));
        await api('/workflow/preview', request, 400);
    });

    it('refuses to suppress native events by replacing a malformed override or assuming runtime compatibility', async t => {
        const f = fixture(t);
        f.put(NATIVE_HOOK_PATH, 'integrations:\n  copilot:\n    events: invalid\n');
        const { api } = await serve(t, f.root);
        const request = { operation: 'native-override-empty', id: 'native-events:copilot' };
        await api('/workflow/preview', request, 400);
        f.put(NATIVE_HOOK_PATH, 'integrations: [');
        await api('/workflow/preview', request, 400);
        f.put(NATIVE_HOOK_PATH, { integrations: { copilot: { events: { stop: [{ command: 'speckit.reporter.run' }, 'malformed'] } } } });
        await api('/workflow/preview', request, 400);
        await api('/workflow/preview', { ...request, operation: 'native-override-restore' }, 400);
        f.put(NATIVE_HOOK_PATH, { integrations: {} });
        f.put('.specify/init-options.json', { speckit_version: '1.2.0', integration: 'copilot' });
        await api('/workflow/preview', request, 400);
    });

    it('never dispatches a Workflow command while an empty native override disagrees with generated settings', async t => {
        const f = fixture(t);
        const generated = '.github/hooks/speckit.json';
        const stale = { version: 1, hooks: { sessionStart: [{ type: 'command', __speckit_event__: true }] } };
        f.put(NATIVE_HOOK_PATH, { integrations: { copilot: { events: {} } } });
        const dispatched = [];
        const { api } = await serve(t, f.root, { send: async prompt => { dispatched.push(prompt); return true; } });
        const run = { operation: 'run', id: 'stage:specify', command: 'specify', intent: 'Give readers an export button' };

        f.put(generated, stale);
        assert.match((await api('/workflow/preview', run, 409)).error, /hook entries remain/);
        f.put(generated, '{"hooks":');
        assert.match((await api('/workflow/preview', run, 409)).error, /could not verify/);
        f.put(generated, { version: 1 });
        const reviewed = await api('/workflow/preview', run);
        assert.ok(reviewed.id);
        f.put(generated, stale);
        await api('/workflow/apply', { id: reviewed.id }, 409);
        assert.deepEqual(dispatched, []);
        f.put(generated, { version: 1, hooks: { sessionStart: [{ type: 'command', __speckit_event__: false }] } });
        const ready = await api('/workflow/preview', run);
        await api('/workflow/apply', { id: ready.id });
        assert.equal(dispatched.length, 1);
    });

    it('checks secondary installed integrations before preview and again at confirmation', async t => {
        const f = fixture(t);
        const generated = '.github/hooks/speckit.json';
        const stale = { version: 1, hooks: { sessionStart: [{ command: 'private-test-command', __speckit_event__: true }] } };
        const state = {
            version: '1.4.1', integration: 'copilot', default_integration: 'claude',
            installed_integrations: ['claude', 'copilot'],
        };
        f.put('.specify/integration.json', state);
        f.put(NATIVE_HOOK_PATH, { integrations: { copilot: { events: {} } } });
        f.put(generated, stale);
        const graph = f.graph();
        assert.equal(graph.runtime.integration, 'claude');
        const secondary = graph.nodes.find(item => item.id === 'native-events:copilot');
        assert.ok(secondary.installed);
        assert.ok(!secondary.canRestoreNativeInheritance);
        assert.doesNotMatch(JSON.stringify(graph), /private-test-command/);
        const dispatched = [];
        const { api } = await serve(t, f.root, { send: async prompt => { dispatched.push(prompt); return true; } });
        const run = { operation: 'run', id: 'stage:specify', command: 'specify', intent: 'Give readers an export button' };

        assert.match((await api('/workflow/preview', run, 409)).error, /empty copilot override/);
        f.put('.specify/integration.json', { version: '1.4.1', installed_integrations: ['claude', ' copilot '] });
        assert.equal(f.graph().runtime.integration, 'claude');
        assert.match((await api('/workflow/preview', run, 409)).error, /empty copilot override/);
        f.put(generated, '{"hooks":');
        assert.match((await api('/workflow/preview', run, 409)).error, /could not verify/);
        f.put(generated, { version: 1 });
        const ready = await api('/workflow/preview', run);
        f.put(generated, stale);
        await api('/workflow/apply', { id: ready.id }, 409);
        assert.equal(dispatched.length, 0);

        f.put('.specify/integration.json', { ...state, installed_integrations: ['claude'] });
        const withoutCopilot = await api('/workflow/preview', run);
        await api('/workflow/apply', { id: withoutCopilot.id });
        assert.equal(dispatched.length, 1);
    });

    it('reviews restoring inheritance without restoring an unsafe handler or touching generated settings', async t => {
        const f = fixture(t);
        const readOnly = { command: 'speckit.reporter.run' };
        f.install('reporter', { manifest: { extension: { effect: 'read-only' }, events: { stop: readOnly } } });
        f.install('unsafe', { manifest: { 'x-companion': { effect: 'external-write' }, events: { stop: { command: 'speckit.unsafe.run' } } } });
        const unrelated = { events: { stop: readOnly } };
        f.put(NATIVE_HOOK_PATH, { integrations: { copilot: { events: {} }, claude: unrelated } });
        const generated = '.github/hooks/speckit.json';
        f.put(generated, { version: 1 });
        const { api } = await serve(t, f.root);
        const request = { operation: 'native-override-restore', id: 'native-events:copilot' };
        const blocked = await api('/workflow/preview', request);
        assert.equal(blocked.id, null);
        assert.ok(blocked.findings.some(item => item.code === 'unguarded-hook' && item.edgeIds.includes('native:unsafe:stop:0')));
        f.registry.unsafe.enabled = false;
        f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
        const preview = await api('/workflow/preview', request);
        assert.ok(preview.id, JSON.stringify(preview.findings));
        assert.deepEqual(preview.diff.edges.changed.filter(item => item.after.active).map(item => item.after.nativeConfiguration), ['inherited']);
        const restored = await api('/workflow/apply', { id: preview.id });
        assert.ok(restored.graph.edges.some(edge => edge.id === 'native:reporter:stop:0' && edge.nativeConfiguration === 'inherited'));
        const saved = readFileSync(join(f.root, NATIVE_HOOK_PATH), 'utf8');
        assert.doesNotMatch(saved, /copilot:/);
        assert.match(saved, /claude:\r?\n\s+events:\r?\n\s+stop:\r?\n\s+command: speckit\.reporter\.run/);
        assert.equal(readFileSync(join(f.root, generated), 'utf8'), '{"version":1}');
    });

    it('previews native override edits without rewriting generated settings or restoring inherited handlers', async t => {
        const f = fixture(t);
        const view = { command: 'speckit.reporter.run', matcher: 'View' };
        const inspect = { command: 'speckit.auditor.run', matcher: 'Inspect' };
        f.install('reporter', { manifest: { extension: { effect: 'read-only' }, events: { post_tool_use: view } } });
        f.install('auditor', { manifest: { 'x-companion': { effect: 'local-write' }, events: { post_tool_use: inspect } } });
        const original = { integrations: { copilot: { events: { post_tool_use: [view, inspect], session_start: view } }, claude: { events: { stop: view } } } };
        const generated = '.github/hooks/speckit.json';
        f.put(NATIVE_HOOK_PATH, original);
        f.put(generated, '{"version":1}');
        const { api } = await serve(t, f.root);
        const id = 'native-override:copilot:post_tool_use:0';
        const append = { operation: 'native-override-add', id: 'native:reporter:post_tool_use:0' };
        await api('/workflow/preview', append, 400);
        await api('/workflow/preview', { ...append, id: 'native:auditor:post_tool_use:0' }, 400);
        const move = await api('/workflow/preview', { operation: 'native-override-down', id });
        assert.ok(move.id, JSON.stringify(move.findings));
        assert.equal(move.documentChange.before, JSON.stringify(original));
        assert.equal(readFileSync(join(f.root, NATIVE_HOOK_PATH), 'utf8'), JSON.stringify(original));
        const applied = await api('/workflow/apply', { id: move.id });
        assert.deepEqual(applied.graph.edges.filter(edge => edge.nativeLayer === 'override' && edge.hook === 'post_tool_use').map(edge => edge.condition), ['Inspect', 'View']);
        const configure = { operation: 'native-override-configure', matcher: 'Read', timeout: 45 };
        await api('/workflow/preview', { ...configure, id }, 400);
        const edited = await api('/workflow/preview', { ...configure, id: 'native-override:copilot:post_tool_use:1' });
        const configured = await api('/workflow/apply', { id: edited.id });
        const handler = configured.graph.edges.find(edge => edge.id === 'native-override:copilot:post_tool_use:1');
        assert.deepEqual([handler.command, handler.condition, handler.timeout], [view.command, 'Read', 45]);
        const muted = await api('/workflow/preview', { operation: 'native-override-mute', id: 'extension:reporter' });
        const remaining = await api('/workflow/apply', { id: muted.id });
        assert.deepEqual(remaining.graph.edges.filter(edge => edge.nativeLayer === 'override').map(edge => edge.command), [inspect.command]);
        const removal = await api('/workflow/preview', { operation: 'native-override-remove', id });
        assert.ok(removal.id);
        await api('/workflow/apply', { id: removal.id });
        const saved = readFileSync(join(f.root, NATIVE_HOOK_PATH), 'utf8');
        assert.match(saved, /copilot:\r?\n\s+events: \{\}/);
        assert.match(saved, /claude:\r?\n\s+events:\r?\n\s+stop:\r?\n\s+command: speckit\.reporter\.run/);
        assert.equal(readFileSync(join(f.root, generated), 'utf8'), '{"version":1}');
        assert.ok((await api('/workflow')).nodes.some(node => node.id === 'native-events:copilot'));
        const restore = await api('/workflow/preview', append);
        assert.ok(restore.id, JSON.stringify(restore.findings));
        const restored = await api('/workflow/apply', { id: restore.id });
        assert.deepEqual(restored.graph.edges.filter(edge => edge.nativeLayer === 'override').map(edge => [edge.command, edge.condition]), [[view.command, 'View']]);
        assert.equal(readFileSync(join(f.root, generated), 'utf8'), '{"version":1}');
    });

    it('previews the exact configuration file and refuses to overwrite an edit after approval', async t => {
        const f = fixture(t);
        const path = '.specify/extensions/preview/config.yml';
        const original = '# User notes\nfidelity: low\nnested:\n  theme: light\n';
        f.install('preview', { manifest: { provides: { config: [{ name: 'config.yml' }] } } });
        f.put(path, original);
        const { api } = await serve(t, f.root);
        const request = { operation: 'configure', id: 'extension:preview', path, values: { fidelity: 'high' } };
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.paths, [path]);
        assert.ok(preview.artifacts.includes(path));
        assert.equal(preview.documentChange.before, original);
        assert.match(preview.documentChange.after, /fidelity: high\nnested:\n  theme: light/);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), original);
        f.put(path, original.replace('theme: light', 'theme: dark'));
        await api('/workflow/apply', { id: preview.id }, 409);
        const refreshed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: refreshed.id });
        assert.equal(readFileSync(join(f.root, path), 'utf8'), refreshed.documentChange.after);
    });

    it('can confirm the exact authored constitution but never overwrites a generated one', async t => {
        const f = fixture(t);
        f.put(CONSTITUTION, '# Current constitution\n');
        const { api } = await serve(t, f.root);
        const request = { operation: 'constitution-save', id: 'stage:constitution', text: '# Proposed constitution\n' };
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.documentChange, { path: CONSTITUTION, before: '# Current constitution\n', after: request.text });
        assert.equal(readFileSync(join(f.root, CONSTITUTION), 'utf8'), '# Current constitution\n');
        await api('/workflow/apply', { id: preview.id });
        assert.equal(readFileSync(join(f.root, CONSTITUTION), 'utf8'), request.text);
        const replacement = await api('/workflow/preview', { ...request, text: '# Future constitution\n' });
        f.install('charter');
        await api('/workflow/apply', { id: replacement.id }, 400);
        await api('/workflow/preview', request, 400);
        assert.equal(readFileSync(join(f.root, CONSTITUTION), 'utf8'), request.text);
    });

    it('confirms only package-owned Markdown selected by Charter and leaves composed files untouched', async t => {
        const f = fixture(t);
        f.install('charter');
        const source = 'packages/api/.charter/constitution.md';
        const id = `file:${source}`;
        const original = '# API rules\r\n\r\nUse typed errors.\r\n';
        const generated = '# Composed Charter constitution\n';
        const config = { distributed_sub_constitutions: true };
        const selected = { distributed_sub_constitutions: [source.slice(0, -3)] };
        f.put('.specify/extensions/charter/scripts/bash/distributed-read.sh', '# fixture: capability declaration only');
        f.put(CHARTER_CONFIG, config);
        f.put(CHARTER_STATE, selected);
        f.put(CONSTITUTION, generated);
        f.put(source, original);
        f.put('packages/worker/.charter/constitution.md', '# Not selected');
        const { api } = await serve(t, f.root, { send: () => assert.fail('A source edit must not dispatch Charter') });
        const graph = await api('/workflow');
        assert.ok(graph.edges.some(edge => edge.kind === 'input' && edge.source === id && edge.target === 'extension:charter'));
        assert.equal(graph.nodes.find(node => node.id === id).editableCharterSource, source);
        const request = { operation: 'charter-source-save', id, text: '# API rules\n\nDocument typed errors.\n' };
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.paths, [source]);
        assert.deepEqual(preview.documentChange, { path: source, before: original, after: request.text.replaceAll('\n', '\r\n') });
        assert.equal(readFileSync(join(f.root, source), 'utf8'), original);
        f.put(CHARTER_STATE, { distributed_sub_constitutions: [] });
        await api('/workflow/apply', { id: preview.id }, 400);
        await api('/workflow/preview', { ...request, id: 'file:packages/worker/.charter/constitution.md' }, 400);
        f.put(CHARTER_STATE, selected);
        const revised = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: revised.id });
        assert.equal(readFileSync(join(f.root, source), 'utf8'), revised.documentChange.after);
        assert.equal(readFileSync(join(f.root, CONSTITUTION), 'utf8'), generated);
        assert.equal(readFileSync(join(f.root, CHARTER_STATE), 'utf8'), JSON.stringify(selected));
        f.put(CHARTER_STATE, { distributed_sub_constitutions: ['../outside/.charter/constitution'] });
        assert.ok((await api('/workflow')).findings.some(item => item.code === 'invalid-charter-source'));
    });

    it('previews and updates one Roadmap status and its revision metadata without dispatching', async t => {
        const f = fixture(t);
        const original = installRoadmap(f);
        const feature = 'specs/001-exports/spec.md';
        f.put(feature, '# Export feature, unchanged');
        const id = 'extension:roadmap';
        const request = { operation: 'roadmap-status', id, entry: '001', status: 'verified' };
        const { api } = await serve(t, f.root, { send: () => assert.fail('Roadmap status must not dispatch') });
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.paths, [ROADMAP_PATH]);
        assert.equal(readFileSync(join(f.root, ROADMAP_PATH), 'utf8'), original);
        assert.equal(preview.diff.nodes.changed.find(item => item.after.id === id).after.roadmapStatus.entries[0].status, 'verified');
        const next = preview.documentChange.after;
        const withoutReport = text => text.slice(text.indexOf('-->') + 3);
        const amended = /\*\*Last Amended\*\*: (\d{4}-\d{2}-\d{2})/.exec(next)?.[1];
        assert.ok(amended);
        assert.equal(withoutReport(next), withoutReport(original).replace('[status: planned]', '[status: verified]')
            .replace('1.2.3 |', '1.2.4 |').replace('Last Amended**: 2026-02-04', `Last Amended**: ${amended}`));
        assert.match(next, /Status: 001 planned → verified/);
        f.put(ROADMAP_PATH, original.replace('A useful export.', 'A different vision.'));
        await api('/workflow/apply', { id: preview.id }, 409);

        f.put(ROADMAP_PATH, original);
        const refreshed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: refreshed.id });
        assert.equal(readFileSync(join(f.root, ROADMAP_PATH), 'utf8'), refreshed.documentChange.after);
        assert.equal(readFileSync(join(f.root, feature), 'utf8'), '# Export feature, unchanged');

        f.put(ROADMAP_PATH, original.replace('### 002', '### 001'));
        const graph = await api('/workflow');
        assert.match(graph.nodes.find(item => item.id === id).roadmapStatus.note, /duplicate ID/);
        await api('/workflow/preview', request, 400);
        f.put(ROADMAP_PATH, original);
        f.put(ROADMAP_CONFIG, { roadmap: { path: 'docs/roadmap.md' } });
        await api('/workflow/preview', request, 400);
    });

    it('confirms only the initial spec sign-off for passing Wireframe evidence and rejects stale evidence', async t => {
        const f = fixture(t);
        const { feature, svg, report, drawing, pass } = installWireframe(f);
        const path = `${feature}/spec.md`;
        const spec = '# Feature Specification: Export\r\n\r\n## User Scenarios & Testing\r\n\r\nUser-facing content.\r\n';
        f.put(path, spec);
        const request = { operation: 'wireframe-signoff', id: 'extension:wireframe', feature };
        const { api } = await serve(t, f.root, { send: () => assert.fail('Wireframe sign-off must not dispatch') });
        f.put(report, pass.replace('**Status:** PASS', '**Status:** PATCH'));
        await api('/workflow/preview', request, 400);
        f.put(report, pass);
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.paths, [path]);
        assert.deepEqual(preview.localEvidence.map(item => item.path), [svg, report]);
        assert.equal(preview.localEvidence[0].digest, createHash('sha256').update(drawing).digest('hex'));
        assert.equal(preview.localEvidence[1].text, pass);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), spec);
        assert.equal(preview.documentChange.after.replace(/## UI Mockup\r\n[\s\S]+?(?=## User Scenarios)/, ''), spec);
        assert.match(preview.documentChange.after, /\[\`wireframes\/01-export.svg\`\]\(\.\/wireframes\/01-export.svg\)/);
        f.put(svg, drawing.replace('Export panel', 'Changed panel'));
        await api('/workflow/apply', { id: preview.id }, 409);

        f.put(svg, drawing);
        const refreshed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: refreshed.id });
        assert.equal(readFileSync(join(f.root, path), 'utf8'), refreshed.documentChange.after);
        assert.equal(readFileSync(join(f.root, svg), 'utf8'), drawing);
        assert.equal(readFileSync(join(f.root, report), 'utf8'), pass);
        await api('/workflow/preview', request, 400);
    });

    it('ratifies only the reviewed ADR bytes using the released adrkit CLI', { skip: process.env.SPECKIT_CANVAS_TEST_GOVERNANCE !== '1' }, async t => {
        const f = fixture(t);
        f.put('.specify/init-options.json', { speckit_version: '1.1.3', integration: 'copilot' });
        f.install('adrkit', { manifest: { extension: { version: '0.1.5' }, requires: { speckit_version: '>=0.13.0,<1.2.0' } } });
        f.registry.adrkit.version = '0.1.5';
        f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
        const record = 'docs/adr/0001-export-format.md';
        const original = [
            '---', 'schemaVersion: 0.2.0', 'id: "0001"', 'title: "Choose an export format"', 'status: proposed',
            'date: 2026-03-04', 'deciders: ["@maintainer"]', 'tags: []', 'scope: component', 'reversibility: unknown',
            'blastRadius: component', 'relatesTo: []', 'affects: []', 'provenance:', '  authoredBy: human', '---',
            '', '# ADR-0001: Choose an export format', '', '## Context', '', 'The export needs a portable representation.',
            '', '## Decision', '', 'Export JSON.', '',
        ].join('\r\n');
        f.put(record, original);
        const { api } = await serve(t, f.root, { now: () => Date.parse('2026-04-05T06:07:08Z'), send: () => assert.fail('Ratification must not dispatch') });
        const request = { operation: 'adr-accept', id: 'extension:adrkit', record, ratifier: '@maintainer' };
        f.put(record, original.replace('deciders: ["@maintainer"]', 'deciders: []'));
        await api('/workflow/preview', request, 400);
        f.put(record, original);
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.paths, [record]);
        assert.equal(readFileSync(join(f.root, record), 'utf8'), original);
        assert.match(preview.documentChange.after, /status: accepted/);
        assert.match(preview.documentChange.after, /ratifiedBy: ['"]?@maintainer/);
        assert.match(preview.documentChange.after, /decidedAt: ['"]?2026-04-05T06:07:08Z/);
        f.put(record, original.replace('Export JSON.', 'Export plain text.'));
        await api('/workflow/apply', { id: preview.id }, 409);
        f.put(record, original);
        const refreshed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: refreshed.id });
        assert.equal(readFileSync(join(f.root, record), 'utf8'), refreshed.documentChange.after);
        await api('/workflow/preview', request, 400);
    });

    function hostedProductChange(t, name = 'initial') {
        const f = fixture(t);
        f.install('pdac');
        f.install('pdac-product', { manifest: { extension: { version: '0.1.0' } } });
        f.registry['pdac-product'].version = '0.1.0';
        f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
        const change = `.specify/productshape/changes/${name}/change.md`;
        const target = 'docs/product/model/business-rules/br-export-format.md';
        const proposed = `.specify/productshape/changes/${name}/proposed/business-rules/br-export-format.md`;
        const request = { operation: 'product-apply', id: 'extension:pdac-product', change: name };
        const original = [
            '---', 'id: CHG-INITIAL', 'type: product-change', 'title: Initial Product Definition', 'status: approved',
            "base-revision: '0000000'", 'operations:', '  add:', '    - BR-EXPORT-FORMAT', '  modify: []', '  remove: []', '---',
            '', '## Problem', '', 'Exports have no agreed format.', '', '## Intended Product Outcome', '', 'Exports use JSON.',
            '', '## Rationale', '', 'JSON is portable.', '', '## Affected Product Areas', '', 'Board export.',
            '', '## Open Questions', '', 'None.', '', '## Product Acceptance', '', 'The export can be parsed as JSON.',
            '', '## Out of Scope', '', 'Import.', '',
        ].join('\n');
        const rule = [
            '---', 'id: BR-EXPORT-FORMAT', 'type: business-rule', 'title: Export format', 'status: active',
            'applies-to: []', 'uses-terms: []', '---', '', '## Rule', '', 'Exports must use JSON.',
            '', '## Rationale', '', 'JSON is portable.', '', '## Examples', '', 'An exported board is a JSON object.',
            '', '## Exceptions', '', 'None.', '',
        ].join('\n');
        f.put('.product/config.yaml', { version: 'v1alpha1', 'product-root': 'docs/product' });
        f.put('docs/product/model/business-rules/.gitkeep', '');
        f.put(proposed, rule);
        return { f, change, target, proposed, request, original, rule };
    }

    it('preflights and applies an approved hosted change using released ProductShape', { skip: process.env.SPECKIT_CANVAS_TEST_GOVERNANCE !== '1' }, async t => {
        const { f, change, target, proposed, request, original, rule } = hostedProductChange(t);
        f.put(change, original.replace('status: approved', 'status: draft'));
        const { api } = await serve(t, f.root, { send: () => assert.fail('Applying a Product Change must not dispatch') });
        await api('/workflow/preview', request, 400);
        f.put(change, original);
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.productChange.documents.map(item => item.path), [target, change]);
        assert.equal(preview.productChange.documents[0].after, rule);
        const transition = preview.diff.nodes.changed.find(item => item.after.id === request.id);
        assert.deepEqual(transition.before.approvedProductChanges, ['initial']);
        assert.deepEqual(transition.after.approvedProductChanges, []);
        assert.deepEqual(transition.after.appliedProductChanges, ['initial']);
        assert.equal(existsSync(join(f.root, target)), false);
        f.put(proposed, rule.replace('Exports must use JSON.', 'Exports must use XML.'));
        await api('/workflow/apply', { id: preview.id }, 409);
        assert.equal(existsSync(join(f.root, target)), false);
        f.put(proposed, rule);
        const approved = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: approved.id });
        assert.equal(readFileSync(join(f.root, target), 'utf8'), rule);
        assert.equal(readFileSync(join(f.root, change), 'utf8'), original.replace('status: approved', 'status: applied'));
        assert.equal(readFileSync(join(f.root, proposed), 'utf8'), rule);
    });

    it('offers Product Change apply and archival only at their matching stages in the canvas', {
        skip: process.env.SPECKIT_CANVAS_TEST_GOVERNANCE !== '1', timeout: 180_000,
    }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const { f, change, target, original, rule } = hostedProductChange(t);
        f.put(change, original);
        f.put('.specify/productshape/changes/draft/change.md', original.replace('status: approved', 'status: draft'));
        const { url } = await serve(t, f.root, { send: () => assert.fail('Governance actions must not dispatch') });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.setDefaultTimeout(60_000);
        await page.goto(url);
        await page.getByRole('button', { name: 'Text view' }).click();
        await page.locator('table [data-workflow-item="extension:pdac-product"]').click();
        const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
        const apply = inspector.getByRole('button', { name: 'Review approved Product Change…' });
        const archive = inspector.getByRole('button', { name: 'Review Product Change archival…' });
        const dialog = page.getByRole('dialog');
        const confirm = dialog.getByRole('button', { name: 'Confirm change' });
        await apply.waitFor();
        assert.equal(await archive.count(), 0);
        await apply.click();
        await dialog.getByLabel('Product Change').selectOption('initial');
        assert.equal(await dialog.getByRole('option', { name: 'draft', exact: true }).count(), 0);
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await confirm.waitFor();
        assert.equal(existsSync(join(f.root, target)), false);
        await confirm.click();
        await archive.waitFor();
        assert.equal(await apply.count(), 0);
        assert.equal(readFileSync(join(f.root, target), 'utf8'), rule);
        await archive.click();
        await dialog.getByLabel('Product Change').selectOption('initial');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Archive move' }).waitFor();
        assert.equal(existsSync(join(f.root, change)), true);
        await confirm.click();
        const archived = '.specify/productshape/archive/initial/change.md';
        await inspector.getByRole('button', { name: archived, exact: true }).waitFor();
        assert.equal(existsSync(join(f.root, change)), false);
        assert.equal(await archive.count(), 0);
        assert.equal(readFileSync(join(f.root, target), 'utf8'), rule);
    });

    it('archives only the confirmed applied change using released ProductShape', { skip: process.env.SPECKIT_CANVAS_TEST_GOVERNANCE !== '1' }, async t => {
        const { f, change, target, proposed, request, original, rule } = hostedProductChange(t);
        const { api } = await serve(t, f.root, { send: () => assert.fail('Archiving a Product Change must not dispatch') });
        const archive = { ...request, operation: 'product-archive' };
        const archived = '.specify/productshape/archive/initial';
        f.put(change, original);
        const refusal = await api('/workflow/preview', archive, 400);
        assert.match(refusal.error, /status must be 'applied'/);
        f.put(change, original.replace('status: approved', 'status: applied'));
        f.put(target, rule);
        const archivePreview = await api('/workflow/preview', archive);
        assert.deepEqual(archivePreview.paths, ['.specify/productshape/changes/initial', archived]);
        assert.deepEqual(archivePreview.productArchive.entries.filter(item => item.kind === 'file').map(item => item.relative),
            ['change.md', 'proposed/business-rules/br-export-format.md']);
        const graphChange = archivePreview.diff.nodes.changed.find(item => item.after.id === request.id);
        assert.ok(!graphChange.after.artifacts.includes(change) && graphChange.after.artifacts.includes(`${archived}/change.md`));
        assert.equal(existsSync(join(f.root, archived)), false);
        f.put(proposed, `${rule}\n`);
        await api('/workflow/apply', { id: archivePreview.id }, 409);
        assert.equal(existsSync(join(f.root, archived)), false);
        f.put(proposed, rule);
        const confirmedArchive = await api('/workflow/preview', archive);
        const { graph } = await api('/workflow/apply', { id: confirmedArchive.id });
        assert.equal(existsSync(join(f.root, change)), false);
        assert.equal(readFileSync(join(f.root, archived, 'change.md'), 'utf8'), original.replace('status: approved', 'status: applied'));
        assert.equal(readFileSync(join(f.root, archived, 'proposed', 'business-rules', 'br-export-format.md'), 'utf8'), rule);
        assert.equal(readFileSync(join(f.root, target), 'utf8'), rule);
        assert.ok(graph.nodes.find(node => node.id === request.id).artifacts.includes(`${archived}/change.md`));
    });

    it('previews replacements, removals and affected citations against a committed ProductShape baseline', {
        skip: process.env.SPECKIT_CANVAS_TEST_GOVERNANCE !== '1',
    }, async t => {
        const { f, target, original, rule, request, change: changePath, proposed: proposalPath } = hostedProductChange(t, 'export-revision');
        const legacyPath = 'docs/product/model/business-rules/br-legacy-export.md';
        const legacy = rule.replace('BR-EXPORT-FORMAT', 'BR-LEGACY-EXPORT').replace('title: Export format', 'title: Legacy export');
        f.put(target, rule);
        f.put(legacyPath, legacy);
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
        Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(f.root, 'no-global-config'), GIT_TERMINAL_PROMPT: '0' });
        const git = (...args) => execFileSync('git', args, { cwd: f.root, env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
        git('init', '--quiet', '--template=');
        git('add', '--', '.product/config.yaml', target, legacyPath);
        git('-c', 'user.name=Canvas Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Product baseline');
        const revision = git('rev-parse', 'HEAD').trim();
        const proposed = rule.replace('Exports must use JSON.', 'Exports must use compact JSON.');
        f.put(changePath, original.replace('CHG-INITIAL', 'CHG-EXPORT-REVISION').replace('0000000', revision)
            .replace('  add:\n    - BR-EXPORT-FORMAT\n  modify: []\n  remove: []', '  add: []\n  modify:\n    - BR-EXPORT-FORMAT\n  remove:\n    - BR-LEGACY-EXPORT'));
        f.put(proposalPath, proposed);
        const citation = (id, text) => `<!-- pdac:cite id="${id}" digest="sha256:${createHash('sha256').update(text).digest('hex')}" -->`;
        const consumer = `# Export contract\n\n${citation('BR-EXPORT-FORMAT', rule)}\n${citation('BR-LEGACY-EXPORT', legacy)}\n`;
        f.put('docs/export-contract.md', consumer);
        const { api } = await serve(t, f.root);
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.productChange.documents.slice(0, 2), [
            { path: target, before: rule, after: proposed }, { path: legacyPath, before: legacy, after: null },
        ]);
        assert.deepEqual(preview.productChange.citations, [
            { path: 'docs/export-contract.md', id: 'BR-EXPORT-FORMAT', status: 'stale' },
            { path: 'docs/export-contract.md', id: 'BR-LEGACY-EXPORT', status: 'unresolved' },
        ]);
        await api('/workflow/apply', { id: preview.id });
        assert.equal(readFileSync(join(f.root, target), 'utf8'), proposed);
        assert.equal(existsSync(join(f.root, legacyPath)), false);
        assert.equal(readFileSync(join(f.root, 'docs/export-contract.md'), 'utf8'), consumer);
    });

    it('revalidates GitHub targets and performs only the approved field change', async t => {
        const f = fixture(t);
        f.install('ghp');
        const url = 'https://github.com/acme/app/issues/1';
        const item = { id: 'item', updatedAt: '2026-01-02T00:00:00Z', project: {
            id: 'project', url: 'https://github.com/orgs/acme/projects/2', title: 'Release', field: {
                id: 'field', options: [{ id: 'todo', name: 'Todo' }, { id: 'doing', name: 'In progress' }, { id: 'done', name: 'Done' }],
            },
        }, status: { optionId: 'todo', name: 'Todo' } };
        const issue = { id: 'issue', url, title: 'Export', state: 'OPEN', updatedAt: '2026-01-01T00:00:00Z',
            projectItems: { pageInfo: { hasNextPage: false }, nodes: [item] } };
        const writes = [];
        let account = 'octocat';
        const workflowGitHub = createGitHubChanges(async (query, vars, mutation) => {
            if (!mutation) {
                const { projects, ...target } = vars;
                assert.deepEqual(target, { owner: 'acme', repo: 'app', number: 1 });
                assert.equal(typeof projects, 'boolean');
                return { viewer: { login: account }, repository: { issue: structuredClone(issue) } };
            }
            writes.push(vars);
            if (query.includes('updateProjectV2ItemFieldValue')) {
                item.status = { optionId: vars.option, name: item.project.field.options.find(option => option.id === vars.option).name };
                return { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id, status: item.status } } };
            }
            assert.match(query, /closeIssue/);
            issue.state = 'CLOSED';
            return { closeIssue: { issue } };
        });
        const { api } = await serve(t, f.root, { workflowGitHub });
        const request = { operation: 'github-change', id: 'extension:ghp', url, action: 'project-status', item: 'item', option: 'done' };
        assert.equal((await api('/workflow/github-target', request)).projects[0].current.name, 'Todo');
        const preview = await api('/workflow/preview', request);
        assert.equal(preview.externalChange.before, 'Todo');
        assert.equal(preview.externalChange.after, 'Done');
        assert.equal(preview.externalChange.account, 'octocat');
        assert.deepEqual(writes, []);
        item.status = { optionId: 'doing', name: 'In progress' };
        await api('/workflow/apply', { id: preview.id }, 409);
        const refreshed = await api('/workflow/preview', request);
        assert.equal(refreshed.externalChange.before, 'In progress');
        assert.equal((await api('/workflow/apply', { id: refreshed.id })).externalApplied, true);
        await api('/workflow/apply', { id: refreshed.id }, 409);
        const close = { ...request, action: 'close' };
        const staleAccount = await api('/workflow/preview', close);
        account = 'another-login';
        await api('/workflow/apply', { id: staleAccount.id }, 409);
        const closed = await api('/workflow/preview', close);
        assert.equal(closed.externalChange.after, 'Closed');
        await api('/workflow/apply', { id: closed.id });
        assert.deepEqual(writes, [{ project: 'project', item: 'item', field: 'field', option: 'done' }, { id: 'issue' }]);
        f.install('project');
        f.hooks({ after_tasks: [hook('ghp'), hook('project')] });
        await api('/workflow/github-target', request, 400);
        await api('/workflow/preview', { ...request, id: 'extension:project' }, 400);
        assert.equal(writes.length, 2);
    });

    it('runs the supported Git hook fixture without dispatching or changing the workspace', async t => {
        const f = fixture(t);
        f.install('git', { command: { name: 'speckit.git.validate' } });
        f.hooks({ after_tasks: [hook('git', { command: 'speckit.git.validate' })] });
        const { api } = await serve(t, f.root, { send: () => assert.fail('Fixture dispatched an agent command') });
        const id = 'hook:after_tasks:0';
        const before = readFileSync(join(f.root, HOOK_PATH), 'utf8');
        assert.equal((await api('/workflow/test-hook', { id })).executed, false);
        const valid = await api('/workflow/test-hook', { id, fixture: 'sequential' });
        assert.equal(valid.executed, true);
        assert.equal(valid.fixture.feature, true);
        assert.equal(valid.fixture.artifact, 'specs/012-checkout');
        const invalid = await api('/workflow/test-hook', { id, fixture: 'invalid' });
        assert.equal(invalid.fixture.feature, false);
        assert.equal(invalid.fixture.artifact, null);
        await api('/workflow/test-hook', { id, fixture: 'unknown' }, 400);
        assert.equal(readFileSync(join(f.root, HOOK_PATH), 'utf8'), before);
    });

    it('requires a separate approval for the exact existing issue label declared in a workflow', async t => {
        const f = fixture(t);
        f.install('ghp');
        const path = '.specify/workflows/publish/workflow.yml';
        const definition = step => ({ workflow: { id: 'publish', name: 'Publish', version: '1.0.0' }, steps: [
            { id: 'review', type: 'gate', message: 'Inspect the release.' }, step,
        ] });
        const step = { id: 'label-release', type: 'github', operation: 'add-label', target: 'issue', repository: 'acme/app', number: 12, label: 'shipped' };
        f.put('.specify/workflows/workflow-registry.json', { workflows: { publish: { enabled: true } } });
        f.put(path, definition(step));
        const writes = [];
        let labelId = 'original-label';
        const issue = { id: 'issue-12', url: 'https://github.com/acme/app/issues/12', title: 'Release',
            labels: { nodes: [], pageInfo: { hasNextPage: false } } };
        const workflowGitHub = createGitHubChanges(async (query, vars, mutation) => {
            if (!mutation) {
                assert.deepEqual(vars, { owner: 'acme', repo: 'app', number: 12, name: 'shipped' });
                return { viewer: { login: 'test-user' }, repository: { issue: structuredClone(issue), label: { name: 'shipped', id: labelId } } };
            }
            assert.match(query, /addLabelsToLabelable/);
            writes.push(vars);
            issue.labels.nodes.push({ id: vars.label });
            return { addLabelsToLabelable: { labelable: issue } };
        });
        const { api } = await serve(t, f.root, { workflowGitHub, send: () => assert.fail('Manual issue label dispatched an agent command') });
        const request = { operation: 'workflow-issue-label', id: 'workflow:publish:label-release', writer: 'extension:ghp' };
        await api('/workflow/preview', { operation: 'github-change', id: 'extension:ghp', action: 'issue-label', url: issue.url, label: 'shipped' }, 400);
        const first = await api('/workflow/preview', { ...request, url: 'https://github.com/other/app/issues/3', label: 'ignored' });
        assert.deepEqual(first.externalChange, { account: 'test-user', target: issue.url, title: 'Release',
            field: 'Issue label', before: 'Not applied', after: 'shipped' });
        labelId = 'recreated-label';
        await api('/workflow/apply', { id: first.id }, 409);
        assert.deepEqual(writes, []);
        const second = await api('/workflow/preview', request);
        assert.equal((await api('/workflow/apply', { id: second.id })).externalApplied, true);
        assert.deepEqual(writes, [{ issue: 'issue-12', label: labelId }]);
        await api('/workflow/preview', request, 400);
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
        f.put(path, definition({ ...step, label: '{{ inputs.release_label }}' }));
        await api('/workflow/preview', request, 400);
    });

    it('checkpoints a guided review before a separate label approval and never retries an uncertain write', async t => {
        const f = fixture(t);
        f.install('ghp');
        const evidence = 'specs/001-exports/spec.md';
        const source = '.specify/workflows/guided/workflow.yml';
        const original = '# Feature Specification: Export board\nApproved evidence.';
        f.put(evidence, original);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { guided: { enabled: true } } });
        f.put(source, guidedDefinition(evidence));
        const id = 'workflow:guided', writer = 'extension:ghp';
        const writes = [];
        let responseLost = true;
        const issue = { id: 'issue-12', url: 'https://github.com/acme/app/issues/12', title: 'Release',
            labels: { nodes: [], pageInfo: { hasNextPage: false } } };
        const options = {
            workflowRunStorage: fixture(t).root,
            send: () => assert.fail('Guided workflow dispatched an agent command'),
            workflowCli: () => assert.fail('Guided workflow ran the Spec Kit CLI'),
            workflowGitHub: createGitHubChanges(async (_query, vars, mutation) => {
                if (!mutation) return { viewer: { login: 'test-user' }, repository: { issue, label: { name: 'shipped', id: 'label' } } };
                writes.push(vars);
                if (responseLost) return {};
                return { addLabelsToLabelable: { labelable: { ...issue, labels: { nodes: [{ id: 'label' }] } } } };
            }),
        };
        const { api } = await serve(t, f.root, options);
        const node = async (server = api) => (await server('/workflow')).nodes.find(node => node.id === id);
        const preview = (operation, data, status) => api('/workflow/preview', { operation, id, ...data }, status);
        const confirm = (proposal, status) => api('/workflow/apply', { id: proposal.id }, status);
        const start = async () => (await confirm(await preview('guided-start'))).graph.nodes.find(node => node.id === id).guidedRun.id;
        assert.equal((await node()).canRunGuided, true);
        await api('/workflow/preview', { operation: 'workflow-issue-label', id: `${id}:attach-label`, writer }, 400);
        let runId = await start();
        await preview('guided-label', { writer, runId }, 409);
        await confirm(await preview('guided-verdict', { runId, verdict: 'reject' }));
        assert.equal((await node()).guidedRun.status, 'aborted');
        runId = await start();
        const decision = await preview('guided-verdict', { runId, verdict: 'approve' });
        assert.equal(decision.reviewChange.artifact.text, original);
        await confirm(decision);
        assert.deepEqual(writes, []);
        const { api: reopened } = await serve(t, f.root, options);
        assert.equal((await node(reopened)).guidedRun.step, 'attach-label');
        const label = await preview('guided-label', { runId, writer, label: 'ignored' });
        assert.equal(label.externalChange.after, 'shipped');
        f.put(evidence, `${original}\nUpdated after approval.`);
        await confirm(label, 409);
        assert.deepEqual(writes, []);
        f.put(evidence, original);
        await confirm(await preview('guided-label', { runId, writer }), 502);
        assert.equal((await node(reopened)).guidedRun.status, 'uncertain');
        await preview('guided-start', {}, 409);
        await preview('guided-label', { runId, writer }, 409);
        assert.deepEqual(writes, [{ issue: 'issue-12', label: 'label' }]);

        responseLost = false;
        const { api: fresh } = await serve(t, f.root, { ...options, workflowRunStorage: fixture(t).root });
        const advance = async (operation, data) => {
            const { id: approval } = await fresh('/workflow/preview', { operation, id, ...data });
            return fresh('/workflow/apply', { id: approval });
        };
        await advance('guided-start');
        runId = (await node(fresh)).guidedRun.id;
        await advance('guided-verdict', { runId, verdict: 'approve' });
        assert.equal((await advance('guided-label', { runId, writer })).guidedOutcome, 'completed');
        assert.equal(writes.length, 2);
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
    });

    it('keeps standalone and write-linked guided gates separately confirmed across a resumed run', async t => {
        const f = fixture(t);
        f.install('ghp');
        const definition = guidedDefinition();
        definition.inputs.intent_verdict = { type: 'string' };
        definition.inputs.final_verdict = { type: 'string' };
        definition.inputs.evidence_verdict = { type: 'string' };
        definition.steps.push(
            { ...definition.steps[0], id: 'final-review', verdict_input: 'final_verdict', message: 'Inspect the final release.' },
            { ...definition.steps[1], id: 'attach-final-label', number: 13, label: 'released' },
            { ...definition.steps[0], id: 'verify-evidence', verdict_input: 'evidence_verdict', message: 'Verify the release evidence.' },
        );
        definition.steps.unshift({ ...definition.steps[0], id: 'review-intent', verdict_input: 'intent_verdict', message: 'Review the release intent.' });
        f.put('.specify/workflows/guided/workflow.yml', definition);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { guided: { enabled: true } } });
        const writes = [];
        const options = {
            workflowRunStorage: fixture(t).root,
            workflowGitHub: createGitHubChanges(async (_query, vars, mutation) => {
                if (!mutation) return { viewer: { login: 'test-user' }, repository: {
                    issue: { id: `issue-${vars.number}`, url: `https://github.com/acme/app/issues/${vars.number}`,
                        title: `Release ${vars.number}`, labels: { nodes: [], pageInfo: { hasNextPage: false } } },
                    label: { name: vars.name, id: vars.name },
                } };
                writes.push(vars);
                return { addLabelsToLabelable: { labelable: { id: vars.issue, labels: { nodes: [{ id: vars.label }] } } } };
            }),
        };
        let { api } = await serve(t, f.root, options);
        const id = 'workflow:guided', writer = 'extension:ghp';
        const node = graph => graph.nodes.find(item => item.id === id);
        const preview = (operation, data, status) => api('/workflow/preview', { operation, id, ...data }, status);
        const confirm = proposal => api('/workflow/apply', { id: proposal.id });
        const runId = node((await confirm(await preview('guided-start'))).graph).guidedRun.id;
        const intent = await confirm(await preview('guided-verdict', { runId, verdict: 'approve' }));
        assert.equal(intent.guidedOutcome, 'review');
        assert.equal(node(intent.graph).guidedRun.step, 'review');
        assert.deepEqual(writes, []);
        await preview('guided-label', { runId, writer }, 409);
        await confirm(await preview('guided-verdict', { runId, verdict: 'approve' }));
        const first = await preview('guided-label', { runId, writer });
        assert.deepEqual(first.guidedChange.steps, ['review-intent', 'review', 'attach-label', 'final-review', 'attach-final-label', 'verify-evidence']);
        const advanced = await confirm(first);
        assert.equal(advanced.guidedOutcome, 'review');
        assert.equal(node(advanced.graph).guidedRun.step, 'final-review');
        ({ api } = await serve(t, f.root, options));
        await preview('guided-label', { runId, writer }, 409);
        const gate = await preview('guided-verdict', { runId, verdict: 'approve' });
        assert.equal(gate.reviewChange.message, 'Inspect the final release.');
        await confirm(gate);
        assert.deepEqual(writes, [{ issue: 'issue-12', label: 'shipped' }]);
        const second = await preview('guided-label', { runId, writer });
        assert.equal(second.externalChange.after, 'released');
        const finalReview = await confirm(second);
        assert.equal(finalReview.guidedOutcome, 'review');
        assert.equal(node(finalReview.graph).guidedRun.step, 'verify-evidence');
        await preview('guided-label', { runId, writer }, 409);
        const final = await preview('guided-verdict', { runId, verdict: 'approve' });
        assert.equal(final.reviewChange.message, 'Verify the release evidence.');
        assert.equal((await confirm(final)).guidedOutcome, 'completed');
        assert.deepEqual(writes, [{ issue: 'issue-12', label: 'shipped' }, { issue: 'issue-13', label: 'released' }]);
    });

    it('routes guided inputs and verdicts to nested checkpoints without authorizing the branch write', async t => {
        const f = fixture(t);
        f.install('ghp');
        const evidence = 'specs/001-exports/spec.md';
        const original = '# Feature Specification: Export board\n\nReview the release.';
        f.put(evidence, original);
        const definition = guidedDefinition(evidence);
        const [review, label] = definition.steps;
        const gate = (id, on_reject = 'abort') => ({ ...review, id, verdict_input: id, on_reject });
        const branch = { id: 'release-path', type: 'if', condition: "{{ inputs.intake == 'approve' }}",
            then: [review, label], else: [gate('rework')] };
        const route = { id: 'choose-track', type: 'if', condition: "{{ inputs.track == 'with-label' }}",
            then: [branch], else: [gate('manual')] };
        Object.assign(definition.inputs, { track: { type: 'string', required: true, enum: ['with-label', 'review-only'] },
            intake: { type: 'string' }, manual: { type: 'string' }, rework: { type: 'string' }, final: { type: 'string' } });
        definition.steps = [gate('intake', 'skip'), route, gate('final')];
        const source = '.specify/workflows/guided/workflow.yml';
        f.put(source, definition);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { guided: { enabled: true } } });
        const writes = [];
        const issue = { id: 'issue-12', url: 'https://github.com/acme/app/issues/12', title: 'Release',
            labels: { nodes: [], pageInfo: { hasNextPage: false } } };
        const options = {
            workflowRunStorage: fixture(t).root,
            send: () => assert.fail('Unexpected agent dispatch'),
            workflowCli: () => assert.fail('Unexpected native workflow execution'),
            workflowGitHub: createGitHubChanges(async (_query, vars, mutation) => {
                if (!mutation) return { viewer: { login: 'test-user' }, repository: { issue, label: { name: 'shipped', id: 'label' } } };
                writes.push(vars);
                return { addLabelsToLabelable: { labelable: { id: vars.issue, labels: { nodes: [{ id: vars.label }] } } } };
            }),
        };
        let { api } = await serve(t, f.root, options);
        const id = 'workflow:guided', writer = 'extension:ghp';
        const node = graph => graph.nodes.find(item => item.id === id);
        const preview = (operation, data, status) => api('/workflow/preview', { operation, id, ...data }, status);
        const confirm = proposal => api('/workflow/apply', { id: proposal.id });
        await preview('guided-start', {}, 400);
        for (const [track, verdict, expectedStep] of [['review-only', 'approve', 'manual'],
            ['with-label', 'reject', 'rework'], ['with-label', 'approve', review.id]]) {
            const startInputs = [{ name: 'track', value: track }];
            const start = await preview('guided-start', { inputs: { track } });
            assert.equal(start.guidedChange.nextStep, 'intake');
            assert.deepEqual(start.guidedChange.steps, []);
            assert.deepEqual(start.reviewChange.startInputs, startInputs);
            const runId = node((await confirm(start)).graph).guidedRun.id;
            const decide = (gate, verdict = 'approve', status) => preview('guided-verdict', { runId, gate, verdict }, status);
            const write = (gate = label.id, status) => preview('guided-label', { runId, writer, gate }, status);
            await preview('guided-verdict', { runId, gate: 'intake', verdict, inputs: { track: 'with-label' } }, 400);
            const selected = await decide('intake', verdict);
            assert.equal(selected.guidedChange.nextStep, expectedStep);
            await confirm(selected);
            ({ api } = await serve(t, f.root, options));
            const saved = node(await api('/workflow')).guidedRun;
            assert.equal(saved.step, expectedStep);
            assert.deepEqual(saved.startInputs, startInputs);
            assert.deepEqual(saved.decisions.map(({ step, verdict, evidence }) => ({ step, verdict, evidence })), [
                { step: 'intake', verdict, evidence: { path: evidence, digest: createHash('sha256').update(original).digest('hex') } },
            ]);
            if (track === 'review-only') {
                const receipt = overrides => `/workflow/decision-evidence?${new URLSearchParams({ id, mode: 'guided', runId, step: 'intake', ...overrides })}`;
                assert.deepEqual(await api(receipt({ path: '../outside.md' })), { path: evidence, text: original, matches: true });
                await api(receipt({ runId: 'stale-run' }), undefined, 404);
                await api(receipt({ mode: 'isolated' }), undefined, 404);
                await api(receipt({ step: 'manual' }), undefined, 404);
            }
            await decide('intake', 'approve', 409);
            await write(label.id, 409);
            await api('/workflow/preview', { operation: 'workflow-issue-label', id: `${id}:${route.id}:${branch.id}:${label.id}`, writer }, 400);
            const decision = await confirm(await decide(expectedStep));
            assert.deepEqual(writes, []);
            if (expectedStep === review.id) {
                assert.equal(node(decision.graph).guidedRun.step, label.id);
                await preview('guided-label', { runId, writer, gate: label.id, inputs: { track: 'with-label' } }, 400);
                await write('wrong-step', 409);
                const proposal = await write();
                assert.equal(proposal.externalChange.target, issue.url);
                assert.equal(proposal.guidedChange.nextStep, 'final');
                assert.deepEqual(writes, []);
                await confirm(proposal);
            }
            assert.equal(node(await api('/workflow')).guidedRun.step, 'final');
            assert.equal((await confirm(await decide('final'))).guidedOutcome, 'completed');
        }
        assert.deepEqual(writes, [{ issue: 'issue-12', label: 'label' }]);
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
        f.put(source, { ...definition, steps: [definition.steps[0], { ...route, else: [label] }] });
        assert.equal(node(await api('/workflow')).canRunGuided, false);
        await preview('guided-start', {}, 400);
    });

    it('previews new parallel-hook advisories without blocking a valid change', async t => {
        const f = fixture(t);
        f.install('git', { command: { name: 'speckit.git.validate' } });
        f.install('preview');
        f.hooks({ after_tasks: [hook('git', { command: 'speckit.git.validate' }), hook('preview', { enabled: false })] });
        const { api } = await serve(t, f.root);
        const graph = await api('/workflow');
        assert.ok(!graph.findings.some(item => item.code === 'parallel-hooks'));
        const result = await api('/workflow/preview', { operation: 'hook-toggle', id: 'hook:after_tasks:1' });
        assert.ok(result.id, JSON.stringify(result.findings));
        assert.ok(result.advisories.some(item => item.code === 'parallel-hooks' && item.edgeIds.length === 2));
        assert.equal(JSON.parse(readFileSync(join(f.root, HOOK_PATH), 'utf8')).hooks.after_tasks[1].enabled, false);
    });

    it('reorders hooks by effective priority, not the row order in the configuration', async t => {
        const f = fixture(t);
        f.install('git', { command: { name: 'speckit.git.validate' } });
        f.install('preview');
        f.hooks({ after_tasks: [hook('git', { command: 'speckit.git.validate', priority: 30 }), hook('preview', { priority: 10 })] });
        const { api } = await serve(t, f.root);
        const graph = await api('/workflow');
        const hooks = graph.edges.filter(edge => edge.kind === 'hook');
        assert.deepEqual(hooks.map(edge => [edge.owner, edge.runOrder]), [['extension:preview', 1], ['extension:git', 2]]);
        const preview = await api('/workflow/preview', { operation: 'hook-up', id: hooks[1].id });
        assert.ok(preview.id);
        const done = await api('/workflow/apply', { id: preview.id });
        assert.deepEqual(done.graph.edges.filter(edge => edge.kind === 'hook').map(edge => edge.owner), ['extension:git', 'extension:preview']);
        assert.equal(done.graph.edges.find(edge => edge.id === hooks[1].id).owner, 'extension:git');
    });

    it('blocks enabling either a competing external writer or its hook and never invokes it', async t => {
        const f = fixture(t);
        f.install('ghp');
        f.install('project', { enabled: false });
        f.hooks({ after_tasks: [hook('project', { enabled: false })] });
        const calls = [];
        const { api } = await serve(t, f.root, { workflowCli: async (_root, args) => { calls.push(args); return 'supported'; } });
        const enable = await api('/workflow/preview', { operation: 'enable', id: 'extension:project' });
        assert.equal(enable.id, null);
        assert.ok(enable.findings.some(item => item.code === 'authority-conflict'));
        const hookId = 'hook:after_tasks:0';
        const simulated = await api('/workflow/test-hook', { id: hookId });
        assert.equal(simulated.executed, false);
        assert.ok(simulated.findings.some(item => item.code === 'hook-prerequisite'));
        const preview = await api('/workflow/preview', { operation: 'hook-toggle', id: hookId });
        assert.equal(preview.ready, false);
        assert.equal(calls.every(args => args.at(-1) === '--help'), true);
        assert.equal(JSON.parse(readFileSync(join(f.root, HOOK_PATH), 'utf8')).hooks.after_tasks[0].enabled, false);
    });

    it('previews local install, disable, enable, update and remove through the same graph validator', async t => {
        const f = fixture(t);
        f.packageFiles('sources/preview', 'preview');
        const calls = [];
        const { api } = await serve(t, f.root, { workflowCli: async (_root, args) => {
            if (args.at(-1) === '--help') return '--dev --force --keep-config';
            const [, verb] = args;
            calls.push(verb);
            if (verb === 'add') {
                f.install('preview');
                if (args.includes('--force')) {
                    f.registry.preview.version = '2.0.0';
                    f.put(REGISTRY, { extensions: f.registry });
                    f.packageFiles('.specify/extensions/preview', 'preview', { manifest: { extension: { id: 'preview', version: '2.0.0' } } });
                }
            } else if (verb === 'remove') {
                delete f.registry.preview;
                f.put(REGISTRY, { extensions: f.registry });
                rmSync(join(f.root, '.specify/extensions/preview'), { recursive: true });
            } else {
                f.registry.preview.enabled = verb === 'enable';
                f.put(REGISTRY, { extensions: f.registry });
            }
            return 'Applied';
        } });
        const id = 'extension:preview';
        for (const [operation, expectation] of [['install', 'enabled'], ['disable', 'disabled'], ['enable', 'enabled'], ['update', 'enabled'], ['remove', 'proposed']]) {
            if (operation === 'update') f.packageFiles('sources/preview', 'preview', { manifest: { extension: { id: 'preview', version: '2.0.0' } } });
            const preview = await api('/workflow/preview', { operation, id, source: 'sources/preview' });
            assert.ok(preview.id, JSON.stringify(preview.findings));
            if (['install', 'update'].includes(operation)) {
                assert.equal(preview.packageDefinition.after, readFileSync(join(f.root, 'sources/preview/extension.yml'), 'utf8'));
                assert.equal(preview.packageDefinition.before, operation === 'install' ? null :
                    readFileSync(join(f.root, '.specify/extensions/preview/extension.yml'), 'utf8'));
            }
            assert.equal(preview.diff.nodes.changed.find(item => item.after.id === id)?.after.state, expectation);
            const done = await api('/workflow/apply', { id: preview.id });
            const node = done.graph.nodes.find(item => item.id === id);
            assert.equal(node.state, expectation);
            if (operation === 'update') assert.equal(node.version, '2.0.0');
        }
        assert.deepEqual(calls, ['add', 'disable', 'enable', 'add', 'remove']);
    });

    it('gives the reviewer a full confirmation window after a slow preview', async t => {
        const f = fixture(t);
        f.install('preview', { enabled: false });
        const minute = 60_000;
        let clock = Date.parse('2026-01-01T10:00:00Z');
        let writes = 0;
        const { api } = await serve(t, f.root, {
            now: () => clock,
            workflowCli: async (_root, _args, probe) => {
                if (probe) clock += 2 * minute;
                else writes++;
                return 'Supported';
            },
        });
        const request = { operation: 'enable', id: 'extension:preview' };
        const first = await api('/workflow/preview', request);
        clock += 4 * minute;
        await api('/workflow/apply', { id: first.id });
        assert.equal(writes, 1);
        const second = await api('/workflow/preview', request);
        clock += 5 * minute + 1;
        await api('/workflow/apply', { id: second.id }, 409);
        assert.equal(writes, 1);
    });

    it('writes only after confirmation, rejects stale input and preserves a durable ownership decision', async t => {
        const f = fixture(t);
        f.install('ghp');
        f.install('project');
        f.hooks({ after_tasks: [hook('project')] });
        const { api } = await serve(t, f.root);
        const change = { operation: 'hook-toggle', id: 'hook:after_tasks:0' };
        const stale = await api('/workflow/preview', change);
        assert.ok(stale.id);
        f.hooks({ after_tasks: [hook('project', { priority: 20 })] });
        await api('/workflow/apply', { id: stale.id }, 409);
        const preview = await api('/workflow/preview', change);
        const result = await api('/workflow/apply', { id: preview.id });
        assert.equal(result.graph.edges.find(edge => edge.id === change.id).active, false);
        await api('/workflow/apply', { id: preview.id }, 409);
        const ownership = await api('/workflow/preview', { operation: 'record-owner', primary: 'ghp', secondary: 'project', strategy: 'manual', owner: 'Product operations', rationale: 'Use only human-gated story lifecycle.' });
        await api('/workflow/apply', { id: ownership.id });
        const policy = JSON.parse(readFileSync(join(f.root, POLICY_PATH), 'utf8'));
        assert.equal(policy.decisions[0].approval.method, 'canvas-confirmation');
        assert.equal(policy.decisions[0].owner, 'Product operations');
        assert.equal((await api('/workflow')).decisions.length, 1);
        const reenable = await api('/workflow/preview', change);
        assert.equal(reenable.id, null);
        assert.ok(reenable.findings.some(item => item.code === 'ownership-decision-drift'));
    });

    it('requires proof of disjoint scopes and blocks drift without splitting canonical owners', async t => {
        const f = fixture(t);
        const register = (id, authority, writes) => f.install(id, { manifest: { 'x-companion': { authority, effect: 'local-write', writes } } });
        register('design-first', 'Mockup inventory', 'features/current/**/*.svg');
        register('design-second', 'Mockup inventory', 'archive/design/**/*.svg');
        register('shadow-charter', 'Constitution composition', 'archive/constitution/**/*.md');
        f.install('charter');
        const { api } = await serve(t, f.root);
        const request = { operation: 'record-owner', primary: 'design-first', secondary: 'design-second', strategy: 'scoped',
            primaryScope: 'features/current', secondaryScope: 'archive/design', owner: 'Design', rationale: 'Separate current designs from the archive.' };
        assert.ok(f.graph().findings.some(item => item.code === 'authority-conflict' && item.nodeIds.includes('extension:design-first')));
        await api('/workflow/preview', { ...request, secondaryScope: 'features/current/extra' }, 400);
        await api('/workflow/preview', { ...request, primary: 'charter', secondary: 'shadow-charter' }, 400);
        const proposal = await api('/workflow/preview', request);
        assert.ok(proposal.id);
        const { graph } = await api('/workflow/apply', { id: proposal.id });
        assert.ok(!graph.findings.some(item => item.code === 'authority-conflict' && item.nodeIds.includes('extension:design-first')));
        assert.equal(graph.decisions[0].secondaryScope, 'archive/design');
        f.hooks({ after_tasks: [hook('design-second', { enabled: false })] });
        const hookPreview = await api('/workflow/preview', { operation: 'hook-toggle', id: 'hook:after_tasks:0' });
        assert.equal(hookPreview.ready, false);
        assert.ok(hookPreview.findings.some(item => item.code === 'ownership-decision-drift'));
        register('design-second', 'Mockup inventory', 'features/current/**/*.svg');
        assert.ok(f.graph().findings.some(item => item.code === 'artifact-writers'));
        assert.ok(f.graph().findings.some(item => item.code === 'ownership-decision-drift'));
    });

    it('previews reviewed step package registration and refuses removal while a workflow uses it', async t => {
        const f = fixture(t);
        const id = 'local-report';
        const base = '.specify/workflows/steps';
        const registry = `${base}/step-registry.json`;
        const source = 'sources/report';
        const manifest = { step: { type_key: id, version: '1.0.0', name: 'Local report' } };
        f.put(`${source}/step.yml`, manifest);
        f.put(`${source}/__init__.py`, '# Read-only fixture; registration does not import it');
        const calls = [];
        const { api } = await serve(t, f.root, { workflowCli: async (_root, args) => {
            calls.push(args);
            if (args.at(-1) !== '--help') {
                f.put(registry, { schema_version: '1.0', steps: { [id]: { source: 'local', version: '1.0.0' } } });
                f.put(`${base}/${id}/step.yml`, manifest);
                f.put(`${base}/${id}/__init__.py`, '# Installed fixture');
            }
            return '--dev --force';
        } });
        const add = await api('/workflow/preview', { operation: 'install', kind: 'Workflow steps', key: id, source });
        assert.deepEqual(calls, [['workflow', 'step', 'add', '--help']]);
        assert.ok(add.paths.includes(`${base}/${id}/__init__.py`));
        assert.equal(add.diff.nodes.added[0].id, `step-package:${id}`);
        const result = await api('/workflow/apply', { id: add.id });
        assert.ok(result.graph.nodes.find(item => item.id === `step-package:${id}`).artifacts.includes(`${base}/${id}/__init__.py`));
        assert.deepEqual(calls[1], ['workflow', 'step', 'add', id, '--dev', source]);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { verify: {} } });
        f.put('.specify/workflows/verify/workflow.yml', { workflow: { id: 'verify' }, steps: [{ id: 'report', type: id }] });
        assert.ok(f.graph().edges.some(edge => edge.source === `step-package:${id}` && edge.target === 'workflow:verify:report'));
        await api('/workflow/preview', { operation: 'remove', id: `step-package:${id}` }, 400);
        assert.equal(calls.length, 2);
    });

    it('updates only the user-owned override after reviewing both versions', async t => {
        const f = fixture(t);
        const core = '.specify/templates/spec-template.md';
        const override = '.specify/templates/overrides/spec-template.md';
        f.put(core, '# Core template\n');
        const { api } = await serve(t, f.root);
        const query = new URLSearchParams({ id: `file:${core}`, path: override });
        assert.deepEqual(await api(`/workflow/config?${query}`), { path: override, text: '# Core template\n', newFile: true });
        const save = await api('/workflow/preview', { operation: 'template-save', id: `file:${core}`, text: '# Project template\n' });
        assert.deepEqual(save.documentChange, { path: override, before: null, after: '# Project template\n' });
        assert.ok(save.diff.nodes.added.some(item => item.id === `file:${override}`));
        assert.throws(() => readFileSync(join(f.root, override)), { code: 'ENOENT' });
        await api('/workflow/apply', { id: save.id });
        const remove = await api('/workflow/preview', { operation: 'template-remove', id: `file:${override}` });
        assert.equal(remove.documentChange.before, '# Project template\n');
        assert.ok(remove.diff.nodes.removed.some(item => item.id === `file:${override}`));
        await api('/workflow/apply', { id: remove.id });
        assert.throws(() => readFileSync(join(f.root, override)), { code: 'ENOENT' });
        assert.equal(readFileSync(join(f.root, core), 'utf8'), '# Core template\n');
    });

    it('links bundle dependencies and prevents unreviewed cascading removal', async t => {
        const f = fixture(t);
        f.install('git');
        const { api } = await serve(t, f.root);
        const component = { kind: 'extensions', id: 'git' };
        f.put('.specify/bundle-records.json', { schema_version: '1.0', bundles: [
            { bundle_id: 'workflow-tools', version: '1.0.0', contributed_components: [component], required_components: [component] },
        ] });
        const graph = f.graph();
        assert.ok(graph.edges.some(edge => edge.source === 'extension:git' && edge.target === 'bundle:workflow-tools'));
        await api('/workflow/preview', { operation: 'bundle-remove-record', id: 'bundle:workflow-tools' }, 400);
        assert.ok(f.graph().nodes.some(node => node.id === 'bundle:workflow-tools'));
    });

    it('removes only the reviewed bundle record without invoking Spec Kit', async t => {
        const f = fixture(t);
        f.install('git');
        const path = '.specify/bundle-records.json';
        const component = { id: 'git', kind: 'extensions', version: '1.0.0' };
        const record = bundle_id => ({ bundle_id, version: '1.0.0', contributed_components: [], required_components: [component] });
        const original = { schema_version: '1.0', bundles: [record('selected'), record('retained')] };
        f.put(path, original);
        const { api } = await serve(t, f.root, { workflowCli: () => assert.fail('Unexpected bundle CLI invocation') });
        const request = { operation: 'bundle-remove-record', id: 'bundle:selected' };
        const preview = await api('/workflow/preview', request);
        assert.equal(preview.documentChange.before, JSON.stringify(original));
        assert.deepEqual(JSON.parse(preview.documentChange.after).bundles, [record('retained')]);
        const edited = { ...original, bundles: [{ ...record('selected'), contributed_components: [component] }, record('retained')] };
        f.put(path, edited);
        await api('/workflow/apply', { id: preview.id }, 409);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), JSON.stringify(edited));
        f.put(path, original);
        const reviewed = await api('/workflow/preview', request);
        const applied = await api('/workflow/apply', { id: reviewed.id });
        assert.equal(readFileSync(join(f.root, path), 'utf8'), reviewed.documentChange.after);
        assert.ok(applied.graph.nodes.some(node => node.id === 'bundle:retained'));
        assert.ok(applied.graph.nodes.some(node => node.id === 'extension:git' && node.active));
    });

    it('transfers shared bundle ownership without removing packages and blocks nonmatching or nested references', async t => {
        const f = fixture(t);
        f.install('git');
        const path = '.specify/bundle-records.json';
        const component = { id: 'git', kind: 'extensions', version: '1.0.0' };
        const record = (bundle_id, contributed_components = []) => ({
            bundle_id, version: '1.0.0', installed_at: '2026-01-01T00:00:00Z',
            contributed_components, required_components: [component],
        });
        const source = record('source', [component]), first = record('first'), second = record('second');
        const registry = bundles => ({ schema_version: '1.0', bundles });
        const request = { operation: 'bundle-remove-record', id: 'bundle:source' };
        const { api } = await serve(t, f.root, { workflowCli: () => assert.fail('Unexpected live package operation') });
        f.put(path, registry([source, { ...first, required_components: [{ ...component, version: '2.0.0' }] }, second]));
        assert.equal(f.graph().nodes.find(node => node.id === request.id).canRemoveRecord, false);
        await api('/workflow/preview', request, 400);
        f.put(path, registry([source, { ...first, bundle_references: [{ id: 'source' }] }, second]));
        await api('/workflow/preview', request, 400);
        f.put(path, registry([source, first, second]));
        const preview = await api('/workflow/preview', request);
        assert.match(preview.notes.join(' '), /ownership transfers to first/);
        const expected = [{ ...first, contributed_components: [component] }, second];
        assert.deepEqual(JSON.parse(preview.documentChange.after).bundles, expected);
        if (process.env.SPECKIT_CANVAS_TEST_CLI === '1') {
            const staged = fixture(t);
            staged.put(path, registry([source, first, second]));
            await callSpecKit(staged.root, ['bundle', 'remove', 'source']);
            assert.deepEqual(JSON.parse(readFileSync(join(staged.root, path), 'utf8')).bundles, expected);
        }
        f.put(path, registry([source, second, first]));
        await api('/workflow/apply', { id: preview.id }, 409);
        f.put(path, registry([source, first, second]));
        const approved = await api('/workflow/preview', request);
        const { graph } = await api('/workflow/apply', { id: approved.id });
        assert.equal(readFileSync(join(f.root, path), 'utf8'), approved.documentChange.after);
        assert.ok(graph.nodes.some(node => node.id === 'extension:git' && node.active));
    });

    it('removes one disabled bundle-owned workflow only after reviewing the exact files', async t => {
        const f = fixture(t);
        const registryPath = '.specify/workflows/workflow-registry.json';
        const bundlePath = '.specify/bundle-records.json';
        const workflowPath = '.specify/workflows/lone-review/workflow.yml';
        const raw = JSON.stringify({ workflow: { id: 'lone-review', version: '1.0.0' },
            steps: [{ id: 'review', type: 'gate', message: 'Inspect the release.' }] });
        const component = { kind: 'workflows', id: 'lone-review', version: '1.0.0' };
        const record = { bundle_id: 'workflow-tools', version: '1.0.0', installed_at: '2026-01-01T00:00:00Z',
            contributed_components: [component], required_components: [component] };
        const other = { version: '1.0.0', enabled: false, source: 'local' };
        const registry = enabled => ({ schema_version: '1.0', workflows: { 'lone-review': { ...other, enabled }, unrelated: other } });
        f.put(workflowPath, raw);
        f.put(bundlePath, { schema_version: '1.0', bundles: [record] });
        f.put(registryPath, registry(true));
        const staged = [];
        const { api, url } = await serve(t, f.root, { workflowCli: async (root, args) => {
            assert.notEqual(root, f.root);
            assert.deepEqual(args, ['bundle', 'remove', 'workflow-tools']);
            assert.equal(readFileSync(join(root, workflowPath), 'utf8'), readFileSync(join(f.root, workflowPath), 'utf8'));
            staged.push(root);
            if (process.env.SPECKIT_CANVAS_TEST_CLI === '1') return callSpecKit(root, args);
            rmSync(join(root, dirname(workflowPath)), { recursive: true });
            writeFileSync(join(root, registryPath), JSON.stringify({ schema_version: '1.0', workflows: { unrelated: other } }));
            writeFileSync(join(root, bundlePath), JSON.stringify({ schema_version: '1.0', bundles: [] }));
            return 'Removed';
        } });
        const request = { operation: 'bundle-remove-workflow', id: 'bundle:workflow-tools' };
        await api('/workflow/preview', request, 400);
        f.put(registryPath, registry(false));
        assert.ok(f.graph().nodes.find(item => item.id === request.id).canRemoveBundleWorkflow);
        const overlayPath = '.specify/workflows/overlays/lone-review/project.yml';
        f.put(overlayPath, { id: 'project', extends: 'lone-review', edits: [] });
        await api('/workflow/preview', request, 400);
        rmSync(join(f.root, overlayPath));
        const savedRun = '.specify/workflows/runs/run-1/state.json';
        f.put(savedRun, { workflow_id: 'lone-review', status: 'paused' });
        await api('/workflow/preview', request, 400);
        rmSync(join(f.root, '.specify/workflows/runs/run-1'), { recursive: true });
        const preview = await api('/workflow/preview', request);
        assert.deepEqual(preview.documentChanges.map(doc => doc.path), [bundlePath, registryPath, workflowPath]);
        assert.equal(preview.documentChanges.at(-1).after, null);
        assert.equal(readFileSync(join(f.root, workflowPath), 'utf8'), raw);
        const companion = '.specify/workflows/lone-review/evidence.md';
        f.put(companion, 'Do not delete');
        await api('/workflow/apply', { id: preview.id }, 400);
        assert.equal(readFileSync(join(f.root, companion), 'utf8'), 'Do not delete');
        rmSync(join(f.root, companion));
        const stale = await api('/workflow/preview', request);
        f.put(workflowPath, `${raw}\n`);
        await api('/workflow/apply', { id: stale.id }, 409);
        assert.equal(readFileSync(join(f.root, workflowPath), 'utf8'), `${raw}\n`);
        f.put(workflowPath, raw);
        const approved = await api('/workflow/preview', request);
        const { graph } = await api('/workflow/apply', { id: approved.id });
        assert.equal(existsSync(join(f.root, workflowPath)), false);
        assert.ok(existsSync(join(f.root, dirname(workflowPath))));
        for (const doc of approved.documentChanges.slice(0, 2)) assert.equal(readFileSync(join(f.root, doc.path), 'utf8'), doc.after);
        assert.ok(!graph.nodes.some(item => item.id === request.id || item.id === 'workflow:lone-review'));
        assert.equal(staged.length, 5);
        await t.test('shows all three reviewed changes in the management dialog', async browserTest => {
            let browser;
            try {
                const { chromium } = await import('playwright-core');
                browser = await chromium.launch({ channel: 'chrome', headless: true });
            } catch {
                browserTest.skip('No system Chrome to drive');
                return;
            }
            browserTest.after(() => browser.close());
            f.put(workflowPath, raw);
            f.put(registryPath, registry(false));
            f.put(bundlePath, { schema_version: '1.0', bundles: [record] });
            const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
            await page.goto(url);
            await page.getByRole('button', { name: 'Spec Kit Management' }).click();
            await page.getByLabel('Filter by category').selectOption('Bundles');
            await page.getByRole('table', { name: 'Participants' }).getByRole('button', { name: 'Inspect workflow-tools', exact: true }).click();
            await page.getByRole('button', { name: 'Remove bundle and workflow…' }).click();
            const dialog = page.getByRole('dialog');
            for (const path of [bundlePath, registryPath, workflowPath]) await dialog.getByRole('heading', { name: path, exact: true }).waitFor();
            await dialog.getByText('Remove this file.', { exact: true }).waitFor();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            assert.equal(readFileSync(join(f.root, workflowPath), 'utf8'), raw);
        });
    });

    it('refuses to stage a bundle that would install or overwrite a package', async t => {
        const f = fixture(t);
        const source = 'bundles/workflow-tools/bundle.yml';
        const writeBundle = extensions => f.put(source, {
            bundle: { id: 'workflow-tools', version: '1.0.0' },
            provides: { extensions },
        });
        const { api } = await serve(t, f.root, { workflowCli: () => assert.fail('Unexpected bundle CLI invocation') });
        const request = { operation: 'bundle-install-record', source };
        writeBundle([{ id: 'preview', version: '1.0.0' }]);
        await api('/workflow/preview', request, 400);
        f.install('preview');
        writeBundle([{ id: 'preview', version: '2.0.0' }]);
        await api('/workflow/preview', request, 400);
        writeBundle([{ id: 'preview', version: '1.0.0', source: 'remote' }]);
        await api('/workflow/preview', request, 400);
    });

    it('reviews a pinned GitHub bundle before writing the exact record and retaining provenance', {
        skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 240_000,
    }, async t => {
        const f = fixture(t);
        f.install('reporter');
        const raw = JSON.stringify({
            schema_version: '1.0',
            bundle: { id: 'release-tools', name: 'Release tools', version: '1.0.0', role: 'test', description: 'Fixture', author: 'Tests', license: 'MIT' },
            requires: { speckit_version: '>=1.0.0' },
            provides: { extensions: [{ id: 'reporter', version: '1.0.0' }] },
        });
        const remoteUrl = `https://raw.githubusercontent.com/acme/fixtures/${'c'.repeat(40)}/bundle.yml`;
        const sha256 = createHash('sha256').update(raw).digest('hex');
        let body = raw, downloads = 0;
        const { api } = await serve(t, f.root, {
            now: () => Date.parse('2026-04-05T06:07:08Z'),
            workflowFetch: async (url, options) => {
                assert.equal(url, remoteUrl);
                assert.equal(options.redirect, 'error');
                assert.equal(options.credentials, 'omit');
                downloads++;
                return new Response(body);
            },
        });
        const request = { operation: 'bundle-install-record', remoteUrl, sha256 };
        await api('/workflow/preview', { ...request, remoteUrl: remoteUrl.replace('bundle.yml', 'workflow.yml') }, 400);
        assert.equal(downloads, 0);
        const record = '.specify/bundle-records.json';
        const preview = await api('/workflow/preview', request);
        assert.ok(preview.id, JSON.stringify(preview.findings));
        assert.equal(preview.documentChange.before, null);
        assert.equal(preview.packageDefinition.after, raw);
        assert.equal(existsSync(join(f.root, record)), false);
        const receipt = join(f.root, preview.packageDefinition.path);
        assert.equal(existsSync(receipt), false);
        body = `${raw}\n`;
        await api('/workflow/apply', { id: preview.id }, 409);
        assert.equal(existsSync(join(f.root, record)), false);
        assert.equal(existsSync(receipt), false);
        body = raw;
        const reviewed = await api('/workflow/preview', request);
        const applied = await api('/workflow/apply', { id: reviewed.id });
        assert.ok(applied.graph.edges.some(edge => edge.source === 'extension:reporter' && edge.target === 'bundle:release-tools'));
        assert.equal(readFileSync(join(f.root, record), 'utf8'), reviewed.documentChange.after);
        assert.equal(JSON.parse(reviewed.documentChange.after).bundles[0].installed_at, '2026-04-05T06:07:08Z');
        assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { id: 'release-tools', version: '1.0.0', url: remoteUrl, sha256, manifest: raw });
        assert.equal(downloads, 4);
    });

    it('reviews an exact catalog bundle release and rechecks listing and trust at confirmation', { timeout: 120_000 }, async t => {
        const f = fixture(t);
        f.install('reporter');
        const catalogPath = '.specify/bundle-catalogs.yml';
        const catalogId = 'catalog:bundle:bundles';
        const index = 'https://raw.githubusercontent.com/acme/fixtures/main/bundles.json';
        const url = `https://raw.githubusercontent.com/acme/fixtures/${'d'.repeat(40)}/bundle.yml`;
        const id = 'release-tools';
        const raw = JSON.stringify({ schema_version: '1.0', bundle: {
            id, name: 'Release tools', version: '1.0.0', role: 'test', description: 'Fixture', author: 'Tests', license: 'MIT',
        }, requires: { speckit_version: '>=1.0.0' }, provides: { extensions: [{ id: 'reporter', version: '1.0.0' }] } });
        const sha256 = createHash('sha256').update(raw).digest('hex');
        const configure = policy => f.put(catalogPath, { schema_version: '1.0', catalogs: [{ id: 'bundles', url: index, install_policy: policy }] });
        const record = '.specify/bundle-records.json';
        const release = { download_url: url, sha256 };
        let releases = { '1.0.0': release };
        let manifest = raw;
        const real = Boolean(process.env.SPECKIT_CANVAS_TEST_CLI);
        configure('discovery-only');
        const { api } = await serve(t, f.root, {
            workflowFetch: target => {
                if (target === index) return new Response(JSON.stringify({ schema_version: '1.0', bundles: {
                    [id]: { id, version: '2.0.0', download_url: 'https://github.com/acme/fixtures/releases/download/v2/bundle.zip', releases },
                } }));
                assert.equal(target, url);
                return new Response(manifest);
            },
            workflowCli: async (project, args) => {
                assert.notEqual(project, f.root);
                assert.deepEqual(args.slice(0, 2), ['bundle', 'install']);
                assert.ok(args.includes('--offline'));
                if (real) return callSpecKit(project, args);
                writeFileSync(join(project, record), JSON.stringify({ schema_version: '1.0', bundles: [{
                    bundle_id: id, version: '1.0.0', contributed_components: [],
                    required_components: [{ kind: 'extensions', id: 'reporter', version: '1.0.0' }],
                }] }));
                return 'Bundle record staged';
            },
        });
        const browse = await api('/workflow/catalog', { id: catalogId });
        assert.equal(browse.installAllowed, false);
        assert.deepEqual(browse.releases.map(item => [item.key, item.version, item.installed]), [[id, '1.0.0', null]]);
        const [{ selection }] = browse.releases;
        const request = { operation: 'bundle-install-record', key: id, catalogId, selection };
        await api('/workflow/preview', request, 409);
        configure('install-allowed');
        await api('/workflow/preview', { ...request, remoteUrl: url, sha256 }, 400);
        const approved = await api('/workflow/preview', request);
        assert.equal(approved.packageDefinition.catalog, index);
        assert.equal(approved.packageDefinition.after, raw);
        releases = {};
        await api('/workflow/apply', { id: approved.id }, 409);
        releases = { '1.0.0': release };
        const noLongerTrusted = await api('/workflow/preview', request);
        configure('discovery-only');
        await api('/workflow/apply', { id: noLongerTrusted.id }, 409);
        assert.equal(existsSync(join(f.root, record)), false);
        configure('install-allowed');
        manifest += '\n';
        await api('/workflow/preview', request, 409);
        manifest = raw;
        const reviewed = await api('/workflow/preview', request);
        await api('/workflow/apply', { id: reviewed.id });
        assert.equal(readFileSync(join(f.root, record), 'utf8'), reviewed.documentChange.after);
        const receipt = `.speckit-companion/workflow-sources/bundle-catalog-${selection}.json`;
        assert.ok(reviewed.paths.includes(receipt));
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, receipt), 'utf8')), { catalog: index, id, version: '1.0.0', url, sha256 });
        const installed = await api('/workflow/catalog', { id: catalogId });
        assert.deepEqual(installed.releases[0].installed, { id: `bundle:${id}`, version: '1.0.0' });
    });

    it('reviews only the manifest from an exact, pinned catalog ZIP', { skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 120_000 }, async t => {
        const f = fixture(t);
        f.install('reporter');
        const catalogId = 'catalog:bundle:bundles';
        const index = 'https://raw.githubusercontent.com/acme/fixtures/main/bundles.json';
        const url = 'https://github.com/acme/fixtures/releases/download/v1/bundle.zip';
        const asset = 'https://release-assets.githubusercontent.com/download/asset?signature=fixture';
        const id = 'release-tools';
        const raw = JSON.stringify({ schema_version: '1.0', bundle: {
            id, name: 'Release tools', version: '1.0.0', role: 'test', description: 'Fixture', author: 'Tests', license: 'MIT',
        }, requires: { speckit_version: '>=1.0.0' }, provides: { extensions: [{ id: 'reporter', version: '1.0.0' }] } });
        const digest = bytes => createHash('sha256').update(bytes).digest('hex');
        const zip = catalogZip('bundle.yml', raw, true);
        const record = '.specify/bundle-records.json';
        let payload = zip, pinned = digest(zip), location = asset;
        f.put('.specify/bundle-catalogs.yml', { schema_version: '1.0', catalogs: [
            { id: 'bundles', install_policy: 'install-allowed', url: index },
        ] });
        const { api } = await serve(t, f.root, {
            workflowFetch: (target, options) => {
                assert.equal(options.credentials, 'omit');
                if (target === index) return new Response(JSON.stringify({ bundles: {
                    [id]: { id, version: '1.0.0', download_url: url, sha256: pinned },
                } }));
                if (target === url) {
                    assert.equal(options.redirect, 'manual');
                    return new Response(null, { status: 302, headers: { location } });
                }
                assert.equal(target, asset);
                assert.equal(options.redirect, 'error');
                return new Response(payload);
            },
        });
        const selected = async () => ({ operation: 'bundle-install-record', key: id, catalogId,
            selection: (await api('/workflow/catalog', { id: catalogId })).releases[0].selection });
        const request = await selected();
        location = 'https://downloads.example.invalid/bundle.zip';
        await api('/workflow/preview', request, 502);
        location = asset;
        payload = catalogZip('folder/bundle.yml', raw);
        await api('/workflow/preview', request, 409);
        pinned = digest(payload);
        assert.match((await api('/workflow/preview', await selected(), 400)).error, /one regular bundle\.yml at its root/);
        payload = zip;
        pinned = digest(zip);
        const preview = await api('/workflow/preview', request);
        assert.equal(preview.packageDefinition.after, raw);
        assert.deepEqual([preview.packageDefinition.archiveEntry, preview.packageDefinition.sha256, preview.packageDefinition.manifestSha256],
            ['bundle.yml', pinned, digest(raw)]);
        assert.equal(existsSync(join(f.root, record)), false);
        await api('/workflow/apply', { id: preview.id });
        assert.equal(readFileSync(join(f.root, record), 'utf8'), preview.documentChange.after);
        assert.equal(existsSync(join(f.root, 'extra.txt')), false);
        const receipt = JSON.parse(readFileSync(join(f.root, preview.packageDefinition.path), 'utf8'));
        assert.deepEqual([receipt.archiveEntry, receipt.sha256, receipt.manifestSha256], ['bundle.yml', pinned, digest(raw)]);
    });

    it('registers the reviewed workflow from a standalone catalog ZIP but rejects companion files', {
        skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 120_000,
    }, async t => {
        const f = fixture(t);
        const { id, index, url, body, digest } = catalogFixture(f, true);
        const archive = url.replace('gate.yml', 'gate.zip');
        const zip = catalogZip('workflow.yml', body);
        const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
        let payload = catalogZip('workflow.yml', body, true);
        const { api } = await serve(t, f.root, {
            workflowFetch: target => {
                if (target === index) return new Response(JSON.stringify({ workflows: {
                    'release-review': { version: '1.0.0', url: archive, sha256: sha256(payload) },
                } }));
                assert.equal(target, archive);
                return new Response(payload);
            },
        });
        const request = async () => ({ operation: 'install', kind: 'Workflows', key: 'release-review', catalogId: id,
            selection: (await api('/workflow/catalog', { id })).releases[0].selection });
        assert.match((await api('/workflow/preview', await request(), 400)).error, /only a regular root workflow\.yml/);
        payload = zip;
        const change = await request();
        const preview = await api('/workflow/preview', change);
        assert.equal(preview.packageDefinition.after, body);
        assert.deepEqual([preview.packageDefinition.archiveEntry, preview.packageDefinition.sha256, preview.packageDefinition.manifestSha256],
            ['workflow.yml', sha256(zip), digest]);
        const { graph } = await api('/workflow/apply', { id: preview.id });
        const installed = '.specify/workflows/release-review/workflow.yml';
        assert.equal(readFileSync(join(f.root, installed), 'utf8'), body);
        const node = graph.nodes.find(item => item.id === 'workflow:release-review');
        assert.equal(node.origin, archive);
        const receipt = `.speckit-companion/workflow-sources/release-review-${digest}.yml.json`;
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, receipt), 'utf8')), {
            url: archive, sha256: digest, archiveEntry: 'workflow.yml', archiveSha256: sha256(zip),
        });
    });

    it('runs real local registration against Spec Kit when explicitly enabled', { skip: !process.env.SPECKIT_CANVAS_TEST_CLI }, async t => {
        const f = fixture(t);
        f.packageFiles('sources/preview', 'preview', { command: { description: 'Fixture command' }, manifest: { requires: { speckit_version: '>=1.0.0' }, extension: {
            id: 'preview', version: '1.0.0', name: 'Local preview', description: 'Canvas test fixture', author: 'Tests',
        } } });
        f.put('sources/report/step.yml', { step: { type_key: 'local-report', version: '1.0.0', name: 'Local report' } });
        f.put('sources/report/__init__.py', '# Registration fixture: no executable statements\n');
        const workflowSource = 'sources/verify';
        const workflowDefinition = version => ({ schema_version: '1.0', workflow: { id: 'local-verify', name: 'Local verify', version },
            steps: [{ id: 'review', type: 'gate', message: 'Review the report.' }] });
        f.put(`${workflowSource}/workflow.yml`, workflowDefinition('1.0.0'));
        const presetSource = 'sources/template-preset', preset = 'preset:local-templates';
        const presetManifest = version => ({
            schema_version: '1.0', preset: { id: 'local-templates', name: 'Local templates', version, description: 'Canvas fixture' },
            requires: { speckit_version: '>=1.0.0' },
            provides: { templates: [{ name: 'spec-template', type: 'template', file: 'templates/spec-template.md' }] },
        });
        f.put(`${presetSource}/preset.yml`, presetManifest('1.0.0'));
        f.put(`${presetSource}/templates/spec-template.md`, '# Local template');
        const { api } = await serve(t, f.root);
        const change = async request => {
            const preview = await api('/workflow/preview', request);
            assert.ok(preview.id, JSON.stringify(preview.findings));
            const result = await api('/workflow/apply', { id: preview.id });
            return result.graph;
        };
        const extension = 'extension:preview';
        const step = 'step-package:local-report';
        const workflow = 'workflow:local-verify';
        assert.ok((await change({ operation: 'install', kind: 'Presets', key: 'local-templates', source: presetSource })).nodes
            .find(node => node.id === preset).artifacts.some(path => path.endsWith('templates/spec-template.md')));
        assert.equal((await change({ operation: 'preset-priority', id: preset, priority: 20 })).nodes.find(node => node.id === preset).priority, 20);
        await change({ operation: 'disable', id: preset });
        f.put(`${presetSource}/preset.yml`, presetManifest('2.0.0'));
        const updatedPreset = (await change({ operation: 'update', id: preset, source: presetSource })).nodes.find(node => node.id === preset);
        assert.equal(updatedPreset.version, '2.0.0');
        assert.equal(updatedPreset.state, 'disabled');
        assert.equal(updatedPreset.priority, 20);
        assert.equal((await change({ operation: 'remove', id: preset })).nodes.some(node => node.id === preset), false);
        assert.equal((await change({ operation: 'install', id: extension, source: 'sources/preview' })).nodes.find(node => node.id === extension).state, 'enabled');
        assert.equal((await change({ operation: 'disable', id: extension })).nodes.find(node => node.id === extension).state, 'disabled');
        assert.equal((await change({ operation: 'enable', id: extension })).nodes.find(node => node.id === extension).state, 'enabled');
        const bundleSource = 'sources/local-bundle/bundle.yml';
        const bundleManifest = version => ({
            schema_version: '1.0',
            bundle: { id: 'local-bundle', name: 'Local bundle', version, role: 'test', description: 'Canvas fixture', author: 'Tests', license: 'MIT' },
            requires: { speckit_version: '>=1.0.0' },
            provides: { extensions: [{ id: 'preview', version: '1.0.0' }] },
        });

        f.put(bundleSource, bundleManifest('1.0.0'));
        const register = { operation: 'bundle-install-record', source: bundleSource };
        const staleBundle = await api('/workflow/preview', register);
        assert.ok(staleBundle.id);
        assert.throws(() => readFileSync(join(f.root, '.specify/bundle-records.json')), { code: 'ENOENT' });
        f.put(bundleSource, bundleManifest('1.1.0'));
        await api('/workflow/apply', { id: staleBundle.id }, 409);
        const bundle = 'bundle:local-bundle';
        assert.ok((await change(register)).edges.some(edge => edge.source === extension && edge.target === bundle));
        f.put(bundleSource, bundleManifest('2.0.0'));
        assert.equal((await change({ operation: 'bundle-update-record', id: bundle, source: bundleSource })).nodes.find(node => node.id === bundle).version, '2.0.0');
        const unbundled = await change({ operation: 'bundle-remove-record', id: bundle });
        assert.equal(unbundled.nodes.some(node => node.id === bundle), false);
        assert.equal(unbundled.nodes.find(node => node.id === extension).state, 'enabled');
        assert.equal((await change({ operation: 'remove', id: extension })).nodes.find(node => node.id === extension).state, 'proposed');
        assert.equal((await change({ operation: 'install', kind: 'Workflow steps', key: 'local-report', source: 'sources/report' })).nodes.find(node => node.id === step).state, 'enabled');
        assert.equal((await change({ operation: 'remove', id: step })).nodes.some(node => node.id === step), false);
        assert.equal((await change({ operation: 'install', kind: 'Workflows', key: 'local-verify', source: workflowSource })).nodes.find(node => node.id === workflow).state, 'enabled');
        assert.equal((await change({ operation: 'disable', id: workflow })).nodes.find(node => node.id === workflow).state, 'disabled');
        f.put(`${workflowSource}/workflow.yml`, workflowDefinition('2.0.0'));
        const updated = (await change({ operation: 'update', id: workflow, source: workflowSource })).nodes.find(node => node.id === workflow);
        assert.equal(updated.version, '2.0.0');
        assert.equal(updated.state, 'disabled');
        assert.equal((await change({ operation: 'remove', id: workflow })).nodes.some(node => node.id === workflow), false);
    });

    it('registers, restricts, and removes project catalogs using each runtime catalog schema', { skip: !process.env.SPECKIT_CANVAS_TEST_CLI }, async t => {
        const f = fixture(t);
        const { api } = await serve(t, f.root);
        for (const kind of ['extension', 'preset', 'workflow', 'step', 'bundle']) {
            const name = `canvas-${kind}`, id = `catalog:${kind}:${name}`;
            const url = `https://example.invalid/${name}.json`;
            const path = `.specify/${kind}-catalogs.yml`;
            const invoke = async request => {
                const preview = await api('/workflow/preview', request);
                assert.ok(preview.id, JSON.stringify(preview.findings));
                assert.deepEqual(preview.paths, [path]);
                return preview;
            };
            const listArgs = [...(kind === 'step' ? ['workflow', 'step'] : [kind]), 'catalog', 'list'];
            const added = await invoke({ operation: 'catalog-add', kind, name, url });
            assert.equal(added.documentChange.before, null);
            assert.equal(existsSync(join(f.root, path)), false);
            assert.equal((await api('/workflow/apply', { id: added.id })).graph.nodes.find(node => node.id === id).installAllowed, false);
            assert.ok((await callSpecKit(f.root, listArgs)).includes(url), `Spec Kit did not list ${url}`);
            await api('/workflow/preview', { operation: 'catalog-allow-install', id, url: `${url}.changed` }, 409);
            const allow = await invoke({ operation: 'catalog-allow-install', id, url });
            assert.equal((await api('/workflow')).nodes.find(node => node.id === id).installAllowed, false);
            assert.equal((await api('/workflow/apply', { id: allow.id })).graph.nodes.find(node => node.id === id).installAllowed, true);
            const restricted = await invoke({ operation: 'catalog-discovery', id });
            assert.equal(restricted.diff.nodes.changed.find(item => item.after.id === id).after.installAllowed, false);
            assert.equal((await api('/workflow/apply', { id: restricted.id })).graph.nodes.find(node => node.id === id).installAllowed, false);
            assert.doesNotMatch(await callSpecKit(f.root, listArgs), /canvas-.*install[- ]allowed/);
            const removed = await invoke({ operation: 'catalog-remove', id });
            assert.equal((await api('/workflow/apply', { id: removed.id })).graph.nodes.some(node => node.id === id), false);
            assert.ok(!(await callSpecKit(f.root, listArgs)).includes(url));
        }
    });

    it('requires confirmation to start and resume native gates without loading repository plugins', { skip: !process.env.SPECKIT_CANVAS_TEST_CLI }, async t => {
        const f = fixture(t);
        const storage = fixture(t).root;
        const id = 'workflow:release-review';
        const path = '.specify/workflows/release-review/workflow.yml';
        const definition = {
            schema_version: '1.0',
            workflow: { id: 'release-review', name: 'Release review', version: '1.0.0' },
            inputs: { evidence: { type: 'string', required: false }, release: { type: 'string', required: false } },
            steps: [
                { id: 'evidence', type: 'gate', message: 'Review the evidence.', verdict_input: 'evidence' },
                { id: 'release', type: 'gate', message: 'Review the release.', verdict_input: 'release', show_file: 'specs/001-exports/spec.md' },
            ],
        };
        const evidence = 'specs/001-exports/spec.md';
        f.put(evidence, '# Feature Specification: Export board\r\nReviewed release A.');
        f.put(path, definition);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { 'release-review': { enabled: true } } });
        f.put('.specify/workflows/steps/unsupported/step.yml', { step: { type_key: 'unsupported' } });
        const importMarker = join(f.root, 'step-imported');
        f.put('.specify/workflows/steps/unsupported/__init__.py',
            `from pathlib import Path\nPath(${JSON.stringify(importMarker)}).touch()\n`);
        let failedStage;
        const config = { workflowRunStorage: storage, send: () => assert.fail('Unexpected agent dispatch'),
            workflowCli: (root, args, probe, options) => {
                if (!probe && args[1] === 'resume') {
                    if (!failedStage) {
                        failedStage = root;
                        throw Object.assign(new Error('Simulated checkpoint contention'), { code: 'review-checkpoint-busy' });
                    }
                    assert.notEqual(root, failedStage);
                    assert.equal(existsSync(failedStage), false);
                }
                return callSpecKit(root, args, probe, options);
            } };
        const { api } = await serve(t, f.root, config);
        const start = await api('/workflow/preview', { operation: 'workflow-review-start', id });
        assert.ok(start.id);
        assert.equal((await api('/workflow')).nodes.find(node => node.id === id).isolatedRun, null);
        const result = await api('/workflow/apply', { id: start.id });
        const runId = result.workflowOutcome.id;
        assert.deepEqual(result.workflowOutcome, { status: 'paused', step: 'evidence', id: runId });
        const { api: reopened } = await serve(t, f.root, config);
        assert.equal((await reopened('/workflow')).nodes.find(node => node.id === id).isolatedRun.resumable, true);
        const request = { operation: 'workflow-review-resume', id, runId, gate: 'evidence', verdict: 'approve' };
        const decision = await reopened('/workflow/preview', request);
        assert.equal(decision.reviewChange.message, 'Review the evidence.');
        assert.equal(decision.reviewChange.verdict, 'approve');
        const advanced = await reopened('/workflow/apply', { id: decision.id });
        assert.deepEqual(advanced.workflowOutcome, { status: 'paused', step: 'release', id: runId });
        await reopened('/workflow/preview', request, 400);
        const reject = await reopened('/workflow/preview', { ...request, gate: 'release', verdict: 'reject' });
        assert.equal(reject.reviewChange.artifact.path, evidence);
        assert.equal(reject.reviewChange.artifact.text, '# Feature Specification: Export board\r\nReviewed release A.');
        assert.match(reject.reviewChange.artifact.digest, /^[0-9a-f]{64}$/);
        f.put(evidence, '# Feature Specification: Export board\r\nReviewed release B.');
        await reopened('/workflow/apply', { id: reject.id }, 409);
        const updated = await reopened('/workflow/preview', { ...request, gate: 'release', verdict: 'reject' });
        assert.notEqual(updated.reviewChange.artifact.digest, reject.reviewChange.artifact.digest);
        const ended = await reopened('/workflow/apply', { id: updated.id });
        assert.equal(ended.workflowOutcome.id, runId);
        assert.equal(ended.workflowOutcome.status, 'aborted');
        assert.equal(existsSync(importMarker), false);
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
        await reopened('/workflow/preview', request, 400);
        f.put(path, { ...definition, steps: [...definition.steps, { id: 'extra', type: 'prompt', prompt: 'Not a gate' }] });
        assert.equal((await reopened('/workflow')).nodes.find(node => node.id === id).canRunReview, false);
        await reopened('/workflow/preview', { operation: 'workflow-review-start', id }, 400);
    });

    it('previews verdict-dependent review gates and resumes the chosen branch with released Spec Kit', {
        skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 90_000,
    }, async t => {
        const f = fixture(t);
        const storage = fixture(t).root;
        const id = 'workflow:branched-review';
        const path = '.specify/workflows/branched-review/workflow.yml';
        const gate = (id, on_reject = 'abort') => ({ id, type: 'gate', message: `Review ${id}.`, verdict_input: id, on_reject });
        const branch = { id: 'classify', type: 'if', condition: "{{ inputs.intake == 'approve' }}",
            then: [{ id: 'confirm-ready', type: 'if', condition: true, then: [gate('ready')] }], else: [gate('rework')] };
        const definition = {
            workflow: { id: 'branched-review', name: 'Branched review', version: '1.0.0' },
            inputs: Object.fromEntries(['intake', 'ready', 'rework', 'final'].map(name => [name, { type: 'string', required: false }])),
            steps: [gate('intake', 'skip'), branch, gate('final')],
        };
        f.put('.specify/workflows/workflow-registry.json', { workflows: { 'branched-review': { enabled: true } } });
        f.put(path, definition);
        const config = { workflowRunStorage: storage, send: () => assert.fail('Unexpected agent dispatch'),
            workflowCli: (root, args, probe, options) => {
                if (!probe) {
                    assert.notEqual(root, f.root);
                    assert.equal(existsSync(join(root, '.specify/workflows/steps')), false);
                }
                return callSpecKit(root, args, probe, options);
            } };
        f.put('.specify/workflows/steps/unused/step.yml', { step: { type_key: 'unused' } });
        let { api } = await serve(t, f.root, config);
        async function preview(params) { return api('/workflow/preview', { id, ...params }); }
        async function confirm(proposal) { return (await api('/workflow/apply', { id: proposal.id })).workflowOutcome; }
        for (const [verdict, expectedStep] of [['approve', 'ready'], ['reject', 'rework']]) {
            const start = await preview({ operation: 'workflow-review-start' });
            assert.equal(start.reviewChange.nextGate, 'intake');
            const initial = await confirm(start);
            assert.equal(initial.step, 'intake');
            const resume = (gate, verdict) => preview({ operation: 'workflow-review-resume', runId: initial.id, gate, verdict });
            const choice = await resume('intake', verdict);
            assert.equal(choice.reviewChange.nextGate, expectedStep);
            assert.equal((await confirm(choice)).step, expectedStep);
            ({ api } = await serve(t, f.root, config));
            const node = (await api('/workflow')).nodes.find(node => node.id === id);
            assert.equal(node.isolatedRun.step, expectedStep);
            assert.equal(node.isolatedRun.resumable, true);
            assert.equal((await confirm(await resume(expectedStep, 'approve'))).step, 'final');
            assert.equal((await confirm(await resume('final', 'approve'))).status, 'completed');
        }
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
        await api('/workflow/preview', { operation: 'workflow-review-configure', id, gate: 'ready' }, 400);
        for (const unsafeBranch of [
            { ...branch, else: [{ id: 'unreviewed', type: 'prompt', prompt: 'Not a gate' }] },
            { ...branch, condition: "{{ inputs.final == 'approve' }}" },
            { ...branch, condition: "{{ inputs.intake == 'approve' or true }}" },
            { ...branch, else: [gate('ready')] },
        ]) {
            f.put(path, { ...definition, steps: [definition.steps[0], unsafeBranch, definition.steps[2]] });
            assert.equal((await api('/workflow')).nodes.find(node => node.id === id).canRunReview, false);
            await api('/workflow/preview', { id, operation: 'workflow-review-start' }, 400);
        }
    });

    it('installs only reviewed disabled core workflows from offline bundles', {
        skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 90_000,
    }, async t => {
        const f = fixture(t);
        const source = 'bundles/assess/bundle.yml';
        const definition = '.specify/workflows/assess/workflow.yml';
        const registry = '.specify/workflows/workflow-registry.json';
        const records = '.specify/bundle-records.json';
        const other = { version: '2.0.0', enabled: false };
        const baseline = { schema_version: '1.0', workflows: { other } };
        f.put(registry, baseline);
        f.put('.specify/workflows/other/workflow.yml', { workflow: { id: 'other', version: '2.0.0' },
            steps: [{ id: 'review', type: 'gate', message: 'A separate workflow.' }] });
        const manifest = { schema_version: '1.0',
            bundle: { id: 'assess-review', name: 'Assessment review', version: '1.0.0', role: 'workflow',
                description: 'One offline workflow', author: 'Fixture', license: 'MIT' },
            requires: { speckit_version: '>=1.4.1' }, provides: { workflows: [{ id: 'assess', version: '1.0.0' }] } };
        f.put(source, manifest);
        const { api } = await serve(t, f.root);
        const request = { operation: 'bundle-install-core-workflow', source };
        const preview = await api('/workflow/preview', request);
        assert.ok(preview.id, JSON.stringify(preview.findings));
        assert.deepEqual(new Set(preview.paths), new Set([definition, registry, records]));
        assert.equal(preview.diff.nodes.added.find(node => node.id === 'workflow:assess').state, 'disabled');
        assert.equal(existsSync(join(f.root, definition)), false);
        assert.equal(existsSync(join(f.root, records)), false);
        f.put(source, { ...manifest, bundle: { ...manifest.bundle, description: 'Updated bundle' } });
        await api('/workflow/apply', { id: preview.id }, 409);
        assert.equal(existsSync(join(f.root, definition)), false);
        const reviewed = await api('/workflow/preview', request);
        const result = await api('/workflow/apply', { id: reviewed.id });
        const node = result.graph.nodes.find(node => node.id === 'workflow:assess');
        assert.equal(node.state, 'disabled');
        assert.equal(node.origin, 'specify-core:1.4.1/assess');
        const read = path => readFileSync(join(f.root, path), 'utf8');
        for (const change of reviewed.documentChanges) assert.equal(read(change.path), change.after);
        assert.deepEqual(JSON.parse(read(registry)).workflows.other, other);
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
        await api('/workflow/preview', request, 400);
        f.put(source, { ...manifest, provides: { workflows: [{ id: 'bugfix', version: '1.0.1', source: './workflow.yml' }] } });
        await api('/workflow/preview', request, 400);
        const refs = [{ id: 'speckit', version: '1.0.2' }, { id: 'bugfix', version: '1.0.1' }];
        const setWorkflows = workflows => f.put(source, { ...manifest, bundle: { ...manifest.bundle, id: 'delivery-core' }, provides: { workflows } });
        setWorkflows([refs[0], refs[0]]);
        await api('/workflow/preview', request, 400);
        setWorkflows([...refs, manifest.provides.workflows[0]]);
        await api('/workflow/preview', request, 400);
        setWorkflows(refs);
        const prepared = await api('/workflow/preview', request);
        const paths = refs.map(ref => `.specify/workflows/${ref.id}/workflow.yml`);
        assert.ok(prepared.id, JSON.stringify(prepared.findings));
        assert.deepEqual(new Set(prepared.paths), new Set([...paths, registry, records]));
        assert.ok(paths.every(path => !existsSync(join(f.root, path))));
        f.put(paths[1], '# Another user created this workflow');
        await api('/workflow/apply', { id: prepared.id }, 409);
        assert.equal(read(paths[1]), '# Another user created this workflow');
        assert.equal(existsSync(join(f.root, paths[0])), false);
        assert.deepEqual(Object.keys(JSON.parse(read(registry)).workflows), ['other', 'assess']);
        rmSync(join(f.root, dirname(paths[1])), { recursive: true });
        const batch = await api('/workflow/preview', request);
        const applied = await api('/workflow/apply', { id: batch.id });
        for (const ref of refs) {
            const installed = applied.graph.nodes.find(node => node.id === `workflow:${ref.id}`);
            assert.equal(installed.state, 'disabled');
            assert.equal(installed.origin, `specify-core:1.4.1/${ref.id}`);
        }
        for (const change of batch.documentChanges) assert.equal(read(change.path), change.after);
        assert.deepEqual(JSON.parse(read(records)).bundles.at(-1).contributed_components,
            refs.map(ref => ({ kind: 'workflows', ...ref })));
    });

    it('binds declared routing choices to the exact isolated checkpoint with released Spec Kit', {
        skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 90_000,
    }, async t => {
        const { f, id, path, definition, evidence } = routingFixture(t);
        const storage = fixture(t).root;
        const executions = [];
        const options = { workflowRunStorage: storage, send: () => assert.fail('Unexpected agent dispatch'),
            workflowCli: (root, args, probe, flags) => {
                if (!probe) {
                    assert.notEqual(root, f.root);
                    executions.push(args);
                }
                return callSpecKit(root, args, probe, flags);
            } };
        let { api } = await serve(t, f.root, options);
        const start = (inputs, status) => api('/workflow/preview', { operation: 'workflow-review-start', id, inputs }, status);
        const confirm = (proposal, status) => api('/workflow/apply', { id: proposal.id }, status);
        for (const invalid of [{}, { track: 'unlisted' }, { track: 'standard', standard_verdict: 'approve' }]) await start(invalid, 400);
        const stale = await start({ track: 'extended' });
        assert.equal(stale.reviewChange.nextGate, 'extended');
        assert.deepEqual(stale.reviewChange.startInputs, [{ name: 'track', value: 'extended' }, { name: 'detail', value: 'brief' }]);
        assert.equal(stale.reviewChange.artifact.path, evidence);
        f.put(path, { ...definition, inputs: { ...definition.inputs, detail: { ...definition.inputs.detail, default: 'full' } } });
        await confirm(stale, 409);
        assert.deepEqual(executions, []);
        f.put(path, definition);
        for (const [track, verdict, detail, next] of [['extended', 'approve', 'full', 'final'], ['standard', 'reject', 'brief', null]]) {
            const proposal = await start({ track, detail });
            const { workflowOutcome: result } = await confirm(proposal);
            assert.equal(result.step, track);
            const savedInputs = [{ name: 'track', value: track }, { name: 'detail', value: detail }];
            ({ api } = await serve(t, f.root, options));
            const node = (await api('/workflow')).nodes.find(node => node.id === id);
            assert.deepEqual(node.isolatedRun.startInputs, savedInputs);
            assert.equal(node.isolatedRun.resumable, true);
            const resume = { operation: 'workflow-review-resume', id, runId: result.id, gate: track, verdict };
            await api('/workflow/preview', { ...resume, inputs: { track: 'standard' } }, 400);
            const decision = await api('/workflow/preview', resume);
            assert.deepEqual(decision.reviewChange.startInputs, savedInputs);
            assert.equal(decision.reviewChange.nextGate, next);
            const { workflowOutcome: resumed } = await confirm(decision);
            assert.equal(resumed.id, result.id);
            assert.equal(resumed.status, next ? 'paused' : 'aborted');
            f.put(evidence, '# Feature Specification: Export board\n\nThis copy changed after review.');
            const recorded = (await api('/workflow')).nodes.find(node => node.id === id).isolatedRun.decisions;
            assert.deepEqual(recorded.map(({ step, verdict, evidence }) => ({ step, verdict, evidence })), [
                { step: track, verdict, evidence: { path: evidence, digest: decision.reviewChange.artifact.digest } },
            ]);
            if (next) {
                const final = await api('/workflow/preview', { ...resume, gate: next });
                assert.equal((await confirm(final)).workflowOutcome.status, 'completed');
            }
        }
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
        f.put(path, { ...definition, inputs: { ...definition.inputs, track: { type: 'string', required: true } } });
        assert.equal((await api('/workflow')).nodes.find(node => node.id === id).canRunReview, false);
    });

    it('reorders and removes hooks from the active Companion recipe without touching another anchor or generated files', { skip: !process.env.SPECKIT_CANVAS_TEST_CLI }, async t => {
        const f = fixture(t);
        const recipe = '.specify/companion/workflows/review.yml';
        const source = [
            '# Project review recipe', 'commands:', '  specify:', '    hooks:', '      before:',
            '        handoff:', '          - { type: prompt, text: "Keep me" }',
            '  plan:', '    hooks:', '      before:', '        handoff:',
            '          - { type: prompt, text: "First" }', '          - { type: prompt, text: "Second" }', '',
        ].join('\r\n');
        const selection = 'workflow: review\r\n';
        f.install('companion');
        f.put('.specify/companion.yml', selection);
        f.put(recipe, source);
        f.put('.github/prompts/speckit.plan.prompt.md', '# Generated agent command');
        const { api } = await serve(t, f.root);
        const id = 'embedded:plan:before:handoff:0';
        const preview = await api('/workflow/preview', { operation: 'embedded-down', id });
        assert.ok(preview.id);
        assert.equal(preview.documentChange.before, source);
        assert.match(preview.documentChange.after, /Second" }\r\n +-\s+\{ type: prompt, text: "First"/);
        assert.equal(readFileSync(join(f.root, recipe), 'utf8'), source);
        await api('/workflow/apply', { id: preview.id });
        const writer = operation => api('/workflow/preview', { operation, id });
        const removal = await writer('embedded-remove');
        assert.ok(removal.id);
        await api('/workflow/apply', { id: removal.id });
        const last = await writer('embedded-remove');
        assert.ok(last.id);
        await api('/workflow/apply', { id: last.id });
        const text = readFileSync(join(f.root, recipe), 'utf8');
        assert.match(text, /^# Project review recipe\r\n/);
        assert.match(text, /Keep me/);
        assert.doesNotMatch(text, /First|Second/);
        assert.equal(readFileSync(join(f.root, '.specify/companion.yml'), 'utf8'), selection);
        assert.equal(readFileSync(join(f.root, '.github/prompts/speckit.plan.prompt.md'), 'utf8'), '# Generated agent command');
    });

    it('previews gate configuration edits and refuses runtime expressions or edits to a paused run', async t => {
        const f = fixture(t);
        const id = 'workflow:review';
        const path = '.specify/workflows/review/workflow.yml';
        f.put('.specify/workflows/workflow-registry.json', { workflows: { review: { enabled: true } } });
        const original = {
            workflow: { id: 'review', name: 'Release review', version: '1.0.0' },
            inputs: { verdict: { type: 'string', required: false } },
            steps: [{ id: 'review', type: 'gate', message: 'Inspect the release evidence.', verdict_input: 'verdict' }],
        };
        f.put(path, original);
        const overlay = '.specify/workflows/overlays/review/canvas-review-gates.yml';
        const workflowCli = process.env.SPECKIT_CANVAS_TEST_CLI ? callSpecKit : async (stage, args) => {
            assert.notEqual(stage, f.root);
            assert.deepEqual(args, ['workflow', 'resolve', 'review']);
            assert.match(readFileSync(join(stage, overlay), 'utf8'), /Confirm the signed release notes/);
            return 'review: project:canvas-review-gates';
        };
        const { api } = await serve(t, f.root, { workflowCli, workflowRunStorage: fixture(t).root });
        const request = { operation: 'workflow-review-configure', id, gate: 'review', message: 'Confirm the signed release notes.', rejection: 'skip' };
        await api('/workflow/preview', { ...request, message: '{{ inputs.verdict }}' }, 400);
        f.put('privileged.md', '# Not an inventoried feature document');
        await api('/workflow/preview', { ...request, artifact: 'privileged.md' }, 400);
        await api('/workflow/preview', { ...request, artifact: '../outside.md' }, 400);
        const planned = await api('/workflow/preview', request);
        assert.ok(planned.id);
        assert.equal(planned.documentChange.path, overlay);
        assert.equal(planned.documentChange.before, null);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), JSON.stringify(original));
        const result = await api('/workflow/apply', { id: planned.id });
        const node = result.graph.nodes.find(node => node.id === id);
        const gate = node.reviewGates[0];
        assert.deepEqual([gate.message, gate.rejection, gate.input], [request.message, 'skip', 'verdict']);
        assert.equal(node.canRunReview, true);
        assert.equal(result.graph.nodes.find(item => item.id === `${id}:review`).source, overlay);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), JSON.stringify(original));
        const overlayId = 'overlay:review:canvas-review-gates.yml';
        const disable = await api('/workflow/preview', { operation: 'overlay-disable', id: overlayId });
        const disabled = await api('/workflow/apply', { id: disable.id });
        assert.equal(disabled.graph.nodes.find(item => item.id === id).reviewGates[0].message, original.steps[0].message);
        assert.equal(disabled.graph.nodes.find(item => item.id === overlayId).canEnableOverlay, true);
        const restore = await api('/workflow/preview', { operation: 'overlay-enable', id: overlayId });
        assert.match(restore.documentChange.before, /enabled: false/);
        assert.match(restore.documentChange.after, /enabled: true/);
        const restored = await api('/workflow/apply', { id: restore.id });
        assert.equal(restored.graph.nodes.find(item => item.id === id).reviewGates[0].message, request.message);
        assert.equal(readFileSync(join(f.root, path), 'utf8'), JSON.stringify(original));
        f.put('.specify/workflows/runs/native-run/state.json', { run_id: 'native-run', workflow_id: 'review',
            status: 'paused', updated_at: '2026-01-02T00:00:00Z' });
        await api('/workflow/preview', { ...request, rejection: 'abort' }, 409);
    });

    it('blocks only the canvas commands that can trigger the unverified Companion hook', async t => {
        const f = fixture(t);
        f.install('companion');
        f.put('.specify/companion.yml', { commands: { plan: { hooks: { before: { handoff: [{ type: 'prompt', text: 'Review outputs' }] } } } } });
        for (const id of ['001-exports', '002-stock']) f.put(`specs/${id}/spec.md`, '# Feature Specification: Export board');
        f.put('specs/002-stock/.spec-context.json', { workflow: 'speckit', specName: 'Stock', currentStep: 'specify', status: 'specified', history: [] });
        const { api } = await serve(t, f.root);
        const result = await api('/workflow');
        assert.equal(result.edges.find(edge => edge.id === 'embedded:plan:before:handoff:0').status, 'blocked');
        const plan = { operation: 'run', id: 'stage:plan', command: 'plan' };
        const blocked = await api('/workflow/preview', { ...plan, feature: 'specs/001-exports' }, 400);
        assert.match(JSON.stringify(blocked), /unverified effects/);
        assert.ok((await api('/workflow/preview', { ...plan, feature: 'specs/002-stock' })).id);
        assert.ok((await api('/workflow/preview', { ...plan, id: 'stage:tasks', command: 'tasks', feature: 'specs/001-exports' })).id);
    });

    it('does not silently run a base definition when a project overlay declares other effects', async t => {
        const f = fixture(t);
        const id = 'workflow:review';
        const path = '.specify/workflows/overlays/review/publish.yml';
        f.put('.specify/workflows/workflow-registry.json', { workflows: { review: { enabled: true } } });
        f.put('.specify/workflows/review/workflow.yml', {
            workflow: { id: 'review', name: 'Release review', version: '1.0.0' },
            inputs: { verdict: { type: 'string', required: false } },
            steps: [{ id: 'review', type: 'gate', message: 'Inspect the release evidence.', verdict_input: 'verdict' }],
        });
        const overlay = { id: 'publish', extends: 'review', edits: [{
            insert_after: 'review',
            step: { id: 'after-review', type: 'if', condition: 'true', then: [{ id: 'label', type: 'github' }] },
        }] };
        f.put(path, overlay);
        const { api } = await serve(t, f.root, { workflowRunStorage: fixture(t).root, workflowCli: async (_root, _args, probe) => {
            assert.equal(probe, true, 'Do not execute the workflow or its overlay');
            return '--json --input';
        } });
        const graph = await api('/workflow');
        const edge = graph.edges.find(item => item.kind === 'overlay' && item.target === id);
        assert.deepEqual([edge.path, edge.effect, edge.status], [path, 'external-write', 'blocked']);
        assert.equal(graph.nodes.find(node => node.id === id).canRunReview, false);
        const start = { operation: 'workflow-review-start', id };
        await api('/workflow/preview', start, 400);
        const overlayNode = { id: edge.source };
        const disable = await api('/workflow/preview', { operation: 'overlay-disable', ...overlayNode });
        assert.equal(disable.documentChange.before, JSON.stringify(overlay));
        assert.equal(readFileSync(join(f.root, path), 'utf8'), JSON.stringify(overlay));
        assert.equal((await api('/workflow/apply', { id: disable.id })).graph.nodes.find(item => item.id === id).canRunReview, true);
        const preview = await api('/workflow/preview', start);
        assert.ok(preview.id);
        f.put(path, overlay);
        await api('/workflow/apply', { id: preview.id }, 400);
        const remove = await api('/workflow/preview', { operation: 'overlay-remove', ...overlayNode });
        assert.equal(remove.documentChange.after, null);
        assert.ok(remove.diff.nodes.removed.some(item => item.id === edge.source));
        assert.equal((await api('/workflow/apply', { id: remove.id })).graph.nodes.find(item => item.id === id).canRunReview, true);
        assert.equal(existsSync(join(f.root, path)), false);
        for (let index = 0; index < 33; index++) f.put(`.specify/workflows/overlays/review/overlay-${index}.yml`, { ...overlay, enabled: false });
        const incomplete = await api('/workflow');
        assert.ok(incomplete.findings.some(item => item.code === 'unreadable-overlay-directory' && item.nodeIds.includes(id)));
        assert.equal(incomplete.nodes.find(item => item.id === id).canRunReview, false);
        await api('/workflow/composition', { id }, 400);
    });

    it('inspects actual Spec Kit step attribution without importing project packages', { skip: !process.env.SPECKIT_CANVAS_TEST_CLI }, async t => {
        const f = fixture(t);
        const source = '.specify/workflows/publish/workflow.yml';
        const overlay = '.specify/workflows/overlays/publish/preview.yml';
        f.put('.specify/workflows/workflow-registry.json', { workflows: { publish: { enabled: true } } });
        f.put(source, {
            schema_version: '1.0', workflow: { id: 'publish', name: 'Release', version: '1.0.0' },
            steps: [{ id: 'first', type: 'gate', message: 'Review first' }, { id: 'last', type: 'gate', message: 'Review last' }],
        });
        f.put(overlay, { id: 'preview', extends: 'publish', edits: [{
            insert_before: 'last', step: { id: 'middle', type: 'gate', message: 'Review the preview' },
        }] });
        const cli = async (staged, args, probe) => {
            assert.notEqual(staged, f.root);
            assert.equal(existsSync(join(staged, '.specify/workflows/functions')), false);
            assert.equal(existsSync(join(staged, '.specify/workflows/steps')), false);
            return callSpecKit(staged, args, probe);
        };
        f.put('.specify/workflows/steps/local/step.yml', { step: { type_key: 'local' } });
        f.put('.specify/workflows/steps/local/__init__.py', '# Not part of composition');
        const { api } = await serve(t, f.root, { workflowCli: cli });
        const result = await api('/workflow/composition', { id: 'workflow:publish' });
        assert.deepEqual(result.sources, [source, overlay]);
        assert.match(result.text, /first:[^\n]*\n[^\n]*middle: project:preview[^\n]*\n[^\n]*last:/);
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
    });

    it('does not invoke workflow registration after local code appears after preview', async t => {
        const f = fixture(t);
        const source = 'sources/review';
        f.put(`${source}/workflow.yml`, {
            workflow: { id: 'review', name: 'Release review', version: '1.0.0' },
            steps: [{ id: 'review', type: 'gate', message: 'Inspect the release evidence.' }],
        });
        const { api } = await serve(t, f.root, { workflowCli: async (_root, _args, probe) => {
            assert.equal(probe, true, 'Do not invoke a CLI operation that may load local code');
            return '--dev';
        } });
        const request = { operation: 'install', kind: 'Workflows', key: 'review', source };
        const approved = await api('/workflow/preview', request);
        assert.ok(approved.id);
        f.put('.specify/workflows/functions/local/function.yml', { id: 'local' });
        f.put('.specify/workflows/functions/local/__init__.py', '# Local functions');
        const refusal = await api('/workflow/apply', { id: approved.id }, 400);
        assert.match(refusal.error, /can import local functions/);
        await api('/workflow/preview', request, 400);
    });

    it('keeps the existing agent transport and previews feature outputs without dispatching', async t => {
        const f = fixture(t);
        f.put('specs/001-exports/spec.md', '# Feature Specification: Export board');
        const sent = [];
        const { api } = await serve(t, f.root, { send: async prompt => { sent.push(prompt); return true; }, checkoutWriter: null });
        const preview = await api('/workflow/preview', { operation: 'run', id: 'stage:plan', command: 'plan', feature: 'specs/001-exports',
            artifact: 'specs/001-exports/spec.md' });
        assert.ok(preview.id);
        assert.equal(sent.length, 0);
        assert.equal(preview.invocation, '/speckit.plan specs/001-exports');
        assert.ok(preview.paths.includes('specs/001-exports/plan.md'));
        await api('/workflow/apply', { id: preview.id });
        assert.equal(sent[0], `${preview.invocation}\n\nSelected input artifact: specs/001-exports/spec.md`);
        await api('/run', { spec: 'specs/001-exports', command: 'tasks' });
        assert.equal(sent[1], '/speckit.tasks specs/001-exports');
    });

    it('requires Preview inputs and prepares a fidelity-first dispatch for the chosen feature', async t => {
        const f = fixture(t);
        const feature = 'specs/001-exports';
        const output = `${feature}/preview/wireflow.html`;
        f.put(`${feature}/spec.md`, '# Export');
        f.put('specs/002-other/spec.md', '# Not the selected feature');
        f.install('preview', { manifest: { extension: { version: '1.3.0' } }, command: { name: 'speckit.preview' } });
        f.registry.preview.version = '1.3.0';
        f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
        f.put('.specify/extensions/preview/templates/preview/wireflow.html', '<main></main>');
        const sent = [];
        const { api } = await serve(t, f.root, { send: async prompt => { sent.push(prompt); return true; }, checkoutWriter: null });
        const request = { operation: 'run', id: 'extension:preview', command: 'speckit.preview',
            feature, fidelity: 'high', intent: 'Focus on empty states.' };
        assert.match((await api('/workflow/preview', request, 400)).error, /requires .*uc\.md/);
        f.put(`${feature}/uc.md`, '# Export use case');
        await api('/workflow/preview', { ...request, fidelity: 'unsupported' }, 400);
        const proposal = await api('/workflow/preview', request);
        assert.equal(proposal.invocation, '/speckit.preview high Focus on empty states.');
        assert.deepEqual(proposal.paths, [output]);
        assert.ok(proposal.readPaths.includes(`${feature}/uc.md`));
        assert.deepEqual(sent, []);
        await api('/workflow/apply', { id: proposal.id });
        assert.equal(sent.length, 1);
        assert.match(sent[0], /set SPECIFY_FEATURE to "001-exports"/);
        assert.equal(existsSync(join(f.root, output)), false);
    });
});

describe('workflow in the browser', () => {
    it('previews every core bundle file before installing disabled workflows in Management', {
        skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 60_000,
    }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        const source = 'bundles/assess/bundle.yml';
        const refs = [{ id: 'assess', version: '1.0.0' }, { id: 'bugfix', version: '1.0.1' }];
        f.put(source, { schema_version: '1.0',
            bundle: { id: 'assessment', name: 'Assessment', version: '1.0.0', role: 'workflow',
                description: 'Offline workflows', author: 'Fixture', license: 'MIT' },
            requires: { speckit_version: '>=1.4.1' }, provides: { workflows: refs } });
        const { url, api } = await serve(t, f.root);
        const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
        page.setDefaultTimeout(10_000);
        await page.goto(url);
        await page.getByRole('button', { name: 'Spec Kit Management' }).click();
        await page.getByLabel('Filter by category').selectOption('Bundles');
        await page.getByRole('button', { name: 'Install core workflow bundle…' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Path to bundle.yml').fill(source);
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Install assessment 1.0.0 with assess, bugfix disabled' }).waitFor();
        for (const { id } of refs) {
            const definition = `.specify/workflows/${id}/workflow.yml`;
            await dialog.getByRole('heading', { name: definition, exact: true }).waitFor();
            assert.equal(existsSync(join(f.root, definition)), false);
        }
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByRole('table', { name: 'Participants' }).getByRole('button', { name: 'Inspect assessment', exact: true }).waitFor();
        const graph = await api('/workflow');
        for (const { id } of refs) assert.equal(graph.nodes.find(node => node.id === `workflow:${id}`).state, 'disabled');
    });

    it('collects isolated workflow inputs from Workflow & runs and records them on reload', {
        skip: !process.env.SPECKIT_CANVAS_TEST_CLI, timeout: 60_000,
    }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const { f } = routingFixture(t);
        const { url } = await serve(t, f.root, { workflowRunStorage: fixture(t).root });
        const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
        page.setDefaultTimeout(10_000);
        await page.goto(url);
        await page.getByRole('button', { name: 'Workflow & runs', exact: true }).click();
        await page.getByRole('button', { name: 'Start isolated review…' }).click();
        const dialog = page.getByRole('dialog');
        const track = dialog.getByLabel('track', { exact: true });
        assert.equal(await track.inputValue(), '');
        assert.equal(await dialog.getByLabel('detail', { exact: true }).inputValue(), 'brief');
        await track.selectOption('extended');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Run inputs', exact: true }).waitFor();
        await dialog.getByText('Pause at extended', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByText('Isolated review run: paused.', { exact: true }).waitFor();
        await page.reload();
        const runs = page.getByRole('button', { name: 'Workflow & runs', exact: true });
        if (await runs.getAttribute('aria-pressed') !== 'true') await runs.click();
        await page.getByLabel('Run record', { exact: true }).selectOption('isolated');
        await page.getByRole('heading', { name: 'Recorded start inputs' }).waitFor();
        assert.match(await page.getByRole('heading', { name: 'Recorded start inputs' }).locator('..').innerText(), /track\s+extended\s+detail\s+brief/);
        await page.getByRole('button', { name: 'Review verdict…' }).click();
        await dialog.getByLabel('Verdict').selectOption('approve');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText('Complete the run', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByText('Isolated review run: completed.', { exact: true }).waitFor();
        const decisions = page.getByRole('list', { name: 'Recorded gate decisions' });
        await decisions.getByText('Approved', { exact: true }).waitFor();
        assert.match(await decisions.innerText(), /specs\/001-exports\/spec\.md\s+SHA-256 [a-f0-9]{64}/);
    });

    it('compares the current evidence with a confirmed gate receipt', { timeout: 60_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        f.install('ghp');
        const evidence = 'specs/001-exports/spec.md';
        f.put(evidence, '# Feature Specification: Export board\n\nReviewed evidence.');
        const definition = guidedDefinition(evidence), [gate] = definition.steps;
        f.put('.specify/workflows/guided/workflow.yml', definition);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { guided: { enabled: true } } });
        const { api, url } = await serve(t, f.root, { workflowRunStorage: fixture(t).root });
        const id = 'workflow:guided';
        const apply = async request => api('/workflow/apply', { id: (await api('/workflow/preview', { id, ...request })).id });
        const started = await apply({ operation: 'guided-start' });
        const runId = started.graph.nodes.find(node => node.id === id).guidedRun.id;
        await apply({ operation: 'guided-verdict', runId, gate: gate.id, verdict: 'approve' });
        const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
        page.setDefaultTimeout(10_000);
        await page.goto(url);
        await page.getByRole('button', { name: 'Workflow & runs', exact: true }).click();
        await page.getByLabel('Run record', { exact: true }).selectOption('guided');
        const decisions = page.getByRole('list', { name: 'Recorded gate decisions' });
        const dialog = page.getByRole('dialog');
        const compare = decisions.getByRole('button', { name: 'Compare current evidence…' });
        await compare.click();
        await dialog.getByText('The current file matches the version reviewed at this gate.', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        f.put(evidence, '# Feature Specification: Export board\n\nUpdated evidence.');
        await compare.click();
        await dialog.getByText('The current file differs from the version reviewed at this gate.', { exact: false }).waitFor();
        await dialog.locator('pre', { hasText: 'Updated evidence.' }).waitFor();
    });

    it('shows ordered sequence evidence and falls back to source for a conditional sequence', { timeout: 60_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        const feature = 'specs/001-exports';
        const artifact = `${feature}/diagrams/sequence.mmd`;
        f.put(`${feature}/spec.md`, '# Feature Specification: Export board');
        f.put(artifact, 'sequenceDiagram\nparticipant A as Requester\nparticipant B as Worker\nA->>B: Queue <b>export</b>\nB-->>A: Accepted');
        const { url, focus } = await serve(t, f.root);
        focus('001-exports');
        const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
        page.setDefaultTimeout(10_000);
        await page.goto(url);
        await page.getByRole('tab', { name: /^Architecture/ }).click();
        const messages = page.getByRole('list', { name: 'Messages in sequence order' }).getByRole('listitem');
        await messages.nth(1).waitFor();
        assert.match(await messages.nth(0).innerText(), /Requester.*Worker.*Queue <b>export<\/b>/s);
        assert.match(await messages.nth(1).innerText(), /Worker.*Requester.*Accepted.*dashed arrow/s);
        assert.equal(await messages.locator('b').count(), 0);
        f.put(artifact, 'sequenceDiagram\nA->>B: Queue\nalt accepted\nB-->>A: Accepted\nend');
        await page.getByText('A structured preview is not available for this Mermaid source.').waitFor();
        assert.equal(await messages.count(), 0);
        await page.getByText(/alt accepted/).waitFor();
    });

    it('copies a native start command without starting a run or filling its inputs', { timeout: 60_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { review: { enabled: true }, retired: { enabled: false } } });
        for (const id of ['review', 'retired']) f.put(`.specify/workflows/${id}/workflow.yml`, {
            workflow: { id, name: id === 'review' ? 'Review release' : 'Retired review' },
            inputs: { release: { type: 'string', required: true } },
            steps: [{ id: 'check', type: 'gate', message: 'Inspect the release.' }],
        });
        const { url } = await serve(t, f.root);
        const page = await browser.newPage();
        page.setDefaultTimeout(10_000);
        await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async text => { window.testCopied = text; } },
        }));
        await page.goto(url);
        await page.getByRole('button', { name: 'Workflow & runs', exact: true }).click();
        await page.getByRole('button', { name: 'Review release', exact: true }).click();
        await page.getByText(/^Declared inputs: release\./).waitFor();
        await page.getByRole('button', { name: 'Copy start command' }).click();
        await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.testCopied), 'specify workflow run review');
        assert.equal(existsSync(join(f.root, '.specify/workflows/runs')), false);
        await page.getByRole('button', { name: 'Retired review', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: 'Copy start command' }).count(), 0);
    });

    it('shows a static Illustrate drawing without loading active HTML or SVG resources', { timeout: 60_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        const feature = 'specs/001-exports';
        f.put(`${feature}/spec.md`, '# Feature Specification: Export board');
        f.put(`${feature}/diagrams/export.html`, `
            <script>document.body.dataset.diagramRan = 'yes'</script>
            <img src="/diagram-external-html">
            <svg viewBox="0 0 640 200" onload="document.body.dataset.diagramRan = 'yes'">
                <title>Export request path</title><desc>Request goes to the worker.</desc>
                <defs><marker id="arrow" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 1 L7 4 L0 7"/></marker></defs>
                <style>@import url('/diagram-external-css')</style>
                <rect x="20" y="20" width="70" height="36" fill="#cabffd" />
                <line x1="20" y1="70" x2="90" y2="70" stroke="black" marker-end="url(#arrow)"/>
                <path d="M0 1 L7 4" fill="url(/diagram-external-paint#foo)"/>
                <foreignObject><p>Not a drawing</p><svg viewBox="0 0 40 40"><circle r="10"/></svg></foreignObject>
                <image href="/diagram-external-svg"/><animate attributeName="x" values="0;10"/>
                <text x="20" y="40">Browser</text>
            </svg>
        `);
        const { url, focus } = await serve(t, f.root);
        focus('001-exports');
        const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
        page.setDefaultTimeout(10_000);
        const requests = [];
        page.on('request', request => { if (request.url().includes('/diagram-external-')) requests.push(request.url()); });
        await page.goto(url);
        await page.getByRole('tab', { name: /^Architecture/ }).click();
        const image = page.getByRole('img', { name: 'Export request path' });
        await image.waitFor();
        assert.deepEqual(await image.evaluate(async img => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; }), [640, 200]);
        const svg = decodeURIComponent((await image.getAttribute('src')).split(',')[1] ?? '');
        assert.match(svg, /marker-end="url\(#arrow\)"/);
        assert.match(svg, />Browser<\/text>/);
        assert.doesNotMatch(svg, /diagram-external|onload|<foreignObject|<animate|<style/);
        assert.equal(await page.locator('.sb-diagram-preview img').count(), 1);
        await page.getByText('Request goes to the worker.', { exact: true }).waitFor();
        await page.setViewportSize({ width: 420, height: 900 });
        assert.ok((await image.boundingBox()).width <= 420);
        await page.getByText('HTML source', { exact: true }).click();
        await page.getByText(/<foreignObject>.*Not a drawing/).waitFor();
        assert.equal(await page.evaluate(() => document.body.dataset.diagramRan), undefined);
        assert.deepEqual(requests, []);
    });

    it('reviews an HVE import in Tasks and shows the verified profile after confirmation', {
        skip: process.env.SPECKIT_CANVAS_TEST_APM !== '1', timeout: 120_000,
    }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        f.put('specs/001-exports/spec.md', '# Feature Specification: Export board');
        f.put('specs/001-exports/tasks.md', '# Tasks\n\n- [ ] T001 Build export\n');
        const { url, focus } = await serve(t, f.root);
        focus('001-exports');
        const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
        page.setDefaultTimeout(30_000);
        await page.goto(url);
        await page.getByRole('tab', { name: /^Tasks/ }).click();
        await page.getByRole('button', { name: 'Preview HVE Core import…' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('heading', { name: 'Import the HVE Core functional code reviewer' }).waitFor();
        assert.equal(existsSync(join(f.root, 'apm.lock.yaml')), false);
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByRole('button', { name: 'See agent assignments' }).click();
        await page.getByText('HVE Core imports (1)', { exact: true }).click();
        await page.getByText('Verified · inspect only', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Assign a task…' }).count(), 0);
    });

    it('separates native checkpoints from current steps and renders extension tabs without executing prototypes', { timeout: 45_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        const feature = 'specs/001-exports';
        f.put(`${feature}/spec.md`, '# Export\n\n## Figma Design Context\nReview this mockup.');
        f.put(`${feature}/plan.md`, '# Plan\n\nReview the model before implementing.');
        f.put(`${feature}/data-model-diagram.mmd`, `erDiagram
            Export {
                UUID_string id PK
                Record_array records "exported records"
            }
            Export ||--o{ Record : "contains <strong>records</strong>"`);
        f.put(`${feature}/historical-review.md`, '# Evidence referenced by the previous workflow definition.');
        f.put(`${feature}/tasks.md`, '# Tasks\n\n- [ ] T001 Build export\n- [ ] T003 Add an export check\n');
        f.put(`${feature}/preview/wireflow.html`, `
            <h2>Export prototype</h2>
            <details onclick="document.body.dataset.prototypeRan = 'yes'"><summary>Empty state</summary><p>No exports yet.</p></details>
            <table><caption>Export states</caption><tr><th>State</th><td>Ready</td></tr></table>
            <a href="/prototype-fixture-link">Export example</a>
            <img src="/prototype-fixture.png" alt="Untrusted image">
            <link rel="stylesheet" href="/prototype-fixture.css">
            <script>document.body.dataset.prototypeRan = "yes"</script>
        `);
        f.put(`${feature}/preview/export-details.html`, '<p>Initial export details</p>');
        f.install('reporter', { manifest: { 'x-companion': { specViews: [
            { phase: 'Prototypes', path: 'preview/wireflow.html', documents: ['tasks'] },
        ] } } });
        f.install('preview', { manifest: { extension: { version: '1.3.0' } }, command: { name: 'speckit.preview' } });
        f.registry.preview.version = '1.3.0';
        f.put(REGISTRY, { schema_version: '1.0', extensions: f.registry });
        f.put(`${feature}/uc.md`, '# Export use case');
        f.put('.specify/extensions/preview/templates/preview/wireflow.html', '<main></main>');
        installAgentAssign(f, feature);
        f.put('.specify/workflows/workflow-registry.json', { workflows: { review: { enabled: true } } });
        f.put('.specify/workflows/review/workflow.yml', { workflow: { id: 'review', name: 'Release review', version: '1.0.0' },
            steps: [{ id: 'check', type: 'fan-out', max_concurrency: 3, items: '[]', step: { id: 'item', type: 'prompt', agent: 'reviewer' } },
                { id: 'gather', type: 'fan-in', wait_for: ['check'] },
                { id: 'approve', type: 'gate', message: 'Inspect the release.', show_file: `${feature}/spec.md` }] });
        f.put(POLICY_PATH, { version: 1, decisions: [], runAnnotations: {
            'workflow:review:check:item': 'validation', 'workflow:review:approve': 'acceptance',
        } });
        f.put('.specify/workflows/runs/native-1/state.json', { run_id: 'native-1', workflow_id: 'review', status: 'paused', updated_at: '2026-01-02T00:00:00Z',
            current_step_id: 'old-approval', step_results: {
                'old-check': { type: 'fan-out', status: 'completed', output: { item_count: 2, max_concurrency: 2, items: ['private-item-a'] } },
                'old-check:previous-reviewer:1': { status: 'failed' },
                'old-check:previous-reviewer:0': { status: 'completed' },
                'old-check:previous-reviewer:2': { status: 'completed' },
                'check[0]:item': { status: 'completed' },
                'first-approval': { type: 'gate', status: 'completed', output: { choice: 'approve', show_file: `${feature}/data-model-diagram.mmd` } },
                'first-rejection': { type: 'gate', status: 'completed', output: { choice: 'reject', on_reject: 'continue' } },
                'old-approval': { type: 'gate', status: 'paused', output: { show_file: `${feature}/historical-review.md` } } } });
        const { url, focus } = await serve(t, f.root);
        const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
        const artifactRequests = [];
        page.on('request', request => { if (request.url().includes('/prototype-fixture')) artifactRequests.push(request.url()); });
        await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async text => { window.testCopied = text; } },
        }));
        await page.goto(url);
        await page.getByRole('button', { name: 'Workflow & runs', exact: true }).click();
        await page.getByText('Native gate needs input', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Inspect checkpoint' }).click();
        await page.getByText('check[0]:item', { exact: true }).waitFor();
        await page.getByText('Fan-out expansion · 2 items · Recorded concurrency limit: 2', { exact: true }).waitFor();
        const items = page.getByRole('list', { name: 'Recorded items for old-check' });
        assert.deepEqual(await items.locator('code').allTextContents(), ['old-check:previous-reviewer:0', 'old-check:previous-reviewer:1']);
        await items.getByText('Failed', { exact: true }).waitFor();
        await page.getByText('old-check:previous-reviewer:2', { exact: true }).waitFor();
        assert.equal(await page.getByText('private-item-a', { exact: true }).count(), 0);
        await page.getByText('Human review gate · Approved', { exact: true }).waitFor();
        const rejected = page.getByRole('listitem').filter({ hasText: 'first-rejection' });
        await rejected.getByText('Human review gate · Rejected', { exact: true }).waitFor();
        await rejected.getByText('Completed', { exact: true }).waitFor();
        await page.getByText('The diagram is the current definition, not a reconstruction of this historical run.').waitFor();
        await page.getByText('Up to 3 items run in parallel.').waitFor();
        await page.getByText('Collects results from check.').waitFor();
        await page.getByText('Validation check', { exact: true }).waitFor();
        await page.getByText('Acceptance gate', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: /^resume|review verdict/i }).count(), 0);
        await page.getByRole('button', { name: 'Copy resume command', exact: true }).click();
        await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.testCopied), 'specify workflow resume native-1');
        const record = page.getByLabel('Run record', { exact: true });
        await record.selectOption({ label: 'Current definition' });
        assert.equal(await page.getByRole('button', { name: 'Copy resume command', exact: true }).count(), 0);
        await record.selectOption('native:native-1');
        await page.getByRole('listitem').filter({ hasText: 'old-approval' }).getByRole('button', { name: 'Read recorded evidence reference…' }).click();
        await page.getByRole('dialog').getByText(/Evidence referenced by the previous workflow definition/).waitFor();
        await page.getByRole('dialog').getByText(/may have changed since that checkpoint/).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
        await page.getByRole('listitem').filter({ hasText: 'first-approval' }).getByRole('button', { name: 'Read recorded evidence reference…' }).click();
        await page.getByRole('dialog').getByText('0..*', { exact: true }).waitFor();
        await page.getByRole('dialog').getByText(/may have changed since that checkpoint/).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
        await page.getByRole('button', { name: 'Read definition evidence…' }).click();
        await page.getByRole('dialog').getByText(/Review this mockup/).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
        for (const width of [420, 1080]) {
            await page.setViewportSize({ width, height: 900 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        }
        await page.getByRole('button', { name: 'Specs & runs', exact: true }).click();
        focus(feature);
        await page.getByRole('tab', { name: 'Spec', exact: true }).click();
        await page.getByText(/contains an embedded Figma section/).waitFor();
        await page.setViewportSize({ width: 420, height: 900 });
        await page.getByRole('tab', { name: /^Plan/ }).click();
        await page.getByRole('button', { name: 'See data model evidence' }).click();
        const relation = page.locator('.sb-model-edge');
        await relation.getByText('0..*', { exact: true }).waitFor();
        await page.getByText('contains <strong>records</strong> · Identifying', { exact: true }).waitFor();
        await page.getByText('Export (2)', { exact: true }).click();
        await page.getByRole('table', { name: 'Export fields' }).getByRole('cell', { name: 'Record_array' }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.getByText('Mermaid source', { exact: true }).click();
        await page.locator('.sb-model-preview pre').filter({ hasText: 'erDiagram' }).waitFor();
        await page.getByRole('tab', { name: /^Tasks/ }).click();
        await page.getByRole('button', { name: 'See agent assignments' }).click();
        await page.getByText('HVE Core imports (1)', { exact: true }).click();
        await page.getByText('Verified · assignable', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Edit T001 assignment…' }).click();
        await page.getByRole('dialog').getByLabel('Reason').fill('Review the export.');
        await page.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click();
        await page.getByRole('dialog').getByRole('heading', { name: 'Assign T001 to hve-review' }).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm change' }).click();
        await page.getByText('T001 · hve-review', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Assign a task…' }).click();
        await page.getByRole('dialog').getByLabel('Task', { exact: true }).selectOption('T003');
        await page.getByRole('dialog').getByLabel('Reason').fill('Review the export check.');
        await page.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click();
        await page.getByRole('dialog').getByRole('heading', { name: 'Assign T003 to hve-review' }).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm change' }).click();
        await page.getByText('T003 · hve-review', { exact: true }).waitFor();
        await page.getByRole('tab', { name: /^Prototypes/ }).click();
        const prototype = page.getByLabel('Prototypes artifact');
        await page.getByText('Initial export details', { exact: true }).waitFor();
        await page.getByRole('tab', { name: /^Tasks/ }).click();
        await page.getByRole('button', { name: 'See prototypes evidence' }).click();
        const outline = page.getByRole('region', { name: 'Structural preview' });
        await outline.getByRole('heading', { name: 'Export prototype', exact: true }).waitFor();
        await outline.getByRole('table', { name: 'Export states' }).getByRole('cell', { name: 'Ready' }).waitFor();
        await page.getByText('Empty state', { exact: true }).click();
        await page.getByText('No exports yet.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Export example' }).count(), 0);
        await page.getByText('HTML source', { exact: true }).click();
        await page.getByText(/<script>document\.body\.dataset\.prototypeRan/).waitFor();
        await page.getByText(/Declared by reporter/).waitFor();
        assert.equal(await page.evaluate(() => document.body.dataset.prototypeRan), undefined);
        assert.deepEqual(artifactRequests, []);
        await prototype.focus();
        f.put(`${feature}/preview/wireflow.html`, '<p>Updated export details in place</p>');
        await page.getByText('Updated export details in place', { exact: true }).waitFor();
        assert.equal(await prototype.inputValue(), `${feature}/preview/wireflow.html`);
        assert.equal(await prototype.evaluate(node => document.activeElement === node), true);
        await page.getByRole('button', { name: 'Spec Kit Management' }).click();
        await page.getByLabel('Filter by category').selectOption('Extensions');
        await page.getByRole('button', { name: 'Inspect Preview', exact: true }).click();
        await page.getByRole('button', { name: 'Preview speckit.preview…', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Feature', { exact: true }).selectOption(feature);
        await dialog.getByLabel('Fidelity', { exact: true }).selectOption('mid');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText('/speckit.preview mid', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Approve & dispatch' }).waitFor();
    });

    it('replays wireflow feedback and local screen navigation without executing repository interactions', { timeout: 60_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        const feature = 'specs/001-exports';
        f.put(`${feature}/spec.md`, '# Feature Specification: Export board');
        f.put(`${feature}/preview/wireflow.html`, `
            <form action="/prototype-fixture-submit">
                <button data-preview-action data-preview-label="Export queued" onclick="document.body.dataset.prototypeRan = 'yes'">Queue export</button>
                <button data-preview-action data-preview-target="#export-validation" data-preview-label="&lt;b&gt;Missing name&lt;/b&gt;">Validate export</button>
                <button data-preview-action data-preview-target="body">Outside target</button>
                <button data-preview-action data-preview-target="#duplicate">Ambiguous target</button>
            </form>
            <p data-preview-status>Awaiting an action</p>
            <p id="export-validation">No validation yet</p>
            <p id="duplicate">First duplicate</p><p id="duplicate">Second duplicate</p>
            <h2 id="start-screen">Start screen</h2>
            <a href="#review-screen" onclick="document.body.dataset.prototypeRan = 'yes'">Go to review</a>
            <a href="#duplicate-screen">Ambiguous screen</a>
            <a href="#missing-screen">Missing screen</a>
            <a href="/prototype-fixture-submit">External screen</a>
            <a href="javascript:void(0)">Script screen</a>
            <h2 id="duplicate-screen">Duplicate one</h2><h2 id="duplicate-screen">Duplicate two</h2>
            <details><summary>Review screen details</summary>
                <h2 id="review-screen">Review screen</h2>
                <a href="#start-screen">Back to start</a>
            </details>
        `);
        const { url, focus } = await serve(t, f.root);
        focus('001-exports');
        const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
        page.setDefaultTimeout(10_000);
        const requests = [];
        page.on('request', request => { if (request.url().includes('/prototype-fixture-submit')) requests.push(request.url()); });
        await page.goto(url);
        await page.getByRole('tab', { name: /^Prototypes/ }).click();
        const outline = page.getByRole('region', { name: 'Structural preview' });
        await outline.getByRole('button', { name: 'Queue export' }).press('Enter');
        await outline.getByText('Export queued', { exact: true }).waitFor();
        await outline.getByRole('button', { name: 'Validate export' }).click();
        await outline.getByText('<b>Missing name</b>', { exact: true }).waitFor();
        assert.deepEqual(await outline.getByRole('button').allTextContents(), ['Queue export', 'Validate export', 'Go to review']);
        await outline.getByRole('button', { name: 'Go to review' }).press('Enter');
        const review = outline.getByRole('heading', { name: 'Review screen', exact: true });
        await review.waitFor();
        assert.equal(await review.evaluate(node => node === document.activeElement), true);
        await outline.getByRole('button', { name: 'Back to start' }).press('Enter');
        assert.equal(await outline.getByRole('heading', { name: 'Start screen' }).evaluate(node => node === document.activeElement), true);
        assert.equal(await outline.locator('a[href], [id="review-screen"]').count(), 0);
        assert.equal(new URL(page.url()).hash, '');
        assert.equal(await page.evaluate(() => document.body.dataset.prototypeRan), undefined);
        assert.deepEqual(requests, []);
    });

    it('browses and previews pinned workflows and bundles from the catalog inspector', { timeout: 45_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        const { index, url: definition, body, digest } = catalogFixture(f, true);
        const bundleIndex = 'https://raw.githubusercontent.com/acme/fixtures/main/bundles.json';
        const bundleUrl = `https://raw.githubusercontent.com/acme/fixtures/${'d'.repeat(40)}/bundle.yml`;
        const bundle = JSON.stringify({ bundle: { id: 'release-tools', version: '1.0.0' },
            provides: { extensions: [{ id: 'reporter', version: '1.0.0' }] } });
        const bundleDigest = createHash('sha256').update(bundle).digest('hex');
        f.put('.specify/bundle-catalogs.yml', { schema_version: '1.0', catalogs: [
            { id: 'bundles', install_policy: 'install-allowed', url: bundleIndex },
        ] });
        const { url } = await serve(t, f.root, {
            workflowFetch: target => new Response(target === index ? JSON.stringify({
                workflows: [{ id: 'release-review', version: '1.0.0', url: definition, sha256: digest }],
            }) : target === bundleIndex ? JSON.stringify({
                bundles: { 'release-tools': { id: 'release-tools', version: '1.0.0', download_url: bundleUrl, sha256: bundleDigest } },
            }) : target === bundleUrl ? bundle : body),
            workflowCli: async (_root, [group, verb], probe) => {
                assert.deepEqual([group, verb], ['workflow', 'add']);
                return probe ? '--dev' : 'Validated';
            },
        });
        const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
        await page.goto(url);
        await page.getByRole('button', { name: 'Spec Kit Management' }).click();
        await page.getByLabel('Filter by category').selectOption('Catalogs');
        await page.getByRole('button', { name: 'Inspect delivery', exact: true }).click();
        await page.getByRole('button', { name: 'Browse pinned workflows…' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Workflow release').selectOption({ label: 'release-review · 1.0.0' });
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText('Catalog source', { exact: true }).waitFor();
        await dialog.getByText(digest, { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Confirm change' }).waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(existsSync(join(f.root, '.specify/workflows/workflow-registry.json')), false);
        await page.getByRole('button', { name: 'Inspect bundles', exact: true }).click();
        await page.getByRole('button', { name: 'Browse pinned bundles…' }).click();
        await dialog.getByLabel('Bundle release').selectOption({ label: 'release-tools · 1.0.0' });
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText('reporter must be an unblocked, independently installed extension at 1.0.0.', { exact: false }).waitFor();
        assert.equal(existsSync(join(f.root, '.specify/bundle-records.json')), false);
    });

    it('refreshes hook edits made on disk without replacing an open confirmation', { timeout: 45_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        f.install('git', { command: { name: 'speckit.git.validate' } });
        const row = hook('git', { command: 'speckit.git.validate' });
        f.hooks({ after_tasks: [row] });
        const { url } = await serve(t, f.root);
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.goto(url);
        await page.locator('#workflow-text-toggle').click();
        await page.getByRole('table', { name: 'Connections and hooks' })
            .locator('button[data-workflow-item="hook:after_tasks:0"]').click();
        const inspector = page.locator('#workflow-inspector');
        const dialog = page.getByRole('dialog');
        await inspector.getByRole('button', { name: 'Disable hook…' }).click();
        const confirmation = dialog.getByRole('button', { name: 'Confirm change' });
        await confirmation.waitFor();
        await page.evaluate(() => {
            const stream = new EventSource(`/api/events${location.search}`);
            stream.addEventListener('snapshot', event => { window.workflowTestRevision = JSON.parse(event.data).workflowRevision; });
        });
        await page.waitForFunction(() => Number.isInteger(window.workflowTestRevision));
        const originalRevision = await page.evaluate(() => window.workflowTestRevision);
        f.hooks({ after_tasks: [{ ...row, enabled: false }] });
        await page.waitForFunction(revision => window.workflowTestRevision > revision, originalRevision);
        await confirmation.click();
        await dialog.getByRole('alert').getByText(/changed after preview/i).waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await inspector.getByRole('button', { name: 'Enable hook…' }).waitFor();
        f.hooks({ after_tasks: [row] });
        await inspector.getByRole('button', { name: 'Disable hook…' }).waitFor();

        f.put(NATIVE_HOOK_PATH, { integrations: { copilot: { events: {} } } });
        await page.getByRole('button', { name: 'Inspect copilot native event override', exact: true }).click();
        await inspector.getByRole('button', { name: NATIVE_HOOK_PATH, exact: true }).waitFor();
        const native = '.github/hooks/speckit.json';
        f.put(native, { version: 1, hooks: { postToolUse: [{ type: 'command', __speckit_event__: true }] } });
        const pending = inspector.getByText(/Spec Kit hook entries remain/);
        await pending.waitFor();
        f.put(native, { version: 1 });
        await pending.waitFor({ state: 'hidden' });
    });

    it('opens a requested spec first and follows a later focus from the workflow tab', { timeout: 45_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        t.after(() => browser.close());
        const f = fixture(t);
        f.put('specs/001-exports/spec.md', '# Feature Specification: Export board');
        const { url, focus } = await serve(t, f.root);
        focus('001-exports');
        const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
        await page.goto(url);
        const title = page.locator('#layout .detail h2').filter({ hasText: 'Export board' });
        await title.waitFor();
        await page.locator('#workflow-tab').click();
        await page.locator('#workflow-view').waitFor();
        await page.locator('#live[data-state="live"]').waitFor();
        focus('001-exports');
        await title.waitFor();
    });

    it('shares graph and text actions, confirms changes and review gates, and dispatches a form-built command', { timeout: 180_000 }, async t => {
        let browser;
        try {
            const { chromium } = await import('playwright-core');
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch {
            t.skip('No system Chrome to drive');
            return;
        }
        const f = fixture(t);
        f.install('git', { command: { name: 'speckit.git.validate' } });
        f.install('ghp');
        f.install('charter');
        installRoadmap(f);
        installWireframe(f);
        const charterSource = 'packages/api/.charter/constitution.md';
        const charterOriginal = '# Use typed errors.';
        const charterProposed = '# Document typed errors.';
        f.put('.specify/extensions/charter/scripts/bash/distributed-read.sh', '# fixture: capability declaration only');
        f.put(CHARTER_CONFIG, { distributed_sub_constitutions: true });
        f.put(CHARTER_STATE, { distributed_sub_constitutions: [charterSource.slice(0, -3)] });
        f.put(charterSource, charterOriginal);
        f.put(CONSTITUTION, '# Composed Charter constitution');
        f.hooks({ after_tasks: [hook('git', { command: 'speckit.git.validate' })] });
        f.put('specs/001-exports/spec.md', '# Feature Specification: Export board\n\n## User Stories\n\nExport this board.');
        f.put('.specify/workflows/workflow-registry.json', { workflows: { review: { enabled: true }, publish: { enabled: true }, guided: { enabled: true } } });
        const guided = guidedDefinition('specs/001-exports/spec.md');
        guided.inputs.intake = { type: 'string' };
        guided.steps = [
            { id: 'intake', type: 'gate', message: 'Choose the release path.', verdict_input: 'intake', on_reject: 'skip' },
            { id: 'release-path', type: 'if', condition: "{{ inputs.intake == 'approve' }}", then: guided.steps },
        ];
        f.put('.specify/workflows/guided/workflow.yml', guided);
        f.put('.specify/workflows/publish/workflow.yml', {
            workflow: { id: 'publish', name: 'Publish', version: '1.0.0' },
            steps: [{ id: 'label-release', type: 'github', operation: 'add-label', target: 'issue', repository: 'acme/app', number: 12, label: 'shipped' }],
        });
        f.put('.specify/workflows/review/workflow.yml', {
            workflow: { id: 'review', name: 'Release review', version: '1.0.0' },
            inputs: { verdict: { type: 'string', required: false } },
            steps: [{ id: 'review', type: 'gate', message: 'Inspect the release evidence.', verdict_input: 'verdict' }],
        });
        const runStorage = fixture(t).root;
        const sent = [], writes = [], executions = [];
        const remoteUrl = `https://raw.githubusercontent.com/acme/fixtures/${'d'.repeat(40)}/check.yml`;
        const remoteBody = JSON.stringify({
            workflow: { id: 'pinned-check', version: '1.0.0', name: 'Pinned check' },
            inputs: { verdict: { type: 'string' } },
            steps: [{ id: 'check', type: 'gate', message: 'Check the notes.', verdict_input: 'verdict' }],
        });
        const workflowCli = async (staged, args, probe) => {
            if (probe) return '--json --input --dev';
            if (args[1] === 'add') {
                assert.equal(readFileSync(args[3], 'utf8'), remoteBody);
                if (staged === f.root) {
                    f.put('.specify/workflows/pinned-check/workflow.yml', remoteBody);
                    const path = '.specify/workflows/workflow-registry.json';
                    const registry = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
                    registry.workflows['pinned-check'] = { enabled: true, source: args[3] };
                    f.put(path, registry);
                }
                return 'Registered';
            }
            if (args[1] === 'resolve') {
                assert.notEqual(staged, f.root);
                assert.equal(args[2], 'review');
                return existsSync(join(staged, '.specify/workflows/overlays/review/canvas-review-gates.yml')) ?
                    'Step attribution:\n  • review: project:canvas-review-gates' : 'Step attribution:\n  • review: base';
            }
            executions.push(args);
            assert.notEqual(staged, f.root);
            const completed = args[1] === 'resume';
            const state = { run_id: 'review-1', workflow_id: 'review', installed_workflow_id: 'review',
                status: completed ? 'completed' : 'paused', current_step_id: completed ? null : 'review',
                updated_at: '2026-01-02T00:00:00Z' };
            const directory = join(staged, '.specify', 'workflows', 'runs', state.run_id);
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
            return JSON.stringify(state);
        };
        const issue = { id: 'issue-12', url: 'https://github.com/acme/app/issues/12', title: 'Export', state: 'OPEN',
            projectItems: { nodes: [{ id: 'item', status: { optionId: 'old', name: 'Todo' }, project: {
                id: 'project', title: 'Delivery', url: 'https://github.com/orgs/acme/projects/1',
                field: { id: 'status-field', options: [{ id: 'old', name: 'Todo' }, { id: 'new', name: 'Done' }] },
            } }] },
        };
        const workflowGitHub = createGitHubChanges(async (query, vars, mutation) => {
            if (!mutation && query.includes('label(name:')) return { viewer: { login: 'test-user' }, repository: {
                issue: { ...issue, labels: { nodes: [], pageInfo: { hasNextPage: false } } }, label: { name: 'shipped', id: 'label' },
            } };
            if (!mutation) return { viewer: { login: 'test-user' }, repository: { issue } };
            writes.push(vars);
            if (query.includes('addLabelsToLabelable')) {
                return { addLabelsToLabelable: { labelable: { ...issue, labels: { nodes: [{ id: 'label' }] } } } };
            }
            return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item', status: { optionId: 'new' } } } };
        });
        const { url, api } = await serve(t, f.root, { send: async prompt => { sent.push(prompt); return true; }, checkoutWriter: null,
            workflowGitHub, workflowCli, workflowRunStorage: runStorage,
            workflowFetch: async url => {
                assert.equal(url, remoteUrl);
                return new Response(remoteBody);
            } });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
        page.setDefaultTimeout(20_000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        const graph = page.locator('#workflow-svg');
        await graph.locator('[data-workflow-item="extension:git"]').waitFor();
        await graph.locator('[data-workflow-item="workflow:review"]').waitFor();
        const nodes = await graph.locator('.wf-node').count(), edges = await graph.locator('.wf-edge-group').count();
        assert.ok(nodes >= 38);
        assert.ok(edges > 30);
        const fit = await graph.getAttribute('viewBox');
        await page.getByRole('button', { name: 'Zoom in' }).click();
        assert.notEqual(await graph.getAttribute('viewBox'), fit);
        await page.getByRole('button', { name: 'Fit view' }).click();
        assert.equal(await graph.getAttribute('viewBox'), fit);
        await graph.locator('[data-workflow-item="extension:git"]').press('Enter');
        const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
        await inspector.getByRole('heading', { name: 'git', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Text view' }).click();
        assert.equal(await page.getByRole('table', { name: 'Participants' }).getByRole('row').count(), nodes + 1);
        assert.equal(await page.getByRole('table', { name: 'Connections and hooks' }).getByRole('row').count(), edges + 1);
        await inspector.getByRole('button', { name: 'Inspect after_tasks · Enabled' }).click();
        const dialog = page.getByRole('dialog');
        await inspector.getByRole('button', { name: 'Run local fixture…' }).click();
        await dialog.getByLabel('Fixture').selectOption('timestamp');
        await dialog.getByRole('button', { name: 'Run fixture' }).click();
        await dialog.getByText('specs/20260319-143022-checkout', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await inspector.getByRole('button', { name: 'Disable hook…' }).click();
        await dialog.getByRole('heading', { name: 'Workflow changes' }).waitFor();
        assert.equal(JSON.parse(readFileSync(join(f.root, HOOK_PATH), 'utf8')).hooks.after_tasks[0].enabled, true);
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await inspector.getByText('Inactive or proposed').waitFor();
        await page.getByRole('button', { name: 'Inspect copilot native event override', exact: true }).click();
        await inspector.getByRole('button', { name: 'Suppress all native events…' }).click();
        await dialog.getByText('Suppress all Spec Kit native events for copilot', { exact: true }).waitFor();
        assert.equal(existsSync(join(f.root, NATIVE_HOOK_PATH)), false);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await inspector.getByRole('button', { name: 'Suppress all native events…' }).click();
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await inspector.getByRole('button', { name: NATIVE_HOOK_PATH, exact: true }).waitFor();
        assert.match(readFileSync(join(f.root, NATIVE_HOOK_PATH), 'utf8'), /copilot:\r?\n\s+events: \{\}/);
        await page.getByRole('button', { name: 'Inspect GHP', exact: true }).click();
        await inspector.getByRole('button', { name: 'Review GitHub change…' }).click();
        await dialog.getByLabel('Issue URL').fill(issue.url);
        await dialog.getByLabel('Change', { exact: true }).selectOption('project-status');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByLabel('New status').selectOption('new');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText('test-user', { exact: true }).waitFor();
        assert.deepEqual(writes, []);
        await dialog.getByRole('button', { name: 'Apply GitHub change' }).click();
        await page.getByText('GitHub confirmed the change.', { exact: true }).waitFor();
        assert.deepEqual(writes, [{ project: 'project', item: 'item', field: 'status-field', option: 'new' }]);
        const reloaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workflow');
        await api('/refresh', {});
        await reloaded;
        await page.getByText('GitHub confirmed the change.', { exact: true }).waitFor();

        await page.getByRole('button', { name: 'Spec Kit Management' }).click();
        await page.getByLabel('Filter by category').selectOption('Bundles');
        await page.getByRole('button', { name: 'Register pinned GitHub bundle…' }).click();
        await dialog.getByLabel('Pinned raw GitHub URL').waitFor();
        await dialog.getByLabel('Expected SHA-256').waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await page.getByLabel('Filter by category').selectOption('Hooks');
        assert.equal(await page.getByRole('table', { name: 'Connections and hooks' }).getByRole('row').count(), 2);
        await page.getByLabel('Filter by category').selectOption('Workflows');
        await page.getByRole('button', { name: 'Register pinned GitHub workflow…' }).click();
        await dialog.getByLabel('Workflow identifier').fill('pinned-check');
        await dialog.getByLabel('Pinned raw GitHub URL').fill(remoteUrl);
        await dialog.getByLabel('Expected SHA-256').fill(createHash('sha256').update(remoteBody).digest('hex'));
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText(remoteBody, { exact: true }).waitFor();
        assert.equal(existsSync(join(f.root, '.specify/workflows/pinned-check/workflow.yml')), false);
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByRole('button', { name: 'Inspect Pinned check', exact: true }).waitFor();
        assert.deepEqual(executions, []);
        await page.getByRole('button', { name: 'Inspect Release review', exact: true }).click();
        await inspector.getByRole('button', { name: 'Inspect composed steps…' }).click();
        await dialog.getByText('review: base', { exact: false }).waitFor();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await inspector.getByRole('button', { name: 'Configure review gate…' }).click();
        await dialog.getByLabel('Review evidence').selectOption('specs/001-exports/spec.md');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Proposed content' }).waitFor();
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByText('Confirmed change applied. The workflow reflects the latest repository state.', { exact: true }).waitFor();
        assert.ok((await api('/workflow')).edges.some(edge => edge.kind === 'input' && edge.target === 'workflow:review:review' &&
            edge.reads[0] === 'specs/001-exports/spec.md'));
        await inspector.getByRole('button', { name: 'Start isolated review…' }).click();
        await dialog.getByRole('heading', { name: 'Start review workflow: Release review' }).waitFor();
        assert.deepEqual(executions, []);
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByText('Isolated review run: paused.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Workflow & runs', exact: true }).click();
        await page.getByRole('button', { name: 'Review verdict…' }).click();
        await dialog.getByLabel('Verdict').selectOption('approve');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Record gate decision: review' }).waitFor();
        await dialog.getByText('Complete the run', { exact: true }).waitFor();
        await dialog.getByRole('heading', { name: 'Review evidence' }).waitFor();
        await dialog.getByText('# Feature Specification: Export board ## User Stories Export this board.', { exact: true }).waitFor();
        assert.deepEqual(executions, [['workflow', 'run', 'review', '--json']]);
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByText('Isolated review run: completed.', { exact: true }).waitFor();
        assert.deepEqual(executions.at(-1), ['workflow', 'resume', 'review-1', '--json', '--input', 'verdict=approve']);
        assert.deepEqual(sent, []);
        await page.getByRole('button', { name: 'Spec Kit Management' }).click();
        await page.getByLabel('Filter by category').selectOption('Workflow steps');
        await page.getByRole('table', { name: 'Participants' }).getByRole('button', { name: 'Inspect label-release', exact: true }).click();
        await inspector.getByRole('button', { name: 'Review issue label…' }).click();
        await dialog.getByLabel('GitHub integration').selectOption('extension:ghp');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Review issue label change' }).waitFor();
        await dialog.getByText('shipped', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(writes.length, 1, 'Closing a manual label preview without confirmation must not write');

        await page.getByLabel('Filter by category').selectOption('Workflows');
        await page.getByRole('table', { name: 'Participants' }).getByRole('button', { name: 'Inspect Guided publish', exact: true }).click();
        await inspector.getByRole('button', { name: 'Start guided run…' }).click();
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await inspector.getByRole('button', { name: 'Decide guided gate…' }).click();
        await dialog.getByLabel('Verdict').selectOption('approve');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText('Next checkpoint', { exact: true }).waitFor();
        await dialog.getByText('review', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByRole('button', { name: 'Workflow & runs', exact: true }).click();
        await page.getByRole('navigation', { name: 'Installed workflows' }).getByRole('button', { name: 'Guided publish', exact: true }).click();
        await page.locator('#workflow-runs .run-step[data-current="true"]').getByText('review', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Review verdict…', exact: true }).click();
        await dialog.getByLabel('Verdict').selectOption('approve');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Review evidence' }).waitFor();
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await page.getByRole('button', { name: 'Review GitHub change…', exact: true }).click();
        await dialog.getByLabel('GitHub integration').selectOption('extension:ghp');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        assert.equal(writes.length, 1, 'The guided verdict must not write to GitHub');
        await dialog.getByText('shipped', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Apply GitHub change' }).click();
        await page.getByText('Guided run: completed.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Spec Kit Management' }).click();
        assert.deepEqual(writes.at(-1), { issue: 'issue-12', label: 'label' });

        await page.getByLabel('Filter by category').selectOption('Constitution and Charter');
        await page.getByRole('table', { name: 'Participants' }).getByRole('button', { name: 'Inspect packages/api charter rules', exact: true }).click();
        await inspector.getByRole('button', { name: 'Review Charter source edit…' }).click();
        await dialog.getByLabel('Constitution Markdown').fill(charterProposed);
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText(charterProposed, { exact: true }).waitFor();
        assert.equal(readFileSync(join(f.root, charterSource), 'utf8'), charterOriginal);
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(readFileSync(join(f.root, charterSource), 'utf8'), charterProposed);
        assert.equal(readFileSync(join(f.root, CONSTITUTION), 'utf8'), '# Composed Charter constitution');

        await page.getByLabel('Filter by category').selectOption('Extensions');
        await page.getByRole('table', { name: 'Participants' }).locator('button[data-workflow-item="extension:roadmap"]').click();
        await inspector.getByRole('button', { name: 'Review roadmap status change…' }).click();
        await dialog.getByLabel('Roadmap entry').selectOption('001');
        await dialog.getByLabel('New roadmap status').selectOption('verified');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText(/Status: 001 planned → verified/).waitFor();
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.match(readFileSync(join(f.root, ROADMAP_PATH), 'utf8'), /### 001 — Export \[status: verified\]/);

        await page.getByRole('table', { name: 'Participants' }).locator('button[data-workflow-item="extension:wireframe"]').click();
        await inspector.getByRole('button', { name: 'Review initial wireframe sign-off…' }).click();
        await dialog.getByLabel('Feature').selectOption('specs/001-exports');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Wireframe review evidence' }).waitFor();
        const drawing = dialog.getByRole('img', { name: /Wireframe: .*01-export\.svg/ });
        await drawing.waitFor({ state: 'visible' });
        assert.deepEqual(await drawing.evaluate(canvas => [...canvas.getContext('2d').getImageData(50, 35, 1, 1).data]), [0, 0, 128, 255]);
        await dialog.getByRole('button', { name: 'Confirm change' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.match(readFileSync(join(f.root, 'specs/001-exports/spec.md'), 'utf8'), /## UI Mockup/);

        await page.getByRole('button', { name: 'Workflow', exact: true }).click();
        await page.getByRole('button', { name: 'New spec…' }).click();
        await dialog.getByLabel('What should this feature accomplish?').fill('Export the current view.');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText('/speckit.specify Export the current view.', { exact: true }).waitFor();
        assert.deepEqual(sent, []);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('button', { name: 'Inspect Plan', exact: true }).click();
        await inspector.getByRole('button', { name: 'Preview Create plan…' }).click();
        await dialog.getByLabel('Feature', { exact: true }).selectOption('specs/001-exports');
        await dialog.getByLabel('Input artifact').selectOption('specs/001-exports/spec.md');
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await dialog.getByText('/speckit.plan specs/001-exports', { exact: true }).waitFor();
        assert.deepEqual(sent, []);
        await dialog.getByRole('button', { name: 'Approve & dispatch' }).click();
        await page.getByText('Sent /speckit.plan to the chat', { exact: true }).waitFor();
        assert.deepEqual(sent, ['/speckit.plan specs/001-exports\n\nSelected input artifact: specs/001-exports/spec.md']);

        await page.setViewportSize({ width: 430, height: 850 });
        await page.emulateMedia({ colorScheme: 'light' });
        await page.getByRole('button', { name: 'Graph view' }).click();
        assert.ok(await graph.isVisible());
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        f.put(NATIVE_HOOK_PATH, { integrations: { copilot: { events: {} } } });
        f.put('.github/hooks/speckit.json', { version: 1, hooks: { sessionStart: [{ __speckit_event__: true }] } });
        await page.getByRole('button', { name: 'Validate workflow' }).click();
        await page.getByRole('status').filter({ hasText: 'Command dispatch from Workflow is blocked' }).waitFor();
        assert.ok(await page.getByRole('button', { name: 'New spec…' }).isDisabled());
        assert.ok(await inspector.getByRole('button', { name: 'Preview Create plan…' }).isDisabled());

        f.put('.specify/integration.json', {
            version: '1.4.1', default_integration: 'claude', installed_integrations: ['claude', 'copilot'],
        });
        await page.getByRole('button', { name: 'Validate workflow' }).click();
        await page.locator('#workflow-runtime').filter({ hasText: /claude integration/ }).waitFor();
        await graph.locator('[data-workflow-item="native-events:copilot"]').press('Enter');
        const secondaryWarning = inspector.getByText(/hook entries remain.*empty copilot override/);
        await secondaryWarning.waitFor();
        assert.equal(await inspector.getByRole('button', { name: 'Restore inherited native events…' }).count(), 0);
        await page.getByRole('button', { name: 'Text view' }).click();
        await page.getByRole('table', { name: 'Participants' })
            .getByRole('button', { name: 'Inspect copilot native event override', exact: true }).click();
        await secondaryWarning.waitFor();
        assert.ok(await page.getByRole('button', { name: 'New spec…' }).isDisabled());
        assert.equal(sent.length, 1);
        assert.deepEqual(errors, []);
    });
});
