import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { issueLabelStep } from './workflow-github.mjs';
import { validateGraph } from './workflow-model.mjs';
import { gateDecision, isolatedReviewFlow, selectedReviewInputs, validGateDecisions } from './workflow-review-run.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const inProgress = new Set(['review', 'write']);
const statuses = new Set([...inProgress, 'aborted', 'completed', 'uncertain']);
const hex = /^[a-f0-9]{64}$/;
const stepId = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const validVerdict = value => value === 'approve' || value === 'reject';
const maxGates = 6;

export function guidedReview(definition, key) {
    const ids = new Set(), targets = new Set(), writes = new Map();
    function inspect(sequence, parent, depth) {
        if (!Array.isArray(sequence) || depth > 4) return null;
        const steps = [];
        for (let index = 0; index < sequence.length; index++) {
            const step = sequence[index];
            if (typeof step?.id !== 'string' || !stepId.test(step.id) || ids.has(step.id) || ids.size >= 24) return null;
            ids.add(step.id);
            if (step.type === 'if') {
                const then = inspect(step.then, `${parent}:${step.id}`, depth + 1);
                const hasElse = Object.hasOwn(step, 'else');
                const otherwise = hasElse ? inspect(step.else, `${parent}:${step.id}`, depth + 1) : null;
                if (!then || hasElse && !otherwise) return null;
                steps.push({ ...step, then, ...(hasElse ? { else: otherwise } : {}) });
            } else if (step.type === 'gate') {
                steps.push(step);
                if (sequence[index + 1]?.type !== 'github') continue;
                const write = sequence[++index];
                if (typeof write.id !== 'string' || !stepId.test(write.id) || ids.has(write.id) || ids.size >= 24 ||
                    Object.hasOwn(write, 'continue_on_error')) return null;
                const change = issueLabelStep(write);
                if (!change) return null;
                const target = JSON.stringify([change.url.toLowerCase(), change.label.toLowerCase()]);
                if (targets.has(target)) return null;
                targets.add(target);
                ids.add(write.id);
                writes.set(step.id, { write: write.id, writeNode: `${parent}:${write.id}`, change });
            } else {
                return null;
            }
        }
        return steps;
    }
    const steps = inspect(definition?.steps, `workflow:${key}`, 0);
    if (!steps || !writes.size) return null;
    const flow = isolatedReviewFlow({ ...definition, steps }, key);
    if (!flow || flow.gates.length > maxGates || (!flow.branching && flow.gates.some(gate => gate.rejection !== 'abort'))) return null;
    return { ...flow, checkpoints: flow.gates.map(gate => ({ gate, ...writes.get(gate.id) })) };
}

export function canGuide(graph, node) {
    if (!node?.active || !node.guidedReview || node.health || node.hasProjectOverlay ||
        ['paused', 'running'].includes(node.lastRunStatus)) return false;
    const guarded = new Set(node.guidedReview.map(checkpoint => checkpoint.writeNode).filter(Boolean));
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
        if (!stat.isFile() || stat.size > 8 * 1024) throw invalid('The guided run checkpoint is not a readable, bounded file.');
        const raw = readFileSync(path, 'utf8');
        let record;
        try { record = JSON.parse(raw); }
        catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw invalid('The guided run checkpoint is not valid JSON.');
        }
        if (typeof record?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id) || !statuses.has(record.status) ||
            typeof record.definition !== 'string' || !hex.test(record.definition) || !Number.isFinite(Date.parse(record.updated)) ||
            !validGateDecisions(record.decisions, maxGates) ||
            !(record.evidence === null || typeof record.evidence === 'string' && hex.test(record.evidence)) ||
            (record.verdicts !== undefined && (!record.verdicts || typeof record.verdicts !== 'object' ||
                Array.isArray(record.verdicts) || Object.keys(record.verdicts).length > maxGates ||
                !Object.values(record.verdicts).every(validVerdict))) ||
            (record.cursor !== undefined && (!Number.isSafeInteger(record.cursor) || record.cursor < 0 || record.cursor >= maxGates))) {
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
                const startInputs = matched ? selectedReviewInputs(node.guidedFlow.startInputs, record.inputs ?? {}, true) : [];
                return { id: record.id, status: record.status, updated: record.updated, matched, step, startInputs, decisions: record.decisions ?? [] };
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
            const checkpoints = node.guidedReview;
            const flow = node.guidedFlow;
            if (!start && Object.hasOwn(request, 'inputs')) throw invalid('Start inputs cannot be changed after starting a guided run.');
            const startInputs = stop ? [] : selectedReviewInputs(flow?.startInputs ?? [],
                start && Object.hasOwn(request, 'inputs') ? request.inputs : (start ? {} : record?.inputs ?? {}), !start);
            const inputs = Object.fromEntries(startInputs.map(({ name, value }) => [name, value]));
            const first = start ? flow?.next(inputs).gate : null;
            if (start && flow && !first) throw invalid('The selected inputs reach no review gate. Choose a route with a review gate.');
            const pair = start ? checkpoints?.find(item => item.gate.id === first?.id) : checkpoints?.[cursor];
            if (start ? !pair || record && (inProgress.has(record.status) || record.status === 'uncertain') :
                !record || request.runId !== record.id ||
                (stop ? !inProgress.has(record.status) : !pair || record.definition !== node.guidedDefinitionStamp ||
                    record.status !== (gate ? 'review' : 'write') || (!gate && !pair.write) ||
                    ((flow.branching || request.gate !== undefined) && request.gate !== (gate ? pair.gate.id : pair.write)))) {
                throw invalid('The guided checkpoint is not eligible for this action. Reload the inspector.', 409);
            }
            const verdicts = start || stop ? {} : { ...(record.verdicts ?? Object.fromEntries(
                checkpoints.slice(0, cursor + (gate ? 0 : 1)).map(item => [item.gate.input, 'approve']))) };
            if (!start && !stop) {
                const { [pair.gate.input]: recordedVerdict, ...priorVerdicts } = verdicts;
                if ((gate ? recordedVerdict !== undefined : recordedVerdict !== 'approve') ||
                    flow.next({ ...inputs, ...priorVerdicts }).gate?.id !== pair.gate.id) {
                    throw invalid('The recorded verdicts do not match the guided checkpoint.', 409);
                }
            }
            if (gate) verdicts[pair.gate.input] = request.verdict;
            const after = stop ? { status: 'aborted' } : flow.next({ ...inputs, ...verdicts });
            const needsWrite = gate && request.verdict === 'approve' && pair.write;
            const status = needsWrite ? 'write' : after.status === 'paused' ? 'review' : after.status;
            const nextStep = needsWrite ? pair.write : after.gate?.id;
            const nextCursor = stop ? cursor : checkpoints.findIndex(item => item.gate.id === (needsWrite ? pair.gate.id : nextStep));
            return {
                stamp: raw === null ? null : hash(raw),
                evidence: record?.evidence ?? null,
                pair,
                startInputs,
                status,
                nextStep,
                async execute({ evidence = null, verify, write } = {}) {
                    mkdirSync(storage, { recursive: true });
                    const lock = `${path}.lock`;
                    try { mkdirSync(lock); }
                    catch (error) {
                        if (error.code === 'EEXIST') throw invalid('This guided run is being changed, or a previous host was interrupted. Do not retry an uncertain GitHub write.', 409);
                        throw error;
                    }
                    const next = start ? { id: randomUUID(), definition: node.guidedDefinitionStamp, evidence: null } : { ...record };
                    if (start && startInputs.length) next.inputs = inputs;
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
                        if (write) {
                            // Persist the attempt before sending it: a lost response must never grant a retry.
                            await save('uncertain');
                            verify?.();
                            if (!(await write())?.externalApplied) throw invalid('GitHub did not confirm the change. Inspect the issue; this run will not retry.', 502);
                        }
                        if (!stop) next.verdicts = verdicts;
                        if (gate) {
                            next.decisions = [...(record.decisions ?? []), gateDecision(pair.gate.id, request.verdict, new Date(now()).toISOString(), evidence)];
                            if (!validGateDecisions(next.decisions, maxGates)) throw invalid('The recorded decisions do not match this checkpoint.', 409);
                        }
                        if (nextCursor >= 0) next.cursor = nextCursor;
                        next.evidence = needsWrite ? evidence?.digest ?? null : null;
                        await save(status);
                        return { guidedOutcome: status, ...(write ? { externalApplied: true } : {}) };
                    } finally { rmdirSync(lock); }
                },
            };
        },
    };
}
