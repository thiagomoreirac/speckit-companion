import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';
import { id, nativeFile, original, schemaData, seedExtensionConfig } from './fixtures/extension-config.mjs';

async function setup(t, options = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'canvas-extension-config-')));
    const files = seedExtensionConfig(root);
    const sent = [];
    let server;
    t.after(async () => {
        await server?.close();
        rmSync(root, { force: true, recursive: true });
    });
    server = await createSpecServer({ root, send: async prompt => sent.push(prompt), ...options });
    const post = async (suffix, body = {}, authorized = true) => {
        const response = await fetch(new URL(`/api/integrations/config${suffix}`, server.url), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(authorized ? { 'x-speckit-token': server.token } : {}) },
            body: JSON.stringify({ expectedRoot: root, id, ...body }),
        });
        return { status: response.status, data: await response.json() };
    };
    return { ...files, post, sent, server };
}

it('discovers and saves declared extension settings without exposing existing values or running hooks', async t => {
    const { config, directory, hooks, post, sent } = await setup(t);
    const initialHooks = readFileSync(hooks, 'utf8');
    const preview = (file, changes) => post('/preview', { file: file.name, revision: file.revision, changes });
    assert.equal((await post('', {}, false)).status, 403);
    const opened = await post('');
    assert.equal(opened.status, 200);
    assert.doesNotMatch(JSON.stringify(opened), /synthetic-credential|synthetic-command-not-called/);
    assert.deepEqual(opened.data.hooks, [{ phase: 'after_plan', enabled: 1, disabled: 0 }]);
    const [yaml, json] = opened.data.files;
    for (const changes of [{ format: 'invalid' }, { limit: 101 }, { format: 'brief', apiToken: 'not-allowed' }, { includeSummary: false }]) {
        assert.equal((await preview(yaml, changes)).status, 400);
    }
    const reviewed = await preview(yaml, { format: 'brief', includeSummary: false, limit: 4 });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.doesNotMatch(JSON.stringify(reviewed.data), /synthetic-credential/);
    assert.equal(readFileSync(config, 'utf8'), original);
    assert.equal((await post('/save', { token: reviewed.data.token })).status, 200);
    assert.equal((await post('/save', { token: reviewed.data.token })).status, 400);
    const written = readFileSync(config, 'utf8');
    assert.match(written, /format: "brief"/);
    assert.match(written, /includeSummary: false/);
    assert.match(written, /synthetic-credential/);
    assert.match(written, /# keep this comment/);
    assert.equal(readFileSync(hooks, 'utf8'), initialHooks);
    assert.deepEqual(sent, []);

    const jsonFile = join(directory, 'secondary.json');
    const jsonReview = await preview(json, { format: 'brief' });
    assert.equal(jsonReview.status, 200, JSON.stringify(jsonReview.data));
    assert.equal(existsSync(jsonFile), false);
    assert.equal((await post('/save', { token: jsonReview.data.token })).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(jsonFile, 'utf8')), { format: 'brief' });
    assert.equal((await post('', { id: 'template-tool' })).data.files[0].template, 'base.yml');
    assert.equal((await post('', { id: 'manual-tool' })).data.docs, 'https://github.com/example/manual-tool');
});

it('refuses stale reviews and unsupported or out-of-scope settings', async t => {
    const { config, schema, manifest, post } = await setup(t);
    const open = async () => (await post('')).data.files[0];
    for (const path of [config, schema, manifest]) {
        const initial = readFileSync(path, 'utf8');
        const preview = await post('/preview', { file: nativeFile, revision: (await open()).revision, changes: { format: 'brief' } });
        assert.equal(preview.status, 200, JSON.stringify(preview.data));
        writeFileSync(path, `${initial}\n`);
        assert.match((await post('/save', { token: preview.data.token })).data.error, /settings changed/i);
        writeFileSync(path, initial);
    }
    const unknownSchema = { ...schemaData, $ref: 'https://example.invalid/never-fetched' };
    writeFileSync(schema, JSON.stringify(unknownSchema));
    assert.equal((await open()).canEdit, false);
    writeFileSync(schema, JSON.stringify(schemaData));
    writeFileSync(config, 'base: &copy [1]\nextra: *copy\n');
    assert.equal((await open()).canEdit, false);
    assert.equal((await post('', { id: 'not-registered' })).status, 400);
    writeFileSync(manifest, 'extension: {id: example-reporter, version: 1.2.3}\nprovides:\n  config:\n    - name: ../../other.yml\n');
    assert.match((await post('')).data.problem, /unsafe or duplicate/);
});

it('reviews generated extension settings in the browser and writes only on confirmation', async t => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch()).catch(() => null);
    if (!browser) return t.skip('no Chromium to drive');
    t.after(() => browser.close());
    const { config, server } = await setup(t);
    const page = await browser.newPage({ viewport: { width: 680, height: 900 }, colorScheme: 'dark' });
    await page.goto(server.url);
    await page.locator('#board-tools-toggle').click();
    await page.locator('#workflow-toggle').click();
    await page.locator('#workflow-integrations-view').click();
    await page.getByRole('button', { name: 'Configure: Example Reporter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Example Reporter setup' });
    const form = dialog.getByRole('region', { name: 'report.yml', exact: true });
    const format = form.getByLabel(/Report format/);
    const warning = dialog.getByText('Required project settings are missing', { exact: false });
    await warning.waitFor();
    await format.selectOption('brief');
    await form.getByLabel(/Include summary/).selectOption('false');
    assert.doesNotMatch(await dialog.innerText(), /synthetic-credential/);
    const review = page.getByRole('dialog', { name: 'Review extension settings' });
    const reviewButton = form.getByRole('button', { name: 'Review changes' });
    await reviewButton.click();
    await review.getByText('"brief"', { exact: true }).waitFor();
    if (process.env.CANVAS_CONFIG_SCREENSHOT) await review.screenshot({ path: process.env.CANVAS_CONFIG_SCREENSHOT });
    assert.equal(readFileSync(config, 'utf8'), original);
    await review.getByRole('button', { name: 'Cancel' }).click();
    await review.waitFor({ state: 'hidden' });
    assert.equal(readFileSync(config, 'utf8'), original);
    await reviewButton.click();
    await review.getByRole('button', { name: 'Save settings' }).click();
    await form.getByText('Set in project file', { exact: true }).first().waitFor();
    await warning.waitFor({ state: 'hidden' });
    assert.match(readFileSync(config, 'utf8'), /format: "brief"/);
    await dialog.getByRole('button', { name: 'Close setup' }).click();
    await page.getByRole('button', { name: 'View setup: Template Tool' }).click();
    const templates = page.getByRole('dialog', { name: 'Template Tool setup' });
    await templates.getByText('base.yml', { exact: true }).waitFor();
    assert.equal(await templates.getByRole('button', { name: 'Review changes' }).count(), 0);
    await templates.getByRole('button', { name: 'Close setup' }).click();
    await page.getByRole('button', { name: 'Manual setup: Manual Tool' }).click();
    await page.getByRole('link', { name: 'Extension documentation' }).waitFor();
});
