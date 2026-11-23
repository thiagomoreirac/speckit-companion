import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReportPrompt, listReports, processExtensionPrompt, reportAction, reportAnswerPrompt, reportDetail } from '../com.github.copilot/extensions/speckit-companion/reports.mjs';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'canvas-reports-'));
    for (const dir of ['.specify/bugs/cart', '.specify/assessments/dark-mode', '.specify/extensions/bug', '.specify/extensions/assess', '.github/skills/speckit-bug-fix', '.github/skills/speckit-bug-assess', '.github/skills/speckit-assess-research']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, '.specify/bugs/cart/assessment.md'), '# Bug Assessment: Cart error\n\n- **Verdict**: valid\n');
    writeFileSync(join(root, '.specify/assessments/dark-mode/intake.md'), '# Idea Intake: Dark mode\n');
    for (const name of ['speckit-bug-fix', 'speckit-bug-assess', 'speckit-assess-research']) writeFileSync(join(root, '.github/skills', name, 'SKILL.md'), '# Command');
    return root;
}

describe('bug and idea reports', () => {
    it('uses the VS Code state and actions, and targets the selected folder', () => {
        const root = fixture();
        assert.equal(listReports(root, 'bugs').items[0].state, 'to-fix');
        const bug = reportDetail(root, 'bugs', 'cart').item;
        assert.equal(bug.title, 'Cart error');
        assert.ok(bug.documents[0].html.includes('Cart error'));
        assert.equal(bug.actions[0].id, 'bug.fix');
        assert.match(reportAction(root, 'bugs', 'cart', 'bug.fix'), /^\/speckit-bug-fix slug=cart/);
        assert.equal(reportDetail(root, 'ideas', 'dark-mode').item.actions[0].id, 'idea.research');
        assert.throws(() => reportAction(root, 'bugs', 'cart', 'bug.test'), /no longer available/);
        assert.throws(() => reportDetail(root, 'bugs', '../cart'), /Invalid/);
    });

    it('stages new input and blocks commands from a disabled extension', () => {
        const root = fixture();
        const prompt = createReportPrompt(root, 'bugs', { text: 'Checkout fails', slug: 'checkout-fails' });
        assert.match(prompt, /^\/speckit-bug-assess slug=checkout-fails/);
        const dir = join(root, '.speckit-companion/process-create');
        const staged = readdirSync(dir).find(name => name.startsWith('bugs-checkout-fails-'));
        assert.equal(readFileSync(join(dir, staged), 'utf8'), 'Checkout fails\n');
        writeFileSync(join(root, '.specify/extensions/.registry'), JSON.stringify({ extensions: { bug: { enabled: false } } }));
        assert.deepEqual(reportDetail(root, 'bugs', 'cart').item.actions, []);
        assert.throws(() => reportAction(root, 'bugs', 'cart', 'bug.fix'), /turned off/);
        assert.match(processExtensionPrompt(root, 'bugs'), /specify extension enable bug/);
    });

    it('uses the workspace assessment directory from JSONC settings', () => {
        const root = fixture();
        mkdirSync(join(root, '.vscode'), { recursive: true });
        mkdirSync(join(root, 'notes/ideas/custom'), { recursive: true });
        writeFileSync(join(root, 'notes/ideas/custom/intake.md'), '# Idea Intake: Custom location\n');
        writeFileSync(join(root, '.vscode/settings.json'), '{\n  "url": "https://example.test/a,}", // retained in string\n  "speckit.assessmentsDirectory": "notes/ideas", /* comment */\n}');
        const result = listReports(root, 'ideas');
        assert.equal(result.directory, 'notes/ideas');
        assert.equal(result.items[0].title, 'Custom location');
    });

    it('offers only the matching paused review gate and targets its run', () => {
        const root = fixture();
        const dir = join(root, '.specify/workflows/runs/run-1');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'state.json'), JSON.stringify({ run_id: 'run-1', workflow_id: 'bugfix', status: 'paused', current_step_id: 'review-assessment', inputs: { slug: 'cart' } }));
        const detail = reportDetail(root, 'bugs', 'cart').item;
        assert.ok(detail.actions.some(action => action.id === 'bug.approve'));
        assert.match(reportAction(root, 'bugs', 'cart', 'bug.approve'), /specify workflow resume run-1.*choose 1 \(approve\)/);
    });

    it('sends an answer only for a question still in the report', () => {
        const root = fixture();
        writeFileSync(join(root, '.specify/bugs/cart/assessment.md'), '# Bug Assessment: Cart error\n\n[NEEDS CLARIFICATION: Which browser?]\n');
        assert.deepEqual(reportDetail(root, 'bugs', 'cart').item.documents[0].questions, ['Which browser?']);
        const prompt = reportAnswerPrompt(root, 'bugs', 'cart', 'assessment', 'Which browser?', 'Firefox');
        assert.match(prompt, /Update \.specify\/bugs\/cart\/assessment\.md/);
        const dir = join(root, '.speckit-companion/report-answers');
        assert.match(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'), /Firefox/);
        assert.throws(() => reportAnswerPrompt(root, 'bugs', 'cart', 'assessment', 'Not asked?', 'answer'), /no longer asks/);
    });
});
