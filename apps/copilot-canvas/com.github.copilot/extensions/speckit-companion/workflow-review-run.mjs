import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysWithin = (value, keys) => isMapping(value) && Object.keys(value).every(key => keys.includes(key));
const workflowId = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const reserved = new Set(['overlays', 'runs', 'steps', 'functions']);
const runId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const inputId = /^[a-z][a-z0-9_]{0,79}$/;
const literal = (text, max) => typeof text === 'string' && Boolean(text.trim()) && text.length <= max && !/{{|\0/.test(text);
const digest = value => createHash('sha256').update(value).digest('hex');
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const running = new Set();

export const isReviewArtifactPath = path => literal(path, 420) &&
    path.split('/').every(part => Boolean(part) && !part.startsWith('.') && !/[\\:\x00-\x1f\x7f]/.test(part)) &&
    /\.md$/i.test(path);

export function reviewGates(config, key) {
    if (!workflowId.test(key) || reserved.has(key) || !keysWithin(config, ['schema_version', 'workflow', 'steps', 'inputs', 'requires']) ||
        (Object.hasOwn(config, 'schema_version') && config.schema_version !== '1.0') ||
        !keysWithin(config.workflow, ['id', 'name', 'version', 'description', 'author']) ||
        config.workflow.id !== key || !literal(config.workflow.name, 120) ||
        !Object.values(config.workflow).every(value => typeof value === 'string') ||
        (Object.hasOwn(config, 'requires') && (!keysWithin(config.requires, ['speckit_version']) ||
            (Object.hasOwn(config.requires, 'speckit_version') && typeof config.requires.speckit_version !== 'string'))) ||
        !isMapping(config.inputs) || !Array.isArray(config.steps) || config.steps.length < 1 || config.steps.length > 12) return null;
    const seenSteps = new Set(), seenInputs = new Set();
    const gates = [];
    for (const step of config.steps) {
        if (!keysWithin(step, ['id', 'type', 'message', 'options', 'on_reject', 'verdict_input', 'show_file']) ||
            typeof step.id !== 'string' || !workflowId.test(step.id) || seenSteps.has(step.id) ||
            step.type !== 'gate' || !literal(step.message, 2400) ||
            (Object.hasOwn(step, 'show_file') && !isReviewArtifactPath(step.show_file)) ||
            typeof step.verdict_input !== 'string' || !inputId.test(step.verdict_input) || seenInputs.has(step.verdict_input) ||
            !Object.hasOwn(config.inputs, step.verdict_input)) return null;
        const input = config.inputs[step.verdict_input];
        const options = step.options ?? ['approve', 'reject'];
        const rejection = step.on_reject ?? 'abort';
        if (!keysWithin(input, ['type', 'required', 'default', 'description']) || input.type !== 'string' ||
            (input.required !== undefined && input.required !== false) || (input.default !== undefined && input.default !== '') ||
            !Array.isArray(options) || options.length !== 2 || !options.includes('approve') || !options.includes('reject') ||
            !['abort', 'skip'].includes(rejection) || (Object.hasOwn(step, 'options') && step.options == null) ||
            (Object.hasOwn(step, 'on_reject') && step.on_reject == null)) return null;
        seenSteps.add(step.id);
        seenInputs.add(step.verdict_input);
        gates.push({ id: step.id, message: step.message, input: step.verdict_input, rejection,
            ...(step.show_file ? { artifact: step.show_file } : {}) });
    }
    return Object.keys(config.inputs).length === seenInputs.size ? gates : null;
}

export const REVIEW_OVERLAY_ID = 'canvas-review-gates';
export const reviewOverlayPath = key => `.specify/workflows/overlays/${key}/${REVIEW_OVERLAY_ID}.yml`;

export function composeReviewOverlay(base, key, overlay) {
    if (!reviewGates(base, key) || !keysWithin(overlay, ['id', 'extends', 'edits', 'enabled']) ||
        overlay.id !== REVIEW_OVERLAY_ID || overlay.extends !== key || overlay.enabled !== true ||
        !Array.isArray(overlay.edits) || !overlay.edits.length || overlay.edits.length > base.steps.length) return null;
    const replacements = new Map();
    for (const edit of overlay.edits) {
        if (!keysWithin(edit, ['replace', 'step'])) return null;
        const step = base.steps.find(item => item.id === edit.replace);
        if (!step || edit.step?.id !== step.id || edit.step?.verdict_input !== step.verdict_input ||
            replacements.has(step.id)) return null;
        replacements.set(step.id, edit.step);
    }
    const result = { ...base, steps: base.steps.map(step => replacements.get(step.id) ?? step) };
    return reviewGates(result, key) ? result : null;
}

function readText(path, max = 256 * 1024) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (!stat.isFile() || stat.size > max) throw invalid('The isolated workflow checkpoint is not a readable, bounded file.');
    return readFileSync(path, 'utf8');
}

export function createReviewRuns(storage) {
    const location = (root, key) => join(storage, `${digest(JSON.stringify([root, key]))}.json`);
    const read = path => {
        const raw = readText(path);
        if (raw == null) return { raw, record: null };
        let record;
        try { record = JSON.parse(raw); }
        catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw invalid('The isolated workflow checkpoint is not valid JSON.');
        }
        if (typeof record?.state?.run_id !== 'string' || !runId.test(record.state.run_id) ||
            typeof record.definitionStamp !== 'string' || !Number.isFinite(Date.parse(record.state.updated_at))) {
            throw invalid('The isolated workflow checkpoint has an invalid record shape.');
        }
        return { raw, record };
    };
    return {
        observe(root, node) {
            if (!storage || !node.reviewGates) return null;
            let record;
            try { ({ record } = read(location(root, node.key))); }
            catch (error) { return { error: error.status ? error.message : 'The isolated workflow checkpoint could not be read.' }; }
            if (!record) return null;
            const { run_id: id, current_step_id: step, status, updated_at: updated } = record.state;
            const gate = node.reviewGates.find(gate => gate.id === step);
            return { id, status, step, updated, resumable: status === 'paused' && Boolean(gate) && record.definitionStamp === node.reviewDefinitionStamp };
        },
        async prepare(root, node, request, config, cli, probe) {
            if (!storage) throw invalid('The canvas host has no session storage for isolated workflow runs.');
            const gates = node?.reviewGates;
            if (node?.kind !== 'Workflows' || !gates || !node.active || node.healthStatus === 'blocked') {
                throw invalid('An isolated run requires an enabled workflow containing only literal review gates with distinct optional verdict inputs.');
            }
            if (node.hasProjectOverlay && !node.reviewOverlay) throw invalid('An enabled project overlay changes this workflow. The isolated adapter runs only literal review overrides.');
            const path = location(root, node.key);
            const { raw, record } = read(path);
            const resume = request.operation === 'workflow-review-resume';
            const prior = record?.state;
            if (!resume && prior?.status === 'paused') throw invalid('This session already has a paused review run. Resolve its current gate before starting again.');
            const gate = resume ? gates.find(item => item.id === prior?.current_step_id) : gates[0];
            if (resume && (prior?.status !== 'paused' || !gate || request.gate !== gate.id || request.runId !== prior.run_id || prior.workflow_id !== node.key ||
                prior.installed_workflow_id !== node.key || prior.installed_registry_root != null ||
                record.definitionStamp !== node.reviewDefinitionStamp || !['approve', 'reject'].includes(request.verdict))) {
                throw invalid('The paused run, its definition, or the selected verdict changed. Reload the inspector.');
            }
            const verb = resume ? 'resume' : 'run';
            const args = ['workflow', verb, resume ? prior.run_id : node.key, '--json'];
            if (resume) args.push('--input', `${gate.input}=${request.verdict}`);
            const abort = resume && request.verdict === 'reject' && gate.rejection === 'abort';
            const next = resume ? gates[gates.indexOf(gate) + 1] : gate;
            const expected = abort ? 'aborted' : next ? 'paused' : 'completed';
            if (probe) {
                const help = await cli(root, ['workflow', verb, '--help'], true);
                if (!help.includes('--json') || (resume && !help.includes('--input'))) {
                    throw invalid('Upgrade Spec Kit to a version with JSON workflow outcomes and noninteractive gate inputs.');
                }
            }
            return {
                stamp: raw == null ? null : digest(raw),
                invocation: ['specify', ...args].join(' '),
                review: { gate: gate.id, message: gate.message, verdict: resume ? request.verdict : null, rejection: gate.rejection,
                    runId: prior?.run_id ?? null, artifactPath: gate.artifact ?? null },
                async execute(verifyEvidence) {
                    if (running.has(path) || read(path).raw !== raw) throw invalid('The review checkpoint changed. Open a new preview.', 409);
                    running.add(path);
                    const write = (target, text) => {
                        mkdirSync(dirname(target), { recursive: true });
                        writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
                    };
                    const runStaged = async () => {
                        const staged = mkdtempSync(join(tmpdir(), 'canvas-review-'));
                        try {
                            const base = join(staged, '.specify', 'workflows');
                            const definition = JSON.stringify(config);
                            write(join(base, 'workflow-registry.json'), JSON.stringify({ workflows: { [node.key]: { enabled: true } } }));
                            write(join(base, node.key, 'workflow.yml'), definition);
                            if (resume) {
                                const checkpoint = join(base, 'runs', prior.run_id);
                                write(join(checkpoint, 'workflow.yml'), definition);
                                write(join(checkpoint, 'state.json'), JSON.stringify({ ...prior, workflow_dir: join(base, node.key) }));
                            }
                            const result = JSON.parse(await cli(staged, args, false, { workflowOutcome: true }));
                            if (typeof result?.run_id !== 'string' || !runId.test(result.run_id) ||
                                result.workflow_id !== node.key || (resume && result.run_id !== prior.run_id)) {
                                throw invalid('Spec Kit did not return the expected isolated workflow run.');
                            }
                            const state = JSON.parse(readText(join(base, 'runs', result.run_id, 'state.json')) ?? 'null');
                            if (state?.workflow_id !== node.key || state.installed_workflow_id !== node.key || state.installed_registry_root != null ||
                                state.run_id !== result.run_id || state.status !== result.status || !Number.isFinite(Date.parse(state.updated_at)) ||
                                state.status !== expected ||
                                (expected === 'paused' && state.current_step_id !== next.id)) {
                                throw invalid('Spec Kit did not save a compatible isolated workflow checkpoint.');
                            }
                            return state;
                        } finally {
                            rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                        }
                    };
                    try {
                        let state;
                        for (let attempt = 0; ; attempt++) {
                            if (read(path).raw !== raw) throw invalid('The review checkpoint changed. Open a new preview.', 409);
                            try { state = await runStaged(); break; }
                            catch (error) {
                                // Only an isolated, gate-only run can retry from the original checkpoint without repeating effects.
                                if (error.code !== 'review-checkpoint-busy' || attempt >= 2) throw error;
                                await delay(150 * (attempt + 1));
                            }
                        }
                        if (read(path).raw !== raw) throw invalid('The review checkpoint changed during execution. Reload the inspector.', 409);
                        verifyEvidence?.();
                        const temp = `${path}.${randomUUID()}.tmp`;
                        try {
                            write(temp, JSON.stringify({ definitionStamp: node.reviewDefinitionStamp, state: { ...state, workflow_dir: null } }));
                            renameSync(temp, path);
                        } finally { rmSync(temp, { force: true }); }
                        return { workflowOutcome: { id: state.run_id, status: state.status, step: state.current_step_id } };
                    } finally {
                        running.delete(path);
                    }
                },
            };
        },
    };
}
