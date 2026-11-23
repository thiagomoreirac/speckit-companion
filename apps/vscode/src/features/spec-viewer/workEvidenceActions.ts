import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { getProjectRoot } from '../../core/projectRoot';
import { entityDiagram } from '../../protocol/entityDiagram';
import type { WorkEvidenceRequest, WorkEvidenceResponse } from '../../protocol/workEvidence';
import { artifactReviews, codeRevision, compareEvidence, evidenceInventory, impactPrompt, readEvidence, recordArtifactReview } from './evidenceRecords';
import { wireflowPreview } from './wireflowPreview';
import { listWork, projectPath, writeWork, writeWorkLink } from './workRecords';

export async function handleWorkEvidence(
    directory: string,
    message: WorkEvidenceRequest,
    host: { reply: (response: WorkEvidenceResponse) => Thenable<boolean>; explain: (prompt: string) => Promise<unknown> },
): Promise<void> {
    const base = { type: 'workEvidenceResult' as const, request: message.request };
    try {
        const root = getProjectRoot();
        if (!root) throw new Error('Open the repository that owns this spec.');
        const spec = relative(root, directory).split(sep).join('/');
        if (!projectPath(root, spec, 'directory')) throw new Error('The spec is not in the selected repository.');
        if (message.action === 'list') {
            const { records, links } = listWork(root);
            await host.reply({ ...base, action: 'list', spec, records, links: links.filter(link => link.spec === spec), files: evidenceInventory(root, spec) });
            return;
        }
        if (message.action === 'preview') {
            const { content, ...artifact } = readEvidence(root, spec, message.path);
            const text = content.toString(artifact.mime ? 'base64' : 'utf8');
            await host.reply({ ...base, action: 'preview', artifact: { ...artifact, content: text, diagram: entityDiagram(artifact.kind, text),
                wireflow: artifact.kind === 'prototype' ? wireflowPreview(artifact.path, text) : null },
                reviews: artifactReviews(root, spec).filter(review => review.path === artifact.path) });
            return;
        }
        if (message.action === 'compare') {
            await host.reply({ ...base, action: 'compare', comparison: compareEvidence(root, spec, message.path, message.reviewed) });
            return;
        }
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing work records or asking for an explanation.');
        switch (message.action) {
            case 'create': {
                const work = writeWork(root, message);
                try {
                    writeWorkLink(root, spec, work);
                } catch (error) {
                    throw new Error(`Saved "${work.title}", but could not link it. Refresh the list to retry the link.`, { cause: error });
                }
                break;
            }
            case 'link': {
                const record = listWork(root).records.find(work => work.id === message.id);
                if (!record) throw new Error('That plan or epic is no longer available.');
                writeWorkLink(root, spec, record);
                break;
            }
            case 'impact': {
                const artifact = readEvidence(root, spec, message.path);
                if (artifact.revision !== message.revision) throw new Error('This artifact changed. Reopen it before asking for an explanation.');
                await host.explain(impactPrompt(spec, artifact, message.question, codeRevision(root)));
                break;
            }
            case 'review': {
                const artifact = readEvidence(root, spec, message.path);
                if (artifact.revision !== message.revision) throw new Error('This artifact changed. Reopen it before recording a review.');
                if (message.decision !== 'approve' && message.decision !== 'request-changes') throw new Error('Choose a review decision.');
                const label = message.decision === 'approve' ? 'Approve artifact' : 'Request changes';
                const response = await vscode.window.showWarningMessage(
                    `${label}: ${artifact.path} (${artifact.revision.slice(0, 12)})`,
                    { modal: true, detail: message.keepSnapshot === true
                        ? 'This records a local decision and retains a copy of the artifact in this repository. It does not advance the workflow.'
                        : 'This records a local decision and does not advance the workflow.' },
                    label,
                );
                if (response !== label) {
                    await host.reply({ ...base, action: 'error', message: 'No decision recorded.' });
                    return;
                }
                if (getProjectRoot() !== root) throw new Error('The selected repository changed. Reopen the spec.');
                recordArtifactReview(root, spec, { ...message, version: message.revision });
                break;
            }
            default:
                throw new Error('Unknown work or evidence action.');
        }
        await host.reply({ ...base, action: message.action });
    } catch (error) {
        await host.reply({ ...base, action: 'error', message: error instanceof Error ? error.message : String(error) });
    }
}
