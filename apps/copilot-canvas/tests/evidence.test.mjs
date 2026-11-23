import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { artifactProjection } from '../com.github.copilot/extensions/speckit-companion/evidence-artifacts.mjs';
import { createSpecServer } from '../com.github.copilot/extensions/speckit-companion/server.mjs';

const spec = 'specs/001-example';
const model = '# Data model\n\n```mermaid\nerDiagram\n    TEAM ||--o{ MEMBER : "owns <record>"\n```\n';

async function fixture(t) {
    const path = resolve(`.canvas-evidence-test-${randomUUID()}`);
    mkdirSync(join(path, spec), { recursive: true });
    const root = realpathSync(path);
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
    const write = (name, value) => writeFileSync(join(root, spec, name), value);
    write('spec.md', '# Example');
    const sends = [];
    const server = await createSpecServer({ root, send: async (...args) => { sends.push(args); return true; } });
    t.after(() => server.close());
    const url = new URL(server.url);
    const headers = { 'x-speckit-token': url.searchParams.get('token'), 'Content-Type': 'application/json' };
    const call = (path, body) => fetch(new URL(path, url), body ? {
        method: 'POST', headers, body: JSON.stringify({ expectedRoot: root, spec, ...body }),
    } : { headers });
    return { root, write, url, call, sends };
}

describe('Evidence workbench', () => {
    it('reviews a create-only local SVG and rejects stale inputs or an occupied output without dispatch', async t => {
        const { root, write, call, sends } = await fixture(t);
        const get = () => call(`/api/evidence/generators?id=${spec}`).then(response => response.json());
        const generator = 'local-er-svg';
        const preview = async () => {
            const response = await call('/api/evidence/generation-preview', { generator });
            assert.equal(response.status, 200);
            return response.json();
        };
        assert.match((await get()).localGenerator.reason, /Add data-model.md/);
        write('data-model.md', model);
        assert.equal((await get()).localGenerator.reason, null);
        const first = await preview();
        const file = join(root, first.output);
        assert.deepEqual(first.inputs, [`${spec}/data-model.md`]);
        assert.equal(existsSync(file), false);
        write('data-model.md', `${model}\nA new revision.\n`);
        assert.equal((await call('/api/evidence/generate', { generator, revision: first.revision })).status, 400);
        assert.equal(existsSync(file), false);
        const approved = await preview();
        const result = await call('/api/evidence/generate', { generator, revision: approved.revision });
        assert.equal(result.status, 200);
        assert.deepEqual(await result.json(), { created: true, output: first.output });
        const svg = readFileSync(file, 'utf8');
        assert.match(svg, /owns &lt;record&gt;/);
        assert.doesNotMatch(svg, /<record>/);
        assert.equal((await call('/api/evidence/generate', { generator, revision: approved.revision })).status, 400);
        assert.equal(readFileSync(file, 'utf8'), svg);
        assert.deepEqual(sends, []);
        const inventory = await call(`/api/evidence?id=${spec}`).then(response => response.json());
        assert.equal(inventory.files.find(item => item.path === first.output).role, 'diagrams');
    });

    it('only projects the bounded diagram subset and keeps unknown syntax available as source', () => {
        const flow = 'flowchart TD\n  A[Start] -->|Continue| B[Finish]';
        const sequence = 'sequenceDiagram\n  participant A as Alice\n  A->>B: Ping\n  B-->>A: Pong';
        assert.equal(artifactProjection('diagram', flow).visualDiagram.links[0].label, 'Continue');
        assert.equal(artifactProjection('diagram', sequence).visualDiagram.links[1].arrow, '-->>');
        assert.equal(artifactProjection('diagram', `${flow}\n  click B href "/somewhere"`).visualDiagram, null);
        const document = artifactProjection('document', `# Process\n\n\`\`\`mermaid\n${flow}\n\`\`\`\n\n\`\`\`mermaid\n${sequence}\n\`\`\`\n`);
        assert.match(document.markdownHtml, /Process/);
        assert.deepEqual(document.diagrams.map(item => item.model.type), ['flow', 'sequence']);
    });

    it('opens the first document, preserves keyboard navigation and previews artifacts in dark and light', async t => {
        const { chromium } = await import('playwright-core').catch(() => ({}));
        const browser = await chromium?.launch({ channel: 'chrome', headless: true }).catch(() =>
            chromium.launch({ headless: true }).catch(() => null));
        if (!browser) return t.skip('Chromium unavailable');
        t.after(() => browser.close());
        const { write, url } = await fixture(t);
        write('spec.md', '# Example\n\nRead **rendered Markdown**.');
        write('review-note.md', '# Review note\n\n![Markup asset](/evidence-no-load)\n\n[Local link](/evidence-no-load)\n\n<script>window.evidenceMarker = true</script>');
        write('model.mmd', 'erDiagram\n  TEAM ||--o{ MEMBER : contains\n');
        write('flow.mmd', 'graph LR\n  A[Review] --> B[Publish]\n');
        write('capture.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50"/><script>window.evidenceMarker=true</script></svg>');
        write('capture.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
        const page = await browser.newPage({ viewport: { width: 480, height: 760 }, colorScheme: 'dark' });
        page.setDefaultTimeout(5000);
        t.after(() => page.close());
        const requests = [];
        page.on('request', request => { if (new URL(request.url()).pathname === '/evidence-no-load') requests.push(request.url()); });
        await page.goto(url.href);
        await page.locator(`.spec-card[data-id="${spec}"]`).click();
        await page.getByRole('tab', { name: 'Evidence' }).click();
        const tabs = page.getByRole('tablist', { name: 'Evidence categories' });
        const sheet = page.locator('.evidence-tabpanel');
        await sheet.getByText('rendered Markdown', { exact: true }).waitFor();
        assert.equal(await sheet.getByText('Ready to review', { exact: true }).isVisible(), true);
        await sheet.getByRole('combobox', { name: 'Choose an artifact' }).selectOption(`${spec}/review-note.md`);
        await sheet.getByText('Local link', { exact: true }).waitFor();
        assert.equal(await sheet.getByRole('link').count(), 0);
        assert.equal(await sheet.getByRole('img').count(), 0);
        await tabs.getByRole('tab', { name: 'Documents 2 files' }).press('ArrowRight');
        await sheet.getByRole('region', { name: 'Flowchart preview' }).waitFor();
        assert.equal(await tabs.getByRole('tab', { name: 'Diagrams 2 files' }).getAttribute('aria-selected'), 'true');
        await sheet.getByRole('combobox', { name: 'Choose an artifact' }).selectOption(`${spec}/model.mmd`);
        await sheet.getByRole('region', { name: 'Entity relationship preview' }).waitFor();
        await sheet.getByText('Review this artifact', { exact: true }).click();
        await sheet.getByRole('button', { name: 'Request changes' }).click();
        await page.getByRole('button', { name: 'Record decision' }).click();
        await sheet.locator('.evidence-doc-header').getByText('Changes requested', { exact: true }).waitFor();
        write('model.mmd', 'erDiagram\n  TEAM ||--o{ OWNER : contains\n');
        await page.getByRole('button', { name: 'Refresh artifacts' }).click();
        await sheet.getByText('Review stale', { exact: true }).waitFor();
        for (const [width, colorScheme] of [[480, 'dark'], [1080, 'light']]) {
            await page.setViewportSize({ width, height: 760 });
            await page.emulateMedia({ colorScheme });
            await tabs.getByRole('tab', { name: 'Design 2 files' }).click();
            for (const file of ['capture.svg', 'capture.png']) {
                await sheet.getByRole('combobox', { name: 'Choose an artifact' }).selectOption(`${spec}/${file}`);
                const image = sheet.getByRole('img', { name: `Preview of ${file}` });
                await image.waitFor();
                await image.evaluate(img => img.decode());
            }
            assert.ok(await sheet.evaluate(panel => panel.scrollWidth <= panel.clientWidth));
            assert.equal(await page.locator('html').getAttribute('data-theme'), colorScheme);
        }
        assert.equal(await page.evaluate(() => window.evidenceMarker), undefined);
        assert.deepEqual(requests, []);
    });
});
