import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';
import { createEcosystem, integrationSnapshot } from '../com.github.copilot/extensions/speckit-companion/ecosystem.mjs';
import { recordLockPath, recordStep } from '../com.github.copilot/extensions/speckit-companion/run-record.mjs';
import { linkedDraftStorage } from '../com.github.copilot/extensions/speckit-companion/workspace.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function call(board, path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: board.port, path, method, headers: { host: `127.0.0.1:${board.port}`, ...headers } }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

describe('Companion product work and routines', () => {
    it('captures native ideas, requires authorization and applies a reviewed update to the exact destination', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-product-'));
        const spec = 'specs/001-trail';
        const other = 'specs/002-map';
        const original = '# Trail\r\n\r\nKeep this paragraph.  \r\n';
        for (const id of [spec, other]) {
            mkdirSync(join(root, id), { recursive: true });
            writeFileSync(join(root, id, 'spec.md'), original);
        }
        const board = await createSpecServer({ root });
        const headers = { 'x-speckit-token': board.token };
        const get = async path => JSON.parse((await call(board, path, { headers })).body);
        const post = (path, body) => call(board, path, { method: 'POST', headers, body: { expectedRoot: board.snapshot.root, ...body } });
        const triage = { kind: 'ideas', slug: 'offline-trail' };
        const preview = (spec, idea = triage.slug) => post('/api/work/preview-idea', { spec, idea });
        const update = (kind, id, token) => post('/api/work/apply-idea', {
            idea: triage.slug, target: { kind, id }, summary: 'Keep offline edits in a queue.', confirmed: true, token,
        });
        try {
            const capture = await post('/api/reports/triage', { ...triage, title: 'Offline trail', description: 'Queue offline edits.', status: 'new', revision: null });
            assert.equal(capture.status, 200, capture.body);
            assert.equal((await get('/api/report?kind=ideas&slug=offline-trail')).item.state, 'draft');
            assert.equal((await preview(spec)).status, 400);
            const ready = await post('/api/reports/triage', { ...triage, status: 'ready', revision: JSON.parse(capture.body).revision });
            assert.equal(ready.status, 200, ready.body);
            assert.equal((await post('/api/reports/triage', { ...triage, status: 'parked', revision: JSON.parse(capture.body).revision })).status, 409);

            const plan = JSON.parse((await post('/api/work/create', { kind: 'business-plan', title: 'Pilot plan', description: 'Pilot with one team.' })).body);
            const epic = JSON.parse((await post('/api/work/create', { kind: 'epic', title: 'Reliability', description: 'Support offline work.', parent: plan.id })).body);
            for (const destination of [plan, epic]) {
                const applied = await update(destination.kind, destination.id);
                assert.equal(applied.status, 200, applied.body);
            }
            const inventory = await get('/api/work');
            assert.equal(inventory.records.find(row => row.id === epic.id).parent, plan.id);
            assert.deepEqual(new Set(inventory.updates.map(row => row.target.id)), new Set([plan.id, epic.id]));
            assert.equal((await get('/api/report?kind=ideas&slug=offline-trail')).item.updates.length, 2);

            const reviewed = await preview(spec);
            assert.equal(reviewed.status, 200, reviewed.body);
            const { token } = JSON.parse(reviewed.body);
            assert.equal((await update('spec', other, token)).status, 400);
            writeFileSync(join(root, spec, 'spec.md'), `${original}An external edit.\r\n`);
            assert.notEqual((await update('spec', spec, token)).status, 200);
            const reopened = JSON.parse((await preview(spec)).body);
            const applied = await update('spec', spec, reopened.token);
            assert.equal(applied.status, 200, applied.body);
            assert.equal((await update('spec', spec, reopened.token)).status, 400);
            assert.equal(readFileSync(join(root, other, 'spec.md'), 'utf8'), original);
            assert.equal(readFileSync(join(root, spec, 'spec.md'), 'utf8'),
                `${original}An external edit.\r\n\r\n\r\n## Product update from idea offline-trail\r\n\r\nKeep offline edits in a queue.\r\n`);
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('saves and archives recurring drafts without dispatching until a review is requested', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-routines-'));
        const prompts = [];
        const board = await createSpecServer({ root, send: async prompt => { prompts.push(prompt); return true; } });
        const headers = { 'x-speckit-token': board.token };
        const post = (path, body) => call(board, `/api/routines/${path}`, { method: 'POST', headers, body: { expectedRoot: board.snapshot.root, ...body } });
        const input = { name: 'Weekly analysis', kind: 'command', action: 'speckit.analyze', rhythm: 'weekly', day: 1, hour: 10, minute: 0 };
        try {
            assert.equal((await post('save', { ...input, action: 'speckit.analyze && other' })).status, 400);
            assert.equal((await post('save', { ...input, day: 7 })).status, 400);
            assert.equal((await post('save', { ...input, expectedRoot: join(root, 'other') })).status, 400);
            const saved = await post('save', input);
            assert.equal(saved.status, 200, saved.body);
            const { id, revision } = JSON.parse(saved.body);
            assert.equal(prompts.length, 0);
            assert.equal((await post('review', { id, revision: 'stale' })).status, 400);
            const reviewed = await post('review', { id, revision });
            assert.equal(reviewed.status, 200, reviewed.body);
            assert.equal(prompts.length, 1);
            assert.match(prompts[0], /user_confirmation set to dialog/);
            assert.match(prompts[0], /"weekday":1,"timezone":"local computer time"/);
            const archived = await post('archive', { id, revision, archived: true });
            assert.equal(archived.status, 200, archived.body);
            assert.equal((await post('review', { id, revision: JSON.parse(archived.body).revision })).status, 400);
            assert.equal(prompts.length, 1);
            assert.equal((await post('manage', {})).status, 200);
            assert.match(prompts.at(-1), /list_workflows tool scoped to the exact configured project/);
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('canvas settings', () => {
    it('applies repository settings and rejects stale, invalid, and host-owned edits', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-settings-'));
        const vscode = join(root, '.vscode');
        const file = join(vscode, 'settings.json');
        const spec = join(root, 'apps', 'board', 'specs', '101-sample');
        mkdirSync(spec, { recursive: true });
        mkdirSync(vscode);
        mkdirSync(join(root, '.specify', 'extensions', 'companion'), { recursive: true });
        writeFileSync(join(spec, 'spec.md'), '# Sample');
        writeFileSync(join(spec, '.spec-context.json'), JSON.stringify({ workflow: 'demo', status: 'specified', history: [] }));
        writeFileSync(file, '{\n  // Editor preference\n  "editor.tabSize": 4,\n}\n');
        const sent = [];
        let terminal = false;
        const board = await createSpecServer({ root, send: async prompt => { sent.push(prompt); return true; }, openTerminal: async () => { terminal = true; } });
        const headers = { 'x-speckit-token': board.token };
        const get = async path => JSON.parse((await call(board, path, { headers })).body);
        const post = (path, body) => call(board, path, { method: 'POST', headers, body: { expectedRoot: board.snapshot.root, ...body } });
        try {
            const initial = await get('/api/settings');
            assert.equal(initial.fields.find(f => f.key === 'speckit.permissionMode').source, 'Host');
            assert.equal((await post('/api/settings', { version: initial.version, changes: { 'speckit.permissionMode': 'auto-approve' } })).status, 400);
            assert.equal((await post('/api/settings', { version: initial.version, changes: { 'speckit.specDirectories': ['../outside'] } })).status, 400);
            const saved = await post('/api/settings', { version: initial.version, changes: {
                'speckit.specDirectories': ['apps/*/specs'],
                'speckit.defaultWorkflow': 'speckit',
                'speckit.commandFormat': 'dash',
                'speckit.aiContextInstructions': false,
                'speckit.viewer.activityPanel': false,
                'speckit.customWorkflows': [{ name: 'demo', 'step-specify': 'demo.specify', 'step-plan': 'demo.plan' }],
                'speckit.customCommands': [{ name: 'review', requiresSpecDir: false }, { name: 'check', command: 'check ${specDir} --strict' }],
            } });
            assert.equal(saved.status, 200, saved.body);
            assert.match(readFileSync(file, 'utf8'), /\/\/ Editor preference[\s\S]*"editor.tabSize": 4/);
            const snapshot = await get('/api/snapshot');
            assert.equal(snapshot.specify.default, 'speckit');
            assert.ok(snapshot.specify.choices.some(choice => choice.id === 'demo'));
            const id = snapshot.specs[0].id;
            const detail = await get(`/api/spec?id=${encodeURIComponent(id)}`);
            assert.equal(detail.showActivity, false);
            assert.equal((await post('/api/run', { spec: id, command: 'plan' })).status, 200);
            assert.equal(sent.at(-1), `/demo.plan ${id}`);
            assert.equal((await get(`/api/spec?id=${encodeURIComponent(id)}`)).spec.steps.plan, 'in-progress');
            assert.match((await post('/api/run', { spec: id, command: 'tasks' })).body, /no tasks command configured/);
            board.settle();
            assert.equal((await post('/api/custom-command', { spec: id, id: 'custom:0', command: '/speckit.review' })).status, 200);
            assert.equal(sent.at(-1), '/speckit.review');
            assert.equal((await post('/api/custom-command', { spec: id, id: 'custom:1', command: '/speckit.check ${specDir} --strict' })).status, 200);
            assert.equal(sent.at(-1), `/speckit.check ${id} --strict`);
            const specify = await post('/api/specify', { description: 'New feature', workflow: 'speckit' });
            assert.equal(specify.status, 200, specify.body);
            assert.match(sent.at(-1), /^\/speckit-specify New feature/);
            assert.match(sent.at(-1), /Name the new spec folder `102-<short-name>`/);
            assert.equal(JSON.parse(specify.body).instructionsFile, null);
            board.settle();
            assert.equal((await post('/api/settings', { version: initial.version, changes: { 'speckit.viewer.activityPanel': null } })).status, 409);
            assert.equal((await post('/api/terminal', {})).status, 200);
            assert.ok(terminal);
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    describe('canvas linked work and evidence', () => {
        it('recovers a linked draft after reopening without resending it or choosing between two matches', async () => {
            const temporary = mkdtempSync(join(tmpdir(), 'canvas-link-recovery-'));
            const root = join(temporary, 'repo');
            const settings = join(root, '.vscode');
            mkdirSync(settings, { recursive: true });
            writeFileSync(join(settings, 'settings.json'), '{"speckit.aiContextInstructions":false}');
            const drafts = linkedDraftStorage(temporary, 'board');
            const sent = [];
            let board = await createSpecServer({ root, linkedDraft: drafts, send: async prompt => { sent.push(prompt); return true; } });
            const get = async path => JSON.parse((await call(board, path, { headers: { 'x-speckit-token': board.token } })).body);
            const post = (path, body) => call(board, path, { method: 'POST', headers: { 'x-speckit-token': board.token }, body: { expectedRoot: root, ...body } });
            try {
                const plan = JSON.parse((await post('/api/work/create', { kind: 'business-plan', title: 'Pilot', description: 'Test demand.' })).body);
                const result = await post('/api/specify', { description: 'Confidential draft text', workflow: 'speckit', source: { kind: plan.kind, id: plan.id } });
                assert.equal(result.status, 200, result.body);
                const marker = sent[0].match(/<!-- Companion source: [a-f0-9-]+ -->/)[0];
                assert.doesNotMatch(JSON.stringify(drafts.read()), /Confidential draft text/);
                await board.close();
                for (const slug of ['001-pilot', '002-duplicate']) {
                    const folder = join(root, 'specs', slug);
                    mkdirSync(folder, { recursive: true });
                    writeFileSync(join(folder, 'spec.md'), `# Pilot\n\n${marker}\n`);
                }
                board = await createSpecServer({ root, linkedDraft: drafts, send: async prompt => { sent.push(prompt); return true; } });
                assert.deepEqual((await get('/api/work')).links, []);
                writeFileSync(join(root, 'specs', '002-duplicate', 'spec.md'), `# Duplicate\n\n> ${marker}\n`);
                await post('/api/refresh', {});
                assert.deepEqual((await get('/api/work')).links.map(link => [link.spec, link.source.id]), [['specs/001-pilot', plan.id]]);
                assert.equal(drafts.read(), null);
                assert.equal(sent.length, 1);
            } finally {
                await board.close();
                rmSync(temporary, { recursive: true, force: true });
            }
        });

        it('links only the new spec with the exact source marker', async () => {
            const root = mkdtempSync(join(tmpdir(), 'canvas-linked-work-'));
            const source = join(root, '.vscode');
            mkdirSync(source);
            writeFileSync(join(source, 'settings.json'), '{"speckit.aiContextInstructions":false}');
            const sent = [];
            const board = await createSpecServer({ root, send: async prompt => { sent.push(prompt); return true; } });
            const headers = { 'x-speckit-token': board.token };
            const get = async path => JSON.parse((await call(board, path, { headers })).body);
            const post = (path, body) => call(board, path, { method: 'POST', headers, body: { expectedRoot: root, ...body } });
            try {
                const plan = await post('/api/work/create', { kind: 'business-plan', title: 'Pilot', description: 'Start with a small release.' });
                assert.equal(plan.status, 200, plan.body);
                const { id } = JSON.parse(plan.body);
                assert.equal((await post('/api/work/create', { kind: 'epic', title: 'Ship', description: 'Release it', parent: 'missing' })).status, 400);
                assert.equal((await post('/api/work/create', { kind: 'epic', title: 'Ship', description: 'Release it', parent: id })).status, 200);
                const draft = await post('/api/specify', { description: 'Build the pilot', workflow: 'speckit', source: { kind: 'business-plan', id } });
                assert.equal(draft.status, 200, draft.body);
                const marker = sent[0].match(/<!-- Companion source: [a-f0-9-]+ -->/)[0];
                assert.equal((await post('/api/specify', { description: 'Another spec' })).status, 400);
                const wrong = join(root, 'specs', '001-unrelated');
                const right = join(root, 'specs', '002-pilot');
                mkdirSync(wrong, { recursive: true });
                writeFileSync(join(wrong, 'spec.md'), `# Unrelated\n> ${marker}\n`);
                await post('/api/refresh', {});
                assert.deepEqual((await get('/api/work')).links, []);
                mkdirSync(right, { recursive: true });
                writeFileSync(join(right, 'spec.md'), `# Pilot\n\n${marker}\n`);
                await post('/api/refresh', {});
                const links = (await get('/api/work')).links;
                assert.deepEqual(links.map(link => [link.spec, link.source.id]), [['specs/002-pilot', id]]);
                await post('/api/work/link', { spec: 'specs/002-pilot', source: { kind: 'business-plan', id } });
                assert.equal((await get('/api/work')).links.length, 1);
                const bug = join(root, '.specify', 'bugs', 'cart');
                mkdirSync(bug, { recursive: true });
                writeFileSync(join(bug, 'assessment.md'), '# Bug Assessment: Cart error\n');
                const linked = await post('/api/work/link', { spec: 'specs/002-pilot', source: { kind: 'bug', id: 'cart' } });
                assert.equal(linked.status, 200, linked.body);
                const report = await get('/api/report?kind=bugs&slug=cart');
                assert.deepEqual(report.item.linkedSpecs.map(spec => spec.id), ['specs/002-pilot']);
            } finally {
                await board.close();
                rmSync(root, { recursive: true, force: true });
            }
        });

        it('scopes previews and records only decisions for the reviewed artifact revision', async () => {
            const root = mkdtempSync(join(tmpdir(), 'canvas-evidence-'));
            const spec = 'specs/001-inbox';
            const path = `${spec}/design.html`;
            mkdirSync(join(root, spec), { recursive: true });
            writeFileSync(join(root, spec, 'spec.md'), '# Inbox');
            writeFileSync(join(root, path), '<script>throw new Error("repository code")</script>');
            const sent = [];
            const board = await createSpecServer({ root, send: async prompt => { sent.push(prompt); return true; } });
            const headers = { 'x-speckit-token': board.token };
            const get = path => call(board, path, { headers });
            const post = (route, body) => call(board, route, { method: 'POST', headers, body: { expectedRoot: root, ...body } });
            try {
                assert.equal((await get(`/api/artifact?id=${spec}&path=${spec}/../unrelated.md`)).status, 400);
                const raw = await get(`/api/artifact?id=${spec}&path=${path}`);
                assert.equal(raw.status, 200, raw.body);
                const { revision: version, content, kind } = JSON.parse(raw.body);
                assert.equal(kind, 'prototype');
                assert.match(content, /^<script>/);
                assert.equal(JSON.parse(raw.body).wireflow, null);
                const approval = { spec, path, version, note: 'Reviewed initial design.', decision: 'approve' };
                assert.equal((await post('/api/artifact/review', approval)).status, 400);
                const recorded = await post('/api/artifact/review', { ...approval, confirmed: true });
                assert.equal(recorded.status, 200, recorded.body);
                const impact = await post('/api/impact', { spec, path, version, question: 'Where is the inbox rendered?' });
                assert.equal(impact.status, 200, impact.body);
                assert.match(sent[0], /analysis only.*do not edit/);
                writeFileSync(join(root, path), '<h1>Revised</h1>');
                assert.equal((await post('/api/artifact/review', { ...approval, confirmed: true })).status, 400);
                assert.equal((await post('/api/impact', { spec, path, version })).status, 400);
                const audit = JSON.parse((await get(`/api/workflow-reviews?id=${spec}`)).body);
                assert.equal(audit.reviews.length, 1);
                assert.equal(audit.reviews[0].version, version);
                assert.notEqual(new Map(audit.revisions).get(path), version);
                assert.deepEqual(audit.runs, []);
            } finally {
                await board.close();
                rmSync(root, { recursive: true, force: true });
            }
        });

        it('starts Pre-Spec Cards only in the reviewed session without creating discovery files', async () => {
            const root = mkdtempSync(join(tmpdir(), 'canvas-discovery-'));
            const registry = join(root, '.specify', 'extensions', '.registry');
            const skill = 'speckit-prespec-idea';
            const skillPath = join(root, '.github', 'skills', skill, 'SKILL.md');
            const entry = { version: '0.4.0', enabled: true, registered_skills: [skill] };
            mkdirSync(join(registry, '..'), { recursive: true });
            mkdirSync(join(skillPath, '..'), { recursive: true });
            const integration = join(root, '.specify', 'integration.json');
            writeFileSync(integration, '{"default_integration":"claude"}');
            const save = () => writeFileSync(registry, JSON.stringify({ extensions: { prespec: entry } }));
            const sent = [];
            let accepted = true;
            const board = await createSpecServer({ root, saveRoot: () => {}, send: async (prompt, target) => {
                sent.push({ prompt, target });
                return accepted;
            } });
            const headers = { 'x-speckit-token': board.token };
            const status = async () => JSON.parse((await call(board, '/api/discovery', { headers })).body);
            const start = (revision, overrides = {}) => call(board, '/api/discovery', {
                method: 'POST', headers, body: { idea: 'Find archived recipes faster', expectedRoot: root, revision, ...overrides },
            });
            try {
                assert.match((await status()).reason, /configured for Copilot/);
                assert.match((await start()).body, /configured for Copilot/);
                writeFileSync(integration, '{"default_integration":"copilot"}');
                assert.equal((await status()).setup, true);
                assert.equal((await start()).status, 400);
                save();
                assert.match((await status()).reason, /Idea skill is missing/);
                writeFileSync(skillPath, '# Idea skill');
                const original = await status();
                assert.equal(original.target, 'This Copilot chat');
                assert.equal((await start(original.revision, { expectedRoot: 'another repository' })).status, 400);
                writeFileSync(skillPath, '# Revised Idea skill');
                assert.equal((await start(original.revision)).status, 400);
                const owning = await status();
                board.bindSession({ sessionId: 'child-discovery', cwd: root, name: 'Discovery session' });
                assert.equal((await start(owning.revision)).status, 400);
                const bound = await status();
                assert.equal(bound.target, 'Discovery session');
                assert.equal((await start(bound.revision, { idea: 'x'.repeat(3001) })).status, 400);
                entry.version = '9.9.9';
                save();
                assert.match((await start(bound.revision)).body, /requires the reviewed Pre-Spec Cards version/);
                entry.version = '0.4.0';
                save();
                assert.deepEqual(sent, []);
                const result = await start(bound.revision);
                assert.equal(result.status, 200, result.body);
                assert.equal(sent[0].target, 'child-discovery');
                assert.match(sent[0].prompt, /goal, motivation, and folder slug.*end the turn.*explicit reply.*Sending this request is not confirmation/);
                assert.match(sent[0].prompt, /Idea: "Find archived recipes faster"/);
                assert.ok(!existsSync(join(root, 'ideas')));
                assert.ok(!existsSync(join(root, '.specify', 'feature.prespec.json')));
                accepted = false;
                assert.match((await start(bound.revision)).body, /did not accept/);
                assert.deepEqual(sent.map(item => item.target), ['child-discovery', 'child-discovery']);
                entry.enabled = false;
                save();
                assert.match((await start(bound.revision)).body, /Enable Pre-Spec Cards/);
                assert.equal(sent.length, 2);
            } finally {
                await board.close();
                rmSync(root, { recursive: true, force: true });
            }
        });

        it('routes a new Product Change draft only to the reviewed project and session', async () => {
            const root = mkdtempSync(join(tmpdir(), 'canvas-product-change-'));
            const skill = 'speckit-pdac-product-change';
            const skillPath = `.github/skills/${skill}/SKILL.md`;
            const config = join(root, '.product', 'config.yaml');
            const registry = join(root, '.specify', 'extensions', '.registry');
            for (const path of [config, registry, join(root, skillPath)]) mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(join(root, '.specify', 'integration.json'), '{"integration":"copilot"}');
            writeFileSync(join(root, skillPath), '# Draft Product Change');
            const requests = [];
            let accepted = true;
            let dispatchError;
            const board = await createSpecServer({ root, saveRoot: () => {}, send: async (prompt, target) => {
                requests.push({ prompt, target });
                if (dispatchError) throw dispatchError;
                return accepted;
            } });
            const headers = { 'x-speckit-token': board.token };
            const status = async () => JSON.parse((await call(board, '/api/product-change', { headers })).body);
            const start = (revision, extra = {}) => call(board, '/api/product-change', { method: 'POST', headers,
                body: { revision, expectedRoot: root, name: 'share-views', description: 'Let teams share saved views.', ...extra } });
            try {
                assert.equal((await status()).setup, true);
                writeFileSync(registry, JSON.stringify({ extensions: { 'pdac-product': { version: '0.1.0', registered_skills: [skill] } } }));
                assert.match((await status()).reason, /Initialize ProductShape/);
                writeFileSync(config, 'product-root: docs/product');
                const owning = await status();
                board.bindSession({ sessionId: 'child-product', cwd: root, name: 'Product workspace' });
                assert.equal((await start(owning.revision)).status, 400);
                const beforeEdit = await status();
                assert.equal(beforeEdit.target, 'Product workspace');
                writeFileSync(config, 'product-root: product');
                assert.match((await start(beforeEdit.revision)).body, /configuration changed/);
                const { revision } = await status();
                assert.equal((await start(revision, { expectedRoot: 'another repository' })).status, 400);
                for (const name of ['../another', 'Not-A-Slug', 'con', 'a--b', 'x'.repeat(81)]) {
                    assert.equal((await start(revision, { name })).status, 400, name);
                }
                assert.equal((await start(revision, { description: 'x'.repeat(3001) })).status, 400);
                const changes = join(root, '.specify', 'productshape', 'changes');
                mkdirSync(join(changes, 'existing'), { recursive: true });
                assert.match((await start(revision, { name: 'existing' })).body, /already exists/);
                assert.deepEqual(requests, []);
                accepted = false;
                assert.match((await start(revision)).body, /did not accept/);
                dispatchError = Object.assign(new Error('The draft subprocess failed.'), { status: 2 });
                const failed = await start(revision);
                assert.equal(failed.status, 400);
                assert.deepEqual(JSON.parse(failed.body), { error: dispatchError.message });
                dispatchError = undefined;
                accepted = true;
                const result = await start(revision);
                assert.equal(result.status, 200, result.body);
                assert.deepEqual(requests.map(request => request.target), ['child-product', 'child-product', 'child-product']);
                assert.match(requests.at(-1).prompt, /speckit-pdac-product-change .*named "share-views"/);
                assert.ok(requests.at(-1).prompt.includes(JSON.stringify('.specify/productshape/changes/share-views')));
                assert.match(requests.at(-1).prompt, /Do not run initial-baseline mode, approve, apply, archive, or edit the accepted model/);
                assert.equal(existsSync(join(changes, 'share-views')), false);
                assert.equal(existsSync(join(root, 'specs')), false);
            } finally {
                await board.close();
                rmSync(root, { recursive: true, force: true });
            }
        });

        it('sends only a reviewed generation request for the exact spec and revision', async () => {
            const root = mkdtempSync(join(tmpdir(), 'canvas-generate-evidence-'));
            const spec = 'specs/001-inbox';
            const registry = join(root, '.specify/extensions/.registry');
            const installed = { version: '1.3.0', registered_skills: ['speckit-preview-preview'] };
            const diagram = { version: '0.2.2', registered_skills: ['speckit-data-model-diagram-generate'] };
            const saveRegistry = () => writeFileSync(registry, JSON.stringify({ extensions: { preview: installed, 'data-model-diagram': diagram } }));
            for (const path of [spec, 'specs/002-unrelated', '.specify/scripts/bash', '.specify/extensions/preview/templates/preview',
                '.github/skills/speckit-preview-preview', '.github/skills/speckit-data-model-diagram-generate']) mkdirSync(join(root, path), { recursive: true });
            writeFileSync(join(root, 'specs/002-unrelated/spec.md'), '# Unrelated');
            writeFileSync(join(root, spec, 'spec.md'), '# Inbox');
            writeFileSync(join(root, spec, 'data-model.md'), '# Inbox model');
            writeFileSync(join(root, '.specify/integration.json'), '{"default_integration":"copilot"}');
            writeFileSync(join(root, '.specify/feature.json'), '{"feature_directory":"specs/002-unrelated"}');
            writeFileSync(join(root, '.specify/extensions/preview/templates/preview/wireflow.html'), '<main></main>');
            writeFileSync(join(root, '.specify/scripts/bash/check-prerequisites.sh'), '');
            for (const { registered_skills: [skill] } of [installed, diagram]) writeFileSync(join(root, '.github/skills', skill, 'SKILL.md'), `# ${skill}`);
            saveRegistry();
            const sent = [];
            const targets = [];
            const board = await createSpecServer({ root, saveRoot: () => {}, send: async (prompt, target) => {
                sent.push(prompt);
                targets.push(target);
                return true;
            } });
            const headers = { 'x-speckit-token': board.token };
            const post = (route, body) => call(board, `/api/evidence/${route}`, { method: 'POST', headers, body: { expectedRoot: root, ...body } });
            const preview = { spec, generator: 'preview', fidelity: 'low' };
            const requested = async (body) => {
                const response = await post('generation-preview', body);
                assert.equal(response.status, 200, response.body);
                return JSON.parse(response.body);
            };
            try {
                const listing = await call(board, `/api/evidence/generators?id=${spec}`, { headers });
                assert.match(JSON.parse(listing.body).generators.find(item => item.id === 'preview').reason, /uc.md/);
                writeFileSync(join(root, spec, 'uc.md'), '# Use cases');
                assert.equal((await post('generation-preview', { ...preview, fidelity: 'low; anything' })).status, 400);
                assert.equal((await post('generate', preview)).status, 400);
                assert.equal((await post('generation-preview', { ...preview, expectedRoot: 'other' })).status, 400);
                const first = await requested(preview);
                assert.deepEqual(first.inputs, [`${spec}/spec.md`, `${spec}/uc.md`]);
                assert.equal(first.output, `${spec}/preview/wireflow.html`);
                assert.equal(first.overwrite, false);
                writeFileSync(join(root, spec, 'uc.md'), '# Revised use cases');
                assert.equal((await post('generate', { ...preview, revision: first.revision })).status, 400);
                const updated = await requested(preview);
                mkdirSync(join(root, spec, 'preview'));
                writeFileSync(join(root, first.output), '<main>Existing wireflow</main>');
                assert.equal((await post('generate', { ...preview, revision: updated.revision })).status, 400);
                const replacement = await requested(preview);
                assert.equal(replacement.overwrite, true);
                assert.equal((await post('generate', { ...preview, fidelity: 'high', revision: replacement.revision })).status, 400);
                assert.deepEqual(sent, []);
                board.bindSession({ sessionId: 'child-inbox', cwd: root, name: 'Inbox session' });
                assert.equal((await post('generate', { ...preview, revision: replacement.revision })).status, 400);
                const bound = await requested(preview);
                assert.equal(bound.target, 'Inbox session');
                assert.equal((await post('generate', { ...preview, revision: bound.revision })).status, 200);
                assert.match(sent[0], /"001-inbox" as the explicit SPECIFY_FEATURE.*Pass low as the first skill argument/);
                assert.match(sent[0], /Update only "specs\/001-inbox\/preview\/wireflow.html"/);
                const model = { spec, generator: 'data-model-diagram' };
                assert.equal((await post('generate', { ...model, revision: (await requested(model)).revision })).status, 200);
                assert.match(sent[1], /SPECIFY_FEATURE_DIRECTORY=specs\/001-inbox and SPECIFY_FEATURE_NO_PERSIST=1/);
                assert.doesNotMatch(sent.join('\n'), /002-unrelated/);
                assert.deepEqual(targets, ['child-inbox', 'child-inbox']);
                assert.equal(readFileSync(join(root, first.output), 'utf8'), '<main>Existing wireflow</main>');
                assert.equal(existsSync(join(root, spec, 'data-model-diagram.mmd')), false);
                installed.version = '9.9.9';
                saveRegistry();
                assert.match((await post('generation-preview', preview)).body, /requires the reviewed extension version/);
            } finally {
                await board.close();
                rmSync(root, { recursive: true, force: true });
            }
        });

        it('reviews only the exact paused gate and never resumes the run', async () => {
            const root = mkdtempSync(join(tmpdir(), 'canvas-gate-review-'));
            const spec = 'specs/001-inbox';
            const path = `${spec}/spec.md`;
            const folder = join(root, '.specify', 'workflows', 'runs', 'review-1');
            mkdirSync(join(root, spec), { recursive: true });
            mkdirSync(folder, { recursive: true });
            writeFileSync(join(root, path), '# Inbox');
            const state = { run_id: 'review-1', workflow_id: 'review', status: 'paused', current_step_id: 'review-spec',
                inputs: { feature_dir: spec }, step_results: { 'review-spec': { type: 'gate', status: 'paused', output: { options: ['approve', 'reject'] } } } };
            const stateFile = join(folder, 'state.json');
            const definition = join(folder, 'workflow.yml');
            writeFileSync(stateFile, JSON.stringify(state));
            writeFileSync(definition, 'steps: [{id: review-spec, type: gate}]');
            const sent = [];
            let terminalsOpened = 0;
            const board = await createSpecServer({ root, openTerminal: async () => { terminalsOpened++; }, send: async prompt => { sent.push(prompt); return true; } });
            const headers = { 'x-speckit-token': board.token };
            const get = async path => JSON.parse((await call(board, path, { headers })).body);
            const post = (route, body) => call(board, route, { method: 'POST', headers, body: { expectedRoot: root, ...body } });
            try {
                const { runs: [run], terminalAvailable } = await get(`/api/workflow-reviews?id=${spec}`);
                assert.equal(terminalAvailable, true);
                assert.equal((await post('/api/terminal', {})).status, 200);
                assert.equal(terminalsOpened, 1);
                assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), state);
                const { revision: version } = await get(`/api/artifact?id=${spec}&path=${path}`);
                const gate = { run: run.id, step: run.gate, version: run.reviewVersion };
                const review = { spec, path, version, gate, decision: 'request-changes', note: 'Check retry behavior', confirmed: true };
                assert.deepEqual(run.choices, ['approve', 'reject']);
                const rejected = await post('/api/artifact/review', { ...review, gate: { ...gate, step: 'wrong' } });
                assert.equal(rejected.status, 400);
                const recorded = await post('/api/artifact/review', review);
                assert.equal(recorded.status, 200, recorded.body);
                assert.deepEqual(JSON.parse(recorded.body).gate, gate);
                assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), state);
                assert.deepEqual(sent, []);
                const impact = await post('/api/impact', { spec, path, version, gate });
                assert.equal(impact.status, 200, impact.body);
                assert.match(sent[0], /paused gate "review-spec" in Spec Kit run review-1/);
                const pause = await post('/api/impact', { spec, gate });
                assert.equal(pause.status, 200, pause.body);
                assert.match(sent[1], /Explain the code impact of the workflow pause/);
                assert.ok(sent[1].includes(gate.version));
                assert.ok(!sent[1].includes('Artifact SHA-256'));
                assert.equal((await post('/api/impact', { spec })).status, 400);
                writeFileSync(definition, 'steps: [{id: review-spec, type: gate, message: Revised}]');
                assert.equal((await post('/api/artifact/review', review)).status, 400);
                assert.equal((await post('/api/impact', { spec, path, version, gate })).status, 400);
                assert.equal((await post('/api/impact', { spec, gate })).status, 400);
                assert.equal(sent.length, 2);
                writeFileSync(stateFile, JSON.stringify({ ...state, inputs: {} }));
                assert.deepEqual((await get(`/api/workflow-reviews?id=${spec}`)).runs, []);
                assert.equal((await get('/api/workflow-runs')).runs[0].reviewVersion, null);
            } finally {
                await board.close();
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
});

describe('canvas ecosystem setup', () => {
    it('runs catalog inspection only in the owning checkout', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-catalog-owner-'));
        try {
            mkdirSync(join(root, '.specify'));
            for (const workingDirectory of [root, tmpdir()]) {
                const board = await createSpecServer({ root, workingDirectory, manual: workingDirectory !== root, saveRoot: () => {} });
                try {
                    const post = expectedRoot => call(board, '/api/integrations/catalogs', {
                        method: 'POST', headers: { 'x-speckit-token': board.token }, body: { expectedRoot },
                    });
                    assert.match((await post(tmpdir())).body, /repository changed/);
                    assert.match((await post(root)).body, workingDirectory === root
                        ? /Set up the repository-local CLI/ : /session that owns this repository/);
                    if (workingDirectory === root) {
                        board.bindSession({ sessionId: 'child', cwd: root, name: 'Child' });
                        assert.match((await post(root)).body, /session that owns this repository/);
                    }
                } finally {
                    await board.close();
                }
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('shows catalog precedence without exposing credentials or claiming catalog installs are approved', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-catalog-stack-'));
        const cli = join(root, process.platform === 'win32' ? '.venv/Scripts/specify.exe' : '.venv/bin/specify');
        const python = join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
        try {
            mkdirSync(join(cli, '..'), { recursive: true });
            writeFileSync(cli, '');
            writeFileSync(python, '');
            writeFileSync(join(root, '.venv', 'pyvenv.cfg'), '');
            const execute = async (file, args, cwd) => {
                assert.equal(cwd, root);
                if (file === cli) return '{"cli_version":"1.4.3"}';
                assert.equal(file, python);
                assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
                return JSON.stringify({
                    extension: {
                        sources: [
                            { name: 'team', priority: 1, installAllowed: true, url: 'https://user:password@catalog.example/private?access=secret#token' },
                            { name: 'community', priority: 2, installAllowed: false, url: 'https://catalog.example/community.json' },
                        ],
                    },
                    preset: { error: true },
                    workflow: { sources: [] },
                    bundle: { sources: [{ name: 'default', priority: 20, installAllowed: true, url: 'builtin://default' }] },
                });
            };
            const ecosystem = createEcosystem({ execute });
            const catalogs = await ecosystem.inspectCatalogs(root);
            assert.deepEqual(catalogs[0], { kind: 'extension', sources: [
                { name: 'team', priority: 1, installAllowed: true, location: 'catalog.example' },
                { name: 'community', priority: 2, installAllowed: false, location: 'catalog.example' },
            ] });
            assert.deepEqual(catalogs[1], { kind: 'preset', unavailable: true });
            assert.deepEqual(catalogs[2], { kind: 'workflow', sources: [] });
            assert.deepEqual(catalogs[3].sources[0].location, 'Bundled with Spec Kit');
            assert.throws(() => ecosystem.preview(root, 'team'), /not approved/);
            const broken = createEcosystem({ execute: async file => {
                if (file === cli) return '{"cli_version":"1.4.3"}';
                throw new Error('Invalid catalog at https://user:password@catalog.example/private');
            } });
            await assert.rejects(broken.inspectCatalogs(root), { message: 'Spec Kit could not inspect catalog sources. Check the catalog configuration in the owning session.' });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not offer the Bash-only diagram package on a PowerShell checkout', () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-diagram-prerequisite-'));
        try {
            const cli = join(root, process.platform === 'win32' ? '.venv/Scripts/specify.exe' : '.venv/bin/specify');
            mkdirSync(join(cli, '..'), { recursive: true });
            writeFileSync(cli, '');
            mkdirSync(join(root, '.specify/scripts/powershell'), { recursive: true });
            writeFileSync(join(root, '.specify/integration.json'), '{"integration":"copilot"}');
            writeFileSync(join(root, '.specify/scripts/powershell/check-prerequisites.ps1'), '');
            const ecosystem = createEcosystem({});
            assert.throws(() => ecosystem.preview(root, 'data-model-diagram'), /requires Spec Kit’s Bash scripts/);
            mkdirSync(join(root, '.specify/scripts/bash'));
            writeFileSync(join(root, '.specify/scripts/bash/check-prerequisites.sh'), '');
            assert.match(ecosystem.preview(root, 'data-model-diagram').changes, /after-Plan hook/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('can initialize a new Copilot project with Bash scripts, without converting an existing project', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-bash-init-'));
        try {
            const cli = join(root, process.platform === 'win32' ? '.venv/Scripts/specify.exe' : '.venv/bin/specify');
            mkdirSync(join(cli, '..'), { recursive: true });
            writeFileSync(cli, '');
            const skills = join(root, '.github', 'skills');
            mkdirSync(skills, { recursive: true });
            mkdirSync(join(skills, 'team-skill'));
            const ecosystem = createEcosystem({ execute: async (_file, args) => {
                if (args[0] === 'version') return '{"cli_version":"1.4.3"}';
                assert.deepEqual(args, ['init', '--here', '--non-interactive', '--force', '--integration', 'copilot', '--integration-options=--skills', '--script', 'sh']);
                mkdirSync(join(root, '.specify/scripts/bash'), { recursive: true });
                writeFileSync(join(root, '.specify/integration.json'), '{"integration":"copilot"}');
                writeFileSync(join(root, '.specify/scripts/bash/check-prerequisites.sh'), '');
            } });
            const { changes, token } = ecosystem.preview(root, 'init:bash');
            assert.match(changes, /does not install Bash/);
            mkdirSync(join(skills, 'SpecKit-plan'));
            await assert.rejects(ecosystem.confirmed(root, token), /will not overwrite/);
            assert.throws(() => ecosystem.preview(root, 'init:bash'), /will not overwrite/);
            rmSync(join(skills, 'SpecKit-plan'), { recursive: true });
            assert.match((await ecosystem.confirmed(root, ecosystem.preview(root, 'init:bash').token)).outcome, /configured with Bash scripts/);
            assert.match(ecosystem.preview(root, 'data-model-diagram').changes, /after-Plan hook/);
            assert.throws(() => ecosystem.preview(root, 'init:bash'), /only offered before .specify exists/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('projects Spec Kit’s configured hooks and effective layers without evaluating hidden layers', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-artifact-stack-'));
        const cli = join(root, process.platform === 'win32' ? '.venv/Scripts/specify.exe' : '.venv/bin/specify');
        const execute = async (file, args, cwd) => {
            assert.equal(file, cli);
            assert.equal(cwd, root);
            if (args[0] === 'version') return '{"cli_version":"1.4.3"}';
            assert.deepEqual(args, ['artifact', 'list', '--json']);
            return JSON.stringify([
                { kind: 'hook', name: 'after_plan:speckit.diagram', registered: false,
                    stack: [{ sourceId: 'diagram', active: false, optional: true, manifestPath: 'extension.yml', strategy: 'additive' }] },
                { kind: 'template', name: 'plan-template', stack: [
                    { active: true, presetId: 'lean', strategy: 'replace', sourcePath: 'lean/plan.md' },
                    { active: false, hidden: true, sourcePath: 'hidden.md' },
                ] },
                { kind: 'script', name: 'initialize', stack: [] },
            ]);
        };
        try {
            mkdirSync(join(cli, '..'), { recursive: true });
            writeFileSync(cli, '');
            assert.deepEqual(await createEcosystem({ execute }).inspectArtifacts(root), [
                { kind: 'hook', name: 'after_plan:speckit.diagram', registered: false,
                    layers: [{ source: 'diagram', active: false, optional: true, path: 'extension.yml', strategy: 'additive' }] },
                { kind: 'template', name: 'plan-template', registered: false,
                    layers: [{ source: 'lean', active: true, optional: false, path: 'lean/plan.md', strategy: 'replace' }] },
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps installed packages separate from the vetted candidate and declared-hook inventory', () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-catalog-'));
        try {
            mkdirSync(join(root, '.specify', 'extensions'), { recursive: true });
            writeFileSync(join(root, '.specify', 'extensions', '.registry'), '{"extensions":{"roadmap":{"enabled":true,"version":"0.1.0"},"figma":{"enabled":true,"version":"3.0.0"}}}');
            const { catalog, packages } = integrationSnapshot(root);
            assert.deepEqual(packages[0].installed.map(item => item.id), ['roadmap', 'figma']);
            assert.deepEqual(catalog.filter(item => item.source.toLowerCase().includes('figma')).map(item => item.source), ['https://github.com/Fyloss/spec-kit-figma']);
            assert.equal(catalog.find(item => item.id === 'figma').certification, 'Installed version 3.0.0 differs from the reviewed version 3.1.1; re-verification needed.');
            for (const id of ['roadmap', 'intake', 'epic', 'adrkit', 'spec-status', 'agent-assign']) {
                assert.ok(!catalog.some(item => item.id === id), id);
            }
            const guard = catalog.find(item => item.id === 'docguard');
            assert.equal(guard.installed, false);
            assert.ok(guard.declaredHooks.includes('Before Specify'));
            assert.match(guard.certification, /Copilot skills registered.*workflow behavior not verified/);
            assert.equal(Object.hasOwn(guard, 'activeHooks'), false);
            const illustrate = catalog.find(item => item.id === 'illustrate');
            assert.equal(illustrate.setupAvailable, true);
            assert.deepEqual(illustrate.declaredHooks, []);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('binds confirmation to the previewed repository and package state and consumes it once', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-integration-'));
        const cli = process.platform === 'win32' ? '.venv/Scripts/specify.exe' : '.venv/bin/specify';
        const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
        const commands = [];
        const execute = async (file, args, cwd) => {
            commands.push({ file, args, cwd });
            if (args[0] === 'version') return '{"cli_version":"1.4.3"}';
            if (args[0] === '-I') {
                mkdirSync(join(root, '.github', 'skills', 'speckit-figma-config'), { recursive: true });
                writeFileSync(join(root, '.github', 'skills', 'speckit-figma-config', 'SKILL.md'), '# Figma');
                writeFileSync(join(root, '.specify', 'extensions', '.registry'), '{"extensions":{"figma":{"version":"3.1.1","registered_skills":["speckit-figma-config"]}}}');
            }
            if (args[1] === 'list') return '[{"id":"figma","name":"Spec Kit Figma","enabled":true,"version":"3.1.1"}]';
        };
        try {
            mkdirSync(join(root, cli, '..'), { recursive: true });
            mkdirSync(join(root, '.specify', 'extensions'), { recursive: true });
            writeFileSync(join(root, cli), '');
            writeFileSync(join(root, python), '');
            writeFileSync(join(root, '.venv', 'pyvenv.cfg'), '');
            writeFileSync(join(root, '.specify', 'integration.json'), '{"integration":"copilot"}');
            const ecosystem = createEcosystem({ execute });
            const prototype = ecosystem.preview(root, 'preview');
            assert.match(prototype.changes, /preview 1\.3\.0.*with no lifecycle hooks/);
            assert.match(prototype.changes, /Installing does not generate a prototype/);
            const illustrate = ecosystem.preview(root, 'illustrate');
            assert.match(illustrate.changes, /illustrate 2\.8\.0.*with no lifecycle hooks/);
            assert.match(illustrate.changes, /does not select a project theme, generate a diagram, or install browser export dependencies/);
            const charter = ecosystem.preview(root, 'charter');
            assert.match(charter.changes, /optional before-Constitution hook/);
            assert.match(charter.changes, /does not configure or fetch a Charter registry, run the hook, or change the constitution/);
            assert.match(ecosystem.preview(root, 'pdac').changes, /optional after-Specify, after-Plan and after-Tasks hooks can edit feature documents/);
            assert.match(ecosystem.preview(root, 'pdac-product').changes, /with no lifecycle hooks[\s\S]*requires separate human approval and a dry run/);
            assert.match(ecosystem.preview(root, 'docguard').changes, /required hooks before Specify, before Tasks, and after Implement[\s\S]*They can block work/);
            assert.match(ecosystem.preview(root, 'wireframe').changes, /Generation needs separate preflight approval; design sign-off can edit spec\.md/);
            assert.deepEqual(commands, [], 'reviewing package setup must not call the CLI');
            const changed = ecosystem.preview(root, 'figma');
            const registry = join(root, '.specify', 'extensions', '.registry');
            writeFileSync(registry, '{"extensions":{"bug":{"version":"1.0.2"}}}');
            await assert.rejects(ecosystem.confirmed(root, changed.token), /project setup changed/);
            const reviewed = ecosystem.preview(root, 'figma');
            await assert.rejects(ecosystem.confirmed(join(root, 'other'), reviewed.token), /this repository again/);
            assert.deepEqual(commands, []);
            assert.match((await ecosystem.confirmed(root, reviewed.token)).outcome, /Figma 3\.1\.1/);
            assert.equal(commands[1].file, join(root, python));
            assert.deepEqual(commands[1].args.slice(0, 2), ['-I', '-c']);
            assert.match(commands[1].args[3], /github\.com\/Fyloss\/spec-kit-figma\/archive\/[a-f0-9]{40}\.zip$/);
            assert.match(commands[1].args[4], /^[a-f0-9]{64}$/);
            assert.ok(reviewed.changes.includes(commands[1].args[4]));
            assert.deepEqual(commands[1].args.slice(5), ['figma', '3.1.1', '1.4.3', 'extension']);
            await assert.rejects(ecosystem.confirmed(root, reviewed.token), /this repository again/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails closed for a missing bundled preset without falling back to a catalog', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-bundled-setup-'));
        try {
            const bin = process.platform === 'win32' ? '.venv/Scripts' : '.venv/bin';
            mkdirSync(join(root, bin), { recursive: true });
            writeFileSync(join(root, bin, process.platform === 'win32' ? 'specify.exe' : 'specify'), '');
            writeFileSync(join(root, bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
            writeFileSync(join(root, '.venv', 'pyvenv.cfg'), '');
            mkdirSync(join(root, '.specify'));
            writeFileSync(join(root, '.specify', 'integration.json'), '{"integration":"copilot"}');
            const attempts = [];
            const ecosystem = createEcosystem({ execute: async (file, args) => {
                if (args[0] === 'version') return '{"cli_version":"1.4.3"}';
                attempts.push([file, args]);
                throw new Error('The expected bundled package is missing.');
            } });
            const { token } = ecosystem.preview(root, 'preset:lean');
            await assert.rejects(ecosystem.confirmed(root, token), /bundled package is missing/);
            assert.equal(attempts.length, 1);
            assert.equal(attempts[0][0], join(root, bin, process.platform === 'win32' ? 'python.exe' : 'python'));
            assert.deepEqual(attempts[0][1].slice(3), ['preset', 'lean', '1.0.0', '1.4.3']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('blocks an enabled competing delivery owner and invalidates earlier setup reviews', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-delivery-setup-'));
        const bin = join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
        const registry = join(root, '.specify', 'extensions', '.registry');
        const ecosystem = createEcosystem({ execute: () => assert.fail('Conflicting setup must not call the CLI') });
        const register = (id, enabled) => writeFileSync(registry, JSON.stringify({ extensions: { [id]: { enabled } } }));
        try {
            mkdirSync(bin, { recursive: true });
            writeFileSync(join(bin, process.platform === 'win32' ? 'specify.exe' : 'specify'), '');
            mkdirSync(join(root, '.specify', 'extensions'), { recursive: true });
            writeFileSync(join(root, '.specify', 'integration.json'), '{"integration":"copilot"}');
            for (const [id, other] of [['project', 'ghp'], ['ghp', 'project']]) {
                register(other, false);
                const reviewed = ecosystem.preview(root, id);
                assert.match(reviewed.changes, /blocks generic Create issues/);
                register(other, true);
                await assert.rejects(ecosystem.confirmed(root, reviewed.token), /project setup changed/);
                const candidate = integrationSnapshot(root).catalog.find(item => item.id === id);
                assert.equal(candidate.setupAvailable, false);
                assert.match(candidate.setupBlocked, new RegExp(`Disable ${other}`));
                assert.throws(() => ecosystem.preview(root, id), /before installing a second GitHub delivery owner/);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('installs OKR Bets and its stock Specify preset only with separate reviews', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-okr-setup-'));
        const bin = join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
        const registry = join(root, '.specify', 'extensions', '.registry');
        const presetRegistry = join(root, '.specify', 'presets', '.registry');
        const skills = ['frame', 'set', 'align', 'measure', 'review', 'checkin', 'status'].map(name => `speckit-okr-${name}`);
        const writeExtension = enabled => writeFileSync(registry, JSON.stringify({
            extensions: { okr: { version: '0.2.1', enabled, registered_skills: skills } },
        }));
        const downloads = [];
        const ecosystem = createEcosystem({ execute: async (_file, args) => {
            if (args[0] === 'version') return '{"cli_version":"1.4.3"}';
            if (args.join(' ') === 'extension list --json') return '[{"id":"okr","name":"OKR Bets","version":"0.2.1","enabled":true}]';
            assert.equal(args[0], '-I');
            const [source, sha, id, , , kind] = args.slice(3);
            downloads.push({ source, sha, id, kind });
            if (kind === 'extension') {
                for (const skill of skills) {
                    const path = join(root, '.github', 'skills', skill);
                    mkdirSync(path, { recursive: true });
                    writeFileSync(join(path, 'SKILL.md'), '# Registered');
                }
                writeExtension(true);
            } else {
                writeFileSync(presetRegistry, '{"presets":{"okr-bet":{"version":"0.2.1","enabled":true}}}');
            }
        } });
        try {
            for (const path of [bin, join(registry, '..'), join(presetRegistry, '..')]) mkdirSync(path, { recursive: true });
            for (const name of ['specify', 'python']) writeFileSync(join(bin, process.platform === 'win32' ? `${name}.exe` : name), '');
            writeFileSync(join(root, '.venv', 'pyvenv.cfg'), '');
            writeFileSync(join(root, '.specify', 'integration.json'), '{"integration":"copilot"}');
            const row = () => integrationSnapshot(root).catalog.find(item => item.id === 'okr');
            assert.ok(row().setupAvailable);
            assert.equal(row().presetSetup, undefined);
            assert.throws(() => ecosystem.preview(root, 'preset:okr-bet'), /needs the reviewed OKR Bets/);
            const extension = ecosystem.preview(root, 'okr');
            assert.match(extension.changes, /optional hooks before Specify, after Specify, and after Plan/);
            assert.equal(downloads.length, 0);
            assert.match((await ecosystem.confirmed(root, extension.token)).outcome, /Installed OKR Bets/);
            assert.equal(downloads.length, 1);
            assert.equal(downloads[0].kind, 'extension');
            assert.ok(extension.changes.includes(downloads[0].sha));
            assert.equal(existsSync(presetRegistry), false);
            assert.equal(row().presetSetup.id, 'preset:okr-bet');
            const preset = ecosystem.preview(root, 'preset:okr-bet');
            assert.match(preset.changes, /stock Specify command and spec template/);
            assert.match(preset.changes, /does not replace the Companion Specify command/);
            writeExtension(false);
            await assert.rejects(ecosystem.confirmed(root, preset.token), /project setup changed/);
            assert.equal(row().presetSetup, undefined);
            assert.equal(downloads.length, 1);
            writeExtension(true);
            const reviewed = ecosystem.preview(root, 'preset:okr-bet');
            assert.match((await ecosystem.confirmed(root, reviewed.token)).outcome, /Registered the OKR Bet preset/);
            assert.deepEqual(downloads.map(({ id, kind }) => [kind, id]), [['extension', 'okr'], ['preset', 'okr-bet']]);
            assert.ok(reviewed.changes.includes(downloads[1].sha));
            assert.throws(() => ecosystem.preview(root, 'preset:okr-bet'), /will not be overwritten/);
            assert.equal(row().presetSetup, undefined);
            assert.ok(!existsSync(join(root, '.specify', 'okr')));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('registers both Pre-Spec Cards skills without starting discovery', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-prespec-setup-'));
        const bin = join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
        const skills = ['speckit-prespec-idea', 'speckit-prespec-playthrough'];
        const registry = join(root, '.specify', 'extensions', '.registry');
        try {
            mkdirSync(bin, { recursive: true });
            writeFileSync(join(bin, process.platform === 'win32' ? 'specify.exe' : 'specify'), '');
            writeFileSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
            writeFileSync(join(root, '.venv', 'pyvenv.cfg'), '');
            mkdirSync(join(root, '.specify', 'extensions'), { recursive: true });
            writeFileSync(join(root, '.specify', 'integration.json'), '{"integration":"copilot"}');
            const catalogEntry = () => integrationSnapshot(root).catalog.find(item => item.id === 'prespec');
            let installed = [];
            const calls = [];
            const ecosystem = createEcosystem({ execute: async (_file, args) => {
                calls.push(args);
                if (args[0] === 'version') return '{"cli_version":"1.4.3"}';
                if (args[0] === '-I') {
                    for (const skill of installed) {
                        const dir = join(root, '.github', 'skills', skill);
                        mkdirSync(dir, { recursive: true });
                        writeFileSync(join(dir, 'SKILL.md'), '# Registered skill');
                    }
                    writeFileSync(registry, JSON.stringify({ extensions: { prespec: { version: '0.4.0', registered_skills: installed } } }));
                    return '';
                }
                if (args.join(' ') === 'extension list --json') return '[{"id":"prespec","name":"Pre-Spec Cards","enabled":true,"version":"0.4.0"}]';
                assert.fail(`Unexpected command: ${args[0]}`);
            } });
            assert.equal(catalogEntry().setupAvailable, true);
            const incomplete = ecosystem.preview(root, 'prespec');
            assert.match(incomplete.changes, /no lifecycle hooks/);
            assert.match(incomplete.changes, /does not create ideas/);
            assert.deepEqual(calls, []);
            installed = skills.slice(0, 1);
            await assert.rejects(ecosystem.confirmed(root, incomplete.token), /speckit-prespec-playthrough/);
            rmSync(registry);
            installed = skills;
            const full = ecosystem.preview(root, 'prespec');
            assert.match((await ecosystem.confirmed(root, full.token)).outcome, /Installed Pre-Spec Cards 0\.4\.0/);
            assert.equal(catalogEntry().setupAvailable, false);
            assert.ok(!existsSync(join(root, 'ideas')));
            assert.ok(!existsSync(join(root, '.specify', 'feature.prespec.json')));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('custom workflow persistence and phases', () => {
    it('records the selected workflow with the shared writer and exposes extra phases and confirmed checkpoints', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-custom-workflow-'));
        const settingsDir = join(root, '.vscode');
        mkdirSync(settingsDir);
        const settingsFile = join(settingsDir, 'settings.json');
        writeFileSync(settingsFile, JSON.stringify({
            'speckit.customWorkflows': [{
                name: 'demo',
                steps: [
                    { name: 'specify', command: 'demo.specify', file: 'spec.md' },
                    { name: 'design', label: 'Design', command: 'demo.design', file: 'design.md' },
                    { name: 'publish', command: 'demo.publish', actionOnly: true },
                    { name: 'implement', command: 'demo.implement', actionOnly: true },
                ],
                checkpoints: [
                    { id: 'commit', trigger: 'after-implement' },
                    { id: 'pr', trigger: 'after-commit', prTitleTemplate: 'feat: ${featureName}' },
                ],
            }],
        }));
        const sent = [];
        const board = await createSpecServer({ root, send: async prompt => { sent.push(prompt); return true; } });
        const headers = { 'x-speckit-token': board.token };
        const post = (path, body) => call(board, path, { method: 'POST', headers, body: { expectedRoot: root, ...body } });
        try {
            const specify = await post('/api/specify', { description: 'A new feature', workflow: 'demo' });
            assert.equal(specify.status, 200, specify.body);
            assert.equal(JSON.parse(specify.body).workflow, 'demo');

            const dir = join(root, 'specs', '101-new-feature');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'spec.md'), '# New feature\n');
            writeFileSync(join(dir, 'design.md'), '# Design\n');
            writeFileSync(join(dir, 'tasks.md'), '- [x] T001 Implement the feature\n');
            const contextFile = join(dir, '.spec-context.json');
            writeFileSync(contextFile, JSON.stringify({
                workflow: 'speckit',
                specName: 'New feature',
                branch: 'main',
                currentStep: 'implement',
                status: 'implemented',
                history: [],
                repositoryField: 'preserved',
            }));
            board.rescan();
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline && board.snapshot.specs.find(spec => spec.name === '101-new-feature')?.workflow !== 'demo') {
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            const saved = JSON.parse(readFileSync(contextFile, 'utf8'));
            assert.equal(saved.workflow, 'demo');
            assert.equal(saved.repositoryField, 'preserved');

            const detailResponse = await call(board, '/api/spec?id=101-new-feature', { headers });
            assert.equal(detailResponse.status, 200);
            const detail = JSON.parse(detailResponse.body);
            assert.deepEqual(detail.customPhases.map(phase => [phase.name, phase.title, phase.file]), [
                ['design', 'Design', 'design.md'], ['publish', 'Publish', null],
            ]);
            assert.deepEqual(detail.checkpoints.map(checkpoint => checkpoint.id), ['commit', 'pr']);
            assert.equal(detail.spec.steps.implement, 'completed');

            const phase = await post('/api/custom-step', { spec: '101-new-feature', step: 'design' });
            assert.equal(phase.status, 200, phase.body);
            assert.match(sent.at(-1), /^\/demo\.design specs\/101-new-feature/);
            assert.match(sent.at(-1), /"design\.md"/);
            const designPrompt = sent.at(-1);
            const phaseRun = name => board.detail('101-new-feature').customPhases.find(item => item.name === name).run;
            await board.settle();
            assert.equal(phaseRun('design').status, 'sent');
            board.began(designPrompt, { messageId: 'design-1', agentMode: 'autopilot' });
            assert.equal(phaseRun('design').status, 'running');
            writeFileSync(join(dir, 'design.md'), '# Updated design\n');
            await board.settle(undefined, { mode: 'autopilot' });
            await board.stopAutopilot({ requestId: 'another-request', reason: 'task_complete' });
            assert.equal(phaseRun('design').status, 'running');
            await board.stopAutopilot({ requestId: 'design-1', reason: 'task_complete' });
            assert.equal(phaseRun('design').status, 'completed');
            assert.ok(phaseRun('design').startedAt);
            const phaseContext = JSON.parse(readFileSync(contextFile, 'utf8'));
            assert.equal(phaseContext.status, saved.status);
            assert.deepEqual(phaseContext.history, saved.history);
            assert.equal(phaseContext.customPhaseRuns[0].status, 'completed');

            await post('/api/custom-step', { spec: '101-new-feature', step: 'design' });
            board.began(sent.at(-1));
            await board.settle();
            assert.equal(phaseRun('design').status, 'unverified', 'an existing output does not prove a rerun succeeded');
            await post('/api/custom-step', { spec: '101-new-feature', step: 'publish' });
            board.began(sent.at(-1));
            await board.settle();
            assert.equal(phaseRun('publish').status, 'unverified');
            await post('/api/custom-step', { spec: '101-new-feature', step: 'design' });
            board.began(sent.at(-1));
            writeFileSync(join(dir, 'design.md'), '# Partial result\n');
            await board.settle(undefined, { aborted: true });
            assert.equal(phaseRun('design').status, 'aborted');

            const denied = await post('/api/checkpoint', { spec: '101-new-feature', id: 'commit', approved: false });
            assert.equal(denied.status, 400);
            const commit = await post('/api/checkpoint', { spec: '101-new-feature', id: 'commit', approved: true });
            assert.equal(commit.status, 200, commit.body);
            assert.match(sent.at(-1), /do not stage unrelated work/);

            const recorded = await post('/api/checkpoint/commit-complete', { spec: '101-new-feature', confirmed: true });
            assert.equal(recorded.status, 200, recorded.body);
            assert.equal(JSON.parse(readFileSync(contextFile, 'utf8')).checkpointStatus.commit, 'completed');
            const pr = await post('/api/checkpoint', { spec: '101-new-feature', id: 'pr', approved: true });
            assert.equal(pr.status, 200, pr.body);
            assert.match(sent.at(-1), /"feat: New feature"/);
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('blocks dispatch for invalid settings and for a workflow missing from the repository settings', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-workflow-errors-'));
        mkdirSync(join(root, '.vscode'), { recursive: true });
        mkdirSync(join(root, 'specs', '101-orphan'), { recursive: true });
        writeFileSync(join(root, 'specs', '101-orphan', 'spec.md'), '# Orphan\n');
        writeFileSync(join(root, 'specs', '101-orphan', '.spec-context.json'), JSON.stringify({
            workflow: 'removed-workflow',
            specName: 'Orphan',
            branch: 'main',
            currentStep: 'specify',
            status: 'specified',
            history: [],
        }));
        const settingsFile = join(root, '.vscode', 'settings.json');
        writeFileSync(settingsFile, JSON.stringify({ 'speckit.defaultWorkflow': 'not-a-workflow' }));
        const sent = [];
        const board = await createSpecServer({ root, send: async prompt => { sent.push(prompt); return true; } });
        const headers = { 'x-speckit-token': board.token };
        try {
            let snapshot = JSON.parse((await call(board, '/api/snapshot', { headers })).body);
            assert.ok(snapshot.settingsErrors.some(error => error.includes('speckit.defaultWorkflow')));
            const invalid = await call(board, '/api/run', { method: 'POST', headers, body: { expectedRoot: root, spec: '101-orphan', command: 'plan' } });
            assert.equal(invalid.status, 409);
            assert.match(JSON.parse(invalid.body).error, /Repository settings are invalid/);
            assert.equal(sent.length, 0);

            const settings = JSON.parse((await call(board, '/api/settings', { headers })).body);
            const repaired = await call(board, '/api/settings', {
                method: 'POST',
                headers,
                body: { expectedRoot: root, version: settings.version, changes: { 'speckit.defaultWorkflow': null } },
            });
            assert.equal(repaired.status, 200, repaired.body);
            snapshot = JSON.parse((await call(board, '/api/snapshot', { headers })).body);
            assert.deepEqual(snapshot.settingsErrors, []);

            const orphan = await call(board, '/api/run', { method: 'POST', headers, body: { expectedRoot: root, spec: '101-orphan', command: 'plan' } });
            assert.equal(orphan.status, 409);
            assert.match(JSON.parse(orphan.body).error, /workflow recorded for this spec is unavailable/);
            snapshot = JSON.parse((await call(board, '/api/snapshot', { headers })).body);
            assert.match(snapshot.specs[0].workflowError, /removed-workflow/);
            assert.equal(sent.length, 0);
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('selected-session dispatch', () => {
    it('sends commands to the bound session and does not claim to track its turn', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-selected-session-'));
        mkdirSync(join(root, '.git'));
        mkdirSync(join(root, 'specs', '101-selected'), { recursive: true });
        writeFileSync(join(root, 'specs', '101-selected', 'spec.md'), '# Selected\n');
        const delivered = [];
        const board = await createSpecServer({
            root,
            saveRoot: () => {},
            send: async (prompt, targetSessionId) => {
                delivered.push({ prompt, targetSessionId });
                return true;
            },
        });
        const headers = { 'x-speckit-token': board.token };
        try {
            board.bindSession({ sessionId: 'selected-session', cwd: root, name: 'Selected session' });
            const response = await call(board, '/api/run', {
                method: 'POST',
                headers,
                body: { expectedRoot: root, spec: '101-selected', command: 'plan' },
            });
            assert.equal(response.status, 200, response.body);
            assert.equal(JSON.parse(response.body).targetSessionId, 'selected-session');
            assert.equal(delivered.at(-1).targetSessionId, 'selected-session');
            const detail = JSON.parse((await call(board, '/api/spec?id=101-selected', { headers })).body);
            assert.equal(detail.spec.steps.plan, 'not-started');
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('stock workflow dispatch', () => {
    it('uses the installed command spelling and identifies a selected repository', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-stock-dispatch-'));
        const skill = join(root, '.github', 'skills', 'speckit-constitution');
        mkdirSync(skill, { recursive: true });
        writeFileSync(join(skill, 'SKILL.md'), '# Constitution');
        const sent = [];
        const board = await createSpecServer({ root, workingDirectory: tmpdir(), manual: true, send: async prompt => { sent.push(prompt); return true; } });
        try {
            const response = await call(board, '/api/workflow', {
                method: 'POST',
                headers: { 'x-speckit-token': board.token },
                body: { type: 'runStockCommand', command: 'constitution' },
            });
            assert.equal(response.status, 200);
            assert.match(sent[0], /^\/speckit-constitution/);
            assert.ok(sent[0].includes(JSON.stringify(root)));
        } finally {
            await board.close();
        }
    });
});

describe('spec lifecycle API', () => {
    it('uses the shared status transitions and preserves the record', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-lifecycle-'));
        const dir = join(root, 'specs', '900-lifecycle');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'spec.md'), '# Lifecycle');
        const file = join(dir, '.spec-context.json');
        writeFileSync(file, JSON.stringify({
            workflow: 'speckit',
            specName: 'Lifecycle',
            branch: '',
            currentStep: 'implement',
            status: 'implemented',
            history: [],
            repositoryField: 'preserved',
        }));
        const board = await createSpecServer({ root });
        const send = async (action, extra = {}) => call(board, '/api/lifecycle', {
            method: 'POST',
            headers: { 'x-speckit-token': board.token },
            body: { expectedRoot: root, spec: 'specs/900-lifecycle', action, ...extra },
        });
        try {
            let response = await send('complete');
            assert.equal(response.status, 200);
            assert.deepEqual(JSON.parse(response.body).changed, ['specs/900-lifecycle']);
            let record = JSON.parse(readFileSync(file, 'utf8'));
            assert.equal(record.status, 'completed');
            assert.equal(record.history.at(-1).kind, 'complete');
            assert.equal(record.history.at(-1).by, 'extension');
            assert.equal(record.repositoryField, 'preserved');

            response = await send('complete');
            assert.deepEqual(JSON.parse(response.body).changed, []);
            assert.equal(JSON.parse(readFileSync(file, 'utf8')).history.length, 1);

            response = await send('archive');
            assert.equal(response.status, 200);
            record = JSON.parse(readFileSync(file, 'utf8'));
            assert.equal(record.status, 'archived');

            response = await send('reactivate');
            assert.equal(response.status, 200);
            record = JSON.parse(readFileSync(file, 'utf8'));
            assert.equal(record.status, 'implementing');
            assert.equal(record.currentStep, 'implement');

            response = await send('force', { status: 'planning' });
            assert.equal(response.status, 200);
            record = JSON.parse(readFileSync(file, 'utf8'));
            assert.equal(record.status, 'planning');
            assert.equal(record.currentStep, 'plan');
            assert.equal(record.history.at(-1).kind, 'start');
            assert.equal(record.history.at(-1).by, 'user');

            response = await call(board, '/api/lifecycle', {
                method: 'POST',
                headers: { 'x-speckit-token': board.token },
                body: { expectedRoot: root, action: 'archive-active' },
            });
            assert.equal(response.status, 200);
            assert.deepEqual(JSON.parse(response.body).changed, ['specs/900-lifecycle']);
            assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'archived');
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses to overwrite a malformed lifecycle record', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-lifecycle-invalid-'));
        const dir = join(root, 'specs', '900-lifecycle');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'spec.md'), '# Lifecycle');
        const file = join(dir, '.spec-context.json');
        writeFileSync(file, '{invalid');
        const board = await createSpecServer({ root });
        try {
            const response = await call(board, '/api/lifecycle', {
                method: 'POST',
                headers: { 'x-speckit-token': board.token },
                body: { expectedRoot: root, spec: 'specs/900-lifecycle', action: 'archive' },
            });
            assert.equal(response.status, 400);
            assert.match(JSON.parse(response.body).error, /not valid JSON/i);
            assert.equal(readFileSync(file, 'utf8'), '{invalid');
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('spec board server', () => {
    let root;
    let board;
    const sent = [];

    before(async () => {
        root = mkdtempSync(join(tmpdir(), 'canvas-server-'));
        mkdirSync(join(root, 'specs'));
        cpSync(join(REPO, 'specs/_01_demo-planned'), join(root, 'specs/_01_demo-planned'), { recursive: true });
        cpSync(join(REPO, 'specs/_02_demo-tasked'), join(root, 'specs/_02_demo-tasked'), { recursive: true });
        const tasked = join(root, 'specs/_02_demo-tasked/.spec-context.json');
        writeFileSync(tasked, readFileSync(tasked, 'utf8').replace('"workflow": "speckit"', '"workflow": "companion"'));
        mkdirSync(join(root, '.specify/extensions/companion'), { recursive: true });
        board = await createSpecServer({ root, send: async (prompt) => { sent.push(prompt); return true; } });
    });

    after(async () => {
        await board.close();
    });

    const auth = () => ({ 'x-speckit-token': board.token });

    it('serves the page with a strict content security policy', async () => {
        const res = await call(board, '/');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-security-policy'], /default-src 'self'/);
        assert.match(res.body, /SpecKit Companion/);
    });

    it('refuses the API without the token or from another host', async () => {
        assert.equal((await call(board, '/api/snapshot')).status, 403);
        assert.equal((await call(board, '/api/snapshot', { headers: { ...auth(), host: 'evil.test' } })).status, 403);
        assert.equal((await call(board, '/api/snapshot', { headers: { ...auth(), origin: 'http://evil.test' } })).status, 403);
    });

    it('returns the snapshot with the Companion command set', async () => {
        const res = await call(board, '/api/snapshot', { headers: auth() });
        const snapshot = JSON.parse(res.body);
        assert.equal(snapshot.specs.length, 2);
        assert.equal(snapshot.commandSet, 'companion');
        assert.ok(snapshot.commands.includes('resume'));
    });

    it('returns a spec detail with rendered documents', async () => {
        const res = await call(board, '/api/spec?id=_02_demo-tasked', { headers: auth() });
        const detail = JSON.parse(res.body);
        assert.equal(detail.spec.id, 'specs/_02_demo-tasked');
        assert.ok(detail.documents.find(d => d.type === 'tasks').html.includes('type="checkbox"'));
        assert.equal((await call(board, '/api/spec?id=nope-nothing', { headers: auth() })).status, 404);
    });

    it('rejects spec document saves when the file changed on disk', async () => {
        const opened = await call(board, '/api/spec-file/open', { method: 'POST', headers: auth(), body: { spec: 'specs/_01_demo-planned', doc: 'spec' } });
        assert.equal(opened.status, 200);
        const { token, content } = JSON.parse(opened.body);
        const file = join(root, 'specs/_01_demo-planned/spec.md');
        writeFileSync(file, `${content}\nExternal edit`);
        const saved = await call(board, '/api/spec-file/save', { method: 'POST', headers: auth(), body: { token, content: 'My draft' } });
        assert.equal(saved.status, 400);
        assert.match(JSON.parse(saved.body).error, /changed since/);
        assert.match(readFileSync(file, 'utf8'), /External edit/);
    });

    it('sends project guidance creation and refinement for the selected repository', async () => {
        const directory = join(root, '.github/instructions');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'style.instructions.md'), 'Use clear names.');
        const opened = await call(board, '/api/project-files/open', { method: 'POST', headers: auth(), body: { path: '.github/instructions/style.instructions.md' } });
        const token = JSON.parse(opened.body).token;
        const refined = await call(board, '/api/project-files/refine', { method: 'POST', headers: auth(), body: { token } });
        assert.match(JSON.parse(refined.body).prompt, /style\.instructions\.md/);
        const created = await call(board, '/api/project-files/create', { method: 'POST', headers: auth(), body: { kind: 'skill', description: 'Check the release notes.' } });
        const prompt = JSON.parse(created.body).prompt;
        assert.match(prompt, /named folder containing SKILL\.md under \.github\/skills\//);
        assert.match(sent.at(-1), /project-create/);
        const longDescription = 'x'.repeat(20000);
        const longCreate = await call(board, '/api/project-files/create', { method: 'POST', headers: auth(), body: { kind: 'agent', description: longDescription } });
        assert.equal(longCreate.status, 200);
        const staged = JSON.parse(longCreate.body).prompt.match(/\.speckit-companion\/project-create\/[^\s]+\.md/)[0];
        assert.equal(readFileSync(join(root, staged), 'utf8'), `${longDescription}\n`);
        const invalid = await call(board, '/api/project-files/create', { method: 'POST', headers: auth(), body: { kind: 'agent', description: `${longDescription}x` } });
        assert.equal(invalid.status, 400);
        const stale = await call(board, '/api/project-files/create', { method: 'POST', headers: auth(), body: { kind: 'agent', description: 'Wrong repository', expectedRoot: join(root, 'old') } });
        assert.equal(stale.status, 400);
        assert.match(JSON.parse(stale.body).error, /repository changed/i);
    });

    it('sends the step command for a spec into the chat', async () => {
        const res = await call(board, '/api/run', { method: 'POST', headers: auth(), body: { spec: 'specs/_02_demo-tasked', command: 'plan' } });
        assert.equal(res.status, 200);
        const { prompt, sent: delivered } = JSON.parse(res.body);
        assert.equal(delivered, true);
        assert.equal(prompt.split('\n')[0], '/speckit.companion.plan specs/_02_demo-tasked');
        assert.equal(sent.at(-1), prompt);
        assert.equal((await call(board, '/api/run', { method: 'POST', headers: auth(), body: { spec: 'specs/_01_demo-planned', command: 'bogus' } })).status, 400);
    });

    it('keeps a stock-workflow spec on the stock commands even with Companion installed', async () => {
        const res = await call(board, '/api/run', { method: 'POST', headers: auth(), body: { spec: 'specs/_01_demo-planned', command: 'tasks' } });
        const { prompt } = JSON.parse(res.body);
        assert.equal(prompt.split('\n')[0], '/speckit.tasks specs/_01_demo-planned');
        assert.doesNotMatch(prompt, /speckit\.companion/);
        const stock = JSON.parse((await call(board, '/api/spec?id=_01_demo-planned', { headers: auth() })).body);
        assert.equal(stock.commandSet, 'speckit');
        assert.ok(!stock.commands.includes('mark-complete'));
        const companion = JSON.parse((await call(board, '/api/spec?id=_02_demo-tasked', { headers: auth() })).body);
        assert.equal(companion.commandSet, 'companion');
        assert.ok(companion.commands.includes('mark-complete'));
    });

    it('sends the stock converge command for both workflows', async () => {
        for (const spec of ['specs/_01_demo-planned', 'specs/_02_demo-tasked']) {
            const res = await call(board, '/api/run', { method: 'POST', headers: auth(), body: { spec, command: 'converge' } });
            assert.equal(res.status, 200);
            assert.equal(JSON.parse(res.body).prompt.split('\n')[0], `/speckit.converge Converge the feature in ${spec}. If that is not the feature you resolve for this run, stop and say so instead of changing its tasks.`);
        }
    });

    it('sends stock document actions for a Companion spec', async () => {
        for (const command of ['clarify', 'checklist', 'analyze']) {
            const res = await call(board, '/api/run', { method: 'POST', headers: auth(), body: { spec: 'specs/_02_demo-tasked', command } });
            assert.equal(res.status, 200);
            assert.equal(JSON.parse(res.body).prompt.split('\n')[0], `/speckit.${command} specs/_02_demo-tasked`);
        }
    });

    it('reviews the selected tasks and GitHub destination before sending a request to create issues', async () => {
        const headers = auth();
        const spec = 'specs/_02_demo-tasked';
        const expectedRoot = board.snapshot.root;
        const issueRequest = (spec, deliveryVersion, deliveryOwner, deliveryTarget) => call(board, '/api/run', { method: 'POST', headers, body: { spec, command: 'taskstoissues', deliveryVersion, deliveryOwner, deliveryTarget, expectedRoot } });
        const preview = async () => JSON.parse((await call(board, `/api/delivery?id=${spec}`, { headers })).body);
        const missing = await issueRequest('specs/_01_demo-planned');
        assert.equal(missing.status, 400);
        assert.match((await preview()).blocked, /No task-to-issues command was found/);
        const github = join(root, '.specify', 'extensions', 'github');
        const skill = join(root, '.github', 'skills', 'speckit-github-taskstoissues');
        mkdirSync(github, { recursive: true });
        mkdirSync(skill, { recursive: true });
        writeFileSync(join(skill, 'SKILL.md'), '# Create issues');
        const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
        git('init', '--quiet');
        assert.match((await preview()).blocked, /Configure origin/);
        const remote = 'git@github.com:Example/Board-Demo.git';
        const rewrite = 'url.https://github.com/another/project.insteadOf';
        git('remote', 'add', 'origin', remote);
        const { version, owner, target, blocked } = await preview();
        assert.equal(blocked, null);
        assert.equal(target, 'example/board-demo');
        assert.match((await issueRequest(spec)).body, /Review the delivery preview/);
        assert.match((await issueRequest(spec, 'old', owner, target)).body, /Tasks changed after your preview/);
        assert.match((await issueRequest(spec, version, '/old', target)).body, /delivery command changed/);
        const before = sent.length;
        git('remote', 'set-url', 'origin', 'https://github.com/example/other');
        assert.equal((await preview()).target, 'example/other');
        assert.match((await issueRequest(spec, version, owner, target)).body, /GitHub destination changed/);
        git('remote', 'set-url', 'origin', 'https://fake-placeholder@github.com/example/board-demo');
        const unsupported = await preview();
        assert.equal(unsupported.target, null);
        assert.match(unsupported.blocked, /without embedded credentials/);
        assert.doesNotMatch(JSON.stringify(unsupported), /fake-placeholder/);
        git('remote', 'set-url', 'origin', remote);
        git('config', '--add', 'remote.origin.url', 'https://github.com/example/other');
        assert.match((await preview()).blocked, /exactly one origin URL/);
        git('config', '--unset-all', 'remote.origin.url');
        git('config', 'remote.origin.url', remote);
        git('config', rewrite, remote);
        assert.match((await issueRequest(spec, version, owner, target)).body, /rewrite to another destination/);
        git('config', '--unset', rewrite);
        assert.equal(sent.length, before);
        const registry = join(root, '.specify', 'extensions', '.registry');
        writeFileSync(registry, '{"extensions":{"project":{"enabled":true},"ghp":{"enabled":true}}}');
        try {
            assert.match((await issueRequest(spec, version, owner, target)).body, /Both delivery extensions are enabled/);
            writeFileSync(registry, '{"extensions":{"github":{"enabled":false}}}');
            assert.match((await issueRequest(spec, version, owner, target)).body, /GitHub extension is disabled/);
        } finally {
            rmSync(registry);
        }
        const res = await issueRequest(spec, version, owner, target);
        assert.equal(res.status, 200);
        const { prompt } = JSON.parse(res.body);
        assert.match(prompt, /^\/speckit-github-taskstoissues Create the issues from specs\/_02_demo-tasked\/tasks\.md\./);
        assert.ok(prompt.includes(`Reviewed tasks SHA-256: ${version}.`));
        assert.match(prompt, /Reviewed GitHub destination: https:\/\/github\.com\/example\/board-demo/);
    });

    it('sends a new spec with the chosen workflow and writes the preamble that seeds the run record to a file', async () => {
        const res = await call(board, '/api/specify', { method: 'POST', headers: auth(), body: { description: 'Show a footer count', workflow: 'speckit' } });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.command, 'speckit.specify');
        assert.equal(body.workflow, 'speckit');
        assert.match(body.instructionsFile, /^\.speckit-companion\/prompts\/specify-\d{8}T\d{9}Z\.md$/);
        assert.ok(sent.at(-1).startsWith('/speckit.specify Show a footer count'));
        assert.ok(sent.at(-1).endsWith(`Before you start, read and follow the run instructions in \`${body.instructionsFile}\`.`));
        const file = readFileSync(join(root, body.instructionsFile), 'utf8');
        assert.match(file, /"workflow": "speckit"/);
        assert.match(file, /"by": "extension"/);
        const auto = await call(board, '/api/specify', { method: 'POST', headers: auth(), body: { description: 'x', workflow: 'auto' } });
        assert.equal(JSON.parse(auto.body).command, 'speckit.companion.auto');
    });

    it('sends a short message for every command in both command sets, with the preamble in the file it names', async () => {
        const cases = [
            ...['plan', 'tasks', 'implement'].map(command => ({ path: '/api/run', body: { spec: 'specs/_02_demo-tasked', command }, line: `/speckit.companion.${command} specs/_02_demo-tasked`, file: `.speckit-companion/prompts/${command}-_02_demo-tasked.md`, phrase: 'This command\'s body carries the full' })),
            ...['plan', 'tasks', 'implement'].map(command => ({ path: '/api/run', body: { spec: 'specs/_01_demo-planned', command }, line: `/speckit.${command} specs/_01_demo-planned`, file: `.speckit-companion/prompts/${command}-_01_demo-planned.md`, phrase: 'Canonical statuses' })),
            ...[['companion', 'speckit.companion.specify'], ['speckit', 'speckit.specify'], ['auto', 'speckit.companion.auto']].map(([workflow, command]) => ({ path: '/api/specify', body: { description: 'Count things', workflow }, line: `/${command} Count things`, file: null, phrase: 'SEED WRITE INSTRUCTIONS' })),
        ];
        for (const { path, body, line, file, phrase } of cases) {
            const res = await call(board, path, { method: 'POST', headers: auth(), body });
            assert.equal(res.status, 200, line);
            const { prompt, instructionsFile } = JSON.parse(res.body);
            assert.equal(sent.at(-1), prompt);
            if (file) assert.equal(instructionsFile, file);
            const paragraphs = prompt.split('\n\n');
            assert.equal(paragraphs[0], line);
            assert.equal(paragraphs.at(-1), `Before you start, read and follow the run instructions in \`${instructionsFile}\`.`);
            assert.ok(paragraphs.length <= 3, `${line}: the command, at most one rule, and the sentence`);
            const written = readFileSync(join(root, instructionsFile), 'utf8');
            for (const text of ['speckit-companion:context-update', phrase]) {
                assert.ok(!prompt.includes(text), `${line}: "${text}" stays out of the chat`);
                assert.ok(written.includes(text), `${line}: "${text}" is in the file`);
            }
        }
        assert.equal(readFileSync(join(root, '.speckit-companion/.gitignore'), 'utf8'), '*\n');
    });

    it('replaces a spec\'s older file for the same step', async () => {
        const file = join(root, '.speckit-companion/prompts/plan-_02_demo-tasked.md');
        writeFileSync(file, 'stale');
        await call(board, '/api/run', { method: 'POST', headers: auth(), body: { spec: 'specs/_02_demo-tasked', command: 'plan' } });
        assert.doesNotMatch(readFileSync(file, 'utf8'), /stale/);
    });

    it('sends one line asking the agent to install Companion and commit its skill files', async () => {
        const res = await call(board, '/api/install', { method: 'POST', headers: auth(), body: {} });
        assert.equal(res.status, 200);
        assert.match(sent.at(-1), /^Run `specify extension add companion --from https:\/\/github\.com\/alfredoperez\/speckit-companion\/releases\/download\/companion-latest\/companion\.zip --force` in this project, then commit the skill files it generates/);
        assert.ok(!sent.at(-1).includes('\n'));
    });

    it('rejects an unknown workflow and an empty description', async () => {
        const unknown = await call(board, '/api/specify', { method: 'POST', headers: auth(), body: { description: 'x', workflow: 'turbo' } });
        assert.equal(unknown.status, 400);
        assert.match(JSON.parse(unknown.body).error, /Unknown workflow/);
        const empty = await call(board, '/api/specify', { method: 'POST', headers: auth(), body: { description: '  ', workflow: 'speckit' } });
        assert.equal(empty.status, 400);
    });

    it('offers the workflow choices in the snapshot', async () => {
        const { specify } = JSON.parse((await call(board, '/api/snapshot', { headers: auth() })).body);
        assert.equal(specify.default, 'companion');
        assert.deepEqual(specify.choices.map(c => c.id), ['companion', 'speckit', 'auto']);
    });

    it('refuses Auto and Companion on a workspace without the extension', async () => {
        const stockRoot = mkdtempSync(join(tmpdir(), 'canvas-stock-'));
        mkdirSync(join(stockRoot, 'specs'));
        const stock = await createSpecServer({ root: stockRoot, send: async () => true });
        try {
            const headers = { 'x-speckit-token': stock.token };
            const auto = await call(stock, '/api/specify', { method: 'POST', headers, body: { description: 'x', workflow: 'auto' } });
            assert.equal(auto.status, 400);
            assert.match(JSON.parse(auto.body).error, /Auto needs the companion spec-kit extension/);
            const ok = await call(stock, '/api/specify', { method: 'POST', headers, body: { description: 'x', workflow: 'speckit' } });
            assert.equal(ok.status, 200);
            const { specify } = JSON.parse((await call(stock, '/api/snapshot', { headers })).body);
            assert.equal(specify.default, 'speckit');
            assert.deepEqual(specify.choices.map(c => c.available), [false, true, false]);
        } finally {
            await stock.close();
        }
    });

    it('writes no file and adds no sentence for a command that has no preamble', async () => {
        const res = await call(board, '/api/run', { method: 'POST', headers: auth(), body: { spec: 'specs/_02_demo-tasked', command: 'status' } });
        assert.equal(JSON.parse(res.body).instructionsFile, null);
        assert.equal(sent.at(-1), '/speckit.companion.status specs/_02_demo-tasked');
        assert.ok(!existsSync(join(root, '.speckit-companion/prompts/status-_02_demo-tasked.md')));
    });

    it('picks up a change on disk without a manual refresh', async () => {
        writeFileSync(join(root, 'specs/_02_demo-tasked/tasks.md'), '- [x] T001 One\n- [ ] T002 Two\n');
        const deadline = Date.now() + 3000;
        let tasks;
        while (Date.now() < deadline) {
            tasks = board.snapshot.specs.find(s => s.id === 'specs/_02_demo-tasked').tasks;
            if (tasks.checked === 1) break;
            await new Promise(r => setTimeout(r, 50));
        }
        assert.deepEqual(tasks, { checked: 1, total: 2 });
    });

    it('streams a snapshot first on the event stream', async () => {
        const first = await new Promise((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port: board.port, path: `/api/events?token=${encodeURIComponent(board.token)}`, headers: { host: `127.0.0.1:${board.port}` } }, (res) => {
                res.once('data', chunk => {
                    resolve(String(chunk));
                    req.destroy();
                });
            });
            req.on('error', reject);
            req.end();
        });
        assert.match(first, /^event: snapshot\n/);
    });
});

/** Open the event stream and collect every snapshot it carries. */
function listen(board) {
    const snapshots = [];
    let buffer = '';
    const req = request({ host: '127.0.0.1', port: board.port, path: `/api/events?token=${encodeURIComponent(board.token)}`, headers: { host: `127.0.0.1:${board.port}` } }, (res) => {
        res.on('data', chunk => {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = frame.match(/^event: snapshot\ndata: (.*)$/s)?.[1];
                if (data) snapshots.push(JSON.parse(data));
            }
        });
        res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end();
    return { snapshots, close: () => req.destroy() };
}

async function until(check, what, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (check()) return;
        await new Promise(r => setTimeout(r, 25));
    }
    assert.fail(`timed out waiting for ${what}`);
}

const ids = snapshot => snapshot.specs.map(s => s.id);

describe('watching for spec folders that are not there yet', () => {
    async function open(prepare = () => {}) {
        const root = mkdtempSync(join(tmpdir(), 'canvas-watch-'));
        prepare(root);
        const board = await createSpecServer({ root, send: async () => true });
        const stream = listen(board);
        await until(() => stream.snapshots.length === 1, 'the opening snapshot');
        return { root, board, stream, close: async () => { stream.close(); await board.close(); } };
    }
    const addSpec = (root, id) => {
        mkdirSync(join(root, id), { recursive: true });
        writeFileSync(join(root, id, 'spec.md'), '# Spec\n');
    };

    it('shows the first spec of a project that had no specs folder, without a refresh', async () => {
        const { root, board, stream, close } = await open();
        try {
            assert.deepEqual(ids(board.snapshot), []);
            addSpec(root, 'specs/001-x');
            await until(() => stream.snapshots.some(s => ids(s).includes('specs/001-x')), 'a snapshot event with the new spec');
            assert.deepEqual(ids(board.snapshot), ['specs/001-x']);
            writeFileSync(join(root, 'specs/001-x/tasks.md'), '- [x] T001 One\n- [ ] T002 Two\n');
            await until(() => stream.snapshots.at(-1).specs[0]?.tasks?.total === 2, 'a later change inside the new folder');
        } finally {
            await close();
        }
    });

    it('shows the first spec when the specs folder was there but empty', async () => {
        const { root, board, stream, close } = await open(root => mkdirSync(join(root, 'specs')));
        try {
            addSpec(root, 'specs/001-x');
            await until(() => stream.snapshots.some(s => ids(s).includes('specs/001-x')), 'a snapshot event with the new spec');
            assert.deepEqual(ids(board.snapshot), ['specs/001-x']);
        } finally {
            await close();
        }
    });

    it('keeps watching after the specs folder is deleted and created again', async () => {
        const { root, board, stream, close } = await open(root => addSpec(root, 'specs/001-x'));
        try {
            assert.deepEqual(ids(board.snapshot), ['specs/001-x']);
            rmSync(join(root, 'specs'), { recursive: true });
            await until(() => ids(stream.snapshots.at(-1)).length === 0, 'a snapshot event without the deleted spec');
            addSpec(root, 'specs/002-y');
            await until(() => ids(stream.snapshots.at(-1)).includes('specs/002-y'), 'a snapshot event with the recreated folder\'s spec');
            assert.deepEqual(ids(board.snapshot), ['specs/002-y']);
            writeFileSync(join(root, 'specs/002-y/plan.md'), '# Plan\n');
            await until(() => stream.snapshots.at(-1).specs[0]?.files?.plan === 'plan.md', 'a change inside the recreated folder');
        } finally {
            await close();
        }
    });

    it('finds a spec folder two levels down that did not exist, such as .specify/specs', async () => {
        const { root, stream, close } = await open();
        try {
            addSpec(root, '.specify/specs/003-z');
            await until(() => stream.snapshots.some(s => ids(s).includes('.specify/specs/003-z')), 'a snapshot event with the nested spec');
        } finally {
            await close();
        }
    });
});

describe('a stock Spec Kit project, with no Companion writer anywhere', () => {
    const STALE = {
        workflow: 'speckit',
        specName: 'Todo Stars',
        selectedAt: '2026-10-05T14:54:53.999Z',
        currentStep: 'specify',
        status: 'specifying',
        history: [{ step: 'specify', substep: null, kind: 'start', by: 'extension', at: '2026-10-05T14:54:53.999Z' }],
    };
    const SPECIFIED = {
        ...STALE,
        status: 'specified',
        history: [...STALE.history, { step: 'specify', substep: null, kind: 'complete', by: 'extension', at: '2026-10-05T14:56:35.000Z' }],
    };
    const SPEC = 'specs/001-todo-stars';

    const IMPLEMENTED = {
        ...SPECIFIED,
        currentStep: 'implement',
        status: 'implemented',
        history: [...SPECIFIED.history, ...['plan', 'tasks', 'implement'].flatMap((step, i) => ['start', 'complete'].map((kind, j) => ({ step, substep: null, kind, by: 'extension', at: `2026-10-05T15:0${i}:${j}0.000Z` })))],
    };

    async function open({ record = STALE, files = ['spec.md', 'plan.md'], quietMs, ceilingMs } = {}) {
        const root = mkdtempSync(join(tmpdir(), 'canvas-stock-run-'));
        for (const step of ['specify', 'plan', 'tasks', 'implement']) {
            mkdirSync(join(root, '.github/skills', `speckit-${step}`), { recursive: true });
            writeFileSync(join(root, '.github/skills', `speckit-${step}`, 'SKILL.md'), `# ${step}\n`);
        }
        mkdirSync(join(root, SPEC), { recursive: true });
        for (const file of files) writeFileSync(join(root, SPEC, file), file === 'tasks.md' ? '- [x] T001 One\n' : `# ${file}\n`);
        if (record) writeFileSync(join(root, SPEC, '.spec-context.json'), JSON.stringify(record));
        const sent = [];
        const clock = { ms: Date.now() + 1000 };
        const hooks = { onSend: null, delivered: true };
        const board = await createSpecServer({ root, checkoutWriter: null, quietMs, ceilingMs, now: () => clock.ms, send: async (prompt) => { sent.push(prompt); hooks.onSend?.(prompt); return hooks.delivered; } });
        const row = () => board.snapshot.specs.find(s => s.id === SPEC);
        const context = () => JSON.parse(readFileSync(join(root, SPEC, '.spec-context.json'), 'utf8'));
        // A document written after the send: its time is set, so the test never depends on the file system's clock.
        const write = (name, text, dir = SPEC) => {
            clock.ms += 1000;
            writeFileSync(join(root, dir, name), text);
            utimesSync(join(root, dir, name), new Date(clock.ms), new Date(clock.ms));
        };
        const pass = (ms) => { clock.ms += ms; board.rescan(); };
        return { root, board, sent, row, context, clock, write, pass, hooks };
    }

    it('reads a record stuck on specifying as planned when spec.md and plan.md are on disk', async () => {
        const { board, row } = await open();
        try {
            assert.deepEqual(row().steps, { specify: 'completed', plan: 'completed', tasks: 'not-started', implement: 'not-started' });
            assert.equal(row().statusLabel, 'Planned');
            const detail = JSON.parse((await call(board, `/api/spec?id=${SPEC}`, { headers: { 'x-speckit-token': board.token } })).body);
            assert.equal(detail.spec.status, 'planned');
            assert.doesNotMatch(detail.overviewHtml, /is-in-flight/);
        } finally {
            await board.close();
        }
    });

    it('sends the dashed command the project registers with the file that holds its steps, and no instruction file', async () => {
        const { root, board, sent } = await open();
        try {
            const result = await board.run(SPEC, 'tasks');
            assert.equal(sent.at(-1), '/speckit-tasks specs/001-todo-stars\n\nIf the steps of /speckit-tasks are not already loaded in this chat, read `.github/skills/speckit-tasks/SKILL.md` first and follow every one of them for the spec in `specs/001-todo-stars`.');
            assert.equal(result.instructionsFile, null);
            assert.ok(!existsSync(join(root, '.speckit-companion')), 'nothing written for the run');
            const detail = JSON.parse((await call(board, `/api/spec?id=${SPEC}`, { headers: { 'x-speckit-token': board.token } })).body);
            assert.equal(detail.commandHint, '/speckit-<step>');
        } finally {
            await board.close();
        }
    });

    it('never mentions write-context.py to the agent, for a step or for a new spec', async () => {
        const { root, board, sent } = await open();
        try {
            for (const step of ['plan', 'tasks', 'implement']) await board.run(SPEC, step);
            const created = await board.specify('Star a todo', 'speckit');
            assert.equal(created.instructionsFile, null);
            assert.ok(sent.at(-1).startsWith('/speckit-specify Star a todo'));
            for (const prompt of sent) assert.doesNotMatch(prompt, /write-context|spec-context|run instructions/);
            assert.ok(!existsSync(join(root, '.speckit-companion')));
        } finally {
            await board.close();
        }
    });

    it('shows a step it sent as running, then records it once the turn settles with the document on disk', async () => {
        const { board, row, context, write } = await open({ record: SPECIFIED });
        try {
            assert.equal(row().statusLabel, 'Planned', 'plan.md is there though the record never heard of a plan');
            await board.run(SPEC, 'tasks');
            assert.equal(row().steps.tasks, 'in-progress');
            assert.equal(row().statusLabel, 'Tasking');
            assert.equal(board.detail(SPEC).spec.steps.tasks, 'in-progress');
            write('tasks.md', '- [ ] T001 One\n');
            board.rescan();
            assert.equal(row().steps.tasks, 'in-progress', 'still running until the turn ends');
            board.settle(new Date(Date.now() + 90000));
            assert.equal(row().steps.tasks, 'completed');
            assert.equal(row().statusLabel, 'Ready to Implement');
            const record = context();
            assert.equal(record.status, 'ready-to-implement');
            assert.equal(record.currentStep, 'tasks');
            assert.deepEqual(record.history.slice(-2).map(e => [e.step, e.kind, e.by]), [['tasks', 'start', 'extension'], ['tasks', 'complete', 'extension']]);
            assert.deepEqual(record.history.slice(0, 2), SPECIFIED.history, 'history is appended to');
            const { timing } = board.detail(SPEC);
            assert.equal(timing.tasks.durationTrusted, true);
            assert.equal(timing.plan, undefined, 'plan ran outside the board, so it has no time');
        } finally {
            await board.close();
        }
    });

    it('stops showing a step as running, and records nothing, when the turn settles without the document', async () => {
        const { board, row, context } = await open();
        try {
            await board.run(SPEC, 'tasks');
            board.settle();
            assert.equal(row().steps.tasks, 'not-started');
            assert.equal(row().statusLabel, 'Planned');
            assert.deepEqual(context(), STALE);
        } finally {
            await board.close();
        }
    });

    it('on a host that never says a turn started, stops looking like running once the written document sits unchanged, and still records at the idle', async () => {
        const { board, row, context, write, pass } = await open({ record: SPECIFIED, quietMs: 120000 });
        try {
            await board.run(SPEC, 'tasks');
            write('tasks.md', '- [ ] T001 One\n');
            pass(119000);
            assert.equal(row().steps.tasks, 'in-progress', 'not quiet for long enough yet');
            pass(2000);
            assert.equal(row().steps.tasks, 'completed', 'it stops looking like running, and the files say where it is');
            assert.deepEqual(context(), SPECIFIED, 'nothing is recorded on quiet alone');
            board.settle();
            assert.equal(context().status, 'ready-to-implement', 'the run was kept, so the idle that does arrive records it');
            assert.deepEqual(context().history.slice(-2).map(e => [e.step, e.kind]), [['tasks', 'start'], ['tasks', 'complete']]);
        } finally {
            await board.close();
        }
    });

    it('never ends a run on quiet while the session is working, and records it when the turn really ends', async () => {
        const { board, sent, row, context, write, pass } = await open({ record: SPECIFIED, quietMs: 120000 });
        try {
            await board.run(SPEC, 'tasks');
            board.began(sent.at(-1));
            write('tasks.md', '- [ ] T001 One\n');
            pass(10 * 60000);
            assert.equal(row().steps.tasks, 'in-progress', 'ten quiet minutes into a turn that is still running');
            board.settle();
            assert.equal(row().steps.tasks, 'completed');
            assert.deepEqual(context().history.slice(-2).map(e => [e.step, e.kind]), [['tasks', 'start'], ['tasks', 'complete']]);
        } finally {
            await board.close();
        }
    });

    it('stops showing a run whose document never appears once the ceiling passes, and stops waking up for it', async () => {
        const { board, sent, row, context, pass } = await open({ record: SPECIFIED, ceilingMs: 2 * 60 * 60000 });
        try {
            await board.run(SPEC, 'tasks');
            board.began(sent.at(-1));
            pass(119 * 60000);
            assert.equal(row().steps.tasks, 'in-progress');
            pass(2 * 60000);
            assert.equal(row().steps.tasks, 'not-started');
            board.settle();
            assert.deepEqual(context(), SPECIFIED);
        } finally {
            await board.close();
        }
    });

    it('settles a step whose turn started before the send returned', async () => {
        const { board, row, context, write, hooks } = await open({ record: SPECIFIED });
        try {
            hooks.onSend = prompt => board.began(prompt);
            await board.run(SPEC, 'tasks');
            assert.equal(row().steps.tasks, 'in-progress');
            write('tasks.md', '- [ ] T001 One\n');
            board.settle();
            assert.equal(row().steps.tasks, 'completed');
            assert.equal(context().status, 'ready-to-implement');
        } finally {
            await board.close();
        }
    });

    it('settles a new spec whose turn started before the send returned', async () => {
        const { root, board, hooks } = await open();
        try {
            hooks.onSend = prompt => board.began(prompt);
            await board.specify('Count the stars', 'speckit');
            mkdirSync(join(root, 'specs/002-star-count'));
            writeFileSync(join(root, 'specs/002-star-count/spec.md'), '# Feature Specification: Star Count\n');
            board.settle();
            assert.equal(JSON.parse(readFileSync(join(root, 'specs/002-star-count/.spec-context.json'), 'utf8')).status, 'specified');
        } finally {
            await board.close();
        }
    });

    it('follows nothing when the send did not reach a chat', async () => {
        const { board, row, hooks } = await open({ record: SPECIFIED });
        try {
            hooks.delivered = false;
            await board.run(SPEC, 'tasks');
            assert.equal(row().steps.tasks, 'not-started');
        } finally {
            await board.close();
        }
    });

    it('starts a run only for a turn whose message carries its whole command line', async () => {
        const { board, sent, row, context, write } = await open({ record: SPECIFIED });
        try {
            await board.run(SPEC, 'tasks');
            const line = sent.at(-1).split('\n')[0];
            board.began(`${line}-more`);
            board.began(`please do not run ${line} yet`);
            write('tasks.md', '- [ ] T001 One\n');
            board.settle();
            assert.equal(row().steps.tasks, 'in-progress', 'neither turn was this run\'s');
            assert.deepEqual(context(), SPECIFIED);
            board.began(`${sent.at(-1)}\n\nsomething the host added`);
            board.settle();
            assert.equal(context().status, 'ready-to-implement');
        } finally {
            await board.close();
        }
    });

    it('keeps trying for a moment when another writer holds the record\'s lock, then writes', async () => {
        const { root, board, context, write } = await open({ record: SPECIFIED });
        const lock = recordLockPath(join(root, SPEC, '.spec-context.json'));
        try {
            await board.run(SPEC, 'tasks');
            write('tasks.md', '- [ ] T001 One\n');
            mkdirSync(join(lock, '..'), { recursive: true });
            writeFileSync(lock, `${process.pid}:some-other-scope:abc`);
            board.settle();
            assert.deepEqual(context(), SPECIFIED, 'not while the lock is held');
            await new Promise(r => setTimeout(r, 250));
            assert.deepEqual(context(), SPECIFIED);
            rmSync(lock);
            await until(() => context().status === 'ready-to-implement', 'the record once the lock is free', 3000);
            assert.equal(board.snapshot.specs[0].status, 'ready-to-implement');
        } finally {
            rmSync(lock, { force: true });
            await board.close();
        }
    });

    it('does not settle a step on the idle of a turn that was already running when the step was sent', async () => {
        const { board, sent, row, context, write } = await open({ record: SPECIFIED });
        try {
            board.began('an earlier message that is still being worked on');
            await board.run(SPEC, 'tasks');
            board.settle();
            assert.equal(row().steps.tasks, 'in-progress', 'that idle belongs to the earlier turn');
            assert.deepEqual(context(), SPECIFIED);
            board.began(sent.at(-1));
            write('tasks.md', '- [ ] T001 One\n');
            board.settle();
            assert.equal(row().steps.tasks, 'completed');
            assert.equal(context().status, 'ready-to-implement');
        } finally {
            await board.close();
        }
    });

    it('does not take a document that was already there at the send as proof the step ran', async () => {
        const { board, row, context, write } = await open({ record: SPECIFIED });
        try {
            await board.run(SPEC, 'plan');
            board.settle();
            assert.deepEqual(context(), SPECIFIED, 'plan.md was not touched, so nothing is recorded');
            assert.equal(row().statusLabel, 'Planned');
            await board.run(SPEC, 'plan');
            write('plan.md', '# plan.md\n\nRewritten.\n');
            board.settle();
            assert.equal(context().status, 'planned', 'a plan.md modified since the send is');
        } finally {
            await board.close();
        }
    });

    it('never moves a record backwards: re-running Plan on an implemented spec writes nothing', async () => {
        const { board, context, write } = await open({ record: IMPLEMENTED, files: ['spec.md', 'plan.md', 'tasks.md'] });
        try {
            await board.run(SPEC, 'plan');
            write('plan.md', '# plan.md\n\nRewritten.\n');
            board.settle();
            assert.deepEqual(context(), IMPLEMENTED);
        } finally {
            await board.close();
        }
    });

    it('does not record a step whose document is empty or still the copied template', async () => {
        const { root, board, row, context, write } = await open({ record: SPECIFIED, files: ['spec.md'] });
        try {
            const template = '# Implementation Plan: [FEATURE]\n\n## Summary\n';
            mkdirSync(join(root, '.specify/templates'), { recursive: true });
            writeFileSync(join(root, '.specify/templates/plan-template.md'), template);
            await board.run(SPEC, 'plan');
            write('plan.md', template);
            board.rescan();
            board.settle();
            assert.equal(row().steps.plan, 'not-started');
            assert.equal(row().statusLabel, 'Specified');
            assert.deepEqual(context(), SPECIFIED);
            await board.run(SPEC, 'tasks');
            write('tasks.md', '');
            board.settle();
            assert.equal(row().steps.tasks, 'not-started');
            assert.deepEqual(context(), SPECIFIED);
        } finally {
            await board.close();
        }
    });

    it('checks who owns the record again when the turn ends: Companion installed mid-turn means the board writes nothing', async () => {
        const { root, board, context, write } = await open({ record: SPECIFIED });
        try {
            await board.run(SPEC, 'tasks');
            write('tasks.md', '- [ ] T001 One\n');
            mkdirSync(join(root, '.specify/extensions/companion/scripts'), { recursive: true });
            writeFileSync(join(root, '.specify/extensions/companion/scripts/write-context.py'), '');
            board.settle();
            assert.deepEqual(context(), SPECIFIED);
        } finally {
            await board.close();
        }
    });

    it('follows a new spec from the send to its folder, and starts its record when the turn settles', async () => {
        const { root, board } = await open();
        try {
            await board.specify('Count the stars', 'speckit');
            const created = 'specs/002-star-count';
            mkdirSync(join(root, created));
            writeFileSync(join(root, created, 'spec.md'), '# Feature Specification: Star Count\n');
            board.rescan();
            const row = () => board.snapshot.specs.find(s => s.id === created);
            assert.equal(row().steps.specify, 'in-progress');
            assert.equal(row().statusLabel, 'Specifying');
            board.settle(new Date(Date.now() + 60000));
            assert.equal(row().steps.specify, 'completed');
            const record = JSON.parse(readFileSync(join(root, created, '.spec-context.json'), 'utf8'));
            assert.equal(record.workflow, 'speckit');
            assert.equal(record.specName, 'Star Count');
            assert.equal(record.status, 'specified');
            assert.deepEqual(record.history.map(e => e.kind), ['start', 'complete']);
        } finally {
            await board.close();
        }
    });

    it('records nothing for a step nobody sent from the board: the files alone say where the spec stands', async () => {
        const { root, board, row } = await open({ record: null });
        try {
            board.settle();
            assert.equal(row().hasContext, false);
            assert.deepEqual(row().steps, { specify: 'completed', plan: 'completed', tasks: 'not-started', implement: 'not-started' });
            assert.ok(!existsSync(join(root, SPEC, '.spec-context.json')));
        } finally {
            await board.close();
        }
    });

    it('leaves a record that stopped mid-step alone, so that step is not handed a time nobody measured', async () => {
        const { board, row, context, write } = await open();
        try {
            await board.run(SPEC, 'tasks');
            write('tasks.md', '- [ ] T001 One\n');
            board.settle(new Date(Date.now() + 90000));
            assert.equal(row().statusLabel, 'Ready to Implement');
            assert.deepEqual(context(), STALE);
            const detail = JSON.parse((await call(board, `/api/spec?id=${SPEC}`, { headers: { 'x-speckit-token': board.token } })).body);
            assert.match(detail.overviewHtml, /Timing coverage: 0 of 4 phases/);
            assert.match(detail.overviewHtml, /No step has a time\. The board times a step it sends, from the send to the end of that chat turn\./);
            assert.doesNotMatch(detail.overviewHtml, /dossier-timing__duration|is-in-flight/);
        } finally {
            await board.close();
        }
    });

    it('says on the Overview what a board-kept time measures', async () => {
        const { board, write } = await open({ record: SPECIFIED });
        try {
            await board.run(SPEC, 'tasks');
            write('tasks.md', '- [ ] T001 One\n');
            board.settle(new Date(Date.now() + 90000));
            const detail = JSON.parse((await call(board, `/api/spec?id=${SPEC}`, { headers: { 'x-speckit-token': board.token } })).body);
            assert.match(detail.overviewHtml, /Timed by the board: from the moment it sent a step to the end of that chat turn\. A step run any other way has no time\./);
            assert.match(detail.overviewHtml, /Timing coverage: 2 of 4 phases/);
            assert.match(detail.overviewHtml, /Specify<\/span><span class="dossier-timing__duration">1m 41s/);
        } finally {
            await board.close();
        }
    });
});

describe('a project where the agent keeps the record', () => {
    it('leaves the record to the agent: a settle writes nothing', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-live-'));
        mkdirSync(join(root, 'specs/001-x'), { recursive: true });
        mkdirSync(join(root, '.specify/extensions/companion/scripts'), { recursive: true });
        writeFileSync(join(root, '.specify/extensions/companion/scripts/write-context.py'), '');
        writeFileSync(join(root, 'specs/001-x/spec.md'), '# X\n');
        const record = { workflow: 'speckit', specName: 'X', currentStep: 'specify', status: 'specified', history: [] };
        writeFileSync(join(root, 'specs/001-x/.spec-context.json'), JSON.stringify(record));
        const board = await createSpecServer({ root, send: async () => true });
        try {
            const result = await board.run('specs/001-x', 'plan');
            assert.match(readFileSync(join(root, result.instructionsFile), 'utf8'), /python3 "\.specify\/extensions\/companion\/scripts\/write-context\.py"/);
            assert.equal(board.snapshot.specs[0].steps.plan, 'in-progress');
            writeFileSync(join(root, 'specs/001-x/plan.md'), '# Plan\n');
            board.settle();
            assert.deepEqual(JSON.parse(readFileSync(join(root, 'specs/001-x/.spec-context.json'), 'utf8')), record);
            assert.equal(board.snapshot.specs[0].steps.plan, 'completed', 'plan.md is there and the record never heard of a plan');
        } finally {
            await board.close();
        }
    });
});

describe('a Companion project where the agent wrote the document and never closed the step', () => {
    const SPEC = 'specs/001-todo-stars';
    const entry = (step, kind, at, by = 'extension') => ({ step, substep: null, kind, by, at });
    const SPECIFIED = {
        workflow: 'companion',
        specName: 'Todo Stars',
        currentStep: 'specify',
        status: 'specified',
        history: [entry('specify', 'start', '2026-10-05T14:54:53.999Z'), entry('specify', 'complete', '2026-10-05T14:56:35.000Z')],
    };

    async function open({ record = SPECIFIED, files = ['spec.md'] } = {}) {
        const root = mkdtempSync(join(tmpdir(), 'canvas-unclosed-'));
        mkdirSync(join(root, '.specify/extensions/companion/scripts'), { recursive: true });
        writeFileSync(join(root, '.specify/extensions/companion/scripts/write-context.py'), '');
        mkdirSync(join(root, SPEC), { recursive: true });
        for (const file of files) writeFileSync(join(root, SPEC, file), file === 'tasks.md' ? '- [ ] T001 One\n' : `# ${file}\n\nReal.\n`);
        const sent = [];
        const clock = { ms: Date.now() + 1000 };
        const board = await createSpecServer({ root, now: () => clock.ms, send: async (prompt) => { sent.push(prompt); return true; } });
        const file = (dir) => join(root, dir, '.spec-context.json');
        const context = (dir = SPEC) => JSON.parse(readFileSync(file(dir), 'utf8'));
        const seed = (value, dir = SPEC) => writeFileSync(file(dir), JSON.stringify(value));
        const write = (name, text, dir = SPEC) => {
            clock.ms += 1000;
            writeFileSync(join(root, dir, name), text);
            utimesSync(join(root, dir, name), new Date(clock.ms), new Date(clock.ms));
        };
        const row = (dir = SPEC) => board.snapshot.specs.find(s => s.id === dir);
        const sentAt = () => new Date(clock.ms).toISOString();
        // What the agent leaves behind: the step's start at the dispatch time, the in-flight status, and no complete.
        const opened = (step, status, at, base = SPECIFIED) => ({ ...base, currentStep: step, status, history: [...base.history, entry(step, 'start', at)] });
        const later = () => new Date(clock.ms + 90000);
        if (record) seed(record);
        board.rescan();
        return { root, board, sent, clock, context, seed, write, row, sentAt, opened, later };
    }

    it('closes plan in the record once its turn ends with plan.md written, so the next step unlocks', async () => {
        const { board, sent, context, seed, write, row, sentAt, opened, later } = await open();
        try {
            const at = sentAt();
            await board.run(SPEC, 'plan');
            board.began(sent[0]);
            const left = opened('plan', 'planning', at);
            seed(left);
            write('plan.md', '# Plan\n\nReal.\n');
            board.rescan();
            assert.equal(row().steps.plan, 'in-progress');
            assert.deepEqual(context(), left, 'nothing is written before the turn ends');
            board.settle(later());
            assert.equal(row().steps.plan, 'completed');
            assert.equal(row().statusLabel, 'Planned');
            const record = context();
            assert.deepEqual([record.status, record.currentStep, record.workflow], ['planned', 'plan', 'companion']);
            assert.deepEqual(record.history.slice(0, -1), left.history, 'history is appended to');
            assert.deepEqual([record.history.at(-1).step, record.history.at(-1).kind, record.history.at(-1).by], ['plan', 'complete', 'extension']);
            assert.equal(board.detail(SPEC).timing.plan.durationTrusted, true, 'from the send to the end of the turn');
        } finally {
            await board.close();
        }
    });

    it('closes specify for a new spec whose record the agent seeded by hand', async () => {
        const { root, board, sent, context, seed, row, sentAt, later } = await open();
        try {
            const at = sentAt();
            await board.specify('Count the stars', 'companion');
            board.began(sent[0]);
            const created = 'specs/002-star-count';
            mkdirSync(join(root, created));
            const left = { workflow: 'companion', specName: 'Star Count', selectedAt: at, currentStep: 'specify', status: 'specifying', history: [entry('specify', 'start', at)] };
            seed(left, created);
            writeFileSync(join(root, created, 'spec.md'), '# Feature Specification: Star Count\n\nReal.\n');
            board.rescan();
            assert.equal(row(created).steps.specify, 'in-progress');
            board.settle(later());
            assert.equal(row(created).steps.specify, 'completed');
            assert.equal(row(created).statusLabel, 'Specified');
            assert.equal(context(created).status, 'specified');
            assert.deepEqual(context(created).history.map(e => [e.step, e.kind, e.by]), [['specify', 'start', 'extension'], ['specify', 'complete', 'extension']]);
        } finally {
            await board.close();
        }
    });

    it('writes nothing while the turn has not ended, even when an earlier turn goes idle', async () => {
        const { board, context, seed, write, row, sentAt, opened } = await open();
        try {
            board.began('an earlier message');
            const at = sentAt();
            await board.run(SPEC, 'plan');
            const left = opened('plan', 'planning', at);
            seed(left);
            write('plan.md', '# Plan\n\nReal.\n');
            board.settle();
            assert.deepEqual(context(), left);
            assert.equal(row().steps.plan, 'in-progress');
        } finally {
            await board.close();
        }
    });

    it('writes nothing when the document is empty or still the copied template', async () => {
        const { root, board, sent, context, seed, write, row, sentAt, opened } = await open();
        try {
            const template = '# Implementation Plan: [FEATURE]\n\n## Summary\n';
            mkdirSync(join(root, '.specify/templates'), { recursive: true });
            writeFileSync(join(root, '.specify/templates/plan-template.md'), template);
            for (const text of [template, '']) {
                const at = sentAt();
                await board.run(SPEC, 'plan');
                board.began(sent.at(-1));
                const left = opened('plan', 'planning', at);
                seed(left);
                write('plan.md', text);
                board.settle();
                assert.deepEqual(context(), left);
                assert.equal(row().steps.plan, 'in-progress', 'the record still leads');
            }
        } finally {
            await board.close();
        }
    });

    it('writes nothing when the recorder closed the step itself before the turn ended', async () => {
        const { board, sent, context, seed, write, row, sentAt, opened, clock } = await open();
        try {
            const at = sentAt();
            await board.run(SPEC, 'plan');
            board.began(sent[0]);
            write('plan.md', '# Plan\n\nReal.\n');
            const left = opened('plan', 'planning', at);
            const done = { ...left, status: 'planned', history: [...left.history, entry('plan', 'complete', new Date(clock.ms + 500).toISOString(), 'ai')] };
            seed(done);
            board.settle();
            assert.deepEqual(context(), done);
            assert.equal(row().steps.plan, 'completed');
        } finally {
            await board.close();
        }
    });

    it('does not show a folded run mid-specify further along, and closes only specify when that turn ends', async () => {
        const { root, board, sent, context, seed, row, sentAt, later } = await open();
        try {
            const at = sentAt();
            await board.specify('Count the stars', 'companion');
            board.began(sent[0]);
            const created = 'specs/002-star-count';
            mkdirSync(join(root, created));
            const left = { workflow: 'companion', specName: 'Star Count', currentStep: 'specify', status: 'specifying', history: [entry('specify', 'start', at)] };
            seed(left, created);
            writeFileSync(join(root, created, 'spec.md'), '# Feature Specification: Star Count\n\nReal.\n');
            writeFileSync(join(root, created, 'plan.md'), '# Plan\n\nReal.\n');
            board.rescan();
            assert.deepEqual([row(created).steps.specify, row(created).steps.plan], ['in-progress', 'not-started']);
            assert.equal(row(created).statusLabel, 'Specifying');
            assert.deepEqual(context(created), left);
            board.settle(later());
            assert.deepEqual(context(created).history.map(e => [e.step, e.kind]), [['specify', 'start'], ['specify', 'complete']]);
            assert.equal(context(created).status, 'specified');
        } finally {
            await board.close();
        }
    });

    it('leaves a step it did not send to the record', async () => {
        const { board, context, seed, write, row, opened } = await open();
        try {
            const left = opened('plan', 'planning', '2026-10-05T15:00:00.000Z');
            seed(left);
            write('plan.md', '# Plan\n\nReal.\n');
            board.settle();
            board.rescan();
            assert.deepEqual(context(), left);
            assert.equal(row().steps.plan, 'in-progress');
        } finally {
            await board.close();
        }
    });

    it('never moves a record backwards, and leaves implement to the recorder', async () => {
        const { board, sent, context, seed, write, sentAt, opened } = await open({ files: ['spec.md', 'plan.md', 'tasks.md'] });
        try {
            const tasked = { ...SPECIFIED, currentStep: 'tasks', status: 'ready-to-implement' };
            seed(tasked);
            await board.run(SPEC, 'plan');
            board.began(sent.at(-1));
            write('plan.md', '# Plan\n\nRewritten.\n');
            board.settle();
            assert.deepEqual(context(), tasked);
            const at = sentAt();
            await board.run(SPEC, 'implement');
            board.began(sent.at(-1));
            const left = opened('implement', 'implementing', at, tasked);
            seed(left);
            write('tasks.md', '- [x] T001 One\n');
            board.settle();
            assert.deepEqual(context(), left);
        } finally {
            await board.close();
        }
    });
});

describe('the board\'s own record writer', () => {
    const START = '2026-10-05T15:00:00.000Z';
    const END = '2026-10-05T15:02:00.000Z';
    const SPECIFIED = { workflow: 'speckit', specName: 'X', currentStep: 'specify', status: 'specified', history: [] };

    function project(record) {
        const root = mkdtempSync(join(tmpdir(), 'canvas-record-'));
        mkdirSync(join(root, 'specs/001-x'), { recursive: true });
        const file = join(root, 'specs/001-x/.spec-context.json');
        if (record !== undefined) writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
        return { root, file, spec: { id: 'specs/001-x', title: 'X' }, read: () => JSON.parse(readFileSync(file, 'utf8')) };
    }

    it('creates the record only when the file is missing, and appends to one it can read', () => {
        const fresh = project();
        assert.equal(recordStep(fresh.root, fresh.spec, 'specify', START, END), true);
        assert.equal(fresh.read().status, 'specified');
        const { root, spec, read } = project(SPECIFIED);
        assert.equal(recordStep(root, spec, 'plan', START, END), true);
        assert.deepEqual([read().status, read().currentStep, read().history.length], ['planned', 'plan', 2]);
    });

    it('writes nothing over a record it could not read', { skip: process.getuid?.() === 0 }, () => {
        const { root, file, spec } = project({ ...SPECIFIED, status: 'implemented', currentStep: 'implement' });
        const before = readFileSync(file, 'utf8');
        chmodSync(file, 0o000);
        try {
            assert.equal(recordStep(root, spec, 'plan', START, END), false);
        } finally {
            chmodSync(file, 0o644);
        }
        assert.equal(readFileSync(file, 'utf8'), before);
        const broken = project('{ not json');
        assert.equal(recordStep(broken.root, broken.spec, 'plan', START, END), false);
        assert.equal(readFileSync(broken.file, 'utf8'), '{ not json');
    });

    it('never lowers the status or the current step', () => {
        for (const [status, currentStep, step] of [['implemented', 'implement', 'plan'], ['planned', 'plan', 'plan'], ['ready-to-implement', 'tasks', 'specify'], ['specified', 'tasks', 'plan'], ['some-custom-status', 'plan', 'tasks']]) {
            const record = { ...SPECIFIED, status, currentStep };
            const { root, spec, read } = project(record);
            assert.equal(recordStep(root, spec, step, START, END), false, `${status} then ${step}`);
            assert.deepEqual(read(), record);
        }
    });

    it('closes only a step the record shows open, and gives a start from an earlier run no time', () => {
        const start = at => ({ step: 'plan', substep: null, kind: 'start', by: 'extension', at });
        const open = at => ({ ...SPECIFIED, currentStep: 'plan', status: 'planning', history: [start(at)] });
        const fresh = project(open(START));
        assert.equal(recordStep(fresh.root, fresh.spec, 'plan', START, END, { closing: true }), true);
        assert.deepEqual([fresh.read().status, fresh.read().history.map(e => e.kind).join()], ['planned', 'start,complete']);
        assert.equal(recordStep(fresh.root, fresh.spec, 'plan', START, END, { closing: true }), false, 'already closed');
        const stale = project(open('2026-10-01T09:00:00.000Z'));
        assert.equal(recordStep(stale.root, stale.spec, 'plan', START, END, { closing: true }), true);
        assert.deepEqual(stale.read().history.map(e => [e.kind, e.at]), [['start', '2026-10-01T09:00:00.000Z'], ['start', START], ['complete', END]]);
        for (const record of [undefined, '{ not json', SPECIFIED, { ...SPECIFIED, currentStep: 'tasks', status: 'tasking', history: [{ ...start(START), step: 'tasks' }] }, { ...open(START), status: 'completed' }]) {
            const { root, file, spec } = project(record);
            const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
            assert.equal(recordStep(root, spec, 'plan', START, END, { closing: true }), false);
            assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : null, before);
        }
    });

    it('takes the lock the other writers take, and stands back while a live writer holds it', () => {
        const { root, file, spec, read } = project(SPECIFIED);
        const lock = recordLockPath(file);
        assert.match(lock, /speckit-companion-locks[\\/][0-9a-f]{32}\.lock$/);
        mkdirSync(join(lock, '..'), { recursive: true });
        writeFileSync(lock, `${process.pid}:some-other-scope:abc`);
        try {
            assert.equal(recordStep(root, spec, 'plan', START, END), 'busy');
            assert.deepEqual(read(), SPECIFIED);
        } finally {
            rmSync(lock, { force: true });
        }
        assert.equal(recordStep(root, spec, 'plan', START, END), true);
        assert.ok(!existsSync(lock), 'and releases it');
    });

    it('reclaims a lock nobody has touched for half a minute', () => {
        const { root, file, spec, read } = project(SPECIFIED);
        const lock = recordLockPath(file);
        mkdirSync(join(lock, '..'), { recursive: true });
        writeFileSync(lock, '1:some-other-scope:abc');
        utimesSync(lock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
        assert.equal(recordStep(root, spec, 'plan', START, END), true);
        assert.equal(read().status, 'planned');
        assert.ok(!existsSync(lock));
    });
});

describe('review notes', () => {
    it('saves anchored notes under the shared lock and refines only after a successful send', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-review-'));
        const dir = join(root, 'specs', '001-review');
        mkdirSync(dir, { recursive: true });
        const source = join(dir, 'spec.md');
        const file = join(dir, '.spec-context.json');
        const record = { workflow: 'speckit', specName: 'Review', status: 'specified', currentStep: 'specify', history: [{ step: 'specify', kind: 'complete', at: '2026-01-01T00:00:00Z' }], custom: { keep: true } };
        writeFileSync(source, '# Review\n\nFirst line.\nSecond line.\n');
        writeFileSync(file, JSON.stringify(record));
        let delivered = false;
        const sent = [];
        const board = await createSpecServer({ root, send: async prompt => { sent.push(prompt); return delivered; } });
        const post = (path, body) => call(board, path, { method: 'POST', headers: { 'x-speckit-token': board.token }, body });
        const detail = async () => JSON.parse((await call(board, '/api/spec?id=001-review', { headers: { 'x-speckit-token': board.token } })).body);
        try {
            const version = (await detail()).documents.find(d => d.type === 'spec').version;
            const input = { spec: '001-review', doc: 'spec', action: 'add', line: 3, version, comment: 'Clarify the scope.' };
            const lock = recordLockPath(file);
            mkdirSync(join(lock, '..'), { recursive: true });
            writeFileSync(lock, `${process.pid}:other-scope:held`);
            try {
                assert.equal((await post('/api/review', input)).status, 400);
                assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record);
            } finally {
                rmSync(lock, { force: true });
            }
            assert.equal((await post('/api/review', { ...input, version: 'stale' })).status, 400);
            assert.equal((await post('/api/review', { ...input, doc: '../outside' })).status, 400);
            assert.equal((await post('/api/review', input)).status, 200);
            let current = JSON.parse(readFileSync(file, 'utf8'));
            assert.deepEqual(current.history, record.history);
            assert.deepEqual(current.custom, record.custom);
            assert.equal(current.status, record.status);
            assert.deepEqual(current.reviewComments[0].anchor, { heading: 'Review', blockText: 'First line.\nSecond line.', line: 3 });
            const id = current.reviewComments[0].id;
            assert.equal((await post('/api/review', { spec: '001-review', action: 'edit', id, comment: 'Clarify the boundary.' })).status, 200);
            const fallback = JSON.parse((await post('/api/refine', { spec: '001-review', doc: 'spec' })).body);
            assert.equal(fallback.sent, false);
            assert.equal(JSON.parse(readFileSync(file, 'utf8')).reviewComments[0].status, 'pending');
            delivered = true;
            const result = JSON.parse((await post('/api/refine', { spec: '001-review', doc: 'spec' })).body);
            assert.equal(result.sent, true);
            assert.match(sent.at(-1), /Edit specs\/001-review\/spec\.md in place/);
            assert.match(sent.at(-1), /Clarify the boundary\./);
            current = JSON.parse(readFileSync(file, 'utf8'));
            assert.equal(current.reviewComments[0].status, 'applied');
            assert.deepEqual(current.history, record.history);
            assert.equal((await post('/api/review', { spec: '001-review', action: 'remove', id })).status, 200);
            assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).reviewComments, []);
        } finally {
            await board.close();
        }
    });

    it('keeps an edited note pending if it changed while refinement was being sent', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-review-race-'));
        const dir = join(root, 'specs', '001-review');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'spec.md'), '# Review\n\nText.\n');
        const file = join(dir, '.spec-context.json');
        writeFileSync(file, JSON.stringify({ workflow: 'speckit', specName: 'Review', status: 'specified', history: [], reviewComments: [{ id: 'one', doc: 'spec', anchor: { heading: 'Review', blockText: 'Text.', line: 3 }, comment: 'Original', status: 'pending', createdAt: '2026-01-01T00:00:00Z' }] }));
        let resolveSend;
        let started;
        const sending = new Promise(resolve => { started = resolve; });
        const board = await createSpecServer({ root, send: () => { started(); return new Promise(resolve => { resolveSend = resolve; }); } });
        const post = (path, body) => call(board, path, { method: 'POST', headers: { 'x-speckit-token': board.token }, body });
        try {
            const refinement = post('/api/refine', { spec: '001-review', doc: 'spec' });
            await sending;
            assert.equal((await post('/api/review', { spec: '001-review', action: 'edit', id: 'one', comment: 'Changed' })).status, 200);
            resolveSend(true);
            assert.equal((await refinement).status, 200);
            const note = JSON.parse(readFileSync(file, 'utf8')).reviewComments[0];
            assert.equal(note.comment, 'Changed');
            assert.equal(note.status, 'pending');
        } finally {
            await board.close();
        }
    });

    it('keeps review notes on closed specs read-only', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-review-closed-'));
        const dir = join(root, 'specs', '001-review');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'spec.md'), '# Review\n\nText.\n');
        const file = join(dir, '.spec-context.json');
        const record = { status: 'completed', currentStep: 'implement', history: [], reviewComments: [{ id: 'one', doc: 'spec', anchor: { heading: 'Review', blockText: 'Text.', line: 3 }, comment: 'Original', status: 'pending', createdAt: '2026-01-01T00:00:00Z' }] };
        writeFileSync(file, JSON.stringify(record));
        const board = await createSpecServer({ root, send: async () => true });
        const post = (path, body) => call(board, path, { method: 'POST', headers: { 'x-speckit-token': board.token }, body });
        try {
            assert.equal((await post('/api/review', { spec: '001-review', action: 'remove', id: 'one' })).status, 400);
            assert.equal((await post('/api/refine', { spec: '001-review', doc: 'spec' })).status, 400);
            assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record);
        } finally {
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('what a file event sends to the page', () => {
    it('sends nothing for a scan that changed nothing, and the change when there is one', async () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-quiet-scan-'));
        mkdirSync(join(root, 'specs/001-x'), { recursive: true });
        const spec = join(root, 'specs/001-x/spec.md');
        writeFileSync(spec, '# X\n');
        const at = new Date(Date.now() - 60000);
        utimesSync(spec, at, at);
        utimesSync(join(root, 'specs/001-x'), at, at);
        const board = await createSpecServer({ root, send: async () => true });
        const stream = listen(board);
        try {
            await until(() => stream.snapshots.length === 1, 'the opening snapshot');
            for (let i = 0; i < 3; i++) {
                writeFileSync(spec, '# X\n');
                utimesSync(spec, at, at);
                utimesSync(join(root, 'specs/001-x'), at, at);
                await new Promise(r => setTimeout(r, 300));
            }
            writeFileSync(join(root, 'specs/001-x/plan.md'), '# Plan\n\nReal.\n');
            await until(() => stream.snapshots.at(-1).specs[0].files.plan === 'plan.md', 'the snapshot with the plan');
            assert.equal(stream.snapshots.filter(s => s.specs[0].files.plan !== 'plan.md').length, 1, 'only the opening snapshot came before the change');
            const count = stream.snapshots.length;
            board.rescan();
            await until(() => stream.snapshots.length === count + 1, 'a snapshot for a scan that was asked for');
        } finally {
            stream.close();
            await board.close();
        }
    });
});
