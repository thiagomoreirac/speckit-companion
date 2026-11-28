import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusinessPlanHost } from '../com.github.copilot/extensions/speckit-companion/business-plan.mjs';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';

describe('Business Plan canvas host', () => {
    let root;
    let sent;
    let host;

    before(() => {
        root = mkdtempSync(join(tmpdir(), 'canvas-business-plan-'));
        sent = [];
        host = createBusinessPlanHost({
            send: async (label, prompt) => {
                sent.push({ label, prompt });
                return { sent: true };
            },
        });
    });

    after(() => rmSync(root, { recursive: true, force: true }));

    it('creates the consuming-project demo plan, validates all 8 checks, and updates node approvals', async () => {
        const [initial] = await host.run(root, { type: 'ready' });
        assert.equal(initial.type, 'state');
        assert.equal(initial.payload.plans.length, 0);
        assert.equal(initial.payload.activePlanPath, null);
        assert.equal(initial.payload.graph, null);

        const created = await host.run(root, { type: 'createDemoPlan' });
        const stateMsg = created.find(m => m.type === 'state');
        assert.ok(stateMsg);
        assert.equal(stateMsg.payload.plans.length, 1);
        assert.equal(stateMsg.payload.activePlanPath, 'examples/consuming-project/traceability.json');
        assert.equal(stateMsg.payload.validation.passed, true);
        assert.equal(stateMsg.payload.validation.checks.length, 8);
        assert.ok(stateMsg.payload.graph.nodes.length >= 16);

        const targetNode = stateMsg.payload.graph.nodes.find(n => n.kind === 'business-case');
        assert.ok(targetNode);

        const updated = await host.run(root, {
            type: 'updateNodeApproval',
            filePath: stateMsg.payload.activePlanPath,
            nodeId: targetNode.id,
            status: 'approved',
            owner: 'finance-lead',
            reference: 'APR-2026-01',
        });
        const updatedState = updated.find(m => m.type === 'state');
        const reloadedNode = updatedState.payload.graph.nodes.find(n => n.id === targetNode.id);
        assert.equal(reloadedNode.approval.status, 'approved');
        assert.equal(reloadedNode.approval.owner, 'finance-lead');
        assert.equal(reloadedNode.approval.reference, 'APR-2026-01');

        const persisted = JSON.parse(readFileSync(join(root, 'examples/consuming-project/traceability.json'), 'utf8'));
        const persistedNode = persisted.nodes.find(n => n.id === targetNode.id);
        assert.equal(persistedNode.approval.status, 'approved');
    });

    it('creates a new starter plan and prompts when title is omitted', async () => {
        const promptMessages = await host.run(root, { type: 'createNewPlan' });
        assert.deepEqual(promptMessages, [{ type: 'createPlanPrompt' }]);

        const created = await host.run(root, {
            type: 'createNewPlan',
            title: 'Enterprise Launch 2026',
            summary: 'B2B launch traceability graph',
        });
        const stateMsg = created.find(m => m.type === 'state');
        assert.equal(stateMsg.payload.activePlanPath, 'business-plans/enterprise-launch-2026/traceability.json');
        assert.equal(stateMsg.payload.plans.find(p => p.filePath === stateMsg.payload.activePlanPath).summary, 'B2B launch traceability graph');
    });

    it('opens in-root source files and rejects path traversal', async () => {
        const viewer = await host.run(root, {
            type: 'openSource',
            filePath: 'examples/consuming-project/traceability.json',
        });
        assert.equal(viewer[0].type, 'fileViewer');
        assert.match(viewer[0].content, /business-case/);

        const outside = join(tmpdir(), 'outside-bp-test.json');
        writeFileSync(outside, '{"secret":true}');
        try {
            const blocked = await host.run(root, { type: 'openSource', filePath: '../outside-bp-test.json' });
            assert.equal(blocked[0].type, 'notice');
            assert.equal(blocked[0].tone, 'error');
        } finally {
            rmSync(outside, { force: true });
        }
    });

    it('dispatches workflow and catalog commands through the session sender', async () => {
        const stepResult = await host.run(root, {
            type: 'runStep',
            commandId: 'speckit.business-plan.discovery',
            graphPath: 'examples/consuming-project/traceability.json',
        });
        assert.equal(stepResult[0].type, 'notice');
        assert.equal(stepResult[0].tone, 'done');
        assert.match(sent.at(-1).prompt, /\/speckit\.business-plan\.discovery/);

        await host.run(root, {
            type: 'registerCatalog',
            source: 'https://github.com/thiagomoreirac/speckit-catalog',
            ref: 'main',
        });
        assert.match(sent.at(-1).prompt, /specify extension catalog add/);
        assert.match(sent.at(-1).prompt, /specify bundle catalog add/);

        await host.run(root, { type: 'installBundle', version: '0.1.0' });
        assert.match(sent.at(-1).prompt, /specify bundle install business-plan --version 0\.1\.0/);
    });

    it('exposes bundle workflow intake choices and scaffolds starter graphs via createFromIntake', async () => {
        const plainRoot = mkdtempSync(join(tmpdir(), 'canvas-bp-plain-'));
        const bundleRoot = mkdtempSync(join(tmpdir(), 'canvas-bp-bundle-'));
        try {
            const plain = host.intakeChoices(plainRoot);
            assert.equal(plain.installed, false);
            assert.equal(plain.default, 'work');

            mkdirSync(join(bundleRoot, '.specify', 'extensions'), { recursive: true });
            mkdirSync(join(bundleRoot, '.specify', 'workflows'), { recursive: true });
            writeFileSync(join(bundleRoot, '.specify', 'bundle-records.json'), JSON.stringify({
                bundles: { 'business-plan': { version: '0.1.0' } },
            }));
            writeFileSync(join(bundleRoot, '.specify', 'extensions', '.registry'), JSON.stringify({
                extensions: { 'business-plan': { version: '0.1.0', enabled: true } },
            }));
            writeFileSync(join(bundleRoot, '.specify', 'workflows', 'business-plan.yml'), 'id: business-plan\nversion: "0.1.0"\n');

            const choices = host.intakeChoices(bundleRoot);
            assert.equal(choices.installed, true);
            assert.equal(choices.bundleVersion, '0.1.0');
            assert.equal(choices.default, 'workflow');
            assert.deepEqual(choices.choices.map(c => c.id), ['workflow', 'discovery', 'plan', 'work']);
            assert.equal(choices.choices.every(c => c.available), true);
            assert.equal(choices.workflow.phases.length, 3);

            const wf = await host.createFromIntake(bundleRoot, {
                title: 'Q3 Self-Serve Growth',
                brief: 'Reduce activation drop-off across self-serve trials.',
                owner: 'VP Product',
                criteria: 'Lift day-7 activation by 15% without hurting support volume.',
                workflow: 'workflow',
                draft: true,
            });
            assert.equal(wf.graphPath, 'business-plans/q3-self-serve-growth/traceability.json');
            assert.equal(wf.sent, true);
            assert.match(wf.prompt, /specify workflow run business-plan/);
            assert.match(wf.prompt, /--input draft=true/);
            assert.match(wf.prompt, /VP Product/);
            const saved = JSON.parse(readFileSync(join(bundleRoot, wf.graphPath), 'utf8'));
            assert.equal(saved.nodes[0].approval.owner, 'VP Product');
            assert.equal(saved.nodes[0].approval.status, 'pending');
            assert.equal(saved.nodes[0].approval.reference, 'TBD');

            await assert.rejects(
                () => host.createFromIntake(bundleRoot, {
                    title: 'Duplicate',
                    brief: 'Should not overwrite existing graph.',
                    graphPath: wf.graphPath,
                    workflow: 'graph-only',
                }),
                /already exists/,
            );

            const disc = await host.createFromIntake(bundleRoot, {
                title: 'Partner Channel',
                brief: 'Assess reseller channel economics.',
                workflow: 'discovery',
            });
            assert.match(disc.prompt, /\/speckit\.business-plan\.discovery/);

            const graphOnly = await host.createFromIntake(bundleRoot, {
                title: 'Graph Only Plan',
                brief: 'Seed graph without chat dispatch.',
                workflow: 'graph-only',
            });
            assert.equal(graphOnly.sent, false);
            assert.equal(graphOnly.prompt, null);
            assert.equal(graphOnly.graphPath, 'business-plans/graph-only-plan/traceability.json');
        } finally {
            rmSync(plainRoot, { recursive: true, force: true });
            rmSync(bundleRoot, { recursive: true, force: true });
        }
    });
});

describe('Business Plan HTTP routes on board server', () => {
    let root;
    let server;

    before(async () => {
        root = mkdtempSync(join(tmpdir(), 'canvas-bp-server-'));
        server = await createSpecServer({
            root,
            send: async () => true,
        });
    });

    after(async () => {
        await server.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('serves the business plan iframe assets and JSON endpoints', async () => {
        const base = `http://127.0.0.1:${server.port}`;
        const token = server.token;

        for (const asset of ['/business-plan', '/business-plan.js', '/business-plan.css', '/business-plan-bridge.js', '/business-plan-canvas.css']) {
            const res = await fetch(`${base}${asset}?token=${encodeURIComponent(token)}`);
            assert.equal(res.status, 200, `${asset} should return 200`);
        }

        const summaryBefore = await fetch(`${base}/api/business-plans?token=${encodeURIComponent(token)}`).then(r => r.json());
        assert.equal(summaryBefore.plans.length, 0);

        const created = await fetch(`${base}/api/business-plan?token=${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'createDemoPlan', expectedRoot: root }),
        }).then(r => r.json());
        assert.ok(created.messages.some(m => m.type === 'state' && m.payload.plans.length === 1));

        const summaryAfter = await fetch(`${base}/api/business-plans?token=${encodeURIComponent(token)}`).then(r => r.json());
        assert.equal(summaryAfter.plans.length, 1);
        assert.equal(summaryAfter.validation.passed, true);
        assert.equal(summaryAfter.validation.passedChecks, 8);
        assert.equal(summaryAfter.validation.totalChecks, 8);

        mkdirSync(join(root, '.specify', 'extensions'), { recursive: true });
        mkdirSync(join(root, '.specify', 'workflows'), { recursive: true });
        writeFileSync(join(root, '.specify', 'bundle-records.json'), JSON.stringify({
            bundles: { 'business-plan': { version: '0.1.0' } },
        }));
        writeFileSync(join(root, '.specify', 'workflows', 'business-plan.yml'), 'id: business-plan\nversion: "0.1.0"\n');

        const snap = await fetch(`${base}/api/snapshot?token=${encodeURIComponent(token)}`).then(r => r.json());
        assert.equal(snap.businessPlan.installed, true);
        assert.equal(snap.businessPlan.default, 'workflow');

        const intake = await fetch(`${base}/api/business-plan/create?token=${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                expectedRoot: root,
                title: 'API Intake Plan',
                brief: 'Launch self-serve onboarding tier.',
                workflow: 'graph-only',
            }),
        }).then(r => r.json());
        assert.equal(intake.graphPath, 'business-plans/api-intake-plan/traceability.json');
        assert.equal(intake.sent, false);
    });
});
