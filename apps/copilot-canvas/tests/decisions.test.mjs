import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';

const repository = 'thiagomoreirac/speckit-companion-canvas-demo';
const github = `https://github.com/${repository}`;
const branch = 'pilot/roster-a';
const evidence = 'specs/002-trailhead-roster-review/spec.md';
const revision = '0123456789abcdef0123456789abcdef01234567';
const bytes = Buffer.from('# Roster\r\n\r\nReview the pilot.  \r\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const gate = { schema: 1, repository, branch, issue: 101, runId: 'bc78faa7', gate: 'review-roster', evidencePath: evidence,
    evidenceRevision: revision, evidenceSha256: sha256, status: 'paused', choice: null, commentId: null };
const receipt = '12345678901234567890';

async function fixture(t) {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'canvas-decisions-')));
    const root = join(parent, 'repo');
    mkdirSync(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'ignore' });
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    git('init', '-b', branch);
    git('remote', 'add', 'origin', `${github}.git`);
    const sent = [];
    const board = await createSpecServer({ root, saveRoot: () => {}, send: async value => { sent.push(value); return true; } });
    const headers = { 'x-speckit-token': board.token };
    const endpoint = new URL('/api/decisions', board.url);
    const read = async (path = endpoint) => {
        const response = await fetch(path, { headers });
        assert.equal(response.status, 200);
        return response.json();
    };
    const directory = join(root, '.speckit-companion', 'cloud-gates');
    const file = (name, value) => {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, value);
        return path;
    };
    const record = (data = {}, id = data.runId ?? gate.runId) =>
        file(`.speckit-companion/cloud-gates/${id}.json`, JSON.stringify({ ...gate, ...data }));
    return { parent, root, board, git, sent, endpoint, headers, read, directory, file, record };
}

describe('local cloud gate inbox', () => {
    it('serves the v1 envelope as read-only, separating paused gates from recorded receipts', async t => {
        const f = await fixture(t);
        try {
            assert.deepEqual((await f.read()).paused, []);
            assert.equal(existsSync(f.directory), false);
            f.file(evidence, bytes);
            const pausedFile = f.record();
            f.record({ runId: 'bc78faa8', issue: 102, status: 'completed', choice: 'approve', commentId: receipt });
            f.record({ runId: 'bc78faa9', issue: 103, status: 'aborted', choice: 'reject', commentId: '19' });
            f.record({ runId: 'bc78faab', issue: 104, status: 'uncertain', choice: 'approve', commentId: '22' });
            const original = readFileSync(pausedFile);
            const model = await f.read();
            assert.equal(model.branch, branch);
            assert.equal(model.repository, repository);
            assert.equal(model.problem, null);
            assert.deepEqual(model.paused, [{
                runId: gate.runId, gate: gate.gate, issue: 101, evidencePath: evidence, evidenceRevision: revision,
                status: 'paused', choice: null, commentId: null, issueUrl: `${github}/issues/101`,
                evidenceUrl: `${github}/blob/${revision}/${evidence}`, commentUrl: null, evidenceCheck: 'matches',
            }]);
            assert.deepEqual(model.past.map(({ status, choice, commentUrl }) => ({ status, choice, commentUrl })), [
                { status: 'uncertain', choice: 'approve', commentUrl: `${github}/issues/104#issuecomment-22` },
                { status: 'completed', choice: 'approve', commentUrl: `${github}/issues/102#issuecomment-${receipt}` },
                { status: 'aborted', choice: 'reject', commentUrl: `${github}/issues/103#issuecomment-19` },
            ]);
            assert.equal((await fetch(f.endpoint)).status, 403);
            const post = { method: 'POST', headers: f.headers, body: JSON.stringify({ runId: gate.runId, choice: 'approve' }) };
            assert.equal((await fetch(f.endpoint, post)).status, 404);
            assert.equal((await fetch(new URL('/api/decisions/approve', f.endpoint), post)).status, 404);
            assert.deepEqual(readFileSync(pausedFile), original);
            assert.deepEqual(f.sent, []);
        } finally {
            await f.board.close();
        }
    });

    it('skips wrong branch, foreign repository, unsafe paths and malformed records', async t => {
        const f = await fixture(t);
        try {
            const invalid = [
                { evidencePath: '../outside.md' },
                { evidencePath: 'specs/../outside.md' },
                { evidencePath: '/spec.md' },
                { evidencePath: 'specs\\spec.md' },
                { evidencePath: 'specs/%2e%2e/spec.md' },
                { evidencePath: 'specs/spec.md:stream' },
                { evidencePath: 'specs/NUL.md' },
                { evidencePath: '.git/config' },
                { evidenceRevision: revision.toUpperCase() },
                { evidenceSha256: 'bad' },
                { issue: Number.MAX_SAFE_INTEGER + 1 },
                { issue: '101' },
                { schema: '1' },
                { branch: 'pilot/../outside' },
                { gate: '<paused>' },
                { choice: 'approve' },
                { status: 'completed', choice: 'reject', commentId: '7' },
                { status: 'aborted', choice: 'reject', commentId: 7 },
                { status: 'uncertain', choice: 'approve', commentId: '0' },
                { status: 'uncertain', choice: 'retry', commentId: '5' },
                { sourceUrl: 'https://example.com' },
            ];
            invalid.forEach((value, i) => f.record({ runId: i.toString(16).padStart(8, '0'), ...value }));
            f.record({}, '12345678');
            f.record({}, `${gate.runId}extra`);
            f.file('.speckit-companion/cloud-gates/99999999.json', ' '.repeat(8193));
            f.record({ runId: 'bcaaccaa', repository: 'outside/other' });
            f.record({ runId: 'bcaaccab', branch: 'pilot/roster-b' });
            f.record();
            const model = await f.read(new URL('/api/decisions?root=outside&branch=pilot/roster-b', f.endpoint));
            assert.deepEqual(model.skipped, { invalid: invalid.length + 3, foreign: 1, otherBranch: 1 });
            assert.deepEqual(model.paused.map(item => item.runId), [gate.runId]);
            assert.deepEqual(model.past, []);

            f.git('remote', 'set-url', 'origin', 'https://example.com/outside/other');
            const wrongOrigin = await f.read();
            assert.match(wrongOrigin.problem, /direct github\.com origin/);
            assert.deepEqual(wrongOrigin.paused, []);
            assert.deepEqual(wrongOrigin.past, []);
        } finally {
            await f.board.close();
        }
    });

    it('compares exact bytes without following linked files or directories', async t => {
        const f = await fixture(t);
        try {
            f.file(evidence, bytes);
            f.record();
            f.file('specs/Review notes.md', bytes.toString().replaceAll('\r', ''));
            f.record({ runId: 'bc78faa8', evidencePath: 'specs/Review notes.md' });
            f.record({ runId: 'bc78faa9', evidencePath: 'specs/missing.md' });
            f.file('specs/too-large.md', Buffer.alloc(1024 * 1024 + 1));
            f.record({ runId: 'bc78faaa', evidencePath: 'specs/too-large.md' });
            const outside = join(f.parent, 'outside');
            mkdirSync(outside);
            writeFileSync(join(outside, 'spec.md'), bytes);
            symlinkSync(outside, join(f.root, 'specs', 'linked'), 'junction');
            f.record({ runId: 'bc78faab', evidencePath: 'specs/linked/spec.md' });
            linkSync(join(outside, 'spec.md'), join(f.root, 'specs', 'hardlink.md'));
            f.record({ runId: 'bc78faac', evidencePath: 'specs/hardlink.md' });
            linkSync(f.record({ runId: 'bc78faad' }), join(outside, 'record.json'));
            const model = await f.read();
            assert.deepEqual(model.paused.map(item => item.evidenceCheck), [
                'matches', 'stale', 'unavailable', 'unavailable', 'unavailable', 'unavailable',
            ]);
            assert.equal(model.paused[1].evidenceUrl, `${github}/blob/${revision}/specs/Review%20notes.md`);
            assert.equal(model.skipped.invalid, 1);
            renameSync(f.directory, `${f.directory}-old`);
            symlinkSync(outside, f.directory, 'junction');
            const redirected = await f.read();
            assert.match(redirected.problem, /ordinary directory/);
            assert.deepEqual(redirected.paused, []);
        } finally {
            await f.board.close();
        }
    });

    it('honors checkout changes and reports an incomplete bounded scan', async t => {
        const f = await fixture(t);
        try {
            f.record();
            for (let i = 0; i < 260; i++) writeFileSync(join(f.directory, `not-a-record-${i}`), '');
            assert.equal((await f.read()).limited, true);
            f.git('symbolic-ref', 'HEAD', 'refs/heads/pilot/roster-b');
            assert.deepEqual((await f.read()).paused, []);
            const other = join(f.parent, 'other');
            mkdirSync(join(other, '.git'), { recursive: true });
            f.board.selectRoot(other);
            const model = await f.read();
            assert.equal(model.root, other);
            assert.deepEqual(model.paused, []);
            assert.deepEqual(model.past, []);
            assert.equal(model.limited, false);
        } finally {
            await f.board.close();
        }
    });

    it('shows checkout-scoped empty, review and error states from the board toolbar', async t => {
        const { chromium } = await import('playwright-core').catch(() => ({}));
        const browser = chromium && await (chromium.launch({ channel: 'chrome', headless: true }).catch(() =>
            chromium.launch({ headless: true }).catch(() => null)));
        if (!browser) return t.skip('no Playwright/Chrome to drive');
        const f = await fixture(t);
        try {
            const page = await browser.newPage({ viewport: { width: 420, height: 760 }, colorScheme: 'dark' });
            await page.goto(f.board.url);
            const toggle = page.getByRole('button', { name: 'Decisions', exact: true });
            await toggle.click();
            const panel = page.getByRole('region', { name: 'Needs your decision' });
            const refresh = panel.getByRole('button', { name: 'Refresh decisions' });
            await panel.getByText('No cloud gate records are available in this checkout.').waitFor();
            assert.equal(await panel.getByRole('heading', { name: 'Needs your decision' }).evaluate(node => document.activeElement === node), true);

            f.file(evidence, '# Local edit');
            f.record();
            f.record({ runId: 'bc78faa8', issue: 102, status: 'uncertain', choice: 'reject', commentId: '27', evidencePath: 'specs/missing.md' });
            f.record({ runId: 'bc78faa9', gate: 'wrong-branch-gate', branch: 'pilot/roster-b' });
            f.record({ runId: 'bc78faaa', status: 'aborted' });
            await refresh.click();
            const pending = panel.getByRole('region', { name: 'Paused' });
            const past = panel.getByRole('region', { name: 'Past and uncertain' });
            await pending.getByText('Stale in this checkout:', { exact: false }).waitFor();
            assert.equal(await pending.getByRole('link', { name: 'GitHub issue #101' }).getAttribute('href'), `${github}/issues/101`);
            assert.equal(await pending.getByRole('link', { name: evidence }).getAttribute('href'), `${github}/blob/${revision}/${evidence}`);
            assert.equal(await pending.getByText(revision, { exact: true }).count(), 1);
            assert.equal(await pending.getByText('wrong-branch-gate').count(), 0);
            await past.getByText('Reconcile with the trusted run owner. Do not retry.').waitFor();
            await past.getByText('Could not check the evidence bytes in this checkout.').waitFor();
            assert.equal(await past.getByRole('link', { name: 'Receipt comment' }).getAttribute('href'), `${github}/issues/102#issuecomment-27`);
            assert.equal(await panel.getByRole('button').count(), 1);
            assert.match(await panel.getByRole('status').innerText(), /malformed[\s\S]+another branch/);
            assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth), true);

            await page.route('**/api/decisions', route => route.fulfill({ json: {}, status: 500 }));
            await refresh.click();
            await panel.getByRole('alert').getByText('Could not read the inbox.', { exact: false }).waitFor();
            await page.getByLabel('More tools', { exact: true }).click();
            await page.getByRole('button', { name: 'Back to specs' }).click();
            assert.equal(await panel.isVisible(), false);
            assert.deepEqual(f.sent, []);
        } finally {
            await browser.close();
            await f.board.close();
        }
    });
});
