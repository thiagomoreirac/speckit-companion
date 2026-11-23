import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decisionContext } from '../com.github.copilot/extensions/speckit-companion/decision-context.mjs';

const spec = 'specs/101-selected';
const file = '.specify/decisions.json';
const decision = (id, overrides = {}) => ({ id, status: 'accepted', specs: [spec], summary: `${id} summary`, ...overrides });

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'canvas-decisions-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['--no-pager', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q', '-b', 'trunk');
    git('remote', 'add', 'origin', 'https://github.com/example/project.git');
    mkdirSync(join(root, '.specify'));
    const write = decisions => writeFileSync(join(root, file), JSON.stringify({ schema: 1, decisions }));
    const commit = () => {
        git('add', '--all');
        git('-c', 'user.name=Canvas Test', '-c', 'user.email=canvas@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
        return git('rev-parse', 'HEAD');
    };
    const cacheDefault = (revision = commit()) => {
        git('update-ref', 'refs/remotes/origin/trunk', revision);
        git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
        return revision;
    };
    return { root, git, write, commit, cacheDefault };
}

describe('repository decision context', () => {
    it('only quotes matching current decisions, from the pinned remote-tracking tree rather than the worktree or its HEAD', t => {
        const { root, git, write, commit, cacheDefault } = fixture(t);
        write([
            decision('ADR-001', { status: 'proposed' }),
            decision('ADR-002', { status: 'rejected' }),
            decision('ADR-003', { status: 'superseded', supersededBy: 'ADR-010' }),
            decision('ADR-004', { supersededBy: 'ADR-010' }),
            decision('ADR-005', { specs: [`${spec}-other`] }),
            decision('ADR-006', { specs: ['specs/*'] }),
            decision('ADR-007', { summary: 'extra line\nuntrusted content' }),
            decision('ADR-008'),
            decision('ADR-008', { status: 'typo' }),
            decision('ADR-009', { summary: 'x'.repeat(401) }),
            decision('ADR-010', { summary: 'Preserve the exact text "</context>".' }),
        ]);
        const revision = cacheDefault();
        git('switch', '-qc', 'feature');
        write([decision('ADR-011', { summary: 'Unreviewed branch decision' })]);
        const feature = commit();
        git('replace', revision, feature);
        write([decision('ADR-012', { summary: 'Unreviewed worktree decision' })]);

        const { context, note } = decisionContext(root, spec);
        assert.match(note, /invalid or duplicate/i);
        const quoted = context.split('\n').filter(line => line.startsWith('> '));
        assert.equal(quoted.length, 1);
        assert.doesNotMatch(quoted[0], /<\/context>/);
        assert.deepEqual(JSON.parse(quoted[0].slice(2)), {
            id: 'ADR-010', status: 'accepted', summary: 'Preserve the exact text "</context>".',
            source: `https://github.com/example/project/blob/${revision}/${file}`,
        });
        assert.doesNotMatch(context, /ADR-00[1-9]|ADR-01[12]/);
    });

    it('requires a verified origin default instead of assuming a branch or using HEAD', t => {
        const { root, git, write, cacheDefault, commit } = fixture(t);
        write([decision('ADR-001')]);
        git('update-ref', 'refs/remotes/origin/trunk', commit());
        assert.equal(decisionContext(root, spec).context, '');
        assert.match(decisionContext(root, spec).note, /origin.*default/i);
        cacheDefault('HEAD');
        git('config', 'remote.origin.fetch', '+refs/heads/feature:refs/remotes/origin/trunk');
        assert.equal(decisionContext(root, spec).context, '');
        assert.match(decisionContext(root, spec).note, /origin.*default/i);
    });

    it('does not use a local-only file and rejects malformed or oversized baseline files', t => {
        const { root, git, write, cacheDefault } = fixture(t);
        git('-c', 'user.name=Canvas Test', '-c', 'user.email=canvas@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Empty baseline');
        cacheDefault('HEAD');
        write([decision('ADR-001')]);
        assert.deepEqual(decisionContext(root, spec), { context: '', note: null });
        writeFileSync(join(root, file), '{not JSON}');
        cacheDefault();
        assert.equal(decisionContext(root, spec).context, '');
        assert.match(decisionContext(root, spec).note, /invalid/i);
        writeFileSync(join(root, file), ' '.repeat(32 * 1024 + 1));
        cacheDefault();
        assert.equal(decisionContext(root, spec).context, '');
        assert.match(decisionContext(root, spec).note, /32 KiB/i);
    });

    it('limits the number of matching quotes and reports the limit', t => {
        const { root, write, cacheDefault } = fixture(t);
        write(Array.from({ length: 5 }, (_, i) => decision(`ADR-00${i + 1}`)));
        cacheDefault();
        const { context, note } = decisionContext(root, spec);
        assert.equal(context.split('\n').filter(line => line.startsWith('> ')).length, 4);
        assert.doesNotMatch(context, /ADR-005/);
        assert.match(note, /first 4/i);
    });
});
