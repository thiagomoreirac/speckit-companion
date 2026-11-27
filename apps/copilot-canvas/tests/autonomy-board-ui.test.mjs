import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';
import { reconcileDeliveryRecord, recoverDeliverySession } from '../com.github.copilot/extensions/speckit-companion/delivery-ledger.mjs';

const temp = prefix => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

function makeGitRepo(prefix) {
    const dir = temp(prefix);
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test User');
    git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo-app.git');
    mkdirSync(join(dir, 'specs', '001-autonomy-board'), { recursive: true });
    writeFileSync(join(dir, 'specs', '001-autonomy-board', 'spec.md'), '# Autonomy Board\n\nShip cloud autonomy.\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Add initial spec');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return dir;
}

async function launch() {
    let chromium;
    try {
        ({ chromium } = await import('playwright-core'));
    } catch {
        return null;
    }
    for (const options of [{ channel: 'chrome' }, {}]) {
        try {
            return await chromium.launch({ headless: true, ...options });
        } catch { /* try next */ }
    }
    return null;
}

describe('autonomy board UI (Phase 5)', { concurrency: false }, () => {
    let browser;

    before(async () => {
        browser = await launch();
    });

    after(async () => {
        await browser?.close();
    });

    it('renders Delivery Ledger badges, detail panel, and expired-session recovery handoff without narrow overflow', async (t) => {
        if (!browser) { t.skip('no Chrome to drive'); return; }
        const root = makeGitRepo('canvas-delivery-ui-');
        reconcileDeliveryRecord(root, {
            kind: 'spec',
            id: '001-autonomy-board',
            repository: 'acme/demo-app',
            autonomyMode: 'unattended',
            branch: 'feat/001-autonomy-board',
            issue: { number: 17, url: 'https://github.com/acme/demo-app/issues/17', state: 'open' },
            pr: { number: 42, url: 'https://github.com/acme/demo-app/pull/42', state: 'open', checks: 'passing' },
            session: { sessionId: 'sess-old', name: 'Implement 001', status: 'active' },
        });
        recoverDeliverySession(root, {
            kind: 'spec',
            id: '001-autonomy-board',
            expiredSessionId: 'sess-old',
            reason: 'Cloud sandbox timed out after 30m.',
        });

        const sent = [];
        const board = await createSpecServer({ root, send: async prompt => { sent.push(prompt); return true; } });
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
        page.on('pageerror', error => { throw error; });
        try {
            await page.goto(board.url);
            await page.waitForSelector('.spec-card .delivery-strip');

            const stripText = await page.locator('.spec-card .delivery-strip').first().textContent();
            assert.match(stripText, /Session expired/);
            assert.match(stripText, /PR #42 ✓/);
            assert.match(stripText, /#17/);
            assert.match(stripText, /Unattended/);

            const panel = page.getByRole('region', { name: 'Delivery status' });
            await panel.waitFor();
            assert.equal(await panel.getByRole('link', { name: 'Issue #17' }).getAttribute('href'), 'https://github.com/acme/demo-app/issues/17');
            assert.equal(await panel.getByRole('link', { name: /PR #42/ }).getAttribute('href'), 'https://github.com/acme/demo-app/pull/42');

            await panel.getByRole('button', { name: 'Recover expired session…' }).click();
            const dialog = page.getByRole('dialog', { name: 'Recover expired session' });
            await dialog.waitFor();
            await dialog.getByRole('button', { name: 'Send recovery handoff' }).click();
            await dialog.waitFor({ state: 'hidden' });

            assert.equal(sent.length, 1);
            assert.match(sent[0], /Recover or reconcile delivery for acme\/demo-app/);
            assert.match(sent[0], /feat\/001-autonomy-board/);

            await page.setViewportSize({ width: 480, height: 760 });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
            assert.equal(overflow, false, 'narrow viewport must not overflow horizontally');
        } finally {
            await page.close();
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('enforces autonomy policy in the Start Dedicated Work dialog and sends selected autonomyMode', async (t) => {
        if (!browser) { t.skip('no Chrome to drive'); return; }
        const root = makeGitRepo('canvas-policy-ui-');
        const requests = [];
        const dedicatedWork = {
            forRoot: () => [],
            request: async (reqRoot, handoff, options) => {
                requests.push({ root: reqRoot, handoff, options });
                return { status: 'requested' };
            },
        };
        const board = await createSpecServer({ root, dedicatedWork, send: async () => true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
        page.on('pageerror', error => { throw error; });
        try {
            mkdirSync(join(root, '.specify'), { recursive: true });
            writeFileSync(join(root, '.specify', 'autonomy.json'), JSON.stringify({
                schema: 1,
                defaultMode: 'gated',
                allowUnattended: false,
                maxConcurrentSessions: 2,
                allowAutoMerge: false,
            }, null, 2));
            git(root, 'add', '.specify/autonomy.json');
            git(root, 'commit', '-m', 'Restrict autonomy policy to gated mode');
            git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

            await page.goto(board.url);
            await page.waitForSelector('.spec-card');
            await page.getByRole('button', { name: 'Start dedicated work' }).click();
            let dialog = page.getByRole('dialog', { name: 'Start dedicated work' });
            await dialog.waitFor();
            const modeSelect = dialog.getByLabel('Autonomy mode');
            assert.equal(await modeSelect.inputValue(), 'gated');
            const unattendedDisabled = await modeSelect.locator('option[value="unattended"]').evaluate(opt => opt.disabled);
            assert.equal(unattendedDisabled, true, 'unattended must be disabled when allowUnattended is false');
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await dialog.waitFor({ state: 'hidden' });

            writeFileSync(join(root, '.specify', 'autonomy.json'), JSON.stringify({
                schema: 1,
                defaultMode: 'gated',
                allowUnattended: true,
                maxConcurrentSessions: 3,
                allowAutoMerge: false,
            }, null, 2));
            git(root, 'add', '.specify/autonomy.json');
            git(root, 'commit', '-m', 'Enable unattended autonomy policy');
            git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

            await page.getByRole('button', { name: 'Start dedicated work' }).click();
            dialog = page.getByRole('dialog', { name: 'Start dedicated work' });
            await dialog.waitFor();
            const selectAfter = dialog.getByLabel('Autonomy mode');
            assert.equal(await selectAfter.locator('option[value="unattended"]').evaluate(opt => opt.disabled), false);
            await selectAfter.selectOption('unattended');
            await dialog.getByRole('button', { name: 'Start dedicated work' }).click();
            await dialog.waitFor({ state: 'hidden' });

            assert.equal(requests.length, 1);
            assert.equal(requests[0].options.autonomyMode, 'unattended');
            assert.equal(requests[0].options.autonomyPolicy.allowAutoMerge, false);
            assert.equal(requests[0].options.autonomyPolicy.maxConcurrentSessions, 3);
        } finally {
            await page.close();
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('renders the Cloud Autonomy Pack blueprints in Routines and prepares a blueprint in chat', async (t) => {
        if (!browser) { t.skip('no Chrome to drive'); return; }
        const root = makeGitRepo('canvas-routines-pack-ui-');
        const sent = [];
        const board = await createSpecServer({ root, send: async prompt => { sent.push(prompt); return true; } });
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
        page.on('pageerror', error => { throw error; });
        try {
            await page.goto(board.url);
            await page.waitForSelector('.spec-card');
            await page.click('#board-tools-toggle');
            await page.click('#routines-toggle');

            await page.getByRole('heading', { name: 'Cloud Autonomy Pack' }).waitFor();
            const cards = page.locator('.blueprint-card');
            assert.equal(await cards.count(), 4);
            await cards.first().getByRole('button', { name: 'Review in chat' }).click();
            await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '1');

            assert.equal(sent.length, 1);
            assert.match(sent[0], /Spec issue dispatch/);
        } finally {
            await page.close();
            await board.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
