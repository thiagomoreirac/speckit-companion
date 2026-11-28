// Drives the board page in headless Chrome (playwright-core, the installed Google Chrome), against a
// throwaway sandbox: what the Copilot app shows minus the app. Skips when Chrome is not available.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';
import { rootSelection } from '../com.github.copilot/extensions/speckit-companion/workspace.mjs';

const temp = prefix => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
function repo(path) {
    mkdirSync(join(path, '.git'), { recursive: true });
}

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEAMBOARD = join(REPO, 'apps/vscode/webview/src/spec-viewer/__fixtures__/teamboard/041-profile-photo-upload');
const SHOTS = process.env.CANVAS_SHOTS ? resolve(process.env.CANVAS_SHOTS) : null;

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
        } catch { /* try the next option */ }
    }
    return null;
}

describe('board page', { concurrency: false }, async () => {
    let root;
    let board;
    let browser;
    let page;
    const sent = [];
    let sessionUp = true;

    before(async () => {
        root = temp('canvas-page-');
        mkdirSync(join(root, 'specs'));
        for (const demo of ['_00_demo-specified', '_01_demo-planned', '_02_demo-tasked', '_03_demo-living']) {
            cpSync(join(REPO, 'tooling', 'fixtures', 'demo-project', 'specs', demo), join(root, 'specs', demo), { recursive: true });
        }
        const rich = join(root, 'specs', '041-profile-photo-upload');
        mkdirSync(join(rich, 'checklists'), { recursive: true });
        for (const name of ['spec.md', 'plan.md', 'tasks.md', 'research.md', 'data-model.md']) cpSync(join(TEAMBOARD, name), join(rich, name));
        cpSync(join(TEAMBOARD, 'spec-context.completed.json'), join(rich, '.spec-context.json'));
        const richContext = JSON.parse(readFileSync(join(rich, '.spec-context.json'), 'utf8'));
        richContext.source = 'idea-1234';
        writeFileSync(join(rich, '.spec-context.json'), JSON.stringify(richContext));
        mkdirSync(join(root, '.specify/extensions/companion'), { recursive: true });
        mkdirSync(join(root, '.specify/extensions/github'), { recursive: true });
        mkdirSync(join(root, '.github/skills/speckit-github-taskstoissues'), { recursive: true });
        writeFileSync(join(root, '.github/skills/speckit-github-taskstoissues/SKILL.md'), '# Create issues');
        mkdirSync(join(root, '.github/instructions'), { recursive: true });
        writeFileSync(join(root, '.github/instructions/style.instructions.md'), 'Original instructions');
        mkdirSync(join(root, '.specify/bugs/cart'), { recursive: true });
        writeFileSync(join(root, '.specify/bugs/cart/assessment.md'), '# Bug Assessment: Cart error\n\n- **Verdict**: valid\n');
        mkdirSync(join(root, '.specify/extensions/bug'), { recursive: true });
        mkdirSync(join(root, '.github/skills/speckit-bug-fix'), { recursive: true });
        writeFileSync(join(root, '.github/skills/speckit-bug-fix/SKILL.md'), '# Fix');
        mkdirSync(join(root, '.github/skills/speckit-bug-assess'), { recursive: true });
        writeFileSync(join(root, '.github/skills/speckit-bug-assess/SKILL.md'), '# Assess');
        board = await createSpecServer({ root, send: async (prompt) => { sent.push(prompt); return sessionUp; } });
        browser = await launch();
        if (!browser) return;
        page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
        page.on('pageerror', error => { throw error; });
        await page.goto(board.url);
        await page.waitForSelector('.spec-card');
        if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    });

    after(async () => {
        await browser?.close();
        await board.close();
    });

    const shot = async (name) => { if (SHOTS && page) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
    const toastShown = () => page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '1');
    const skipWithoutChrome = (t) => { if (!page) { t.skip('no Chrome to drive'); return true; } return false; };

    it('saves and resets settings and refreshes after external changes', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-page-settings-');
        const settingsBoard = await createSpecServer({ root: project });
        const view = await browser.newPage({ viewport: { width: 480, height: 760 }, colorScheme: 'light' });
        try {
            await view.goto(settingsBoard.url);
            await view.click('#board-tools-toggle');
            await view.click('#settings-toggle');
            const activity = view.getByLabel('Show Activity tab', { exact: true });
            await activity.selectOption('false');
            await view.click('#settings-save');
            await view.getByRole('status').filter({ hasText: 'Changes saved' }).waitFor();
            const file = join(project, '.vscode', 'settings.json');
            assert.equal(JSON.parse(readFileSync(file, 'utf8'))['speckit.viewer.activityPanel'], false);
            await view.getByRole('button', { name: 'Reset Show Activity tab' }).click();
            await view.click('#settings-save');
            await view.getByRole('status').filter({ hasText: 'Changes saved' }).waitFor();
            assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), 'speckit.viewer.activityPanel'), false);
            writeFileSync(file, '{"speckit.viewer.activityPanel":false}');
            await view.waitForFunction(() => [...document.querySelectorAll('#settings-fields label')]
                .find(label => label.textContent === 'Show Activity tab')?.control?.value === 'false');
            assert.equal(await view.locator('#settings-panel').evaluate(panel => panel.scrollWidth <= panel.clientWidth), true);
        } finally {
            await view.close();
            await settingsBoard.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('shows extra custom phases and waits for checkpoint confirmation before sending', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-page-custom-workflow-');
        mkdirSync(join(project, '.vscode'), { recursive: true });
        const spec = join(project, 'specs', '101-custom');
        mkdirSync(spec, { recursive: true });
        writeFileSync(join(project, '.vscode/settings.json'), JSON.stringify({
            'speckit.customWorkflows': [{
                name: 'demo',
                steps: [
                    { name: 'specify', command: 'demo.specify', file: 'spec.md' },
                    { name: 'plan', command: 'demo.plan', file: 'plan.md' },
                    { name: 'tasks', command: 'demo.tasks', file: 'tasks.md' },
                    { name: 'implement', command: 'demo.implement', actionOnly: true },
                    { name: 'design', label: 'Design', command: 'demo.design', file: 'design.md' },
                ],
                checkpoints: [{ id: 'commit', trigger: 'after-implement' }],
            }],
        }));
        for (const [file, text] of [
            ['spec.md', '# Custom spec\n'],
            ['plan.md', '# Plan\n'],
            ['tasks.md', '- [x] T001 Complete\n'],
            ['design.md', '# Design\n'],
        ]) writeFileSync(join(spec, file), text);
        writeFileSync(join(spec, '.spec-context.json'), JSON.stringify({
            workflow: 'demo',
            specName: 'Custom',
            branch: 'main',
            currentStep: 'implement',
            status: 'implemented',
            history: [],
        }));
        const sent = [];
        const customBoard = await createSpecServer({ root: project, send: async prompt => { sent.push(prompt); return true; } });
        const view = await browser.newPage({ viewport: { width: 900, height: 760 } });
        try {
            await view.goto(customBoard.url);
            await view.waitForSelector('.spec-card');
            await view.click('.spec-card[data-id="specs/101-custom"]');
            await view.locator('.next-more button:has-text("Run Design")').waitFor();
            await view.click('.next-more button:has-text("Run Design")');
            await view.locator('.next-more button:has-text("Sent; waiting for chat")').waitFor();
            assert.match(sent.at(-1), /^\/demo\.design specs\/101-custom/);
            customBoard.began(sent.at(-1));
            await view.locator('.next-more button:has-text("Design · Running")').waitFor();
            writeFileSync(join(spec, 'design.md'), '# Revised design\n');
            await customBoard.settle();
            await view.locator('.next-more button:has-text("Output updated")').waitFor();

            const before = sent.length;
            await view.click('.next-more button:has-text("Create commit")');
            await view.locator('.confirm-dialog[open] h2:has-text("Ask Copilot to create a commit?")').waitFor();
            assert.equal(sent.length, before);
            await view.locator('.confirm-dialog[open] button:has-text("Cancel")').click();
            assert.equal(sent.length, before);
            await view.click('.next-more button:has-text("Create commit")');
            await view.locator('.confirm-dialog[open] button:has-text("Send request")').click();
            await view.waitForFunction(count => document.querySelector('.toast-msg')?.textContent?.includes('checkpoint'), before);
            assert.match(sent.at(-1), /do not stage unrelated work/);
        } finally {
            await view.close();
            await customBoard.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('keeps tools out of the toolbar and opens Bugs and Ideas independently', async (t) => {
        if (skipWithoutChrome(t)) return;
        const view = await browser.newPage({ viewport: { width: 320, height: 760 } });
        try {
            await view.goto(board.url);
            const more = view.locator('#board-tools-toggle');
            const project = view.locator('#project-toggle');
            const bugs = view.getByRole('button', { name: 'Bugs', exact: true });
            const ideas = view.getByRole('button', { name: 'Ideas', exact: true });
            const heading = view.locator('#reports-title');
            assert.equal(await project.isVisible(), false);
            await more.focus();
            await more.press('Enter');
            assert.equal(await project.isVisible(), true);
            const bounds = await view.locator('.board-tools-list').boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
            await more.press('Tab');
            assert.equal(await project.evaluate(button => button === document.activeElement), true);
            await project.press('Escape');
            assert.equal(await project.isVisible(), false);
            assert.equal(await more.evaluate(button => button === document.activeElement), true);
            await more.click();
            await bugs.click();
            assert.equal(await project.isVisible(), false);
            assert.equal(await heading.textContent(), 'Bugs');
            await ideas.click();
            assert.equal(await heading.textContent(), 'Ideas');
            assert.equal(await bugs.getAttribute('aria-expanded'), 'false');
            assert.equal(await ideas.getAttribute('aria-expanded'), 'true');
            await ideas.click();
            assert.equal(await view.locator('#reports-panel').isVisible(), false);
            await view.click('#new-spec-toggle');
            assert.equal(await view.locator('#new-entry-submit').textContent(), 'Create spec');
            await view.selectOption('#new-entry-kind', 'bugs');
            await view.fill('#new-spec-text', 'Bug draft');
            assert.equal(await view.locator('#report-extra').isVisible(), true);
            assert.equal(await view.locator('#new-spec-workflow').isVisible(), false);
            await view.selectOption('#new-entry-kind', 'ideas');
            assert.equal(await view.locator('#new-entry-submit').textContent(), 'Assess idea');
            assert.equal(await view.locator('#new-spec-text').inputValue(), '');
            await view.selectOption('#new-entry-kind', 'bugs');
            assert.equal(await view.locator('#new-spec-text').inputValue(), 'Bug draft');
        } finally {
            await view.close();
        }
    });

    it('edits project instructions and keeps drafts when opening another file', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('#board-tools-toggle');
        await page.click('#project-toggle');
        await page.locator('.project-file:has-text("style.instructions.md")').click();
        await page.waitForFunction(() => document.getElementById('project-content').value === 'Original instructions');
        await page.locator('#project-content').fill('Updated instructions');
        await page.click('#project-save');
        await page.waitForFunction(() => document.getElementById('project-status').textContent === 'Saved.');
        assert.equal(readFileSync(join(root, '.github/instructions/style.instructions.md'), 'utf8'), 'Updated instructions');
        await page.locator('#project-content').fill('Unsaved draft');
        await page.locator('.project-file:has-text("style.instructions.md")').click();
        assert.match(await page.locator('#project-status').textContent(), /Save or discard/);
        assert.equal(await page.locator('#project-content').inputValue(), 'Unsaved draft');
        await page.click('#project-discard');
        await page.click('#board-tools-toggle');
        await page.click('#specs-return');
    });

    it('keeps an unsaved project draft when the repository changes', async (t) => {
        if (skipWithoutChrome(t)) return;
        const first = temp('canvas-project-one-');
        const second = temp('canvas-project-two-');
        for (const [directory, content] of [[first, 'First'], [second, 'Second']]) {
            repo(directory);
            mkdirSync(join(directory, '.github/instructions'), { recursive: true });
            writeFileSync(join(directory, '.github/instructions/style.instructions.md'), content);
        }
        const server = await createSpecServer({ root: first, saveRoot: () => {} });
        const view = await browser.newPage();
        try {
            await view.goto(server.url);
            await view.click('#board-tools-toggle');
            await view.click('#project-toggle');
            await view.locator('.project-file:has-text("style.instructions.md")').click();
            await view.locator('#project-content').fill('Unsaved first draft');
            await view.fill('#repository-root', second);
            await view.click('#repository-form button[type="submit"]');
            await view.locator('#project-status:has-text("repository changed")').waitFor();
            assert.equal(await view.locator('#project-content').inputValue(), 'Unsaved first draft');
            assert.equal(await view.locator('#project-save').isDisabled(), true);
            await view.click('#project-discard');
            await view.locator('.project-file:has-text("style.instructions.md")').click();
            await view.waitForFunction(() => document.getElementById('project-content').value === 'Second');
            assert.equal(readFileSync(join(first, '.github/instructions/style.instructions.md'), 'utf8'), 'First');
            assert.equal(readFileSync(join(second, '.github/instructions/style.instructions.md'), 'utf8'), 'Second');
        } finally {
            await view.close();
            await server.close();
            await rm(first, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            await rm(second, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });

    it('opens a bug report and sends the offered action for that bug', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('[data-report-kind="bugs"]');
        const pattern = '**/api/report?*';
        const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/report');
        const { promise, resolve } = Promise.withResolvers();
        await page.route(pattern, async route => { await promise; await route.continue(); }, { times: 1 });
        try {
            await page.locator('#reports-list button:has-text("Cart error")').click();
            await started;
            await page.click('#reports-refresh');
            await page.locator('#report-detail').getByRole('heading', { name: 'Bug Assessment: Cart error', exact: true }).waitFor();
        } finally {
            resolve();
        }
        await page.locator('#report-detail button:has-text("Fix bug")').click();
        await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Sent'));
        assert.match(sent.at(-1), /^\/speckit-bug-fix slug=cart/);
        writeFileSync(join(root, '.specify/bugs/cart/assessment.md'), '# Bug Assessment: Updated cart error\n\n- **Verdict**: valid\n');
        await page.locator('#report-detail h2:has-text("Updated cart error")').waitFor();
        await page.click('[data-report-kind="bugs"]');
    });

    it('includes additional context when requesting a bug assessment', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('[data-report-kind="bugs"]');
        await page.click('#new-spec-toggle');
        assert.equal(await page.locator('#reports-panel').isVisible(), false);
        await page.selectOption('#new-entry-kind', 'bugs');
        await page.locator('#new-spec-text').fill('Checkout fails');
        await page.locator('#report-extra').fill('Only on mobile');
        await page.locator('#report-slug').fill('mobile-checkout');
        await page.getByRole('button', { name: 'Assess bug', exact: true }).click();
        await page.waitForFunction(() => document.getElementById('new-spec-text').value === '');
        assert.match(sent.at(-1), /^\/speckit[.-]bug[.-]assess /);
        const path = sent.at(-1).match(/\.speckit-companion\/process-create\/[^\s]+\.md/)[0];
        assert.match(readFileSync(join(root, path), 'utf8'), /Checkout fails\n\n## Additional context\n\nOnly on mobile/);
        assert.equal(await page.locator('#report-extra').inputValue(), '');
        await page.click('#new-spec-toggle');
        await page.selectOption('#new-entry-kind', 'spec');
        await page.click('#new-spec-toggle');
    });

    it('follows changes to the configured idea directory and watches the new location', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-ideas-settings-');
        mkdirSync(join(project, '.vscode'), { recursive: true });
        mkdirSync(join(project, 'notes/ideas/custom'), { recursive: true });
        writeFileSync(join(project, 'notes/ideas/custom/intake.md'), '# Idea Intake: Custom idea\n');
        const server = await createSpecServer({ root: project });
        const view = await browser.newPage();
        try {
            await view.goto(server.url);
            await view.click('[data-report-kind="ideas"]');
            await view.locator('#reports-list:has-text("No ideas")').waitFor();
            writeFileSync(join(project, '.vscode/settings.json'), '{"speckit.assessmentsDirectory":"notes/ideas"}');
            await view.locator('#reports-list button:has-text("Custom idea")').waitFor();
            writeFileSync(join(project, 'notes/ideas/custom/intake.md'), '# Idea Intake: Updated idea\n');
            await view.locator('#reports-list button:has-text("Updated idea")').waitFor();
        } finally {
            await view.close();
            await server.close();
            await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });

    it('checks the idea extension before dispatching intake from the shared form', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-page-new-idea-');
        const requests = [];
        const server = await createSpecServer({ root: project, send: async prompt => { requests.push(prompt); return true; } });
        const view = await browser.newPage();
        try {
            await view.goto(server.url);
            await view.click('#new-spec-toggle');
            await view.selectOption('#new-entry-kind', 'ideas');
            await view.locator('#new-report-extension').waitFor();
            assert.equal(await view.locator('#new-entry-submit').isDisabled(), true);
            assert.equal(requests.length, 0);

            mkdirSync(join(project, '.specify/extensions/assess'), { recursive: true });
            mkdirSync(join(project, '.github/skills/speckit-assess-intake'), { recursive: true });
            writeFileSync(join(project, '.github/skills/speckit-assess-intake/SKILL.md'), '# Intake');
            await view.selectOption('#new-entry-kind', 'spec');
            await view.selectOption('#new-entry-kind', 'ideas');
            await view.fill('#new-spec-text', 'Save searches');
            await view.getByRole('button', { name: 'Assess idea', exact: true }).click();
            await view.locator('#new-spec').waitFor({ state: 'hidden' });
            assert.match(requests[0], /^\/speckit[.-]assess[.-]intake slug=save-searches /);
        } finally {
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('starts Pre-Spec Cards from New and preserves the separate idea draft', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-new-discovery-');
        mkdirSync(join(project, '.specify', 'extensions'), { recursive: true });
        writeFileSync(join(project, '.specify', 'integration.json'), '{"default_integration":"copilot"}');
        const requests = [];
        const server = await createSpecServer({ root: project, saveRoot: () => {}, send: async (prompt, target) => {
            requests.push({ prompt, target });
            return true;
        } });
        const view = await browser.newPage({ viewport: { width: 480, height: 760 } });
        try {
            await view.goto(server.url);
            await view.click('#new-spec-toggle');
            await view.selectOption('#new-entry-kind', 'ideas');
            await view.fill('#new-spec-text', 'Keep the assessment separate.');
            await view.selectOption('#new-entry-kind', 'prespec');
            const start = view.getByRole('button', { name: 'Start discovery in chat' });
            const setup = view.getByRole('button', { name: 'Open Integrations' });
            await setup.waitFor();
            assert.equal(await start.isDisabled(), true);
            await setup.click();
            await view.getByRole('heading', { name: 'Spec Kit integrations' }).waitFor();
            assert.equal(requests.length, 0);

            const skill = 'speckit-prespec-idea';
            const skillDir = join(project, '.github', 'skills', skill);
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(join(skillDir, 'SKILL.md'), '# Idea');
            writeFileSync(join(project, '.specify', 'extensions', '.registry'),
                JSON.stringify({ extensions: { prespec: { version: '0.4.0', registered_skills: [skill] } } }));
            await view.click('#new-spec-toggle');
            await view.locator('#new-report-status:has-text("This Copilot chat")').waitFor();
            assert.equal(await view.locator('#report-slug').isVisible(), false);
            assert.equal(await view.locator('#new-spec-text').inputValue(), '');
            await view.fill('#new-spec-text', 'Let readers compare bookmark layouts');
            server.bindSession({ sessionId: 'discovery-child', cwd: project, name: 'Discovery chat' });
            await view.locator('#new-report-status:has-text("Destination: Discovery chat")').waitFor();
            writeFileSync(join(skillDir, 'SKILL.md'), '# Updated Idea');
            await start.press('Enter');
            await view.getByText(/The discovery target or skill changed/).waitFor();
            await start.waitFor();
            assert.equal(requests.length, 0);
            assert.equal(await view.locator('#new-spec-text').inputValue(), 'Let readers compare bookmark layouts');
            await view.locator('#new-report-status:has-text("Destination: Discovery chat")').waitFor();
            await start.press('Enter');
            await view.locator('#new-spec').waitFor({ state: 'hidden' });
            assert.equal(requests.length, 1);
            assert.equal(requests[0].target, 'discovery-child');
            assert.match(requests[0].prompt, /speckit-prespec-idea.*start Pre-Spec Cards/);
            assert.match(requests[0].prompt, /Idea: "Let readers compare bookmark layouts"/);
            await view.click('#new-spec-toggle');
            await view.selectOption('#new-entry-kind', 'ideas');
            assert.equal(await view.locator('#new-spec-text').inputValue(), 'Keep the assessment separate.');
        } finally {
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('shows the OKR preset beside its extension and previews it before setup', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-okr-preset-');
        mkdirSync(join(project, '.specify', 'extensions'), { recursive: true });
        const bin = join(project, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, process.platform === 'win32' ? 'specify.exe' : 'specify'), '');
        writeFileSync(join(project, '.specify', 'integration.json'), '{"integration":"copilot"}');
        writeFileSync(join(project, '.specify', 'extensions', '.registry'), '{"extensions":{"okr":{"version":"0.2.1","enabled":true}}}');
        const server = await createSpecServer({ root: project });
        const view = await browser.newPage({ viewport: { width: 480, height: 760 } });
        try {
            await view.goto(server.url);
            await view.click('#board-tools-toggle');
            await view.click('#workflow-toggle');
            await view.click('#workflow-integrations-view');
            const okr = view.getByRole('listitem').filter({ has: view.getByRole('link', { name: 'OKR Bets' }) });
            const preset = okr.getByRole('button', { name: 'Install OKR Bet preset' });
            await preset.click();
            const dialog = view.getByRole('dialog', { name: 'Review setup' });
            await dialog.getByText(/This adds a Hypothesis & Bet overlay to the stock Specify command/).waitFor();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await dialog.waitFor({ state: 'hidden' });
            assert.equal(await preset.isEnabled(), true);
            assert.ok(!existsSync(join(project, '.specify', 'presets')));
        } finally {
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('starts a named Product Change from the shared form and retains its draft on failure', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-product-change-');
        const registry = join(project, '.specify', 'extensions', '.registry');
        const skill = 'speckit-pdac-product-change';
        const skillPath = join(project, '.github', 'skills', skill, 'SKILL.md');
        const config = join(project, '.product', 'config.yaml');
        for (const path of [registry, skillPath, config]) mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(join(project, '.specify', 'integration.json'), '{"integration":"copilot"}');
        writeFileSync(registry, JSON.stringify({ extensions: { 'pdac-product': { version: '0.1.0', registered_skills: [skill] } } }));
        writeFileSync(skillPath, '# Change');
        writeFileSync(config, 'product-root: docs/product');
        const requests = [];
        let accepted = false;
        const server = await createSpecServer({ root: project, send: async prompt => { requests.push(prompt); return accepted; } });
        const view = await browser.newPage({ viewport: { width: 480, height: 760 } });
        try {
            await view.goto(server.url);
            await view.click('#new-spec-toggle');
            await view.selectOption('#new-entry-kind', 'product-change');
            const draft = view.getByRole('button', { name: 'Draft Product Change in chat' });
            await view.getByText('Destination: This Copilot chat').waitFor();
            await view.getByLabel('Description', { exact: true }).fill('Let teams share saved views.');
            const changeName = view.getByLabel('Change name', { exact: true });
            await changeName.fill('Share views');
            await draft.click();
            assert.equal(await changeName.evaluate(input => input.validity.patternMismatch), true);
            assert.deepEqual(requests, []);
            await changeName.fill('share-views');
            await draft.click();
            await view.getByText(/Copilot did not accept this request/).waitFor();
            assert.equal(await changeName.inputValue(), 'share-views');
            await view.selectOption('#new-entry-kind', 'business-plan');
            assert.equal(await changeName.isVisible(), false);
            assert.equal(await view.getByLabel('Description', { exact: true }).inputValue(), '');
            await view.selectOption('#new-entry-kind', 'product-change');
            await view.getByText('Destination: This Copilot chat').waitFor();
            assert.equal(await changeName.inputValue(), 'share-views');
            accepted = true;
            await draft.click();
            await view.getByText(/Product Change draft request sent/).waitFor();
            assert.equal(requests.length, 2);
            assert.match(requests[1], /"share-views"[\s\S]*Let teams share saved views/);
            assert.equal(existsSync(join(project, '.specify', 'productshape')), false);
        } finally {
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('shows the delivery conflict and lets you cancel a blocking-hook install', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-governance-setup-');
        const extensions = join(project, '.specify', 'extensions');
        const bin = join(project, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
        mkdirSync(extensions, { recursive: true });
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, process.platform === 'win32' ? 'specify.exe' : 'specify'), '');
        writeFileSync(join(project, '.specify', 'integration.json'), '{"integration":"copilot"}');
        const registry = '{"extensions":{"ghp":{"version":"0.1.2","enabled":true}}}';
        writeFileSync(join(extensions, '.registry'), registry);
        const server = await createSpecServer({ root: project });
        const view = await browser.newPage({ viewport: { width: 480, height: 760 } });
        try {
            await view.goto(server.url);
            await view.click('#board-tools-toggle');
            await view.click('#workflow-toggle');
            await view.click('#workflow-integrations-view');
            const projectSync = view.getByRole('listitem').filter({ has: view.getByRole('link', { name: 'GitHub Project Lifecycle Sync' }) });
            await projectSync.getByText(/Disable ghp in Spec Kit/).waitFor();
            assert.equal(await projectSync.getByRole('button', { name: 'Install GitHub Project Lifecycle Sync' }).count(), 0);
            await view.getByRole('button', { name: 'Install DocGuard', exact: true }).click();
            const dialog = view.getByRole('dialog', { name: 'Review setup' });
            await dialog.getByText(/required hooks before Specify, before Tasks, and after Implement/).waitFor();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await dialog.waitFor({ state: 'hidden' });
            assert.equal(readFileSync(join(extensions, '.registry'), 'utf8'), registry);
        } finally {
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('captures and browses linked work before a spec exists', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-linked-intake-');
        const server = await createSpecServer({ root: project });
        const view = await browser.newPage();
        try {
            await view.goto(server.url);
            await view.click('#new-spec-toggle');
            await view.selectOption('#new-entry-kind', 'business-plan');
            await view.fill('#new-work-title', 'Pilot plan');
            await view.fill('#new-spec-text', 'Test a small release');
            await view.click('#new-entry-submit');
            await view.locator('#linked-work-panel summary:has-text("Pilot plan")').waitFor();
            await view.getByRole('button', { name: 'Draft epic from this plan' }).click();
            await view.locator('#new-epic-parent option:has-text("Pilot plan")').waitFor({ state: 'attached' });
            assert.equal(await view.locator('#new-epic-parent option:checked').textContent(), 'Pilot plan');
            await view.fill('#new-work-title', 'Ship the pilot');
            await view.fill('#new-spec-text', 'Release to one team');
            await view.click('#new-entry-submit');
            await view.locator('#linked-work-panel p:has-text("Business plan: Pilot plan")').waitFor();
            await view.locator('#linked-work-panel .product-record .product-record').getByRole('button', { name: 'Draft linked spec' }).click();
            await view.locator('#new-source-label:has-text("Ship the pilot")').waitFor();
            assert.equal(await view.locator('#new-entry-kind').inputValue(), 'spec');
            assert.match(await view.locator('#new-spec-text').inputValue(), /Release to one team/);
        } finally {
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('adapts New business plan to the installed business-plan bundle workflow', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-bp-bundle-intake-');
        mkdirSync(join(project, '.specify', 'extensions'), { recursive: true });
        mkdirSync(join(project, '.specify', 'workflows'), { recursive: true });
        writeFileSync(join(project, '.specify', 'bundle-records.json'), JSON.stringify({
            bundles: { 'business-plan': { version: '0.1.0' } },
        }));
        writeFileSync(join(project, '.specify', 'extensions', '.registry'), JSON.stringify({
            extensions: { 'business-plan': { version: '0.1.0', enabled: true } },
        }));
        writeFileSync(join(project, '.specify', 'workflows', 'business-plan.yml'), 'id: business-plan\nversion: "0.1.0"\n');

        const sent = [];
        const server = await createSpecServer({
            root: project,
            send: async prompt => { sent.push(prompt); return true; },
        });
        const view = await browser.newPage({ viewport: { width: 1120, height: 820 } });
        try {
            await view.goto(server.url);
            await view.click('#new-spec-toggle');
            await view.selectOption('#new-entry-kind', 'business-plan');

            const group = view.getByRole('radiogroup', { name: 'Business plan workflow' });
            await group.waitFor();
            assert.equal(await group.getByRole('radio', { name: 'Business Plan' }).getAttribute('aria-checked'), 'true');
            assert.equal(await view.locator('#new-bp-phases li').count(), 3);
            assert.equal(await view.locator('#new-entry-text-label').textContent(), 'Sponsor brief & reviewed evidence');

            await view.fill('#new-bp-title', 'Q3 Self-Serve Growth');
            assert.equal(await view.locator('#new-bp-graph').inputValue(), 'business-plans/q3-self-serve-growth/traceability.json');

            await group.getByRole('radio', { name: 'Discovery' }).click();
            assert.equal(await view.locator('#new-entry-submit').textContent(), 'Start discovery in chat');
            assert.equal(await view.locator('#new-bp-draft-row').isHidden(), true);

            await group.getByRole('radio', { name: 'Canvas draft' }).click();
            assert.equal(await view.locator('#new-entry-text-label').textContent(), 'Description');
            assert.equal(await view.locator('#new-work-fields').isVisible(), true);
            assert.equal(await view.locator('#new-work-title').inputValue(), 'Q3 Self-Serve Growth');

            await group.getByRole('radio', { name: 'Business Plan' }).click();
            assert.equal(await view.locator('#new-bp-draft-row').isVisible(), true);
            await view.fill('#new-spec-text', 'Improve self-serve onboarding conversion across free teams.');
            await view.fill('#new-bp-owner', 'VP Product');
            await view.fill('#new-bp-criteria', 'Lift day-7 activation by 15%.');
            await view.click('#new-entry-submit');

            await view.locator('#business-plan-panel').waitFor({ state: 'visible' });
            assert.equal(sent.length, 1);
            assert.match(sent[0], /specify workflow run business-plan/);
            assert.match(sent[0], /business-plans\/q3-self-serve-growth\/traceability\.json/);
            assert.match(sent[0], /--input draft=true/);
            const saved = JSON.parse(readFileSync(join(project, 'business-plans/q3-self-serve-growth/traceability.json'), 'utf8'));
            assert.equal(saved.nodes[0].approval.owner, 'VP Product');
            assert.equal(saved.nodes[0].approval.status, 'pending');
        } finally {
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('captures and triages an idea and manages a routine draft at narrow width without chat', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-native-intake-');
        const sent = [];
        const server = await createSpecServer({ root: project, send: async prompt => { sent.push(prompt); return true; } });
        const view = await browser.newPage({ viewport: { width: 480, height: 900 } });
        try {
            await view.goto(server.url);
            await view.click('#new-spec-toggle');
            await view.selectOption('#new-entry-kind', 'ideas');
            await view.fill('#report-title', 'Offline check-ins');
            await view.fill('#new-spec-text', 'Keep check-ins when there is no connection.');
            await view.getByRole('button', { name: 'Save to canvas' }).click();
            await view.getByRole('heading', { name: 'Offline check-ins' }).waitFor();
            await view.getByLabel('Triage status').selectOption('ready');
            await view.getByRole('button', { name: 'Save triage' }).click();
            await view.getByRole('button', { name: 'Update existing work' }).waitFor();
            await view.click('#board-tools-toggle');
            await view.click('#routines-toggle');
            const routines = view.getByRole('region', { name: 'Routines' });
            await routines.getByLabel('Name', { exact: true }).fill('Morning analysis');
            await routines.getByLabel('Exact command, agent, or workflow').fill('speckit.analyze');
            await routines.getByLabel('Repeat').selectOption('daily');
            await routines.getByRole('button', { name: 'Save draft', exact: true }).click();
            await routines.getByText('Saved draft · not scheduled').waitFor();
            await routines.getByRole('button', { name: 'Archive draft' }).click();
            await routines.getByRole('heading', { name: 'Archived drafts' }).waitFor();
            await routines.getByRole('button', { name: 'Restore draft' }).click();
            await routines.getByText('Saved draft · not scheduled').waitFor();
            assert.equal(sent.length, 0);
            assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        } finally {
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('reviews a wireflow generation request and refreshes its output in a narrow canvas', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-generate-wireflow-');
        const id = 'specs/001-example';
        const path = `${id}/preview/wireflow.html`;
        for (const dir of [id, '.specify/extensions/preview/templates/preview', '.github/skills/speckit-preview-preview']) mkdirSync(join(project, dir), { recursive: true });
        writeFileSync(join(project, id, 'spec.md'), '# Example');
        writeFileSync(join(project, id, 'uc.md'), '# Use cases');
        writeFileSync(join(project, '.specify/integration.json'), '{"default_integration":"copilot"}');
        writeFileSync(join(project, '.specify/extensions/.registry'), '{"extensions":{"preview":{"version":"1.3.0","registered_skills":["speckit-preview-preview"]}}}');
        writeFileSync(join(project, '.specify/extensions/preview/templates/preview/wireflow.html'), '<main></main>');
        writeFileSync(join(project, '.github/skills/speckit-preview-preview/SKILL.md'), '# Preview');
        const sends = [];
        const server = await createSpecServer({ root: project, send: async prompt => { sends.push(prompt); return true; } });
        const view = await browser.newPage({ viewport: { width: 480, height: 760 } });
        try {
            await view.goto(server.url);
            await view.locator(`.spec-card[data-id="${id}"]`).click();
            await view.getByRole('tab', { name: 'Evidence' }).click();
            await view.getByText('Installed generators: Spec Kit Preview', { exact: true }).waitFor();
            await view.getByRole('tab', { name: 'Design Missing' }).click();
            await view.getByRole('button', { name: 'Find a generator' }).press('Enter');
            await view.getByRole('combobox', { name: 'Wireflow fidelity' }).selectOption('mid');
            const review = view.getByRole('button', { name: 'Review HTML wireflow request' });
            await review.click();
            const dialog = view.getByRole('dialog', { name: 'HTML wireflow' });
            assert.match(await dialog.innerText(), /specs\/001-example\/uc\.md/);
            assert.match(await dialog.innerText(), /Create: specs\/001-example\/preview\/wireflow\.html/);
            assert.match(await dialog.innerText(), /Fidelity: mid/);
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            assert.deepEqual(sends, []);
            await review.click();
            await dialog.getByRole('button', { name: 'Send to Copilot' }).click();
            await view.getByText(/Request sent to Copilot/).waitFor();
            await view.getByRole('heading', { name: 'Waiting for Copilot output' }).waitFor();
            assert.equal(sends.length, 1);
            mkdirSync(join(project, id, 'preview'));
            const content = `<html data-fidelity="mid"><head><meta http-equiv="refresh" content="0;url=/fixture-redirect"></head>
                <body><main><section aria-labelledby="design-surface"><h2 id="design-surface">Design</h2>
                <article><h3>Reading list</h3><button onclick="window.repositoryScriptRan=true">Add book</button>
                <img src="/fixture-image"><iframe src="/fixture-frame"></iframe><form action="/fixture-submit"><label>Book title</label></form>
                <p hidden>Hidden state</p><script>window.repositoryScriptRan=true</script><style>.wireflow-surface{display:none}</style></article></section>
                <section aria-labelledby="wireflow"><h2 id="wireflow">Flow</h2><ol><li>Open list</li><li><a href="/fixture-navigation">Save book</a></li></ol></section>
                </main></body></html>`;
            const attemptedLoads = [];
            view.on('request', request => {
                if (new URL(request.url()).pathname.startsWith('/fixture-')) attemptedLoads.push(request.url());
            });
            writeFileSync(join(project, path), content);
            await view.getByRole('button', { name: 'Refresh artifacts' }).click();
            const panel = view.getByRole('region', { name: 'Static prototype preview' });
            await panel.getByRole('heading', { name: 'Reading list' }).waitFor();
            await view.getByText(/Installed producer available: Spec Kit Preview/).waitFor();
            assert.equal(await view.getByText(/Queued, not completed/).count(), 0);
            assert.deepEqual(await panel.getByRole('listitem').allTextContents(), ['Open list', 'Save book']);
            assert.equal(await panel.getByText('Add book', { exact: true }).isVisible(), true);
            assert.equal(await panel.getByText('Hidden state', { exact: true }).count(), 0);
            assert.equal(await panel.locator('a, button, form, img, iframe, script, style').count(), 0);
            await panel.getByText('View HTML source', { exact: true }).press('Enter');
            assert.equal(await panel.locator('pre').textContent(), content);
            assert.equal(await view.evaluate(() => window.repositoryScriptRan), undefined);
            assert.deepEqual(attemptedLoads, []);
            for (const width of [480, 1080]) {
                await view.setViewportSize({ width, height: 760 });
                assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth), true);
            }
        } finally {
            await view.close();
            await server.close();
            await rm(project, { recursive: true, force: true, maxRetries: 3 });
        }
    });

    it('reviews an evidence revision without interpreting prototype markup', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-review-evidence-');
        const id = 'specs/001-example';
        mkdirSync(join(project, id), { recursive: true });
        writeFileSync(join(project, id, 'spec.md'), '# Example');
        writeFileSync(join(project, id, 'preview.html'), '<script>window.repositoryScriptRan=true</script>');
        writeFileSync(join(project, id, 'model.mmd'), 'erDiagram\n  TEAM ||--o{ MEMBER : contains\n');
        const run = join(project, '.specify', 'workflows', 'runs', 'run-one');
        mkdirSync(run, { recursive: true });
        writeFileSync(join(run, 'workflow.yml'), 'steps: [{id: plan, type: command}, {id: review-model, type: gate}]');
        writeFileSync(join(run, 'state.json'), JSON.stringify({ run_id: 'run-one', workflow_id: 'example', status: 'paused',
            current_step_id: 'review-model', inputs: { feature_dir: id }, step_results: {
                plan: { type: 'command', status: 'completed' },
                'review-model': { type: 'gate', status: 'paused', output: { options: ['approve', 'reject'], message: 'Check the model before implementing.' } },
            } }));
        const server = await createSpecServer({ root: project });
        const view = await browser.newPage({ viewport: { width: 480, height: 760 } });
        const releaseComparison = Promise.withResolvers();
        try {
            await view.goto(server.url);
            await view.locator(`.spec-card[data-id="${id}"]`).click();
            await view.getByRole('tab', { name: 'Evidence' }).click();
            await view.getByRole('tab', { name: 'Design 1 file' }).click();
            await view.getByText('View HTML source', { exact: true }).click();
            await view.locator('.artifact-preview pre:has-text("repositoryScriptRan")').waitFor();
            assert.equal(await view.evaluate(() => window.repositoryScriptRan), undefined);
            await view.getByText('Review this artifact', { exact: true }).click();
            await view.getByRole('checkbox', { name: 'Keep a copy for comparison' }).check();
            await view.getByRole('button', { name: 'Approve artifact' }).click();
            await view.getByRole('button', { name: 'Record decision' }).click();
            await view.getByRole('tab', { name: 'Review', exact: true }).click();
            await view.getByText('Current revision', { exact: false }).waitFor();
            writeFileSync(join(project, id, 'preview.html'), '<main>Updated prototype</main>');
            await view.getByRole('button', { name: 'Refresh reviews and runs' }).click();
            await view.getByText('Older or missing revision', { exact: false }).waitFor();
            const compareUrl = /\/api\/artifact\/compare\?/;
            await view.route(compareUrl, async route => {
                await releaseComparison.promise;
                await route.continue();
            });
            await Promise.all([
                view.waitForRequest(compareUrl, { timeout: 5000 }),
                view.getByRole('button', { name: /Compare with current/ }).click(),
            ]);
            writeFileSync(join(project, id, 'spec.md'), '# Updated example');
            await view.getByRole('heading', { name: 'Updated example', exact: true }).waitFor({ timeout: 5000 });
            releaseComparison.resolve();
            const comparison = view.getByRole('region', { name: 'Artifact revision comparison' });
            await comparison.waitFor({ timeout: 5000 });
            assert.deepEqual(await comparison.locator('pre').allTextContents(), [
                '<script>window.repositoryScriptRan=true</script>',
                '<main>Updated prototype</main>',
            ]);
            assert.ok(await comparison.evaluate(panel => panel.scrollWidth <= panel.clientWidth));
            assert.equal(await view.evaluate(() => window.repositoryScriptRan), undefined);
            const steps = view.getByRole('list', { name: 'Recorded workflow steps' });
            assert.equal(await steps.getByRole('listitem').count(), 2);
            assert.match(await steps.locator('[aria-current="step"]').innerText(), /review-model\s+Paused here/);
            const pause = view.getByRole('region', { name: 'Engine pause' });
            assert.match(await pause.innerText(), /Check the model before implementing/);
            assert.equal(await pause.getByRole('button', { name: /^(approve|reject)$/i }).count(), 0);
            const impact = view.waitForRequest(request => request.url().endsWith('/api/impact') && request.method() === 'POST');
            await pause.getByRole('button', { name: 'Explain this pause in chat' }).click();
            const payload = (await impact).postDataJSON();
            assert.equal(payload.spec, id);
            assert.equal(payload.gate.step, 'review-model');
            assert.equal(payload.path, undefined);
            await pause.getByRole('button', { name: 'Review gate evidence' }).press('Enter');
            const evidence = pause.getByRole('region', { name: 'Gate evidence' });
            assert.equal(await evidence.evaluate(node => document.activeElement === node), true);
            await evidence.getByRole('tab', { name: 'Diagrams 1 file' }).click();
            await view.getByLabel('Entity relationship preview').getByText('TEAM', { exact: true }).first().waitFor();
            await evidence.getByText('Explain gate impact in chat', { exact: true }).waitFor();
            await evidence.getByText('Pending review', { exact: true }).waitFor();
            assert.equal(await view.getByRole('button', { name: /resume/i }).count(), 0);
        } finally {
            releaseComparison.resolve();
            await view.close();
            await server.close();
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('lists every spec and filters active ones by default', async (t) => {
        if (skipWithoutChrome(t)) return;
        assert.equal(await page.locator('#count-all').textContent(), '5');
        assert.equal(await page.locator('#count-active').textContent(), '3');
        assert.equal(await page.locator('.spec-card').count(), 3);
        await page.click('[data-filter="all"]');
        assert.equal(await page.locator('.spec-card').count(), 5);
        await shot('01-board-all');
    });

    it('sorts specs with the same number order as the VS Code explorer', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.locator('#spec-sort').selectOption('number');
        await page.waitForFunction(() => document.querySelector('.spec-card')?.dataset.id === 'specs/041-profile-photo-upload');
        await page.locator('#spec-sort').selectOption('recent');
        await page.waitForFunction(() => document.getElementById('spec-sort').value === 'recent' && !document.getElementById('spec-sort').disabled);
    });

    it('finds specs by fuzzy title and source', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.locator('#search').fill('prflpht');
        assert.deepEqual(await page.locator('.spec-card').evaluateAll(cards => cards.map(card => card.dataset.id)), ['specs/041-profile-photo-upload']);
        await page.locator('#search').fill('idea1234');
        assert.deepEqual(await page.locator('.spec-card').evaluateAll(cards => cards.map(card => card.dataset.id)), ['specs/041-profile-photo-upload']);
        await page.locator('#search').fill('');
    });

    it('can distinguish completed specs from archived specs', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-closed-filter-');
        repo(project);
        for (const [name, status] of [['001-active', 'planned'], ['002-complete', 'completed'], ['003-archived', 'archived']]) {
            const dir = join(project, 'specs', name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'spec.md'), `# ${name}\n`);
            writeFileSync(join(dir, '.spec-context.json'), JSON.stringify({ status, currentStep: 'plan', history: [] }));
        }
        const server = await createSpecServer({ root: project });
        const view = await browser.newPage();
        try {
            await view.goto(server.url);
            await view.click('[data-filter="done"]');
            await view.waitForSelector('.spec-card');
            await view.locator('#closed-filter').selectOption('completed');
            assert.deepEqual(await view.locator('.spec-card').evaluateAll(cards => cards.map(card => card.dataset.id)), ['specs/002-complete']);
            await view.locator('#closed-filter').selectOption('archived');
            assert.deepEqual(await view.locator('.spec-card').evaluateAll(cards => cards.map(card => card.dataset.id)), ['specs/003-archived']);
        } finally {
            await view.close();
            await server.close();
            await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });

    it('confirms lifecycle changes, group actions and force-status recovery', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-lifecycle-page-');
        repo(project);
        const dir = join(project, 'specs', '001-lifecycle');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'spec.md'), '# Lifecycle\n');
        const record = join(dir, '.spec-context.json');
        writeFileSync(record, JSON.stringify({ status: 'completed', currentStep: 'implement', history: [] }));
        const server = await createSpecServer({ root: project });
        const view = await browser.newPage();
        try {
            await view.goto(server.url);
            await view.click('[data-filter="done"]');
            await view.waitForSelector('.spec-card');
            await view.click('.spec-card[data-id="specs/001-lifecycle"]');
            await view.click('.next-more button:has-text("Reactivate")');
            await view.locator('dialog[open] h2:has-text("Reactivate this spec?")').waitFor();
            await view.locator('dialog[open] button:has-text("Cancel")').click();
            assert.equal(JSON.parse(readFileSync(record, 'utf8')).status, 'completed');

            await view.click('.next-more button:has-text("Reactivate")');
            await view.locator('dialog[open] button:has-text("Confirm")').click();
            await view.waitForFunction(() => [...document.querySelectorAll('.next-more button')].some(button => button.textContent === 'Mark complete'));
            assert.equal(JSON.parse(readFileSync(record, 'utf8')).status, 'implementing');

            await view.click('[data-filter="active"]');
            await view.locator('#lifecycle-bulk button:has-text("Mark 1 active spec complete")').click();
            await view.locator('dialog[open] button:has-text("Confirm")').click();
            await view.waitForFunction(() => [...document.querySelectorAll('.next-more button')].some(button => button.textContent === 'Reactivate'));
            assert.equal(JSON.parse(readFileSync(record, 'utf8')).status, 'completed');

            await view.locator('.next-more button:has-text("Set status")').click();
            await view.locator('dialog[open] select[aria-label="Lifecycle status"]').selectOption('planning');
            await view.locator('dialog[open] button:has-text("Force status")').click();
            await view.waitForFunction(() => [...document.querySelectorAll('.next-more button')].some(button => button.textContent === 'Mark complete'));
            const recovered = JSON.parse(readFileSync(record, 'utf8'));
            assert.equal(recovered.status, 'planning');
            assert.equal(recovered.currentStep, 'plan');
            assert.equal(recovered.history.at(-1).by, 'user');
        } finally {
            await view.close();
            await server.close();
            await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });

    it('opens a spec on its Overview with the viewer\'s dossier and document tabs', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('.spec-card[data-id="specs/041-profile-photo-upload"]');
        await page.waitForSelector('.tab[aria-selected="true"]:has-text("Overview")');
        assert.ok(await page.locator('.dossier .dossier-intent').count(), 'intent section rendered');
        const tabs = await page.locator('.tab').allTextContents();
        assert.deepEqual(tabs.map(t => t.replace(/\d.*$/, '').trim()).slice(0, 4), ['Overview', 'Spec', 'Plan', 'Tasks']);
        await shot('02-overview');
        await page.click('.tab:has-text("Tasks")');
        await page.waitForSelector('#markdown-content .task-item');
        assert.ok(await page.locator('#markdown-content .phase-header, #markdown-content .lg-phase, #markdown-content h2').count(), 'task phases rendered');
        await shot('03-tasks');
    });

    it('copies the selected spec path and folder name', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(board.url).origin });
        await page.locator('#detail button:has-text("Copy path")').click();
        await page.locator('#detail button:has-text("Copied")').waitFor();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'specs/041-profile-photo-upload');
        await page.locator('#detail button:has-text("Copy name")').click();
        await page.waitForFunction(() => Array.from(document.querySelectorAll('#detail button')).filter(b => b.textContent === 'Copied').length === 2);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '041-profile-photo-upload');
    });

    it('saves a spec document without losing edits when closing', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('[data-filter="all"]');
        await page.click('.spec-card[data-id="specs/_01_demo-planned"]');
        await page.click('.tab:has-text("Spec")');
        await page.click('.next-more button:has-text("Edit document")');
        const editor = page.locator('.spec-editor[open]');
        const original = await editor.locator('textarea').inputValue();
        await editor.locator('textarea').fill(`${original}\n\nCanvas edit\n`);
        await editor.locator('button:has-text("Close")').click();
        assert.match(await editor.locator('[role="status"]').textContent(), /Save your changes/);
        await editor.locator('button:has-text("Save")').click();
        await editor.locator('[role="status"]:has-text("Saved")').waitFor();
        assert.match(readFileSync(join(root, 'specs/_01_demo-planned/spec.md'), 'utf8'), /Canvas edit/);
        await editor.locator('button:has-text("Close")').click();
    });

    it('offers converge on a completed spec, but not on an unfinished spec', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('[data-filter="all"]');
        await page.click('.spec-card[data-id="specs/041-profile-photo-upload"]');
        await page.waitForSelector('.next-more button:has-text("Converge")');
        await page.click('.next-more button:has-text("Converge")');
        assert.equal(sent.at(-1)?.split('\n')[0], '/speckit.converge Converge the feature in specs/041-profile-photo-upload. If that is not the feature you resolve for this run, stop and say so instead of changing its tasks.');
        await page.click('.spec-card[data-id="specs/_01_demo-planned"]');
        await page.waitForSelector('.next-title:has-text("Next: Tasks")');
        assert.equal(await page.locator('.next-more button:has-text("Converge")').count(), 0);
    });

    it('offers the stock document actions on their matching tabs', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('[data-filter="all"]');
        await page.click('.spec-card[data-id="specs/041-profile-photo-upload"]');
        await page.waitForSelector('.tab:has-text("Spec")');
        for (const [tab, action, command] of [['Spec', 'Clarify', 'clarify'], ['Plan', 'Checklist', 'checklist'], ['Tasks', 'Analyze', 'analyze']]) {
            await page.click(`.tab:has-text("${tab}")`);
            await page.click(`.next-more button:has-text("${action}")`);
            assert.equal(sent.at(-1)?.split('\n')[0], `/speckit.${command} specs/041-profile-photo-upload`);
        }
    });

    it('confirms before asking the chat to create GitHub issues', async (t) => {
        if (skipWithoutChrome(t)) return;
        const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
        git('init', '--quiet');
        await page.click('[data-filter="all"]');
        await page.click('.spec-card[data-id="specs/041-profile-photo-upload"]');
        await page.click('.tab:has-text("Tasks")');
        const before = sent.length;
        await page.click('.next-more button:has-text("Create issues")');
        const dialog = page.getByRole('dialog', { name: 'Preview GitHub delivery' });
        await dialog.getByText(/Configure origin before creating issues/).waitFor();
        assert.equal(await dialog.getByRole('button', { name: 'Create issues' }).isDisabled(), true);
        assert.equal(sent.length, before);
        await page.locator('.confirm-dialog button:has-text("Cancel")').click();
        git('remote', 'add', 'origin', 'https://github.com/example/board-demo.git');
        await page.click('.next-more button:has-text("Create issues")');
        await dialog.getByText('GitHub repository: example/board-demo').waitFor();
        await page.locator('.confirm-dialog button:has-text("Cancel")').click();
        assert.equal(sent.length, before);
        await page.click('.next-more button:has-text("Create issues")');
        await page.locator('.confirm-dialog button:has-text("Create issues")').click();
        await page.waitForFunction(count => document.querySelector('.toast-msg')?.textContent?.includes('taskstoissues'), before);
        assert.match(sent.at(-1), /^\/speckit-github-taskstoissues Create the issues from specs\/041-profile-photo-upload\/tasks\.md/);
        assert.match(sent.at(-1), /Reviewed GitHub destination: https:\/\/github\.com\/example\/board-demo/);
    });

    it('shows the next step and sends its command to the chat', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('.spec-card[data-id="specs/_01_demo-planned"]');
        await page.waitForSelector('.next-title:has-text("Next: Tasks")');
        await page.click('.next .btn-primary');
        await page.waitForSelector('.toast.is-visible');
        assert.equal(sent.at(-1)?.split('\n')[0], '/speckit.tasks specs/_01_demo-planned');
        assert.match(await page.locator('.command-hint').textContent(), /uses the Spec Kit workflow/);
        assert.equal((await page.locator('#toast-msg').textContent()).trim(), 'Sent /speckit.tasks to the chat');
        assert.equal(await page.locator('#toast-prompt').isVisible(), false, 'the full prompt stays folded away');
        const box = await page.locator('#toast').boundingBox();
        assert.ok(box.height < 60, `the sent notice is one line, got ${box.height}px`);
        await page.waitForSelector('.next .btn-primary:not(:disabled)');
        await toastShown();
        await shot('04-run-sent');
        await page.locator('#toast').waitFor({ state: 'hidden', timeout: 6000 });
    });

    it('keeps the short message that was sent, and its instruction file, one click away', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('.next .btn-primary');
        await page.waitForSelector('.toast.is-visible');
        await page.click('#toast-actions button:has-text("Show prompt")');
        const prompt = page.locator('#toast-prompt');
        assert.ok(await prompt.isVisible());
        assert.equal(await prompt.textContent(), sent.at(-1));
        assert.equal(await prompt.textContent(), '/speckit.tasks specs/_01_demo-planned\n\nBefore you start, read and follow the run instructions in `.speckit-companion/prompts/tasks-_01_demo-planned.md`.');
        assert.equal(await page.getAttribute('#toast-actions [aria-controls="toast-prompt"]', 'aria-expanded'), 'true');
        assert.equal(await page.locator('#toast-file code').textContent(), '.speckit-companion/prompts/tasks-_01_demo-planned.md');
        assert.equal(await page.locator('#toast-file button:has-text("Copy path")').count(), 1);
        assert.match(readFileSync(join(root, '.speckit-companion/prompts/tasks-_01_demo-planned.md'), 'utf8'), /<!-- speckit-companion:context-update -->/);
        const box = await page.locator('#toast').boundingBox();
        assert.ok(box.height < 860 * 0.4, `the open prompt stays compact, got ${box.height}px`);
        assert.ok(await prompt.evaluate(node => node.scrollHeight <= node.clientHeight), 'the short message fits without scrolling');
        await toastShown();
        await shot('04c-prompt-open');
        await page.click('#toast-actions [aria-label="Dismiss"]');
        await page.locator('#toast').waitFor({ state: 'hidden', timeout: 1000 });
    });

    it('keeps the prompt up to paste when there is no chat session to send to', async (t) => {
        if (skipWithoutChrome(t)) return;
        sessionUp = false;
        try {
            await page.click('.next .btn-primary');
            await page.waitForSelector('.toast.is-visible');
            assert.match(await page.locator('#toast-msg').textContent(), /^No chat session here\b.*paste it into the chat\.$/i);
            assert.ok(await page.locator('#toast-prompt').isVisible(), 'the prompt shows without a click');
            assert.equal(await page.locator('#toast-prompt').textContent(), sent.at(-1));
            assert.doesNotMatch(sent.at(-1), /context-update/);
            assert.ok(await page.locator('#toast-file').isVisible(), 'the instruction file is named beside it');
            assert.equal(await page.locator('#toast-actions button:has-text("Copy")').count(), 1);
            const box = await page.locator('#toast').boundingBox();
            assert.ok(box.height < 860 * 0.4, `the failure notice stays compact, got ${box.height}px`);
            await toastShown();
            await shot('04b-run-not-sent');
            await page.waitForTimeout(4500);
            assert.ok(await page.locator('#toast').isVisible(), 'the failure notice does not fade');
            await page.click('#toast-actions [aria-label="Dismiss"]');
            await page.locator('#toast').waitFor({ state: 'hidden', timeout: 1000 });
        } finally {
            sessionUp = true;
        }
    });

    it('updates the open spec when a file changes on disk', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('.spec-card[data-id="specs/_02_demo-tasked"]');
        await page.waitForSelector('.tab:has-text("Tasks")');
        const tasksPath = join(root, 'specs/_02_demo-tasked/tasks.md');
        writeFileSync(tasksPath, readFileSync(tasksPath, 'utf8').replace('- [ ] **T001**', '- [x] **T001**'));
        await page.waitForFunction(() => document.querySelector('.spec-card[data-id="specs/_02_demo-tasked"] .card-tasks')?.textContent === '1/4', null, { timeout: 5000 });
        await page.waitForSelector('.tab:has-text("Tasks"):has-text("1/4")');
        await shot('05-live-update');
    });

    it('follows the agent when it focuses a spec', async (t) => {
        if (skipWithoutChrome(t)) return;
        board.focus('_03_demo-living');
        await page.waitForSelector('.spec-card[data-id="specs/_03_demo-living"][aria-current="true"]');
        await page.waitForSelector('.detail h2:has-text("Demo — Living Specs")');
    });

    it('collapses to one pane on a narrow panel and gets back to the list', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.setViewportSize({ width: 480, height: 860 });
        if (await page.getAttribute('#layout', 'data-view') === 'detail') await page.click('.back');
        await page.click('.spec-card[data-id="specs/_00_demo-specified"]');
        assert.equal(await page.getAttribute('#layout', 'data-view'), 'detail');
        await shot('06-narrow-detail');
        await page.click('.back');
        assert.equal(await page.getAttribute('#layout', 'data-view'), 'board');
        await shot('06b-narrow-board');
        await page.setViewportSize({ width: 1280, height: 860 });
    });

    it('offers the workflow choice and sends the one picked', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('#new-spec-toggle');
        assert.equal(await page.locator('#new-spec-workflow button').count(), 3);
        assert.equal(await page.getAttribute('#new-spec-workflow [aria-checked="true"]', 'role'), 'radio');
        assert.equal((await page.locator('#new-spec-workflow [aria-checked="true"]').textContent()).trim(), 'Companion');
        await page.click('#new-spec-workflow button:has-text("Spec Kit")');
        await page.fill('#new-spec-text', 'Show a footer count');
        await shot('08-new-spec-workflow');
        await page.click('#new-spec button[type="submit"]');
        await page.waitForSelector('.toast.is-visible');
        assert.ok(sent.at(-1).startsWith('/speckit.specify Show a footer count'));
        const file = sent.at(-1).match(/run instructions in `(\.speckit-companion\/prompts\/specify-[^`]+\.md)`\.$/)?.[1];
        assert.ok(file, 'the message ends with the sentence naming the instruction file');
        assert.doesNotMatch(sent.at(-1), /SEED WRITE INSTRUCTIONS|"workflow"/);
        assert.match(readFileSync(join(root, file), 'utf8'), /"workflow": "speckit"/);
    });

    it('shows no install note where Companion is installed', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.click('#toast-actions [aria-label="Dismiss"]');
        await page.click('#new-spec-toggle');
        await page.waitForSelector('.next');
        assert.equal(await page.locator('.install-hint').count(), 0);
        assert.equal(await page.locator('#new-spec-install').isVisible(), false);
        await page.click('#new-spec-toggle');
    });

    it('disables Companion and Auto and says how to install it when the extension is not installed', async (t) => {
        if (skipWithoutChrome(t)) return;
        const stockRoot = temp('canvas-page-stock-');
        mkdirSync(join(stockRoot, 'specs/001-starred-todos'), { recursive: true });
        writeFileSync(join(stockRoot, 'specs/001-starred-todos/spec.md'), '# Starred todos\n');
        const stockSent = [];
        const stock = await createSpecServer({ root: stockRoot, send: async (prompt) => { stockSent.push(prompt); return true; } });
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
        const stockPage = await context.newPage();
        const line = 'SpecKit Companion is not installed in this project, so the standard Spec Kit commands run.';
        const command = 'specify extension add companion --from https://github.com/alfredoperez/speckit-companion/releases/download/companion-latest/companion.zip --force';
        try {
            await stockPage.goto(stock.url);
            await stockPage.waitForSelector('.next');
            await stockPage.click('#new-spec-toggle');
            const states = await stockPage.locator('#new-spec-workflow button').evaluateAll(buttons => buttons.map(b => [b.textContent.trim(), b.disabled, b.getAttribute('aria-disabled')]));
            assert.deepEqual(states, [['Companion', true, 'true'], ['Spec Kit', false, null], ['Auto', true, 'true']]);
            const looks = await stockPage.locator('#new-spec-workflow button').evaluateAll(buttons => buttons.map(b => [getComputedStyle(b).opacity, getComputedStyle(b).cursor]));
            assert.deepEqual(looks, [['0.6', 'not-allowed'], ['1', 'pointer'], ['0.6', 'not-allowed']]);
            const focusable = await stockPage.locator('#new-spec-workflow button').evaluateAll(buttons => buttons.map(b => { b.focus(); return document.activeElement === b; }));
            assert.deepEqual(focusable, [false, true, false], 'disabled choices take no focus');
            assert.equal((await stockPage.locator('#new-spec-workflow [aria-checked="true"]').textContent()).trim(), 'Spec Kit');

            const inForm = stockPage.locator('#new-spec .install-hint');
            const onCard = stockPage.locator('.next .install-hint');
            for (const hint of [inForm, onCard]) {
                assert.equal(await hint.count(), 1);
                assert.ok((await hint.locator('.install-hint__line').textContent()).startsWith(line));
                assert.equal(await hint.locator('.install-hint__how').count(), 0, 'the command stays folded away');
                const box = await hint.boundingBox();
                assert.ok(box.height < 30, `the note is one line, got ${box.height}px`);
            }
            if (SHOTS) await stockPage.screenshot({ path: join(SHOTS, '09-new-spec-stock.png') });

            await onCard.locator('.btn-link').click();
            assert.equal(await onCard.locator('.install-hint__how code').textContent(), command);
            assert.equal(await onCard.locator('.btn-link').getAttribute('aria-expanded'), 'true');
            await onCard.locator('.install-hint__how button:has-text("Copy")').click();
            await onCard.locator('.install-hint__how button:has-text("Copied")').waitFor();
            assert.equal(await stockPage.evaluate(() => navigator.clipboard.readText()), command);
            if (SHOTS) await stockPage.screenshot({ path: join(SHOTS, '10-install-hint-open.png') });

            await onCard.locator('button:has-text("Ask Copilot to install it")').click();
            await stockPage.waitForSelector('.toast.is-visible');
            assert.ok(stockSent.at(-1).startsWith(`Run \`${command}\` in this project, then commit the skill files it generates`));
            assert.equal((await stockPage.locator('#toast-msg').textContent()).trim(), 'Sent the install request to the chat');

            await onCard.getByRole('button', { name: 'Open setup', exact: true }).click();
            await stockPage.getByRole('heading', { name: 'Spec Kit integrations' }).waitFor();
            await stockPage.getByRole('button', { name: 'Set up CLI in this repository' }).waitFor();
            await stockPage.click('#board-tools-toggle');
            await stockPage.click('#specs-return');
            await stockPage.click('#new-spec-toggle');
            await inForm.locator('[aria-label="Dismiss the install note"]').click();
            assert.equal(await stockPage.locator('.install-hint').count(), 0, 'dismissing hides it in both places');
            assert.match(await stockPage.locator('#new-spec-hint').textContent(), /not installed/);
            assert.match(await stockPage.locator('.command-hint').textContent(), /Stock Spec Kit commands/);
            await stockPage.reload();
            await stockPage.waitForSelector('.next');
            assert.equal(await stockPage.locator('.install-hint').count(), 0, 'and it stays dismissed for the session');
        } finally {
            await context.close();
            await stock.close();
        }
    });

    it('inspects catalog precedence and errors without adding install actions at 480px', async (t) => {
        if (skipWithoutChrome(t)) return;
        const view = await browser.newPage({ viewport: { width: 480, height: 760 } });
        let inspections = 0;
        try {
            await view.route('**/api/integrations', async route => {
                const response = await route.fetch();
                await route.fulfill({ response, json: { ...await response.json(), cli: true } });
            });
            await view.route('**/api/integrations/catalogs', route => {
                inspections++;
                const { expectedRoot } = route.request().postDataJSON();
                return route.fulfill({ json: { root: expectedRoot, catalogs: [
                    { kind: 'extension', sources: [
                        { name: 'Team releases', priority: 1, installAllowed: true, location: 'example.test' },
                        { name: 'Community feed', priority: 20, installAllowed: false, location: 'community.example.test' },
                    ] },
                    { kind: 'preset', unavailable: true },
                    { kind: 'workflow', sources: [] },
                    { kind: 'bundle', sources: [] },
                ] } });
            });
            await view.goto(board.url);
            await view.click('#board-tools-toggle');
            await view.click('#workflow-toggle');
            await view.click('#workflow-integrations-view');
            const inspect = view.getByRole('button', { name: 'Inspect catalog sources', exact: true });
            await inspect.focus();
            assert.equal(inspections, 0);
            await inspect.press('Enter');

            const sources = view.getByRole('region', { name: 'Catalog sources' });
            const entries = sources.locator('li');
            await entries.first().waitFor();
            assert.equal(inspections, 1);
            assert.deepEqual((await entries.allTextContents()).map(entry => entry.split(' · ')[0]), ['Team releases', 'Community feed']);
            assert.match(await entries.nth(0).textContent(), /Install allowed by Spec Kit.*Priority 1/);
            assert.match(await entries.nth(1).textContent(), /Discovery only.*Priority 20/);
            assert.equal(await sources.locator('a, button').count(), 0);
            assert.match(await sources.getByRole('alert').textContent(), /could not read/);
            const workflows = sources.locator('summary').getByText('Workflows', { exact: true });
            await workflows.press('Enter');
            assert.equal(await sources.getByText('No sources configured.').first().isVisible(), true);
            assert.ok(await sources.evaluate(pane => pane.scrollWidth <= pane.clientWidth));
        } finally {
            await view.close();
        }
    });

    it('keeps the nodes it has through a rescan that changed nothing, and a "Copied" through one that did', async (t) => {
        if (skipWithoutChrome(t)) return;
        const stockRoot = temp('canvas-page-redraw-');
        mkdirSync(join(stockRoot, 'specs/001-starred-todos'), { recursive: true });
        writeFileSync(join(stockRoot, 'specs/001-starred-todos/spec.md'), '# Starred todos\n');
        writeFileSync(join(stockRoot, 'specs/001-starred-todos/.spec-context.json'), JSON.stringify({ workflow: 'speckit', specName: 'Starred todos', currentStep: 'specify', status: 'specified', history: [] }));
        const stock = await createSpecServer({ root: stockRoot, send: async () => true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
        const stockPage = await context.newPage();
        try {
            await stockPage.goto(stock.url);
            await stockPage.waitForSelector('.next .install-hint');
            await stockPage.locator('.next .install-hint .btn-link').click();
            await stockPage.locator('.next .install-hint__how button:has-text("Copy")').click();
            await stockPage.locator('.next .install-hint__how button:has-text("Copied")').waitFor();
            await stockPage.evaluate(() => { window.kept = { rail: document.querySelector('.rail'), card: document.querySelector('.spec-card') }; });
            const scans = () => stockPage.evaluate(() => window.scans ?? 0);
            await stockPage.evaluate(() => { new EventSource(`/api/events${location.search}`).addEventListener('snapshot', () => { window.scans = (window.scans ?? 0) + 1; }); });
            await stockPage.waitForFunction(() => window.scans === 1);

            stock.rescan();
            await stockPage.waitForFunction(() => window.scans === 2);
            await stockPage.waitForTimeout(150);
            assert.deepEqual(await stockPage.evaluate(() => [document.querySelector('.rail') === window.kept.rail, document.querySelector('.spec-card') === window.kept.card]), [true, true], 'nothing was rebuilt');
            assert.equal(await stockPage.locator('.next .install-hint__how button:has-text("Copied")').count(), 1);

            writeFileSync(join(stockRoot, 'specs/001-starred-todos/plan.md'), '# Plan\n\nStore the flag.\n');
            stock.rescan();
            await stockPage.waitForSelector('.next-title:has-text("Next: Tasks")');
            assert.equal(await stockPage.evaluate(() => document.querySelector('.rail') === window.kept.rail), false, 'a real change redraws');
            assert.equal(await stockPage.locator('.next .install-hint__how button:has-text("Copied")').count(), 1, 'and the install line keeps its state');
            assert.equal(await scans() >= 3, true);

            mkdirSync(join(stockRoot, '.specify/extensions/companion'), { recursive: true });
            stock.rescan();
            await stockPage.waitForFunction(() => document.querySelectorAll('.install-hint').length === 0);
            assert.match(await stockPage.locator('.command-hint').textContent(), /uses the Spec Kit workflow/, 'the card follows the project, not only the spec');
        } finally {
            await context.close();
            await stock.close();
        }
    });

    it('follows a stock run from the files: a record stuck on specifying, the dashed command, and the step it sent shown as running', async (t) => {
        if (skipWithoutChrome(t)) return;
        const stockRoot = temp('canvas-page-stock-run-');
        const spec = join(stockRoot, 'specs/001-todo-stars');
        mkdirSync(spec, { recursive: true });
        for (const name of ['spec.md', 'plan.md']) writeFileSync(join(spec, name), `# Todo stars: ${name}\n`);
        writeFileSync(join(spec, '.spec-context.json'), JSON.stringify({
            workflow: 'speckit',
            specName: 'Todo Stars',
            currentStep: 'specify',
            status: 'specifying',
            history: [{ step: 'specify', substep: null, kind: 'start', by: 'extension', at: '2026-10-05T14:54:53.999Z' }],
        }));
        for (const step of ['specify', 'plan', 'tasks', 'implement']) {
            mkdirSync(join(stockRoot, '.github/skills', `speckit-${step}`), { recursive: true });
            writeFileSync(join(stockRoot, '.github/skills', `speckit-${step}`, 'SKILL.md'), `# ${step}\n`);
        }
        const stockSent = [];
        const stock = await createSpecServer({ root: stockRoot, checkoutWriter: null, send: async (prompt) => { stockSent.push(prompt); return true; } });
        const stockPage = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
        try {
            await stockPage.goto(stock.url);
            await stockPage.waitForSelector('.next-title:has-text("Next: Tasks")');
            assert.equal((await stockPage.locator('.spec-card .pill').textContent()).trim(), 'Planned');
            assert.deepEqual(await stockPage.locator('.rail .rail-state').allTextContents(), ['Done', 'Done', 'Not started', 'Not started']);
            assert.match(await stockPage.locator('.command-hint').textContent(), /Buttons send \/speckit-<step> specs\/001-todo-stars to the chat\./);
            if (SHOTS) await stockPage.screenshot({ path: join(SHOTS, '12-stock-run-from-files.png') });

            await stockPage.click('.next .btn-primary');
            await stockPage.waitForSelector('.next-title:has-text("Tasks is running")');
            assert.equal(stockSent.at(-1), '/speckit-tasks specs/001-todo-stars\n\nIf the steps of /speckit-tasks are not already loaded in this chat, read `.github/skills/speckit-tasks/SKILL.md` first and follow every one of them for the spec in `specs/001-todo-stars`.');
            assert.equal((await stockPage.locator('#toast-msg').textContent()).trim(), 'Sent /speckit-tasks to the chat');
            await stockPage.click('#toast-actions button:has-text("Show prompt")');
            assert.equal(await stockPage.locator('#toast-prompt').textContent(), stockSent.at(-1));
            assert.equal(await stockPage.locator('#toast-file').isVisible(), false, 'no instruction file for a stock run');
            assert.deepEqual(await stockPage.locator('.rail .rail-state').allTextContents(), ['Done', 'Done', 'Running', 'Not started']);
            assert.equal((await stockPage.locator('.spec-card .pill').textContent()).trim(), 'Tasking');
            if (SHOTS) await stockPage.screenshot({ path: join(SHOTS, '13-stock-run-step-running.png') });

            writeFileSync(join(spec, 'tasks.md'), '- [ ] T001 Add the star\n');
            stock.settle();
            await stockPage.waitForSelector('.next-title:has-text("Next: Implement")');
            assert.deepEqual(await stockPage.locator('.rail .rail-state').allTextContents(), ['Done', 'Done', 'Done', 'Not started']);
        } finally {
            await stockPage.close();
            await stock.close();
        }
    });

    it('picks a state in a plan\'s states card, and draws a file name as a name', async (t) => {
        if (skipWithoutChrome(t)) return;
        const planRoot = temp('canvas-page-plan-');
        const folder = join(planRoot, 'specs/001-review');
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'spec.md'), '# Review\n');
        const plan = [
            '# Plan', '', 'It changes `src/review.ts`.', '',
            '```calls Sending a review', '  send() @ src/review.ts:10', '~   notify() @ src/notify.ts:4', '```', '',
            '```states A review', 'Draft: Edited. (start)', 'Sent: Waiting.', 'Done: Merged. (final)', 'Draft -> Sent: submit', 'Sent -> Done: approve', 'grid:', 'Draft | Sent | Done', '```', '',
        ].join('\n');
        writeFileSync(join(folder, 'plan.md'), plan);
        writeFileSync(join(folder, '.spec-context.json'), JSON.stringify({ workflow: 'speckit', specName: 'Review', currentStep: 'plan', status: 'planned', history: [] }));
        const server = await createSpecServer({ root: planRoot, send: async () => true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
        const planPage = await context.newPage();
        const card = () => planPage.evaluate(() => ({
            caption: document.querySelector('.states-caption')?.textContent,
            picked: [...document.querySelectorAll('.states-state.is-selected')].map(b => b.textContent.trim()),
            moves: document.querySelector('.states-card > .states-moves')?.textContent ?? '',
        }));
        try {
            await planPage.goto(server.url);
            await planPage.click('.tab:has-text("Plan")');
            await planPage.waitForSelector('.states-card');
            assert.match((await card()).caption, /^Draft: Edited\./);
            const lefts = await planPage.locator('.states-state').evaluateAll(buttons => buttons.map(b => Math.round(b.getBoundingClientRect().left)));
            assert.equal(new Set(lefts).size, 3, 'each state sits at its own place in the diagram');

            await planPage.locator('.states-state').nth(1).click();
            const sent = await card();
            assert.match(sent.caption, /^Sent: Waiting\./);
            assert.deepEqual(sent.picked, ['Sent']);
            assert.match(sent.moves, /approve/);
            assert.ok(await planPage.locator('.states-caption').isVisible(), 'the caption is on screen');

            writeFileSync(join(folder, 'plan.md'), `${plan}\nOne more line.\n`);
            await planPage.waitForFunction(() => document.querySelector('#markdown-content')?.textContent.includes('One more line.'));
            assert.match((await card()).caption, /^Sent: Waiting\./, 'the pick survives the redraw');
            await planPage.locator('.states-state').nth(2).click();
            assert.match((await card()).caption, /^Done: Merged\./, 'picking still works on the redrawn card');

            const names = await planPage.locator('#markdown-content .file-ref').evaluateAll(buttons => buttons.map(b => [b.disabled, getComputedStyle(b).cursor, getComputedStyle(b).pointerEvents]));
            assert.ok(names.length > 0, 'the plan draws a file name');
            for (const name of names) assert.deepEqual(name, [true, 'default', 'none']);
            assert.ok(await planPage.locator('.calls-card').count(), 'the plan draws a calls card');
            assert.ok(await planPage.locator('.calls-strike').count(), 'the calls card draws a strike button');
            assert.equal(await planPage.locator('.calls-strike:visible').count(), 0, 'strike stays hidden');
            assert.ok(await planPage.locator('.line-add-btn').count(), 'review notes are available');
        } finally {
            await context.close();
            await server.close();
        }
    });

    it('adds, restores, edits and refines a review note', async (t) => {
        if (skipWithoutChrome(t)) return;
        const reviewRoot = temp('canvas-page-review-');
        const folder = join(reviewRoot, 'specs', '001-review');
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'spec.md'), '# Review\n\nA stable paragraph.\n');
        writeFileSync(join(folder, '.spec-context.json'), JSON.stringify({ workflow: 'speckit', specName: 'Review', currentStep: 'specify', status: 'specified', history: [] }));
        const prompts = [];
        const server = await createSpecServer({ root: reviewRoot, send: async prompt => { prompts.push(prompt); return true; } });
        const reviewPage = await browser.newPage();
        try {
            await reviewPage.goto(server.url);
            await reviewPage.click('.tab:has-text("Spec")');
            const line = reviewPage.locator('.line[data-line="3"]');
            await line.locator('.line-add-btn').click({ force: true });
            await reviewPage.getByLabel('Review note').fill('Clarify scope');
            await reviewPage.getByRole('button', { name: 'Save note' }).click();
            await reviewPage.locator('.review-card:has-text("Clarify scope")').waitFor();
            await reviewPage.reload();
            await reviewPage.click('.tab:has-text("Spec")');
            await reviewPage.locator('.review-card:has-text("Clarify scope")').waitFor();
            await reviewPage.locator('.review-card button:has-text("Edit")').click();
            await reviewPage.getByLabel('Review note').fill('Clarify boundaries');
            await reviewPage.getByRole('button', { name: 'Save note' }).click();
            await reviewPage.locator('.review-card:has-text("Clarify boundaries")').waitFor();
            await reviewPage.getByRole('button', { name: 'Refine 1 note' }).click();
            await reviewPage.locator('.review-card:has-text("Applied")').waitFor();
            assert.match(prompts.at(-1), /Clarify boundaries/);
        } finally {
            await reviewPage.close();
            await server.close();
        }
    });

    it('reads in light mode', async (t) => {
        if (skipWithoutChrome(t)) return;
        await page.emulateMedia({ colorScheme: 'light' });
        await page.waitForFunction(() => document.body.classList.contains('vscode-light'));
        await page.click('[data-filter="all"]');
        await page.click('.spec-card[data-id="specs/041-profile-photo-upload"]');
        await page.waitForSelector('.dossier');
        await shot('07-light-overview');
        await page.emulateMedia({ colorScheme: 'dark' });
    });

    it('selects a repository from a chat and replaces same-id details and file watchers', async (t) => {
        if (skipWithoutChrome(t)) return;
        const workspace = temp('canvas-page-root-');
        const chat = join(workspace, 'chat');
        const repository = join(workspace, 'repository');
        repo(chat);
        repo(repository);
        mkdirSync(join(repository, 'specs/001-shared'), { recursive: true });
        writeFileSync(join(repository, 'specs/001-shared/spec.md'), '# Selected repository\n');
        const selection = rootSelection(workspace);
        let picked = null;
        const server = await createSpecServer({ root: chat, saveRoot: selection.write, browseFolder: async () => {
            if (picked instanceof Error) throw picked;
            return picked;
        } });
        const view = await browser.newPage({ viewport: { width: 1280, height: 860 } });
        try {
            await view.goto(server.url);
            await view.waitForSelector('#repository-warning:visible');
            assert.equal(await view.inputValue('#repository-root'), chat);
            if (SHOTS) await view.screenshot({ path: join(SHOTS, '08-repository-warning.png'), fullPage: false });
            if (SHOTS) {
                await view.fill('#repository-root', REPO);
                const form = await view.locator('#repository-form').boundingBox();
                const warning = await view.locator('#repository-warning').boundingBox();
                await view.screenshot({ path: join(SHOTS, 'repository-controls.png'), clip: { x: form.x, y: form.y, width: form.width, height: warning.y - form.y } });
                await view.fill('#repository-root', chat);
            }
            await view.click('#repository-browse');
            assert.equal(await view.inputValue('#repository-root'), chat);
            assert.equal(selection.read(), null);
            picked = new Error('dialog unavailable');
            await view.click('#repository-browse');
            await view.waitForSelector('.toast.is-visible:has-text("dialog unavailable")');
            picked = repository;
            await view.click('#repository-browse');
            await view.waitForSelector('.detail h2:has-text("Selected repository")');
            assert.equal(selection.read(), repository);
            await view.fill('#repository-root', chat);
            await view.click('#repository-form button[type="submit"]');
            await view.waitForSelector('#repository-warning:visible');
            await view.fill('#repository-root', repository);
            await view.click('#repository-form button[type="submit"]');
            await view.waitForSelector('.spec-card');
            await view.waitForSelector('.detail h2:has-text("Selected repository")');
            assert.equal(await view.locator('#repository-warning').isVisible(), false);
            assert.equal(selection.read(), repository);
            await view.reload();
            await view.waitForSelector('.spec-card');
            assert.equal(await view.inputValue('#repository-root'), repository);
            writeFileSync(join(repository, 'specs/001-shared/spec.md'), '# Updated by watcher\n');
            await view.waitForSelector('.detail h2:has-text("Updated by watcher")');
            mkdirSync(join(chat, 'specs/001-shared'), { recursive: true });
            writeFileSync(join(chat, 'specs/001-shared/spec.md'), '# Different repository\n');
            await view.fill('#repository-root', chat);
            await view.click('#repository-form button[type="submit"]');
            await view.waitForSelector('.detail h2:has-text("Different repository")');
            assert.equal(selection.read(), chat);
            if (SHOTS) await view.screenshot({ path: join(SHOTS, '09-repository-selection.png'), fullPage: false });
            await view.fill('#repository-root', join(workspace, 'missing'));
            await view.click('#repository-form button[type="submit"]');
            await view.waitForSelector('.toast.is-visible:has-text("Could not select repository")');
            assert.equal(selection.read(), chat);
        } finally {
            await view.close();
            await server.close();
            rmSync(workspace, { recursive: true });
        }
    });

    it('shows no time for a recorded spec with no activity, and the file time for one with no record', async (t) => {
        if (skipWithoutChrome(t)) return;
        for (const name of ['090-record-no-history', '091-no-record']) {
            mkdirSync(join(root, 'specs', name));
            writeFileSync(join(root, 'specs', name, 'spec.md'), `# ${name}\n`);
        }
        writeFileSync(join(root, 'specs/090-record-no-history/.spec-context.json'), '{"status": "planned", "history": []}');
        const time = id => page.locator(`.spec-card[data-id="specs/${id}"] .card-time`);
        await page.waitForSelector('.spec-card[data-id="specs/090-record-no-history"]', { timeout: 5000 });
        await page.waitForSelector('.spec-card[data-id="specs/091-no-record"]', { timeout: 5000 });
        assert.equal(await time('090-record-no-history').textContent(), '');
        assert.equal(await time('091-no-record').textContent(), 'just now');
        assert.match(await time('_01_demo-planned').textContent(), /ago$/);
    });

    it('opens the shared Workflow Builder in light mode and reads a node', async (t) => {
        if (skipWithoutChrome(t)) return;
        const project = temp('canvas-builder-');
        const extension = join(project, '.specify', 'extensions', 'companion');
        mkdirSync(extension, { recursive: true });
        cpSync(join(REPO, 'apps', 'speckit-extension'), extension, { recursive: true });
        const server = await createSpecServer({ root: project });
        const view = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
        try {
            await view.goto(`${server.url}&theme=light`);
            await view.click('#board-tools-toggle');
            await view.click('#workflow-toggle');
            const frame = view.frameLocator('#workflow-frame');
            await frame.locator('.pb-node-main').first().waitFor();
            await frame.locator('.pb-node-main').first().click();
            await frame.locator('.pb-doc-p').first().waitFor();
            assert.equal(await frame.locator('body').getAttribute('class'), 'vscode-light');
            await frame.getByRole('button', { name: 'Open the file' }).click();
            await frame.locator('.workflow-editor[open]').waitFor();
            assert.equal(await frame.locator('.workflow-editor textarea').getAttribute('readonly'), '');
            await frame.locator('.workflow-editor button:has-text("Close")').click();
            await frame.getByRole('button', { name: 'Edit', exact: true }).click();
            const draft = frame.locator('.pb-doc textarea');
            await draft.fill(`${await draft.inputValue()}\nBrowser-authored instruction.\n`);
            await frame.getByRole('button', { name: 'Save', exact: true }).click();
            await frame.getByText('Browser-authored instruction.').waitFor();
            await frame.getByRole('button', { name: 'Open the file' }).click();
            await frame.locator('.workflow-editor[open]').waitFor();
            const file = frame.locator('.workflow-editor textarea');
            assert.match(await file.inputValue(), /Browser-authored instruction/);
            await file.fill(`${await file.inputValue()}\nSaved from the file editor.\n`);
            await frame.locator('.workflow-editor button:has-text("Close")').click();
            assert.match(await frame.locator('.workflow-editor [role="alert"]').textContent(), /Save or discard/);
            assert.match(await file.inputValue(), /Saved from the file editor/);
            const workflowFrame = await (await view.locator('#workflow-frame').elementHandle()).contentFrame();
            await workflowFrame.evaluate(() => location.reload());
            await frame.locator('.pb-node-main').first().waitFor();
            await frame.locator('.pb-node-main').first().click();
            await frame.getByRole('button', { name: 'Open the file' }).click();
            await frame.locator('.workflow-editor[open]').waitFor();
            assert.match(await frame.locator('.workflow-editor textarea').inputValue(), /Saved from the file editor/);
            await frame.locator('.workflow-editor button:has-text("Save")').click();
            await frame.locator('.workflow-editor').waitFor({ state: 'detached' });
            await frame.getByRole('button', { name: 'Open the file' }).click();
            await frame.locator('.workflow-editor[open]').waitFor();
            assert.match(await frame.locator('.workflow-editor textarea').inputValue(), /Saved from the file editor/);
            const path = await frame.locator('.workflow-editor h2').textContent();
            await frame.locator('.workflow-editor textarea').fill('Draft after external change');
            await workflowFrame.evaluate(() => location.reload());
            const disk = join(project, path);
            writeFileSync(disk, `${readFileSync(disk, 'utf8')}\nExternal edit.\n`);
            await frame.locator('.pb-node-main').first().waitFor();
            await frame.locator('.pb-node-main').first().click();
            await frame.getByRole('button', { name: 'Open the file' }).click();
            await frame.locator('.workflow-editor[open]').waitFor();
            assert.equal(await frame.locator('.workflow-editor textarea').inputValue(), 'Draft after external change');
            assert.match(await frame.locator('.workflow-editor [role="alert"]').textContent(), /file changed/);
            assert.equal(await frame.locator('.workflow-editor button:has-text("Save")').isDisabled(), true);
            await frame.locator('.workflow-editor button:has-text("Discard")').click();
            assert.match(await frame.locator('.workflow-editor textarea').inputValue(), /External edit/);
        } finally {
            await view.close();
            await server.close();
            await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });
});
