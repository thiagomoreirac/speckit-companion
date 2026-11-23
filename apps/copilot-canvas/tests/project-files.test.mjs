import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectFiles } from '../com.github.copilot/extensions/speckit-companion/project-files.mjs';

describe('project files', () => {
    it('lists project guidance and saves without overwriting an external edit', () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-project-files-'));
        const instructions = join(root, '.github', 'instructions');
        mkdirSync(instructions, { recursive: true });
        const file = join(instructions, 'style.instructions.md');
        writeFileSync(file, 'original');
        writeFileSync(join(root, 'secret.txt'), 'not listed');
        const host = createProjectFiles();
        assert.deepEqual(host.list(root).find(group => group.label === 'Instructions').files, ['.github/instructions/style.instructions.md']);
        assert.throws(() => host.open(root, 'secret.txt'), /no longer available/);
        const opened = host.open(root, '.github/instructions/style.instructions.md');
        host.save(root, opened.token, 'saved');
        assert.equal(readFileSync(file, 'utf8'), 'saved');
        writeFileSync(file, 'external');
        assert.throws(() => host.save(root, opened.token, 'draft'), /changed since/);
        assert.equal(readFileSync(file, 'utf8'), 'external');
        assert.throws(() => host.save(tmpdir(), opened.token, 'draft'), /Reopen/);
    });

    it('does not follow directories outside the project', t => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-project-files-'));
        const outside = mkdtempSync(join(tmpdir(), 'canvas-project-outside-'));
        try {
            writeFileSync(join(outside, 'outside.instructions.md'), 'outside');
            mkdirSync(join(root, '.github'), { recursive: true });
            try {
                symlinkSync(outside, join(root, '.github', 'instructions'), process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Creating directory links requires Windows privileges.');
                throw error;
            }
            const host = createProjectFiles();
            assert.equal(host.list(root).some(group => group.label === 'Instructions'), false);
            assert.throws(() => host.open(root, '.github/instructions/outside.instructions.md'), /no longer available/);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it('preserves file permissions when saving', { skip: process.platform === 'win32' }, () => {
        const root = mkdtempSync(join(tmpdir(), 'canvas-project-files-'));
        try {
            const file = join(root, 'AGENTS.md');
            writeFileSync(file, 'original');
            chmodSync(file, 0o775);
            const host = createProjectFiles();
            const opened = host.open(root, 'AGENTS.md');
            host.save(root, opened.token, 'edited');
            assert.equal(statSync(file).mode & 0o777, 0o775);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
