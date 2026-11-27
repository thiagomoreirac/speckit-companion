import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';
import { cloudGateInbox, decisionReconcilePrompt } from '../com.github.copilot/extensions/speckit-companion/cloud-gates.mjs';
import { previewDecisionPromotions, decisionPromotionPrompt } from '../com.github.copilot/extensions/speckit-companion/decision-context.mjs';
import { reconcileDeliveryRecord } from '../com.github.copilot/extensions/speckit-companion/delivery-ledger.mjs';

function makeRepo(t) {
    const parent = mkdtempSync(join(tmpdir(), 'speckit-multichannel-'));
    const root = join(parent, 'repo');
    mkdirSync(root, { recursive: true });
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    git('remote', 'add', 'origin', 'https://github.com/octo/demo.git');
    mkdirSync(join(root, '.specify'), { recursive: true });
    writeFileSync(join(root, '.specify', 'decisions.json'), JSON.stringify({
        schema: 1,
        decisions: [
            {
                id: 'ADR-001',
                status: 'accepted',
                specs: ['specs/002-billing'],
                summary: 'Use Postgres for billing state.',
            },
        ],
    }, null, 2));
    writeFileSync(join(root, 'README.md'), '# Demo\n');
    git('add', '.');
    git('commit', '-m', 'init');
    const mainSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', mainSha);
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return { root, git, mainSha };
}

test('offline cross-branch gate scanning surfaces paused gates on other branches and correlates delivery records', t => {
    const { root, git } = makeRepo(t);
    git('checkout', '-b', 'feat/billing');
    mkdirSync(join(root, 'specs', '002-billing'), { recursive: true });
    const specBytes = Buffer.from('# Billing\n');
    writeFileSync(join(root, 'specs', '002-billing', 'spec.md'), specBytes);
    git('add', 'specs/002-billing/spec.md');
    git('commit', '-m', 'add billing spec');
    const evidenceSha = git('rev-parse', 'HEAD');
    const sha256 = createHash('sha256').update(specBytes).digest('hex');

    mkdirSync(join(root, '.speckit-companion', 'cloud-gates'), { recursive: true });
    writeFileSync(join(root, '.speckit-companion', 'cloud-gates', 'bc78faa7.json'), JSON.stringify({
        schema: 1,
        runId: 'bc78faa7',
        gate: 'spec-approval-billing',
        status: 'paused',
        repository: 'octo/demo',
        branch: 'feat/billing',
        issue: 42,
        evidencePath: 'specs/002-billing/spec.md',
        evidenceRevision: evidenceSha,
        evidenceSha256: sha256,
        choice: null,
        commentId: null,
    }, null, 2));
    git('add', '.speckit-companion/cloud-gates/bc78faa7.json');
    git('commit', '-m', 'add cloud gate on feat/billing');

    git('checkout', 'main');

    reconcileDeliveryRecord(root, {
        kind: 'spec',
        id: '002-billing',
        title: 'Billing',
        branch: 'feat/billing',
        issue: { number: 42, url: 'https://github.com/octo/demo/issues/42', state: 'open' },
        pr: { number: 55, url: 'https://github.com/octo/demo/pull/55', state: 'open' },
        gate: { id: 'bc78faa7', status: 'paused', url: 'https://github.com/octo/demo/issues/42' },
    });

    const inbox = cloudGateInbox(root);
    assert.equal(inbox.branch, 'main');
    assert.equal(inbox.repository, 'octo/demo');
    assert.equal(inbox.paused.length, 0);
    assert.equal(inbox.crossBranch.length, 1);
    assert.equal(inbox.crossBranch[0].runId, 'bc78faa7');
    assert.equal(inbox.crossBranch[0].branch, 'feat/billing');
    assert.equal(inbox.crossBranch[0].issue, 42);
    assert.equal(inbox.deliveryLinks.length, 1);
    assert.equal(inbox.deliveryLinks[0].pr.number, 55);

    const prompt = decisionReconcilePrompt(root);
    assert.match(prompt, /octo\/demo/);
    assert.match(prompt, /42/);
    assert.match(prompt, /feat\/billing/);
    assert.match(prompt, /Never auto-approve a paused gate/i);
});

test('ADR promotion harvests .spec-context.json decisions, deduplicates against origin/HEAD, and formats schema v1', t => {
    const { root } = makeRepo(t);
    mkdirSync(join(root, 'specs', '002-billing'), { recursive: true });
    writeFileSync(join(root, 'specs', '002-billing', '.spec-context.json'), JSON.stringify({
        decisions: [
            { id: 'ADR-001', summary: 'Use Postgres for billing state.', status: 'accepted' },
            { summary: 'Emit idempotent webhook retries with exponential backoff.', status: 'accepted' },
            { id: 'ADR-010', title: 'Stripe webhook signing secret rotation via vault', status: 'proposed' },
        ],
    }, null, 2));

    const preview = previewDecisionPromotions(root);
    assert.equal(preview.available, true);
    assert.equal(preview.existingCount, 1);
    assert.equal(preview.candidates.length, 2);
    assert.ok(preview.candidates.every(c => /^ADR-[A-Z0-9][A-Z0-9-]{0,39}$/.test(c.id)));
    assert.equal(preview.candidates.some(c => c.id === 'ADR-001'), false);
    assert.ok(preview.candidates.some(c => c.id === 'ADR-010'));

    const prompt = decisionPromotionPrompt(root);
    assert.match(prompt, /ADR-010/);
    assert.match(prompt, /\.specify\/decisions\.json/);
    assert.match(prompt, /schema/);
    assert.match(prompt, /pull request/i);
});

test('server exposes multichannel decision routes while preserving 404 on direct gate writes', async t => {
    const { root } = makeRepo(t);
    mkdirSync(join(root, 'specs', '003-sync'), { recursive: true });
    writeFileSync(join(root, 'specs', '003-sync', '.spec-context.json'), JSON.stringify({
        decisions: [
            { id: 'ADR-020', summary: 'Persist delivery links in .speckit-companion/delivery.', status: 'accepted' },
        ],
    }, null, 2));

    const delivered = [];
    const board = await createSpecServer({
        root,
        send: async (text) => { delivered.push(text); return true; },
    });
    t.after(() => board.close());
    const headers = { 'x-speckit-token': board.token, 'content-type': 'application/json' };
    const url = (path) => new URL(path, board.url);

    // Guardrail: direct decision mutation routes must still return 404.
    const postDecision = await fetch(url('/api/decisions'), { method: 'POST', headers, body: '{}' });
    const postApprove = await fetch(url('/api/decisions/approve'), { method: 'POST', headers, body: '{}' });
    assert.equal(postDecision.status, 404);
    assert.equal(postApprove.status, 404);

    // GET /api/decisions includes adrPromotions + crossBranch + deliveryLinks.
    const decisionsRes = await fetch(url('/api/decisions'), { headers });
    assert.equal(decisionsRes.status, 200);
    const decisions = await decisionsRes.json();
    assert.equal(decisions.adrPromotions.candidates.length, 1);
    assert.equal(decisions.adrPromotions.candidates[0].id, 'ADR-020');

    // GET /api/decisions/promotions works standalone.
    const promoRes = await fetch(url('/api/decisions/promotions'), { headers });
    assert.equal(promoRes.status, 200);
    const promo = await promoRes.json();
    assert.equal(promo.candidates[0].id, 'ADR-020');

    // POST /api/decisions/promote-prompt and /api/decisions/reconcile-prompt deliver handoffs to chat.
    const promotePost = await fetch(url('/api/decisions/promote-prompt'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ expectedRoot: root, candidateIds: ['ADR-020'] }),
    });
    assert.equal(promotePost.status, 200);

    const reconcilePost = await fetch(url('/api/decisions/reconcile-prompt'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ expectedRoot: root }),
    });
    assert.equal(reconcilePost.status, 200);
    assert.equal(delivered.length, 2);
    assert.match(delivered[0], /ADR-020/);
    assert.match(delivered[1], /reconcile/i);
});
