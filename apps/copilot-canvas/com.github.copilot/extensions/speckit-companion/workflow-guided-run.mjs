import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { issueLabelStep } from './workflow-github.mjs';
import { validateGraph } from './workflow-model.mjs';
import { reviewGates } from './workflow-review-run.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const inProgress = new Set(['review', 'write']);
const statuses = new Set([...inProgress, 'aborted', 'completed', 'uncertain']);
const hex = /^[a-f0-9]{64}$/;
const maxPairs = 6;

export function guidedReview(definition, key) {
    const steps = definition?.steps;
    if (!Array.isArray(steps) || !steps.length || steps.length % 2 || steps.length > 2 * maxPairs) return null;
    const gates = reviewGates({ ...definition, steps: steps.filter((_, index) => index % 2 === 0) }, key);
    if (!gates || gates.some(gate => gate.rejection !== 'abort')) return null;
    const ids = new Set(gates.map(gate => gate.id)), targets = new Set(), pairs = [];
    for (const [index, gate] of gates.entries()) {
        const write = steps[index * 2 + 1];
        if (!write || typeof write.id !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(write.id) ||
            write.continue_on_error !== undefined || ids.has(write.id)) return null;
        const change = issueLabelStep(write);
        if (!change) return null;
        const target = JSON.stringify([change.url.toLowerCase(), change.label.toLowerCase()]);
        if (targets.has(target)) return null;
        targets.add(target);
        ids.add(write.id);
        pairs.push({ gate, write: write.id, change });
    }
    return pairs;
}

export function canGuide(graph, node) {
    if (!node?.active || !node.guidedReview || node.health || node.hasProjectOverlay ||
        ['paused', 'running'].includes(node.lastRunStatus)) return false;
    const guarded = new Set(node.guidedReview.map(pair => `${node.id}:${pair.write}`));
    const findings = graph.findings.filter(item => item.code !== 'blocked-prerequisite' &&
        !(item.code === 'unapproved-external-step' && item.nodeIds[0] === node.id && guarded.has(item.nodeIds[1])));
    return !validateGraph(graph.nodes, graph.edges, findings, graph.decisions).some(item => item.severity === 'blocked' &&
        item.nodeIds.some(id => id === node.id || id.startsWith(`${node.id}:`)));
}

export function createGuidedRuns(storage, now) {
    const location = (root, key) => join(storage, `guided-${hash(JSON.stringify([root, key]))}.json`);
    function read(path) {
        let stat;
        try { stat = lstatSync(path); }
        catch (error) {
            if (error.code === 'ENOENT') return { raw: null, record: null };
            throw error;
        }
        if (!stat.isFile() || stat.size > 4096) throw invalid('The guided run checkpoint is not a readable, bounded file.');
        const raw = readFileSync(path, 'utf8');
        let record;
        try { record = JSON.parse(raw); }
        catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw invalid('The guided run checkpoint is not valid JSON.');
        }
        if (typeof record?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id) || !statuses.has(record.status) ||
            typeof record.definition !== 'string' || !hex.test(record.definition) || !Number.isFinite(Date.parse(record.updated)) ||
            !(record.evidence === null || typeof record.evidence === 'string' && hex.test(record.evidence)) ||
            (record.cursor !== undefined && (!Number.isSafeInteger(record.cursor) || record.cursor < 0 || record.cursor >= maxPairs))) {
            throw invalid('The guided run checkpoint has an invalid record shape.');
        }
        return { raw, record };
    }

    return {
        observe(root, node) {
            if (!storage) return null;
            try {
                const { record } = read(location(root, node.key));
                if (!record) return null;
                const pair = node.guidedReview?.[record.cursor ?? 0];
                const matched = Boolean(pair && record.definition === node.guidedDefinitionStamp);
                const step = matched && inProgress.has(record.status) ? (record.status === 'review' ? pair.gate.id : pair.write) : null;
                return { id: record.id, status: record.status, updated: record.updated, matched, step };
            } catch (error) {
                return { error: error.status ? error.message : 'The guided run checkpoint could not be read.' };
            }
        },
        prepare(root, node, request) {
            if (!storage) throw invalid('The canvas host has no session storage for guided workflow runs.');
            const path = location(root, node.key);
            const { raw, record } = read(path);
            const start = request.operation === 'guided-start';
            const stop = request.operation === 'guided-stop';
            const gate = request.operation === 'guided-verdict';
            const cursor = start ? 0 : (record?.cursor ?? 0);
            const pair = node.guidedReview?.[cursor];
            if (start ? record && (inProgress.has(record.status) || record.status === 'uncertain') :
                !record || request.runId !== record.id ||
                (stop ? !inProgress.has(record.status) : !pair || record.definition !== node.guidedDefinitionStamp ||
                    record.status !== (gate ? 'review' : 'write'))) {
                throw invalid('The guided checkpoint is not eligible for this action. Reload the inspector.', 409);
            }
            return {
                stamp: raw === null ? null : hash(raw),
                evidence: record?.evidence ?? null,
                pair,
                hasNext: Boolean(node.guidedReview?.[cursor + 1]),
                async execute({ status, evidence = null, verify, write } = {}) {
                    mkdirSync(storage, { recursive: true });
                    const lock = `${path}.lock`;
                    try { mkdirSync(lock); }
                    catch (error) {
                        if (error.code === 'EEXIST') throw invalid('This guided run is being changed, or a previous host was interrupted. Do not retry an uncertain GitHub write.', 409);
                        throw error;
                    }
                    const next = start ? { id: randomUUID(), definition: node.guidedDefinitionStamp, evidence: null, cursor } : { ...record };
                    const save = async status => {
                        const temp = `${path}.${randomUUID()}.tmp`;
                        try {
                            writeFileSync(temp, JSON.stringify({ ...next, status, updated: new Date(now()).toISOString() }), { flag: 'wx', mode: 0o600, flush: true });
                            for (let attempt = 0; ; attempt++) {
                                try { renameSync(temp, path); break; }
                                catch (error) {
                                    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
                                    await delay(25 * 2 ** attempt);
                                }
                            }
                        } finally { rmSync(temp, { force: true }); }
                    };
                    try {
                        if (read(path).raw !== raw) throw invalid('The guided run changed. Open a new preview.', 409);
                        verify?.();
                        if (gate) next.evidence = evidence;
                        if (write) {
                            // Persist the attempt before sending it: a lost response must never grant a retry.
                            await save('uncertain');
                            verify?.();
                            if (!(await write())?.externalApplied) throw invalid('GitHub did not confirm the change. Inspect the issue; this run will not retry.', 502);
                            if (status === 'review') {
                                next.cursor = cursor + 1;
                                next.evidence = null;
                            }
                        }
                        await save(status);
                        return { guidedOutcome: status, ...(write ? { externalApplied: true } : {}) };
                    } finally { rmdirSync(lock); }
                },
            };
        },
    };
}
