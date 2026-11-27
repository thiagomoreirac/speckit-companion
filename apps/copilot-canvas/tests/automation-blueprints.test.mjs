import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    CLOUD_AUTOMATION_BLUEPRINTS,
    blueprintHandoff,
    listAutomationBlueprints,
    validateBlueprintPack,
} from '../com.github.copilot/extensions/speckit-companion/automation-blueprints.mjs';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';

function makeRepo({ policy = undefined, setOriginHead = true, repoSlug = 'acme/widgets' } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'speckit-blueprints-'));
    const remote = join(base, 'origin.git');
    const work = join(base, 'work');
    mkdirSync(remote, { recursive: true });
    mkdirSync(work, { recursive: true });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    git(remote, 'init', '--bare');
    git(work, 'init', '-b', 'main');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test User');
    git(work, 'remote', 'add', 'origin', remote);
    if (policy !== undefined) {
        mkdirSync(join(work, '.specify'), { recursive: true });
        writeFileSync(join(work, '.specify', 'autonomy.json'), JSON.stringify(policy, null, 2));
    }
    mkdirSync(join(work, 'specs', '001-demo'), { recursive: true });
    writeFileSync(join(work, 'specs', '001-demo', 'spec.md'), '# Demo spec\n');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'init');
    git(work, 'push', '-u', 'origin', 'main');
    if (setOriginHead) {
        git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    }
    git(work, 'remote', 'set-url', 'origin', `https://github.com/${repoSlug}.git`);
    return { base, work };
}

async function call(board, path, { method = 'GET', body } = {}) {
    const res = await fetch(`http://127.0.0.1:${board.port}${path}`, {
        method,
        headers: {
            'x-speckit-token': board.token,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
}

describe('Cloud Automation blueprints and loop safety', () => {
    it('validates all four built-in blueprints as loop-safe, least-privilege, and clean of service settings', () => {
        assert.equal(CLOUD_AUTOMATION_BLUEPRINTS.length, 4);
        const validation = validateBlueprintPack(CLOUD_AUTOMATION_BLUEPRINTS);
        assert.equal(validation.ok, true, JSON.stringify(validation.errors));
        assert.equal(validation.policyCompliant, true);
        for (const bp of CLOUD_AUTOMATION_BLUEPRINTS) {
            assert.equal(bp.trigger.allow_copilot_triggers, false, `${bp.id} must leave allow_copilot_triggers false`);
            assert.ok(bp.fallbackWorkflow?.filename?.endsWith('.yml'));
            assert.ok(bp.fallbackWorkflow?.yaml?.includes('permissions:'));
        }
    });

    it('rejects self-trigger loops, cross-automation cycles, service settings in prompts, and unauthorized merge/wildcard tools', () => {
        const selfLoop = [{
            id: 'bad-commenter',
            writeScope: 'trigger',
            trigger: { type: 'github_event', event: 'issue_comment', allow_copilot_triggers: true },
            tools: ['github/add_issue_comment'],
            prompt: 'Reply on comments.',
        }];
        const res1 = validateBlueprintPack(selfLoop);
        assert.equal(res1.ok, false);
        assert.ok(res1.errors.some(e => e.code === 'self-trigger-loop'));

        const cycle = [
            {
                id: 'job-a',
                writeScope: 'trigger',
                trigger: { type: 'github_event', event: 'issues', allow_copilot_triggers: true },
                tools: ['github/create_pull_request'],
                prompt: 'Open a PR when an issue changes.',
            },
            {
                id: 'job-b',
                writeScope: 'trigger',
                trigger: { type: 'github_event', event: 'pull_request', allow_copilot_triggers: true },
                tools: ['github/update_issue'],
                prompt: 'Update the linked issue when a PR changes.',
            },
        ];
        const res2 = validateBlueprintPack(cycle);
        assert.equal(res2.ok, false);
        assert.ok(res2.errors.some(e => e.code === 'cross-blueprint-cycle'));

        const leakyAndBroad = [{
            id: 'bad-prompt',
            writeScope: 'trigger',
            trigger: { type: 'schedule', rhythm: 'daily', hour: 8, minute: 0, allow_copilot_triggers: false },
            tools: ['github/*', 'github/merge_pull_request'],
            prompt: 'Ensure require_actor_write_permission is true before running.',
        }];
        const res3 = validateBlueprintPack(leakyAndBroad, { policy: { allowAutoMerge: false, allowedWriteScopes: ['trigger'] } });
        assert.equal(res3.ok, false);
        assert.ok(res3.errors.some(e => e.code === 'service-setting-in-prompt'));
        assert.ok(res3.errors.some(e => e.code === 'wildcard-tool'));
        assert.ok(res3.errors.some(e => e.code === 'policy-merge-forbidden'));
    });

    it('enforces repository autonomyPolicy.allowedWriteScopes on blueprints and saved cloud routine drafts', async () => {
        const { base, work } = makeRepo({
            policy: {
                schema: 1,
                defaultMode: 'gated',
                allowUnattended: true,
                allowAutoPr: true,
                allowAutoMerge: false,
                allowedWriteScopes: ['trigger'],
            },
        });
        const prompts = [];
        const board = await createSpecServer({ root: work, send: async prompt => { prompts.push(prompt); return true; } });
        try {
            const catalog = listAutomationBlueprints(work);
            assert.equal(catalog.repository, 'acme/widgets');
            assert.equal(catalog.validation.ok, true);
            assert.equal(catalog.validation.policyCompliant, false);
            const reconciler = catalog.blueprints.find(bp => bp.id === 'delivery-ledger-reconciler');
            assert.equal(reconciler.policyCompliant, false);
            assert.ok(reconciler.issues.some(i => i.code === 'policy-write-scope'));

            const dispatch = catalog.blueprints.find(bp => bp.id === 'spec-issue-dispatch');
            assert.equal(dispatch.policyCompliant, true);

            // GET /api/routines/blueprints exposes validated catalog.
            const bpRes = await call(board, '/api/routines/blueprints');
            assert.equal(bpRes.status, 200);
            assert.equal(bpRes.json.blueprints.length, 4);

            // Saving repository-scoped draft is rejected by policy; trigger-scoped draft succeeds.
            const blockedSave = await call(board, '/api/routines/save-blueprint', {
                method: 'POST',
                body: { expectedRoot: board.snapshot.root, blueprintId: 'delivery-ledger-reconciler' },
            });
            assert.equal(blockedSave.status, 400);
            assert.match(blockedSave.json.error, /allowed|write_scope/i);

            const saved = await call(board, '/api/routines/save-blueprint', {
                method: 'POST',
                body: { expectedRoot: board.snapshot.root, blueprintId: 'spec-issue-dispatch', ownership: 'personal' },
            });
            assert.equal(saved.status, 200);
            assert.equal(saved.json.rhythm, 'event');
            assert.equal(saved.json.event, 'issues');
            assert.equal(saved.json.ownership, 'personal');
            assert.equal(saved.json.writeScope, 'trigger');
            assert.equal(saved.json.blueprintId, 'spec-issue-dispatch');

            // Reviewing the full pack sends an automation-group-creator handoff without creating resources.
            const packReview = await call(board, '/api/routines/blueprint-review', {
                method: 'POST',
                body: { expectedRoot: board.snapshot.root, pack: true },
            });
            assert.equal(packReview.status, 200);
            assert.equal(prompts.length, 1);
            assert.match(prompts[0], /automation-group-creator/);
            assert.match(prompts[0], /Repository autonomy policy restrictions apply/);
            assert.match(prompts[0], /disabled: true/);
            assert.match(prompts[0], /GitHub Actions fallback/);

            // Single-blueprint handoff uses automation-creator.
            const single = blueprintHandoff(work, { blueprintId: 'gate-decision-bridge' });
            assert.match(single, /Use the automation-creator workflow/);
            assert.match(single, /"event":"issue_comment"/);
            assert.match(single, /"allow_copilot_triggers":false/);

            // Event rhythm rejected for local command routines.
            const badEvent = await call(board, '/api/routines/save', {
                method: 'POST',
                body: {
                    expectedRoot: board.snapshot.root,
                    name: 'Bad event',
                    kind: 'command',
                    action: 'speckit.analyze',
                    rhythm: 'event',
                    event: 'issues',
                },
            });
            assert.equal(badEvent.status, 400);
        } finally {
            await board.close();
            rmSync(base, { recursive: true, force: true });
        }
    });
});
