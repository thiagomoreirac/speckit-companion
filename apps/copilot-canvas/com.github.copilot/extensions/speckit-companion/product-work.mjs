import { randomUUID } from 'node:crypto';
import { boardRecord, boardRecords, fieldText, saveBoardRecord } from './board-records.mjs';

export const TRIAGE_STATES = ['new', 'reviewing', 'ready', 'parked'];
const targets = new Set(['business-plan', 'epic', 'spec']);

function triageArea(kind) {
    if (kind === 'bugs') return 'bug-triage';
    if (kind === 'ideas') return 'idea-triage';
    throw new Error('Choose Bugs or Ideas.');
}

export function listTriage(root, kind) {
    return boardRecords(root, triageArea(kind));
}

export function saveTriage(root, body, upstream) {
    const area = triageArea(body.kind);
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(body.slug ?? '') && !upstream) throw new Error('Use a lowercase folder name with hyphens.');
    const current = boardRecord(root, area, body.slug);
    if (!TRIAGE_STATES.includes(body.status)) throw new Error('Choose a triage status.');
    return saveBoardRecord(root, area, body.slug, {
        title: current?.title ?? upstream?.title ?? fieldText(body.title, 'a title', 160),
        description: current?.description ?? (upstream ? '' : fieldText(body.description, 'a description', 10000)),
        status: body.status,
        note: fieldText(body.note ?? '', 'a triage note', 3000, false),
        captured: current?.captured ?? !upstream,
        updatedAt: new Date().toISOString(),
    }, body.revision);
}

export function productUpdates(root) {
    return boardRecords(root, 'product-updates').filter(row =>
        targets.has(row.target?.kind) && typeof row.target?.id === 'string' && typeof row.idea?.id === 'string' &&
        typeof row.summary === 'string' && typeof row.createdAt === 'string')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function productUpdateDraft(target, idea, text) {
    if (!targets.has(target?.kind) || typeof target.id !== 'string' || !idea?.id) throw new Error('Choose an idea and an existing destination.');
    return { target: { kind: target.kind, id: target.id, title: target.title }, idea: { id: idea.id, title: idea.title },
        summary: fieldText(text, 'the proposed change', 6000) };
}

export function recordProductUpdate(root, draft) {
    return saveBoardRecord(root, 'product-updates', randomUUID(), { ...draft, createdAt: new Date().toISOString() }, null);
}
