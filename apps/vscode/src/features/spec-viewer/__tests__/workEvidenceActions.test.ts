import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { getProjectRoot } from '../../../core/projectRoot';
import type { WorkEvidenceResponse } from '../../../protocol/workEvidence';
import { artifactReviews, readEvidence, recordArtifactReview } from '../evidenceRecords';
import { handleWorkEvidence } from '../workEvidenceActions';
import { digest, listWork, writeWork, writeWorkLink } from '../workRecords';

jest.mock('../../../core/projectRoot', () => ({ getProjectRoot: jest.fn() }));

const spec = 'specs/001-pilot';
const artifact = `${spec}/design.html`;

describe('shared work and evidence in the VS Code host', () => {
    let root: string;
    let directory: string;
    let trusted: jest.SpyInstance;
    const host = { reply: jest.fn<Promise<boolean>, [WorkEvidenceResponse]>().mockResolvedValue(true), explain: jest.fn(async () => undefined) };
    const message = { type: 'workEvidence' as const, request: 1 };

    beforeEach(() => {
        jest.clearAllMocks();
        root = mkdtempSync(join(tmpdir(), 'companion-work-evidence-'));
        directory = join(root, ...spec.split('/'));
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'design.html'), '<main>Pilot</main>');
        (getProjectRoot as jest.Mock).mockReturnValue(root);
        trusted = jest.spyOn(vscode.workspace, 'isTrusted', 'get').mockReturnValue(true);
    });

    afterEach(() => {
        trusted.mockRestore();
        rmSync(root, { recursive: true, force: true });
    });

    it('reads links and exact artifact decisions from the same records as the canvas', async () => {
        const plan = writeWork(root, { kind: 'business-plan', title: 'Pilot', description: 'Run a pilot' });
        writeWorkLink(root, spec, plan);
        await handleWorkEvidence(directory, { ...message, action: 'list' }, host);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({
            action: 'list', spec, records: [plan], links: [expect.objectContaining({ source: { kind: plan.kind, id: plan.id, title: plan.title } })],
            files: [expect.objectContaining({ path: artifact, kind: 'prototype' })],
        }));
        await handleWorkEvidence(directory, { ...message, action: 'preview', path: artifact }, host);
        const preview = host.reply.mock.lastCall?.[0];
        if (preview?.action !== 'preview') throw new Error('Artifact preview not returned.');
        expect(preview.artifact.content).toBe('<main>Pilot</main>');
        expect(preview.artifact.wireflow).toBeNull();
        const review = recordArtifactReview(root, spec, { path: artifact, version: preview.artifact.revision, decision: 'approve', note: 'Ready' });
        await handleWorkEvidence(directory, { ...message, action: 'preview', path: artifact }, host);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'preview', reviews: [review] }));
    });

    it('returns an inert projection and the original revision for a Spec Kit wireflow', async () => {
        const path = `${spec}/preview/wireflow.html`;
        const content = '<html data-fidelity="mid"><main><section aria-labelledby="design-surface">'
            + '<h2 id="design-surface">Original heading</h2>'
            + '<img src="https://example.invalid/photo"><script>not evidence</script>'
            + '<a href="/next" onclick="run()">Continue</a><svg><text>not evidence</text></svg>'
            + '</section><section aria-labelledby="wireflow"><ol><li>Open the app</li></ol></section></main>';
        mkdirSync(join(directory, 'preview'));
        writeFileSync(join(directory, 'preview', 'wireflow.html'), content);
        await handleWorkEvidence(directory, { ...message, action: 'preview', path }, host);
        const preview = host.reply.mock.lastCall?.[0];
        if (preview?.action !== 'preview') throw new Error('Artifact preview not returned.');
        expect(preview.artifact).toMatchObject({ path, content, revision: digest(content) });
        expect(preview.artifact.wireflow).toEqual({
            fidelity: 'mid', truncated: false, sections: [
                { id: 'design-surface', children: [{ type: 'label', children: ['Continue'] }] },
                { id: 'wireflow', children: [{ type: 'sequence', children: [{ type: 'item', children: ['Open the app'] }] }] },
            ],
        });
    });

    it('blocks untrusted writes and rejects an artifact changed while confirming', async () => {
        trusted.mockReturnValue(false);
        await handleWorkEvidence(directory, { ...message, action: 'create', kind: 'epic', title: 'Pilot', description: 'Run a pilot' }, host);
        expect(listWork(root).records).toEqual([]);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'error', message: expect.stringMatching(/Trust this workspace/) }));
        trusted.mockReturnValue(true);
        await handleWorkEvidence(directory, { ...message, action: 'preview', path: artifact }, host);
        const preview = host.reply.mock.lastCall?.[0];
        if (preview?.action !== 'preview') throw new Error('Artifact preview not returned.');
        (vscode.window.showWarningMessage as jest.Mock).mockImplementationOnce(async () => {
            writeFileSync(join(directory, 'design.html'), '<main>Changed</main>');
            return 'Approve artifact';
        });
        await handleWorkEvidence(directory, { ...message, action: 'review', path: artifact, revision: preview.artifact.revision, note: '', decision: 'approve' }, host);
        expect(artifactReviews(root, spec)).toEqual([]);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'error', message: expect.stringMatching(/artifact changed/i) }));
    });

    it('compares an opted-in reviewed snapshot to the current revision without interpreting prototype HTML', async () => {
        await handleWorkEvidence(directory, { ...message, action: 'preview', path: artifact }, host);
        const preview = host.reply.mock.lastCall?.[0];
        if (preview?.action !== 'preview') throw new Error('Artifact preview not returned.');
        const { revision } = preview.artifact;
        const input = { path: artifact, version: revision, decision: 'approve' as const, note: '' };
        const compare = { ...message, action: 'compare' as const, path: artifact, reviewed: revision };
        recordArtifactReview(root, spec, input);
        await handleWorkEvidence(directory, compare, host);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'error', message: expect.stringMatching(/no saved copy/i) }));
        recordArtifactReview(root, spec, { ...input, keepSnapshot: true });
        writeFileSync(join(directory, 'design.html'), '<main>Revised</main>');
        await handleWorkEvidence(directory, compare, host);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'compare', comparison: {
            path: artifact, mime: null, reviewed: { revision, content: '<main>Pilot</main>' },
            current: { revision: expect.not.stringMatching(revision), content: '<main>Revised</main>' },
        } }));
        await handleWorkEvidence(directory, { ...compare, reviewed: '../design.html' }, host);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'error' }));
    });

    it('rejects altered or missing snapshots without changing recorded decisions', async () => {
        const { revision } = readEvidence(root, spec, artifact);
        const review = recordArtifactReview(root, spec, { path: artifact, version: revision, decision: 'approve', note: '', keepSnapshot: true });
        const compare = { ...message, action: 'compare' as const, path: artifact, reviewed: revision };
        const saved = join(root, '.speckit-companion', 'artifact-reviews', digest(spec), 'snapshots', `${revision}.artifact`);
        writeFileSync(saved, '<main>Different</main>');
        await handleWorkEvidence(directory, compare, host);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'error', message: expect.stringMatching(/does not match/) }));
        rmSync(saved);
        await handleWorkEvidence(directory, compare, host);
        expect(host.reply).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'error', message: expect.stringMatching(/missing/) }));
        expect(artifactReviews(root, spec)).toEqual([review]);
    });
});
