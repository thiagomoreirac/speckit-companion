import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { dump, load, JSON_SCHEMA } from './vendor/workflow-yaml.mjs';
import { AUTOMATIC_HOOKS, graphDiff, scopeProblem } from './workflow-model.mjs';
import { BUNDLE_RECORDS, CATALOG_TYPES, CHARTER_CONFIG, CHARTER_STATE, CONSTITUTION, HOOK_PATH, NATIVE_HOOK_PATH, POLICY_PATH, TEMPLATE_OVERRIDES, catalogKey, catalogPath, hookPriority, object, readWorkflow, safeId, workflowOverlayPaths, workspaceEntry } from './workflow-inventory.mjs';
import { createGitHubChanges } from './workflow-github.mjs';
import { testHookFixture } from './workflow-hook-fixture.mjs';
import { composeReviewOverlay, createReviewRuns, isReviewArtifactPath, REVIEW_OVERLAY_ID, reviewOverlayPath } from './workflow-review-run.mjs';
import { canGuide, createGuidedRuns } from './workflow-guided-run.mjs';
import { planEmbeddedHookEdit } from './workflow-embedded-hooks.mjs';
import { fetchPinnedWorkflow, parsePinnedWorkflow, reviewedWorkflowSources, sourceFile } from './workflow-remote.mjs';
import { ROADMAP_CONFIG, ROADMAP_PATH, changeRoadmapStatus } from './workflow-roadmap.mjs';
import { addWireframeSignoff, requirePassingWireframeReport, standardWireframeName } from './workflow-wireframe.mjs';
import { stageAdrAcceptance } from './workflow-adr.mjs';
import { PRODUCT_CONFIG, planProductApply, planProductArchive } from './workflow-product.mjs';

const PACKAGES = {
    Extensions: ['extension', '.specify/extensions', '.registry', 'extensions', 'extension.yml'],
    Presets: ['preset', '.specify/presets', '.registry', 'presets', 'preset.yml'],
    Workflows: ['workflow', '.specify/workflows', 'workflow-registry.json', 'workflows', 'workflow.yml'],
    'Workflow steps': ['step', '.specify/workflows/steps', 'step-registry.json', 'steps', 'step.yml'],
};
const BUNDLE_TYPES = { extensions: 'extension', presets: 'preset', workflows: 'workflow', steps: 'step-package' };
const configSize = 128 * 1024;
const markdownSize = 24 * 1024;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const rows = value => Array.isArray(value) ? value : value ? [value] : [];
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const yaml = value => dump(value, { noRefs: true, lineWidth: -1, schema: JSON_SCHEMA });
const file = (root, path) => {
    const entry = workspaceEntry(root, path);
    if (!entry?.stat.isFile()) return null;
    if (entry.stat.size > configSize) throw invalid(`File is too large to edit or preview: ${path}.`);
    return readFileSync(entry.target, 'utf8');
};
const str = (value, label, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw invalid(`Enter ${label} (${max} characters or fewer).`);
    return value.trim();
};
function readReviewedMarkdown(root, path, format = 'Markdown', limit = markdownSize) {
    const entry = workspaceEntry(root, path);
    const requirement = `${path} must contain readable ${format} no larger than ${limit / 1024} KiB.`;
    if (!entry?.stat.isFile() || entry.stat.size > limit) throw invalid(requirement);
    const bytes = readFileSync(entry.target);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw invalid(`${path} is not valid UTF-8.`);
    }
    if (bytes.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw invalid(requirement);
    return { path, text, digest: createHash('sha256').update(bytes).digest('hex') };
}

function readGateArtifact(root, graph, path) {
    if (!isReviewArtifactPath(path) || !graph.nodes.some(node => node.id.startsWith('feature:') && node.artifacts.includes(path))) {
        throw invalid('Choose a Markdown document from an inventoried feature.');
    }
    const artifact = readReviewedMarkdown(root, path);
    if (!artifact.text.trim()) throw invalid(`Review evidence ${path} cannot be empty.`);
    return artifact;
}

function requireWorkflowRegistrationWithoutPlugins(root) {
    for (const [directory, manifest] of [['steps', 'step.yml'], ['functions', 'function.yml']]) {
        const path = `.specify/workflows/${directory}`;
        const entry = workspaceEntry(root, path);
        if (!entry && !lstatSync(join(root, path), { throwIfNoEntry: false })) continue;
        if (!entry?.stat.isDirectory()) throw invalid(`The canvas cannot inspect custom workflow ${directory}.`);
        const plugins = readdirSync(entry.target, { withFileTypes: true }).some(item => {
            if (item.isSymbolicLink()) return true;
            if (!item.isDirectory() || (directory === 'functions' && item.name === '.cache')) return false;
            return [manifest, '__init__.py'].every(name =>
                lstatSync(join(entry.target, item.name, name), { throwIfNoEntry: false }) != null);
        });
        if (plugins) throw invalid(`Spec Kit can import local ${directory} before validating a workflow. Canvas registration cannot preview those effects; use a project without custom workflow code.`);
    }
}

function catalogUrl(value) {
    let url;
    try { url = new URL(str(value, 'an HTTPS catalog URL', 1000)); }
    catch { throw invalid('Enter a valid HTTPS catalog URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw invalid('Use a plain HTTPS catalog URL without credentials, query parameters, or a fragment.');
    }
    return url.href;
}

function packageDigest(root, path, capture) {
    let remaining = 20 * 1024 * 1024, count = 0;
    const digest = createHash('sha256');
    function visit(relative) {
        const entry = workspaceEntry(root, relative);
        if (!entry || ++count > 1500) throw invalid('Source must be a self-contained, inspectable package without symbolic links.');
        digest.update(relative).update('\0');
        if (entry.stat.isDirectory()) {
            for (const name of readdirSync(entry.target).sort()) visit(`${relative}/${name}`);
        } else if (entry.stat.isFile() && (remaining -= entry.stat.size) >= 0) {
            const bytes = readFileSync(entry.target);
            digest.update(String(bytes.length)).update('\0').update(bytes);
            capture?.set(relative, bytes);
        } else {
            throw invalid('Source package exceeds the inspection size limit or contains unsupported files.');
        }
    }
    visit(path);
    return digest.digest('hex');
}

function writeTemporaryProject(root, inputs) {
    mkdirSync(join(root, '.specify'));
    for (const [path, contents] of inputs) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents, { flag: 'wx' });
    }
}

async function validateReviewOverlay(cli, workflow, source, overlay, text) {
    const staged = mkdtempSync(join(tmpdir(), 'canvas-gate-overlay-'));
    try {
        writeTemporaryProject(staged, new Map([[workflow.source, source], [overlay, text]]));
        const attribution = await cli(staged, ['workflow', 'resolve', workflow.key]);
        if (!attribution.includes(REVIEW_OVERLAY_ID)) throw invalid('Spec Kit could not attribute the gates to this overlay. Inspect the workflow or upgrade Spec Kit.');
    } finally { rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

function writeConfig(root, path, text, base, { exclusiveCreate = false } = {}) {
    const parts = path.split('/');
    const basename = parts.pop();
    const relative = parts.join('/');
    if (relative === '.speckit-companion' && !lstatSync(join(root, relative), { throwIfNoEntry: false })) mkdirSync(join(root, relative), { recursive: false });
    if (relative === TEMPLATE_OVERRIDES && workspaceEntry(root, '.specify/templates')?.stat.isDirectory() &&
        !lstatSync(join(root, relative), { throwIfNoEntry: false })) mkdirSync(join(root, relative), { recursive: false });
    if (text != null && /^\.specify\/workflows\/overlays\/[a-z0-9][a-z0-9-]*$/.test(relative) &&
        path === reviewOverlayPath(parts.at(-1)) && workspaceEntry(root, '.specify/workflows')?.stat.isDirectory()) {
        for (const dir of ['.specify/workflows/overlays', relative]) {
            if (!workspaceEntry(root, dir) && !lstatSync(join(root, dir), { throwIfNoEntry: false })) mkdirSync(join(root, dir));
            if (!workspaceEntry(root, dir)?.stat.isDirectory()) throw invalid(`Cannot write to ${dir}.`);
        }
    }
    const directory = workspaceEntry(root, relative);
    if (!directory?.stat.isDirectory()) throw invalid(`Cannot write to ${relative}.`);
    const target = join(directory.target, basename);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw invalid(`Cannot replace ${path}.`);
    if (file(root, path) !== base) throw invalid(`The file ${path} changed. Preview the edit again.`, 409);
    if (text == null) {
        rmSync(target);
        return;
    }
    const temp = join(directory.target, `.${basename}.${randomUUID()}.tmp`);
    writeFileSync(temp, text, { flag: 'wx', mode: stat?.mode ?? 0o600 });
    try {
        if (base === null && exclusiveCreate) linkSync(temp, target);
        else renameSync(temp, target);
    }
    finally { rmSync(temp, { force: true }); }
}

function writeProductDocuments(root, documents) {
    for (const { path, before } of documents) {
        if (file(root, path) !== before) throw invalid(`The file ${path} changed. Preview the edit again.`, 409);
    }
    const written = [];
    try {
        for (const doc of documents) {
            writeConfig(root, doc.path, doc.after, doc.before, { exclusiveCreate: true });
            written.push(doc);
        }
    } catch (error) {
        const unrestored = [];
        for (const doc of written.reverse()) {
            try { writeConfig(root, doc.path, doc.before, doc.after, { exclusiveCreate: true }); }
            catch { unrestored.push(doc.path); }
        }
        if (unrestored.length) throw invalid(`Product apply failed and could not restore: ${unrestored.join(', ')}. Inspect those paths before retrying.`, 409);
        throw error;
    }
}

function retainWorkflowSource(root, path, text) {
    for (const dir of ['.speckit-companion', reviewedWorkflowSources]) {
        if (!workspaceEntry(root, dir) && !lstatSync(join(root, dir), { throwIfNoEntry: false })) mkdirSync(join(root, dir));
        if (!workspaceEntry(root, dir)?.stat.isDirectory()) throw invalid(`Cannot write to ${dir}.`);
    }
    const entry = workspaceEntry(root, path);
    const existing = entry?.stat.isFile() && entry.stat.size <= configSize ? readFileSync(entry.target, 'utf8') : null;
    if (existing === text) return;
    if (lstatSync(join(root, path), { throwIfNoEntry: false })) {
        throw invalid(`The retained source ${path} does not match the reviewed file.`, 409);
    }
    try { writeFileSync(join(root, path), text, { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) {
        if (error.code === 'EEXIST') throw invalid(`The retained source ${path} changed. Open a new preview.`, 409);
        throw error;
    }
}

async function registerPinnedWorkflow(root, sourcePath, text, cli, probe) {
    const staged = mkdtempSync(join(tmpdir(), 'canvas-pinned-workflow-'));
    try {
        const path = join(staged, sourcePath.split('/').at(-1));
        writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
        if (probe) mkdirSync(join(staged, '.specify'));
        else requireWorkflowRegistrationWithoutPlugins(root);
        return await cli(probe ? staged : root, ['workflow', 'add', '--dev', path]);
    } finally { rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

const exec = promisify(execFile);
export async function callSpecKit(root, args, probe = false, { workflowOutcome = false } = {}) {
    const env = { ...process.env, SPECIFY_INIT_DIR: root, NO_COLOR: '1', COLUMNS: '120' };
    if (workflowOutcome) delete env.SPECKIT_WORKFLOW_RUN_ID;
    try {
        const result = await exec('specify', args, { cwd: root, timeout: probe ? 60_000 : 120_000, maxBuffer: 128 * 1024,
            windowsHide: true, env });
        return result.stdout.trim();
    } catch (error) {
        const output = String(error.stderr || error.stdout || '');
        if (workflowOutcome && process.platform === 'win32' && error.code === 1 &&
            /\[WinError (?:5|32|33)\]/.test(output) && /\.(?:inputs|state)\.json\.[\w\s]+\.tmp/.test(output)) {
            throw Object.assign(invalid('Windows did not let Spec Kit replace a temporary review checkpoint.', 503), { code: 'review-checkpoint-busy' });
        }
        if (workflowOutcome && error.code === 1 && error.stdout?.trim()) return error.stdout.trim();
        if (error.code === 'ENOENT') throw invalid('Spec Kit CLI is not on the canvas host PATH. Install or upgrade Spec Kit and restart the host.');
        if (error.killed) throw invalid(`Spec Kit timed out. ${probe ? 'Retry the preview after the host is less busy.' : 'Refresh the graph before retrying.'}`);
        throw invalid(probe ? `This Spec Kit CLI does not expose ${args.slice(0, -1).join(' ')}. Upgrade Spec Kit or use a supported local configuration.` :
            `Spec Kit did not complete the change. Refresh the graph before retrying. ${output.slice(0, 900)}`);
    }
}

async function stageBundleRecord(root, graph, request, base, cli) {
    const sourcePath = str(request.source, 'the repository-relative path to bundle.yml', 300);
    if (sourcePath.split('/').at(-1) !== 'bundle.yml') throw invalid('Choose a local bundle.yml file.');
    const raw = file(root, sourcePath);
    if (raw == null) throw invalid('Choose an accessible bundle.yml from this repository.');
    const manifest = load(raw, { schema: JSON_SCHEMA });
    const { id, version } = manifest?.bundle ?? {};
    if (!safeId(id) || typeof version !== 'string' || (request.id && request.id !== `bundle:${id}`)) throw invalid('The manifest must declare the selected bundle’s ID and version.');
    const original = base == null ? { schema_version: '1.0', bundles: [] } : JSON.parse(base);
    const current = original.bundles.find(record => record.bundle_id === id);
    const update = request.operation === 'bundle-update-record';
    if (update ? !current : current) throw invalid('The bundle registration changed. Reload the inspector and try again.');
    if (current && (!Array.isArray(current.contributed_components) || current.contributed_components.length || rows(current.bundle_references).length)) {
        throw invalid('Only bundles without contributed packages or nested references can be refreshed here.');
    }
    if (!object(manifest.provides) || rows(manifest.provides.bundles).length) throw invalid('Only flat local bundles can be registered offline.');
    const inputs = new Map([[sourcePath, raw]]);
    for (const path of ['.specify/init-options.json', '.specify/integration.json', BUNDLE_RECORDS]) {
        const contents = file(root, path);
        if (contents != null) inputs.set(path, contents);
    }
    const components = [];
    for (const [kind, type] of Object.entries(BUNDLE_TYPES)) {
        const entries = manifest.provides[kind] ?? [];
        if (!Array.isArray(entries)) throw invalid(`Bundle ${kind} must be a list.`);
        const [, dir, registry, , filename] = Object.values(PACKAGES).find(entry => entry[3] === kind);
        for (const ref of entries) {
            if (!safeId(ref?.id) || typeof ref.version !== 'string' || ref.source) throw invalid('Pin every component to its installed version without a catalog source.');
            const node = graph.nodes.find(item => item.id === `${type}:${ref.id}`);
            if (!node?.active || node.healthStatus === 'blocked' || node.version !== ref.version || original.bundles.some(record =>
                rows(record.contributed_components).some(component => component.kind === kind && component.id === ref.id))) {
                throw invalid(`${ref.id} must be an unblocked, independently installed ${type} at ${ref.version}. Register the reviewed component first.`);
            }
            for (const path of [`${dir}/${registry}`, `${dir}/${ref.id}/${filename}`]) {
                const contents = file(root, path);
                if (contents == null) throw invalid(`Missing component registration file: ${path}.`);
                inputs.set(path, contents);
            }
            components.push(node);
        }
    }
    // Let Spec Kit prepare its record in a disposable project; never copy generated package files back.
    const staged = mkdtempSync(join(tmpdir(), 'canvas-bundle-'));
    try {
        writeTemporaryProject(staged, inputs);
        const args = ['bundle', 'install', `.${process.platform === 'win32' ? '\\' : '/'}${sourcePath}`, '--offline', ...(update ? ['--refresh'] : [])];
        const output = await cli(staged, args);
        const generated = file(staged, BUNDLE_RECORDS);
        if (generated == null) throw invalid('Spec Kit did not produce a bundle record. Use a CLI that supports offline local bundles.');
        const next = JSON.parse(generated);
        const record = next.bundles?.find(item => item.bundle_id === id);
        if (record?.version !== version || !Array.isArray(record.contributed_components) || record.contributed_components.length ||
            !Array.isArray(record.required_components) || record.required_components.length !== components.length ||
            !isDeepStrictEqual(next.bundles.filter(item => item.bundle_id !== id), original.bundles.filter(item => item.bundle_id !== id))) {
            throw invalid('The runtime planned package or unrelated record changes. Register each component separately before registering this bundle.');
        }
        const { installed_at, ...recordStamp } = record;
        return { sourcePath, raw, next, generated, id, version, components, args, output, recordStamp };
    } finally { rmSync(staged, { recursive: true, force: true }); }
}

function projectHooks(hooks, extension, action, declared = []) {
    hooks.installed = rows(hooks.installed).filter(id => id !== extension);
    if (action !== 'remove') hooks.installed.push(extension);
    hooks.hooks ??= {};
    for (const [event, value] of Object.entries(hooks.hooks)) {
        hooks.hooks[event] = rows(value).flatMap(row => {
            if (row.extension !== extension) return [row];
            if (['remove', 'install', 'update'].includes(action)) return [];
            return [{ ...row, enabled: action === 'enable' }];
        });
    }
    for (const row of declared) (hooks.hooks[row.event] ??= []).push({ extension, command: row.command, enabled: true, optional: row.optional, priority: row.priority });
}

function stageRun({ node, request, specs, before, runPreview }) {
    const cmd = node?.commands.find(item => item.id === request.command);
    if (!node?.active || !cmd || node.healthStatus === 'blocked') throw invalid('Select a ready command in the inspector.');
    if (node.effect === 'external-write') throw invalid('Do not dispatch an external writer to the agent. Use “Review GitHub change” for supported GitHub operations.');
    if (node.effect === 'unknown') throw invalid('This command has no verified effect boundary.');
    if (node.kind !== 'Lifecycle' && node.kind !== 'Extensions') throw invalid('Manage this item through its registered lifecycle or extension.');
    const feature = specs.find(spec => spec.id === request.feature)?.id;
    if (request.feature && !feature) throw invalid('This feature is no longer available.');
    const artifact = request.artifact || null;
    if (artifact && !(before.nodes.find(item => item.id === `feature:${feature}`)?.artifacts.includes(artifact) || node.artifacts.includes(artifact))) {
        throw invalid('Select an artifact from the inspector or the selected feature.');
    }
    const needsFeature = node.kind === 'Lifecycle' && !['specify', 'constitution'].includes(cmd.id);
    if (needsFeature && !feature) throw invalid('Select a feature before previewing this command.');
    const intent = ['specify', 'constitution'].includes(cmd.id) ? str(request.intent, 'an intent', 4000) :
        request.intent ? str(request.intent, 'an intent', 4000) : '';
    const stage = node.stage ?? node.id;
    const detail = runPreview(node, cmd, { feature, artifact, intent, workflow: request.workflow });
    const triggered = before.edges.filter(edge => edge.active && (edge.kind === 'native-hook' ||
        (edge.kind === 'hook' && (edge.source === stage || edge.target === stage)) ||
        (edge.kind === 'embedded-hook' && edge.commandKey === detail.companionStep)));
    const blocked = before.findings.filter(finding => finding.severity === 'blocked' &&
        (finding.nodeIds.includes(node.id) || triggered.some(edge => finding.edgeIds.includes(edge.id)) ||
         [HOOK_PATH, NATIVE_HOOK_PATH].includes(finding.path) || finding.code === 'malformed-hook'));
    if (blocked.length) throw invalid(blocked[0].message);
    return { ...detail, node, affected: [node], triggered };
}

function requireGitHubWriter(graph, id) {
    const node = graph.nodes.find(item => item.id === id);
    if (!node?.active || node.healthStatus === 'blocked' || !['extension:ghp', 'extension:project'].includes(node.id) ||
        graph.decisions.some(item => item.secondary === node.key && item.strategy === 'primary') ||
        graph.findings.some(item => item.severity === 'blocked' && (item.code === 'malformed-hook' || item.path === HOOK_PATH || item.path === POLICY_PATH))) {
        throw invalid('Select an enabled, unblocked GitHub integration and disable any competing automatic writer before continuing.');
    }
    return node;
}

export function createWorkflowActions({ context, runPreview, run, changed, cli = callSpecKit, github = createGitHubChanges(), now = Date.now, runStorage, fetchSource }) {
    const pending = new Map();
    const reviewRuns = createReviewRuns(runStorage);
    const guidedRuns = createGuidedRuns(runStorage, now);
    let applying = false;
    const snapshot = () => {
        const { root, specs, specDirs } = context();
        const { graph } = readWorkflow(root, specs, specDirs);
        for (const node of graph.nodes.filter(item => item.kind === 'Workflows')) {
            node.canRunReview = Boolean(runStorage && node.active && node.reviewGates && (!node.hasProjectOverlay || node.reviewOverlay) && node.healthStatus !== 'blocked');
            node.isolatedRun = reviewRuns.observe(root, node);
            node.canRunGuided = Boolean(runStorage && canGuide(graph, node));
            node.guidedRun = guidedRuns.observe(root, node);
            delete node.reviewDefinitionStamp;
            delete node.reviewDefinition;
            delete node.guidedDefinitionStamp;
        }
        return graph;
    };

    async function plan(request, probe, reviewedAt) {
        const { root, specs, specDirs, revision } = context();
        const read = overrides => readWorkflow(root, specs, specDirs, overrides);
        const current = read();
        const before = current.graph;
        const node = before.nodes.find(item => item.id === request.id);
        const edge = before.edges.find(item => item.id === request.id);
        const operation = request.operation;
        const overrides = new Map();
        let execute, invocation, title, sourceStamp, sourcePath;
        let paths = [], notes = [], affected = [], triggered = [], readPaths = [];
        let documentChange, productChange, productArchive, externalChange, reviewChange, guidedChange, packageDefinition, localEvidence, validatePackage;
        const managed = PACKAGES[node?.kind ?? request.kind];
        const hookEdit = (operation === 'hook-add' || operation === 'hook-mute-all' || ['hook-toggle', 'hook-remove', 'hook-up', 'hook-down', 'hook-behavior'].includes(operation));

        if (operation === 'run') {
            const detail = stageRun({ node, request, specs, before, runPreview });
            ({ invocation, title, affected, triggered } = detail);
            paths = detail.paths;
            readPaths = [request.artifact, detail.instruction].filter(Boolean);
            notes = ['This approves dispatch only. The agent reports what it wrote; any external write needs separate approval.', ...(detail.notes ?? [])];
            execute = () => run(detail);
        } else if (operation === 'workflow-review-configure') {
            const gate = node?.reviewGates?.find(item => item.id === request.gate);
            if (node?.kind !== 'Workflows' || !node.installed || !gate) throw invalid('Select a literal gate in an installed review workflow.');
            if (node.hasProjectOverlay && !node.reviewOverlay) throw invalid('Disable or remove other enabled overlays before configuring a literal review gate.');
            const isolated = reviewRuns.observe(root, node);
            if (isolated?.error || isolated?.status === 'paused' || ['paused', 'running'].includes(node.lastRunStatus)) {
                throw invalid('Resolve the active review run or unreadable checkpoint before editing this gate.', 409);
            }
            const message = str(request.message, 'a review message', 2400);
            if (!['abort', 'skip'].includes(request.rejection)) throw invalid('Choose whether rejection aborts the workflow or skips this gate.');
            const artifact = request.artifact === undefined ? gate.artifact : request.artifact === '' ? undefined : request.artifact;
            if (artifact !== undefined && artifact !== gate.artifact) readGateArtifact(root, before, artifact);
            if (message === gate.message && request.rejection === gate.rejection && artifact === gate.artifact) {
                throw invalid('Change the message, review evidence, or rejection behavior before previewing.');
            }
            const installed = file(root, node.source);
            const definition = load(installed, { schema: JSON_SCHEMA });
            const step = { ...node.reviewDefinition.steps.find(item => item.id === gate.id) };
            step.message = message;
            step.on_reject = request.rejection;
            if (artifact === undefined) delete step.show_file;
            else step.show_file = artifact;
            const path = reviewOverlayPath(node.key);
            const base = file(root, path);
            const existing = base == null ? null : load(base, { schema: JSON_SCHEMA });
            if (base != null && (!node.reviewOverlay || !composeReviewOverlay(definition, node.key, existing))) {
                throw invalid('The project review overlay is disabled or not editable. Inspect or remove it before replacing it.');
            }
            const nextOverlay = { id: REVIEW_OVERLAY_ID, extends: node.key, enabled: true,
                edits: [...rows(existing?.edits).filter(edit => edit.replace !== gate.id), { replace: gate.id, step }] };
            const effective = composeReviewOverlay(definition, node.key, nextOverlay);
            if (!effective) throw invalid('Use a literal review message without workflow expressions.');
            const next = yaml(nextOverlay);
            if (probe) await validateReviewOverlay(cli, node, installed, path, next);
            overrides.set(path, nextOverlay);
            sourceStamp = [installed, base, artifact && readGateArtifact(root, before, artifact).digest];
            readPaths = [node.source, ...(artifact ? [artifact] : [])];
            paths = [path];
            affected = [node];
            documentChange = { path, before: base, after: next };
            title = `Configure review gate: ${gate.id}`;
            notes = ['This writes a repository-owned Spec Kit overlay and leaves the installed workflow unchanged. It does not record a verdict or start a run.'];
            execute = () => writeConfig(root, path, next, base);
        } else if (['overlay-enable', 'overlay-disable', 'overlay-remove'].includes(operation)) {
            const enabling = operation === 'overlay-enable';
            const removing = operation === 'overlay-remove';
            if (node?.kind !== 'Workflow overlays' || (!removing && !(enabling ? node.canEnableOverlay : node.canDisableOverlay))) {
                throw invalid(enabling ? 'Only a compatible literal review overlay can be enabled here, with no other enabled layers.' :
                    'Select an existing project workflow overlay.');
            }
            const owner = before.nodes.find(item => item.id === node.workflowOwner);
            const path = node.source;
            const isolated = owner && (enabling || owner.reviewOverlay === path) ? reviewRuns.observe(root, owner) : null;
            if (owner?.lastRunStatus === 'running' || enabling && owner.lastRunStatus === 'paused' ||
                isolated?.status === 'paused' || isolated?.error) {
                throw invalid('Resolve the active workflow run or unreadable review checkpoint before changing this overlay.', 409);
            }
            const base = file(root, path);
            if (base == null) throw invalid('The overlay file is no longer available.', 409);
            const next = removing ? null : { ...load(base, { schema: JSON_SCHEMA }), enabled: enabling };
            const text = next == null ? null : yaml(next);
            const installed = enabling ? file(root, owner.source) : null;
            if (enabling) {
                if (!installed || !composeReviewOverlay(load(installed, { schema: JSON_SCHEMA }), owner.key, next)) {
                    throw invalid('The overlay no longer matches the installed literal gates. Inspect the sources again.', 409);
                }
                if (probe) await validateReviewOverlay(cli, owner, installed, path, text);
                readPaths = [owner.source];
            }
            sourceStamp = [base, installed];
            overrides.set(path, next);
            paths = [path];
            affected = [node, ...(owner ? [owner] : [])];
            documentChange = { path, before: base, after: text };
            title = `${removing ? 'Remove' : enabling ? 'Enable' : 'Disable'} workflow overlay: ${node.name}`;
            notes = [enabling ? 'Spec Kit will use this layer in future composition. Enabling it does not start a run.' :
                'Spec Kit will skip this layer in future composition. Other layers and saved workflow checkpoints are unchanged.',
                ...(!removing ? ['The YAML is reserialized.'] : [])];
            execute = () => writeConfig(root, path, text, base);
        } else if (['workflow-review-start', 'workflow-review-resume'].includes(operation)) {
            if (node?.kind !== 'Workflows' || !node.reviewGates) throw invalid('Select an installed workflow made up of literal review gates.');
            const prepared = await reviewRuns.prepare(root, node, request, node.reviewDefinition, cli, probe);
            ({ execute, invocation, review: reviewChange, stamp: sourceStamp } = prepared);
            affected = [node];
            readPaths = [node.source, ...(node.reviewOverlay ? [node.reviewOverlay] : [])];
            if (reviewChange.artifactPath) {
                const artifact = readGateArtifact(root, before, reviewChange.artifactPath);
                reviewChange.artifact = artifact;
                readPaths.push(artifact.path);
                sourceStamp = [sourceStamp, artifact.digest];
                execute = () => prepared.execute(() => {
                    if (readGateArtifact(root, before, artifact.path).digest !== artifact.digest) {
                        throw invalid('The review evidence changed while recording the gate. Open a new preview.', 409);
                    }
                });
            }
            title = operation === 'workflow-review-start' ? `Start review workflow: ${node.name}` : `Record gate decision: ${reviewChange.gate}`;
            notes = ['Spec Kit runs the reviewed gate-only definition in a temporary project. Only supported literal gate replacements are included; no repository plugins, hooks, or agent commands run. The checkpoint stays with this canvas session.'];
        } else if (['guided-start', 'guided-stop', 'guided-verdict', 'guided-label'].includes(operation)) {
            const stop = operation === 'guided-stop';
            const start = operation === 'guided-start';
            const verdict = operation === 'guided-verdict';
            const label = operation === 'guided-label';
            if (node?.kind !== 'Workflows' || (!stop && !canGuide(before, node))) {
                throw invalid('Select an enabled workflow with literal gate and issue-label pairs, without overlays or other blockers.');
            }
            if (verdict && !['approve', 'reject'].includes(request.verdict)) throw invalid('Choose approve or reject.');
            const prepared = guidedRuns.prepare(root, node, request);
            const { gate, change } = prepared.pair ?? {};
            const base = !stop && file(root, node.source);
            if (!stop && (base == null || createHash('sha256').update(JSON.stringify(load(base, { schema: JSON_SCHEMA }))).digest('hex') !== node.guidedDefinitionStamp)) {
                throw invalid('The installed definition changed. Open a new preview.', 409);
            }
            const status = stop || (verdict && request.verdict === 'reject') ? 'aborted' :
                start || label && prepared.hasNext ? 'review' : verdict ? 'write' : 'completed';
            affected = [node];
            readPaths = [node.source];
            const evidence = !stop && gate.artifact ? readGateArtifact(root, before, gate.artifact) : null;
            if (evidence) readPaths.push(evidence.path);
            if (label && (evidence?.digest ?? null) !== prepared.evidence) {
                throw invalid('The reviewed evidence changed. End this run and review the updated evidence in a new run.', 409);
            }
            let external;
            if (label) {
                affected.push(requireGitHubWriter(before, request.writer));
                external = await github.prepare(change);
                externalChange = external.change;
            }
            sourceStamp = [prepared.stamp, evidence?.digest, external?.stamp];
            guidedChange = { status, steps: node.guidedReview?.flatMap(pair => [pair.gate.id, pair.write]) ?? [], runId: request.runId };
            if (verdict) reviewChange = { gate: gate.id, message: gate.message, verdict: request.verdict, rejection: 'abort',
                runId: request.runId, artifact: evidence };
            title = start ? `Start guided run: ${node.name}` : stop ? `End guided run: ${node.name}` :
                verdict ? `Record gate decision: ${gate.id}` : 'Review guided issue label change';
            notes = ['The canvas checkpoints this sequence independently of Spec Kit CLI runs. It does not execute workflow code or invoke repository hooks.'];
            if (label) notes.push('Confirm one GitHub API write for the exact target below. GitHub does not provide an atomic compare-and-set. If the result is uncertain, inspect the issue; the guided run will not retry.');
            else notes.push('This confirmation only records canvas state. It does not authorize or send a GitHub change.');
            if (stop || verdict && request.verdict === 'reject') notes.push('Ending the run does not undo GitHub changes already confirmed.');
            execute = () => prepared.execute({
                status, evidence: evidence?.digest ?? null, write: external && (() => external.execute()),
                verify() {
                    if (!stop && (base == null || file(root, node.source) !== base)) {
                        throw invalid('The installed definition changed. Open a new preview.', 409);
                    }
                    if (evidence && readGateArtifact(root, before, evidence.path).digest !== evidence.digest) {
                        throw invalid('The review evidence changed. Open a new preview.', 409);
                    }
                },
            });
        } else if (operation === 'native-override-empty') {
            if (!node?.canMuteNativeEvents) {
                throw invalid('Select the native event override for a supported Spec Kit integration with handlers to suppress.');
            }
            const base = file(root, NATIVE_HOOK_PATH);
            if (base === null && lstatSync(join(root, NATIVE_HOOK_PATH), { throwIfNoEntry: false })) {
                throw invalid(`Cannot replace ${NATIVE_HOOK_PATH}.`);
            }
            const definition = base === null ? {} : load(base, { schema: JSON_SCHEMA });
            const key = before.runtime.integration;
            definition.integrations = {
                ...definition.integrations,
                [key]: { ...definition.integrations?.[key], events: {} },
            };
            const next = yaml(definition);
            overrides.set(NATIVE_HOOK_PATH, definition);
            paths = [NATIVE_HOOK_PATH];
            documentChange = { path: NATIVE_HOOK_PATH, before: base, after: next };
            title = `Suppress all Spec Kit native events for ${key}`;
            notes = [
                'An empty override replaces every inherited or configured handler for this integration, including built-in handlers not listed in the graph.',
                'This can suppress checks or approval handlers as well as automation. To keep other handlers, remove only the intended entries from an existing override.',
                'This changes project configuration only. It does not update generated settings, stop handlers in a running agent, or change lifecycle or embedded hooks.',
                ...(base === null ? [] : ['The existing YAML is reserialized; review the full file diff before applying.']),
            ];
            execute = () => writeConfig(root, NATIVE_HOOK_PATH, next, base, { exclusiveCreate: true });
        } else if (operation === 'native-override-add') {
            const provider = before.nodes.find(item => item.id === edge?.owner);
            if (edge?.nativeLayer !== 'extension' || !edge.active || edge.effect !== 'read-only' ||
                !provider?.active || provider.healthStatus === 'blocked' ||
                !provider.commands.some(command => command.id === edge.command) ||
                !before.nodes.some(item => item.id === `native-events:${before.runtime.integration}` && item.installed)) {
                throw invalid('Select a declared, read-only handler and configure an existing native override for this integration.');
            }
            const base = file(root, NATIVE_HOOK_PATH);
            const definition = load(base ?? '', { schema: JSON_SCHEMA });
            const events = definition?.integrations?.[before.runtime.integration]?.events;
            if (!object(events) || rows(events[edge.hook]).some(handler => handler.command === edge.command)) {
                throw invalid('The handler is already configured for this event, or the override changed.');
            }
            const handler = { command: edge.command, ...(edge.condition !== undefined ? { matcher: edge.condition } : {}),
                ...(edge.timeout !== undefined ? { timeout: edge.timeout } : {}) };
            const handlers = [...rows(events[edge.hook]), handler];
            events[edge.hook] = handlers.length === 1 ? handler : handlers;
            const next = yaml(definition);
            overrides.set(NATIVE_HOOK_PATH, definition);
            paths = [NATIVE_HOOK_PATH];
            triggered = [edge];
            affected = [provider];
            documentChange = { path: NATIVE_HOOK_PATH, before: base, after: next };
            title = `Add declared handler at ${edge.hook}`;
            notes = ['Adds the handler at the end of the selected integration’s project override. It does not update generated settings or running agents.'];
            execute = () => writeConfig(root, NATIVE_HOOK_PATH, next, base);
        } else if (['native-override-remove', 'native-override-up', 'native-override-down', 'native-override-configure', 'native-override-mute'].includes(operation)) {
            const mute = operation === 'native-override-mute';
            const configure = operation === 'native-override-configure';
            const owned = mute && node?.kind === 'Extensions' ?
                before.edges.filter(item => item.owner === node.id && item.nativeLayer === 'override' && item.editable) : [];
            if (mute ? !owned.length : edge?.nativeLayer !== 'override' || !edge.editable) {
                throw invalid('Select a handler or its enabled owner in an existing native event override.');
            }
            const base = file(root, NATIVE_HOOK_PATH);
            if (base == null) throw invalid('The native override file is no longer available.');
            const definition = load(base, { schema: JSON_SCHEMA });
            const events = definition?.integrations?.[before.runtime.integration]?.events;
            const removes = mute || operation === 'native-override-remove';
            const selectedHandlers = mute ? owned : [edge];
            if (!events || selectedHandlers.some(item => rows(events[item.hook])[item.order]?.command !== item.command)) {
                throw invalid('The override changed. Reload the inspector.', 409);
            }
            for (const [event, eventHandlers] of Object.entries(events ?? {})) {
                const selected = selectedHandlers.filter(item => item.hook === event);
                if (!selected.length) continue;
                const handlers = rows(eventHandlers).slice();
                if (removes) {
                    const indexes = new Set(selected.map(item => item.order));
                    const remaining = handlers.filter((_, index) => !indexes.has(index));
                    if (!remaining.length) delete events[event];
                    else events[event] = remaining;
                } else if (configure) {
                    const provider = before.nodes.find(item => item.id === edge.owner);
                    if (edge.effect !== 'read-only' || !provider?.active || provider.healthStatus === 'blocked') {
                        throw invalid('Only handlers with a known, unblocked read-only provider can change their matcher or timeout.');
                    }
                    const handler = handlers[edge.order];
                    const matcher = request.matcher === '' ? undefined : str(request.matcher, 'a matcher', 160);
                    const timeout = request.timeout === null ? undefined : request.timeout;
                    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600)) {
                        throw invalid('Use a timeout from 1 to 600 seconds, or keep the runtime default.');
                    }
                    if (handler.matcher === matcher && handler.timeout === timeout) throw invalid('Change the matcher or timeout before previewing.');
                    if (matcher === undefined) delete handler.matcher;
                    else handler.matcher = matcher;
                    if (timeout === undefined) delete handler.timeout;
                    else handler.timeout = timeout;
                    events[event] = Array.isArray(eventHandlers) ? handlers : handler;
                } else {
                    const next = edge.order + (operation === 'native-override-up' ? -1 : 1);
                    if (next < 0 || next >= handlers.length) throw invalid('The handler is already at the edge of its list.');
                    [handlers[next], handlers[edge.order]] = [handlers[edge.order], handlers[next]];
                    events[event] = handlers;
                }
            }
            const next = yaml(definition);
            overrides.set(NATIVE_HOOK_PATH, definition);
            paths = [NATIVE_HOOK_PATH];
            affected = mute ? [node] : [];
            triggered = selectedHandlers;
            documentChange = { path: NATIVE_HOOK_PATH, before: base, after: next };
            title = mute ? `Remove ${node.name} handlers from the native override` :
                `${removes ? 'Remove' : configure ? 'Configure' : 'Reorder'} configured handler at ${edge.hook}`;
            notes = ['This changes the project-owned override only. The YAML is reserialized. Generated settings and running agents are not updated by this operation; refresh the integration before relying on the new handlers.',
                'An override with no handlers is still an explicit override. It does not restore inherited events.'];
            execute = () => writeConfig(root, NATIVE_HOOK_PATH, next, base);
        } else if (['embedded-remove', 'embedded-up', 'embedded-down'].includes(operation)) {
            if (edge?.kind !== 'embedded-hook' || !edge.editable) throw invalid('Select an embedded Companion hook declared in a list.');
            const base = file(root, edge.path);
            if (base == null) throw invalid('The Companion recipe is no longer available.');
            const definition = load(base, { schema: JSON_SCHEMA });
            const move = operation === 'embedded-up' ? edge.order - 1 : operation === 'embedded-down' ? edge.order + 1 : null;
            if (move != null && (move < 0 || operation === 'embedded-down' && !edge.canMoveLater)) throw invalid('The hook is already at the edge of its anchor.');
            const next = await planEmbeddedHookEdit(base, definition, edge, move);
            sourceStamp = createHash('sha256').update(next).digest('hex');
            overrides.set(edge.path, load(next, { schema: JSON_SCHEMA }));
            paths = [edge.path];
            documentChange = { path: edge.path, before: base, after: next };
            title = move == null ? `Remove embedded hook at ${edge.hook}` : `Reorder embedded hooks at ${edge.hook}`;
            notes = ['This changes the active, user-owned Companion recipe only. It does not execute hooks or rewrite generated agent instructions.'];
            execute = () => writeConfig(root, edge.path, next, base);
        } else if (operation === 'github-change' || operation === 'workflow-issue-label') {
            const fromStep = operation === 'workflow-issue-label';
            const owner = fromStep && before.nodes.find(item => item.id === node?.workflowOwner);
            if (fromStep && (!node?.active || !node.issueLabelChange || !owner?.active || owner.guidedReview || owner.hasProjectOverlay ||
                before.findings.some(item => item.severity === 'blocked' && item.code !== 'unapproved-external-step' &&
                    (item.nodeIds.includes(owner.id) || item.nodeIds.includes(node.id))))) {
                throw invalid(owner?.guidedReview ? 'Use the guided run to record the gate verdict before previewing this label.' :
                    'Select a literal issue label step in an enabled workflow without project overlays or other blockers.');
            }
            if (!fromStep && request.action === 'issue-label') throw invalid('Select the issue label from its workflow step.');
            affected = [requireGitHubWriter(before, fromStep ? request.writer : request.id), ...(fromStep ? [node] : [])];
            const prepared = await github.prepare(fromStep ? node.issueLabelChange : request);
            ({ execute, change: externalChange } = prepared);
            sourceStamp = prepared.stamp;
            title = `Review ${externalChange.field.toLowerCase()} change`;
            notes = ['Confirmation makes one GitHub API write with the account below. The canvas rechecks the target immediately before writing; GitHub does not provide an atomic compare-and-set for this operation.'];
            if (fromStep) notes.push('This is a manual change. It does not evaluate conditions, run the workflow, advance a checkpoint, or grant approval for other steps.');
        } else if (operation === 'record-owner') {
            if (current.graph.findings.some(item => item.path === POLICY_PATH || item.code === 'malformed-policy')) throw invalid('Repair the ownership policy before writing another decision.');
            const primary = before.nodes.find(item => item.kind === 'Extensions' && item.key === request.primary);
            const secondary = before.nodes.find(item => item.kind === 'Extensions' && item.key === request.secondary);
            if (!primary || !secondary || primary === secondary || !['primary', 'manual', 'disabled-hook', 'scoped'].includes(request.strategy)) throw invalid('Choose two different integrations and a supported resolution.');
            const scoped = request.strategy === 'scoped';
            const scopes = scoped ? { primaryScope: request.primaryScope, secondaryScope: request.secondaryScope } : {};
            if (scoped) {
                const problem = scopeProblem(primary, secondary, scopes, before.edges);
                if (problem) throw invalid(problem);
            } else if (!primary.active || primary.healthStatus === 'blocked') throw invalid('Select an enabled, unblocked primary owner.');
            if (request.strategy === 'primary' && secondary.active) throw invalid('Disable the secondary extension before recording this resolution.');
            if (!scoped && secondary.active && (secondary.mode === 'primary' || before.edges.some(item => AUTOMATIC_HOOKS.includes(item.kind) && item.owner === secondary.id && item.active))) {
                throw invalid('Disable the competing extension or its automatic hooks first. A record does not change runtime behavior.');
            }
            const decision = { primary: primary.key, secondary: secondary.key, strategy: request.strategy, ...scopes,
                owner: str(request.owner, 'the accountable owner', 140), rationale: str(request.rationale, 'a rationale', 800),
                approval: { method: 'canvas-confirmation', at: new Date(now()).toISOString() } };
            const previous = before.decisions.filter(item => !([primary.key, secondary.key].includes(item.primary) && [primary.key, secondary.key].includes(item.secondary)));
            const next = { version: 1, decisions: [...previous, decision] };
            overrides.set(POLICY_PATH, next);
            paths = [POLICY_PATH];
            affected = [primary, secondary];
            title = 'Record ownership decision';
            const base = file(root, POLICY_PATH);
            execute = () => writeConfig(root, POLICY_PATH, json(next), base);
            notes = ['This decision records the accountable owner and the canvas confirmation, not a verified account identity. Runtime settings still determine which hooks run.'];
            if (scoped) notes.push(`Declared output scopes: ${primary.name} → ${scopes.primaryScope}/; ${secondary.name} → ${scopes.secondaryScope}/. This validates declared paths, not agent filesystem access.`);
        } else if (['catalog-add', 'catalog-remove', 'catalog-discovery', 'catalog-allow-install'].includes(operation)) {
            const adding = operation === 'catalog-add';
            const allowing = operation === 'catalog-allow-install';
            const kind = adding ? request.kind : node?.kind === 'Catalogs' ? node.category : null;
            const key = adding ? request.name : node?.key;
            if (!CATALOG_TYPES.includes(kind) || !safeId(key)) throw invalid('Select a supported project catalog type and enter a valid name.');
            if (!workspaceEntry(root, '.specify')?.stat.isDirectory()) throw invalid('Initialize Spec Kit before editing project catalogs.');
            const path = catalogPath(kind);
            if (before.findings.some(item => item.path === path)) throw invalid('Repair the catalog configuration first.');
            const source = file(root, path);
            const catalog = source == null ? (kind === 'bundle' ? { schema_version: '1.0' } : {}) : load(source, { schema: JSON_SCHEMA });
            catalog.catalogs ??= [];
            const index = catalog.catalogs.findIndex(item => catalogKey(kind, item) === key);
            if (adding ? index >= 0 : index < 0) throw invalid('The catalog registration changed. Reload and try again.');
            if (adding) {
                const url = catalogUrl(request.url);
                if (['default', 'community', 'custom'].includes(key.toLowerCase())) throw invalid('Choose a project catalog name that does not shadow a runtime default.');
                catalog.catalogs.push(kind === 'bundle'
                    ? { id: key, url, priority: 10, install_policy: 'discovery-only' }
                    : { name: key, url, priority: 10, install_allowed: false });
            } else if (operation === 'catalog-remove') {
                catalog.catalogs.splice(index, 1);
            } else {
                const entry = catalog.catalogs[index];
                if (allowing && (node.installAllowed !== false || request.url !== entry.url)) {
                    throw invalid('Review the exact discovery-only catalog URL before allowing installation.', 409);
                }
                if (allowing) catalogUrl(entry.url);
                if (kind === 'bundle') entry.install_policy = allowing ? 'install-allowed' : 'discovery-only';
                else entry.install_allowed = allowing;
            }
            if (probe) await cli(root, [...(kind === 'step' ? ['workflow', 'step'] : [kind]), 'catalog', 'list', '--help'], true);
            title = adding ? `Register ${key} for discovery` : operation === 'catalog-remove' ? `Remove ${key}` :
                allowing ? `Allow installation from ${key}` : `Restrict ${key} to discovery`;
            paths = [path];
            const next = catalog.catalogs.length ? catalog : null;
            overrides.set(path, next);
            const text = next ? yaml(next) : null;
            documentChange = { path, before: source, after: text };
            notes = ['This changes the project catalog file only. It does not contact the URL or install packages.', 'Removing a project source does not remove user-level or built-in sources, which may take its place.'];
            if (allowing) notes.push(`Spec Kit can use ${catalog.catalogs[index].url} as an installation source in later operations. Its published packages can change. Review each package separately before installing it.`);
            execute = () => writeConfig(root, path, text, source);
        } else if (hookEdit) {
            if (before.findings.some(item => item.path === HOOK_PATH || item.code === 'malformed-hook')) throw invalid('Repair the hook configuration before editing hooks in the canvas.');
            if (!workspaceEntry(root, '.specify')?.stat.isDirectory()) throw invalid('Initialize Spec Kit before editing hooks.');
            const next = structuredClone(current.hookDocument ?? {});
            next.hooks ??= {};
            if (operation === 'hook-add' || operation === 'hook-mute-all') {
                if (node?.kind !== 'Extensions' || !node.installed) throw invalid('Choose an installed extension.');
                affected = [node];
                if (operation === 'hook-mute-all') {
                    for (const [event, items] of Object.entries(next.hooks)) next.hooks[event] = rows(items).map(item => item.extension === node.key ? { ...item, enabled: false } : item);
                    title = `Disable all lifecycle hooks for ${node.name}`;
                } else {
                    if (!node.active || node.healthStatus === 'blocked') throw invalid('An unavailable extension cannot add a lifecycle hook.');
                    const declared = node.declaredHooks.find(item => item.event === request.event && item.command === request.command);
                    if (!declared) throw invalid('Select a hook declared by this extension.');
                    const items = rows(Object.hasOwn(next.hooks, declared.event) ? next.hooks[declared.event] : null);
                    if (items.some(item => item.extension === node.key && item.command === declared.command)) throw invalid('This hook is already registered.');
                    next.hooks[declared.event] = [...items, { extension: node.key, command: declared.command, enabled: false, optional: declared.optional, priority: declared.priority }];
                    title = `Add disabled ${declared.event} hook`;
                }
            } else {
                if (edge?.kind !== 'hook') throw invalid('This hook is not editable in the Spec Kit lifecycle configuration.');
                const items = rows(next.hooks[edge.hook]);
                const item = items[edge.index];
                if (!item) throw invalid('This hook no longer exists.');
                affected = before.nodes.filter(node => node.id === edge.owner);
                title = `${edge.hook}: ${edge.command}`;
                if (operation === 'hook-remove') items.splice(edge.index, 1);
                if (operation === 'hook-toggle') item.enabled = !edge.active;
                if (operation === 'hook-behavior') {
                    if (!['optional', 'required'].includes(request.behavior)) throw invalid('This runtime supports optional and required lifecycle hooks. For preview or confirmation, disable the hook and run from the inspector.');
                    item.optional = request.behavior === 'optional';
                }
                if (['hook-up', 'hook-down'].includes(operation)) {
                    const ordered = [...items].sort((a, b) => hookPriority(a.priority) - hookPriority(b.priority));
                    const index = ordered.indexOf(item);
                    const adjacent = index + (operation === 'hook-up' ? -1 : 1);
                    if (!ordered[adjacent]) throw invalid('The hook cannot move any further in that direction.');
                    [ordered[index], ordered[adjacent]] = [ordered[adjacent], item];
                    for (const [position, row] of ordered.entries()) row.priority = (position + 1) * 10;
                }
                next.hooks[edge.hook] = items;
            }
            paths = [HOOK_PATH];
            overrides.set(HOOK_PATH, next);
            const base = file(root, HOOK_PATH);
            execute = () => writeConfig(root, HOOK_PATH, yaml(next), base);
            notes = ['This updates Spec Kit lifecycle configuration, not generated command or skill files. Spec Kit’s optional prompt is not canvas approval. The YAML is reserialized.'];
        } else if (['bundle-install-record', 'bundle-update-record'].includes(operation)) {
            if (before.findings.some(item => item.path === BUNDLE_RECORDS || item.code === 'malformed-bundle') || !workspaceEntry(root, '.specify')?.stat.isDirectory()) {
                throw invalid('Select an initialized project with valid bundle records.');
            }
            const base = file(root, BUNDLE_RECORDS);
            const staged = await stageBundleRecord(root, before, request, base, cli);
            sourcePath = staged.sourcePath;
            sourceStamp = [staged.raw, staged.recordStamp];
            paths = [BUNDLE_RECORDS];
            readPaths = [sourcePath, ...staged.components.map(item => item.source)];
            overrides.set(BUNDLE_RECORDS, staged.next);
            title = `${operation === 'bundle-update-record' ? 'Refresh' : 'Register'} ${staged.id} ${staged.version}`;
            invocation = ['specify', ...staged.args].map(word => word.includes(' ') ? JSON.stringify(word) : word).join(' ');
            notes = ['Spec Kit prepared the bundle record offline in a temporary project. Only the record changes on confirmation; reviewed, preinstalled packages are not replaced.'];
            execute = () => {
                if (file(root, sourcePath) !== staged.raw) throw invalid('The bundle manifest changed. Review a new preview.', 409);
                writeConfig(root, BUNDLE_RECORDS, staged.generated, base);
                return { output: staged.output.slice(0, 6000) };
            };
        } else if (operation === 'bundle-remove-record') {
            if (node?.kind !== 'Bundles' || !node.canRemoveRecord || before.findings.some(item => item.code === 'malformed-bundle')) {
                throw invalid('Only a valid bundle record with no contributed components can be removed from this canvas. Cascading package removal is not supported.');
            }
            const current = JSON.parse(file(root, BUNDLE_RECORDS));
            const next = { ...current, bundles: current.bundles.filter(record => record.bundle_id !== node.key) };
            const args = ['bundle', 'remove', node.key];
            if (probe) await cli(root, ['bundle', 'remove', '--help'], true);
            overrides.set(BUNDLE_RECORDS, next);
            paths = [BUNDLE_RECORDS];
            affected = [node];
            title = `Remove ${node.name} bundle record`;
            invocation = ['specify', ...args].join(' ');
            notes = ['This bundle has no contributed components. Removing the record does not uninstall any packages.'];
            execute = async () => ({ output: (await cli(root, args)).slice(0, 6000) });
        } else if (['product-apply', 'product-archive'].includes(operation)) {
            if (node?.id !== 'extension:pdac-product' || node.healthStatus === 'blocked' || !node.productChanges?.includes(request.change)) {
                throw invalid('Select an inventoried change from compatible, enabled PDaC and PDaC Product integrations.');
            }
            const readProduct = path => readReviewedMarkdown(root, path, 'ProductShape text', configSize).text;
            affected = [node];
            if (operation === 'product-archive') {
                const { from, to, entries, configuration, execute: archive } = await planProductArchive(root, request.change, readProduct, workspaceEntry);
                productArchive = { from, to, entries };
                paths = [from, to];
                readPaths = [PRODUCT_CONFIG, ...entries.filter(entry => entry.kind === 'file').map(entry => `${from}/${entry.relative}`)];
                overrides.set(`${from}/change.md`, false);
                overrides.set(`${to}/change.md`, true);
                sourceStamp = [configuration, productArchive];
                title = `Archive Product Change: ${request.change}`;
                notes = ['ProductShape verified the move on a disposable copy. Confirmation moves the reviewed change directory without editing its contents or the product model. It does not commit or merge anything.'];
                execute = archive;
            } else {
                const { documents, citations, sources, configuration, inputStamp } = await planProductApply(root, request.change, readProduct, workspaceEntry);
                productChange = { documents, citations };
                paths = documents.map(doc => doc.path);
                readPaths = [PRODUCT_CONFIG, ...sources.map(item => item.path)];
                sourceStamp = [configuration, inputStamp, sources, productChange];
                overrides.set(documents.at(-1).path, documents.at(-1).after);
                title = `Review Product Change: ${request.change}`;
                notes = ['ProductShape validates the human-approved change and reports affected citations. Confirmation applies only the displayed files; it does not archive, commit, or merge the change.'];
                execute = () => writeProductDocuments(root, documents);
            }
        } else if (operation === 'adr-accept') {
            const entry = node?.adrRecords?.find(item => item.path === request.record);
            if (!entry || node.id !== 'extension:adrkit' || node.healthStatus === 'blocked') {
                throw invalid('Select an inventoried ADR from an enabled and compatible adrkit installation.');
            }
            const decidedAt = new Date(reviewedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
            const { base, next, stamp } = await stageAdrAcceptance(root, entry, request.ratifier, decidedAt, workspaceEntry);
            paths = [entry.path];
            readPaths = stamp.map(([path]) => path);
            affected = [node];
            sourceStamp = [stamp, createHash('sha256').update(next).digest('hex')];
            documentChange = { path: entry.path, before: base, after: next };
            title = `Review acceptance of ADR-${entry.id}`;
            notes = ['The specified human ratifier accepts this decision. The canvas validates a copy with adrkit and writes only the displayed record; nothing is committed.'];
            execute = () => writeConfig(root, entry.path, next, base);
        } else if (operation === 'wireframe-signoff') {
            const feature = node?.wireframeSignoff?.features.find(item => item.id === request.feature);
            if (!feature || node.id !== 'extension:wireframe' || node.healthStatus === 'blocked') {
                throw invalid('Select a feature with an enabled, compatible Wireframe installation and its standard directory.');
            }
            const path = `${feature.id}/spec.md`, directory = `${feature.id}/wireframes`;
            const entry = workspaceEntry(root, directory);
            if (!entry?.stat.isDirectory()) throw invalid('The wireframe directory is no longer available.');
            const names = readdirSync(entry.target).filter(name => /\.svg$/i.test(name)).sort();
            if (!names.length || names.length > 8 || names.some(name => !standardWireframeName(name))) {
                throw invalid('Initial sign-off requires one to eight SVG files with standard Wireframe filenames.');
            }
            const spec = readReviewedMarkdown(root, path);
            localEvidence = names.flatMap(name => {
                const svg = readReviewedMarkdown(root, `${directory}/${name}`, 'SVG text', configSize);
                if (!/^(?:\uFEFF)?\s*(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)/.test(svg.text)) {
                    throw invalid(`${svg.path} is not a readable SVG document.`);
                }
                const report = readReviewedMarkdown(root, `${directory}/${name.slice(0, -4)}.issues.md`);
                requirePassingWireframeReport(report.text, report.path);
                return [{ ...svg, kind: 'drawing' }, report];
            });
            const next = addWireframeSignoff(spec.text, names, new Date(reviewedAt).toISOString().slice(0, 10));
            if (Buffer.byteLength(next) > markdownSize) throw invalid('The updated spec exceeds 24 KiB.');
            paths = [path];
            readPaths = [path, ...localEvidence.map(item => item.path)];
            affected = [node];
            sourceStamp = [spec.digest, ...localEvidence.map(({ path, digest }) => [path, digest]), createHash('sha256').update(next).digest('hex')];
            documentChange = { path, before: spec.text, after: next };
            title = `Review wireframe sign-off for ${feature.name}`;
            notes = ['Confirm only after visually reviewing the listed SVGs. A PASS report does not prove that it reviewed the current SVG bytes.',
                'Writes only the initial UI Mockup section in this feature spec. No wireframes or reports are changed.'];
            execute = () => writeConfig(root, path, next, spec.text);
        } else if (operation === 'roadmap-status') {
            if (node?.id !== 'extension:roadmap' || node.healthStatus === 'blocked' || !node.roadmapStatus?.entries) {
                throw invalid('Select an enabled, compatible Roadmap installation with a supported ledger.');
            }
            const { text: base, digest } = readReviewedMarkdown(root, ROADMAP_PATH);
            const next = changeRoadmapStatus(base, request.entry, request.status, new Date(reviewedAt).toISOString().slice(0, 10));
            if (Buffer.byteLength(next) > markdownSize) throw invalid('The updated roadmap exceeds 24 KiB.');
            paths = [ROADMAP_PATH];
            readPaths = [node.source, ROADMAP_CONFIG];
            affected = [node];
            sourceStamp = [digest, createHash('sha256').update(next).digest('hex')];
            overrides.set(ROADMAP_PATH, next);
            documentChange = { path: ROADMAP_PATH, before: base, after: next };
            title = `Review roadmap status for ${request.entry}`;
            notes = ['Updates one ledger entry, the Sync Impact Report, and the patch version and amendment date. It does not change feature or GitHub status.'];
            execute = () => writeConfig(root, ROADMAP_PATH, next, base);
        } else if (operation === 'charter-source-save') {
            const path = node?.editableCharterSource;
            const owner = before.nodes.find(item => item.id === 'extension:charter');
            if (!path || owner?.healthStatus === 'blocked') throw invalid('Select an existing, enabled distributed Charter source with a ready Charter extension.');
            const proposed = request.text;
            if (typeof proposed !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(proposed) ||
                !proposed.trim() || Buffer.byteLength(proposed) > markdownSize) {
                throw invalid('Enter readable Markdown of 24 KiB or less.');
            }
            const { text: base, digest } = readReviewedMarkdown(root, path);
            const next = /\r\n/.test(base) && !/(?<!\r)\n/.test(base) ? proposed.replace(/\r?\n/g, '\r\n') : proposed;
            if (Buffer.byteLength(next) > markdownSize) throw invalid('The proposed source exceeds the size limit with its original line endings.');
            if (next === base) throw invalid('Change the source before opening a preview.');
            paths = [path];
            readPaths = [CHARTER_CONFIG, CHARTER_STATE];
            affected = [node];
            sourceStamp = digest;
            documentChange = { path, before: base, after: next };
            title = `Review ${node.name}`;
            notes = ['Writes only this package-owned Charter source. The generated project constitution is unchanged; Charter reads this source when it next composes.'];
            execute = () => writeConfig(root, path, next, base);
        } else if (operation === 'constitution-save') {
            const path = node?.editableConstitution;
            if (!path) throw invalid('The constitution is generated, or its source could not be verified. Use the owning integration to propose changes.');
            const next = request.text;
            if (typeof next !== 'string' || next.includes('\0') || !next.trim() || Buffer.byteLength(next) > 24 * 1024) {
                throw invalid('Enter a non-empty constitution of 24 KiB or less.');
            }
            const base = file(root, path);
            if (base === next) throw invalid('There are no constitution changes to preview.');
            sourceStamp = createHash('sha256').update(JSON.stringify(base)).digest('hex');
            overrides.set(path, next);
            paths = [path];
            affected = [node];
            documentChange = { path, before: base, after: next };
            title = base == null ? 'Review new constitution' : 'Review constitution replacement';
            notes = ['Only the reviewed Markdown is written. Plans, templates and generated agent files are not changed.'];
            execute = () => writeConfig(root, path, next, base);
        } else if (operation === 'preset-priority') {
            if (node?.kind !== 'Presets' || !node.installed || node.healthStatus === 'blocked') throw invalid('Select a valid installed preset.');
            if (before.nodes.some(item => item.id === 'preset:constitution-sync' && item.active)) {
                throw invalid('Priority changes can regenerate the managed constitution. Review its source and resolved layers before changing priority.');
            }
            const priority = request.priority;
            if (!Number.isSafeInteger(priority) || priority < 1 || priority > 99999) throw invalid('Enter a whole priority from 1 to 99999.');
            if (priority === node.priority) throw invalid('The preset already has this priority.');
            const path = '.specify/presets/.registry';
            const registry = JSON.parse(file(root, path));
            const args = ['preset', 'set-priority', node.key, String(priority)];
            if (probe) await cli(root, ['preset', 'set-priority', '--help'], true);
            registry.presets[node.key].priority = priority;
            overrides.set(path, registry);
            paths = [path];
            affected = [node];
            title = `Change priority for ${node.name}`;
            invocation = ['specify', ...args].join(' ');
            notes = ['A lower number takes precedence in template resolution. Existing spec documents and their project overrides are not edited.'];
            execute = async () => ({ output: (await cli(root, args)).slice(0, 6000) });
        } else if (['template-save', 'template-remove'].includes(operation)) {
            const path = node?.templateOverride;
            if (!path) throw invalid('Select a Markdown template or project override.');
            const base = file(root, path);
            const removing = operation === 'template-remove';
            const next = removing ? null : request.text;
            if (removing ? node.source !== path || base == null :
                typeof next !== 'string' || next.includes('\0') || !next.trim() || Buffer.byteLength(next) > 24 * 1024) {
                throw invalid(removing ? 'Select an existing project template override.' : 'Enter a non-empty Markdown template of 24 KiB or less.');
            }
            if (next === base) throw invalid('There are no template changes to preview.');
            const upstream = `.specify/templates/${path.split('/').at(-1)}`;
            const original = base ?? file(root, upstream);
            sourceStamp = createHash('sha256').update(JSON.stringify([base, original])).digest('hex');
            overrides.set(path, next);
            paths = [path];
            affected = [node];
            documentChange = { path, before: base, after: next };
            title = removing ? `Remove override for ${node.name}` : `${base == null ? 'Create' : 'Edit'} override for ${node.name}`;
            notes = [removing ? 'Spec Kit returns to its normal template resolution order. Existing specs and generated files are not changed.' :
                'Spec Kit gives the project override precedence. Existing specs, schemas, and generated files are not changed.'];
            execute = () => {
                if (removing) {
                    if (file(root, path) !== base) throw invalid('The template changed. Preview the edit again.', 409);
                    rmSync(workspaceEntry(root, path).target);
                } else writeConfig(root, path, next, base);
            };
        } else if (operation === 'configure') {
            const config = node?.configs?.find(item => item.path === request.path);
            if (!config || !node.installed) throw invalid('Select a configuration declared by an installed extension.');
            if (typeof request.values !== 'object' || !request.values || Array.isArray(request.values)) throw invalid('Enter configuration values before previewing.');
            const base = file(root, config.path);
            const source = base ?? (typeof config.template === 'string' ? file(root, `.specify/extensions/${node.key}/${config.template}`) : null);
            if (source == null) throw invalid('No readable configuration template is provided.');
            const parsed = load(source, { schema: JSON_SCHEMA });
            if (!object(parsed)) throw invalid('This configuration is not a mapping.');
            const next = structuredClone(parsed);
            if (!Object.keys(request.values).length) throw invalid('Enter at least one setting to preview.');
            for (const [key, value] of Object.entries(request.values)) {
                if (!Object.hasOwn(parsed, key) || !['string', 'number', 'boolean'].includes(typeof parsed[key]) || typeof parsed[key] !== typeof value ||
                    (typeof value === 'string' && value.length > 2000) || (typeof value === 'number' && !Number.isFinite(value))) throw invalid(`Unsupported value for ${key}.`);
                Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true });
            }
            if (node.effect === 'external-write' || node.effect === 'unknown') throw invalid('This extension can affect an external or unverified system. Its settings need a typed adapter to preview effects.');
            sourceStamp = createHash('sha256').update(source).digest('hex');
            paths = [config.path];
            affected = [node];
            title = `Configure ${node.name}`;
            const text = yaml(next);
            documentChange = { path: config.path, before: base, after: text };
            execute = () => writeConfig(root, config.path, text, base);
            notes = ['Only existing scalar settings are changed; complex and generated definitions remain read-only. The YAML is reserialized.'];
        } else if (managed && ['install', 'update', 'enable', 'disable', 'remove'].includes(operation)) {
            const [group, base, registryName, property, filename] = managed;
            const prefix = group === 'step' ? ['workflow', 'step'] : [group];
            if (group === 'step' && ['enable', 'disable'].includes(operation)) throw invalid('This runtime does not expose a step enable/disable operation.');
            const pathsFor = key => [`${base}/${registryName}`, `${base}/${key}/${filename}`];
            const key = node?.key ?? request.key;
            if (!safeId(key)) throw invalid('Enter a valid Spec Kit package identifier.');
            if ((operation === 'install') === Boolean(node?.installed)) throw invalid('The registration state changed. Reload the inspector and try again.');
            if (!node && operation !== 'install') throw invalid('Select an installed package.');
            const [registryPath, manifestPath] = pathsFor(key);
            if (before.findings.some(item => item.path === registryPath || group === 'extension' && item.path === HOOK_PATH)) throw invalid('Repair the runtime registry before changing registrations.');
            const registryBase = file(root, registryPath);
            const registry = JSON.parse(registryBase ?? '{}');
            registry[property] ??= {};
            if (!object(registry[property])) throw invalid(`Repair ${registryPath} before changing registrations.`);
            const record = Object.hasOwn(registry[property], key) ? registry[property][key] : null;
            if (operation !== 'install' && !object(record)) throw invalid('This package has no ready runtime registry record.');
            if (operation === 'install' && record) throw invalid('This package is already registered. Reload the inspector.');
            if (group === 'step' && operation === 'remove' && before.nodes.some(item => item.active && item.stepType === key)) {
                throw invalid('A registered workflow still uses this step type. Disable or update that workflow before removing the package.');
            }
            let args;
            let remote;
            let restoreDisabledPreset = false;
            const packagePaths = [];
            if (operation === 'install' || operation === 'update') {
                if (group === 'workflow') requireWorkflowRegistrationWithoutPlugins(root);
                const remoteSource = Object.hasOwn(request, 'remoteUrl');
                if (remoteSource && (group !== 'workflow' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(key) ||
                    ['overlays', 'runs', 'steps', 'functions'].includes(key))) throw invalid('Only standalone workflows support pinned remote sources.');
                const replacement = operation === 'update' && group === 'preset' ? new Map() : null;
                if (remoteSource) {
                    if (!workspaceEntry(root, '.specify')?.stat.isDirectory()) throw invalid('Initialize Spec Kit before registering a pinned workflow.');
                    remote = await fetchPinnedWorkflow(request.remoteUrl, request.sha256, fetchSource);
                    sourcePath = sourceFile(key, remote.hash);
                } else {
                    sourcePath = str(request.source, 'a reviewed repository-relative source directory', 300);
                    if (sourcePath.startsWith('-') || sourcePath === base || sourcePath.startsWith(`${base}/`) ||
                        !workspaceEntry(root, sourcePath)?.stat.isDirectory()) throw invalid('Choose a local package directory outside the installed registry.');
                }
                const digest = remote?.hash ?? packageDigest(root, sourcePath, replacement);
                const raw = remote?.text ?? file(root, `${sourcePath}/${filename}`);
                if (raw == null) throw invalid(`The source directory does not contain ${filename}.`);
                const retained = remote && file(root, sourcePath);
                if (retained != null && retained !== raw) throw invalid('A different file already occupies the retained source path.', 409);
                packageDefinition = { path: manifestPath, before: file(root, manifestPath), after: raw,
                    ...(remote ? { url: remote.url, sha256: digest } : {}) };
                sourceStamp = [digest, createHash('sha256').update(JSON.stringify(packageDefinition)).digest('hex')];
                readPaths = [remote?.url ?? `${sourcePath}/${filename}`];
                const manifest = remote ? parsePinnedWorkflow(raw) : load(raw, { schema: JSON_SCHEMA });
                const meta = manifest?.[group];
                if ((group === 'step' ? meta?.type_key : meta?.id) !== key || typeof meta?.version !== 'string') {
                    throw invalid(`The source must declare ${group} ${key} and its version.`);
                }
                if (group === 'extension' && rows(manifest?.provides?.commands).some(command => typeof command?.file !== 'string' || !workspaceEntry(root, `${sourcePath}/${command.file}`)?.stat.isFile())) {
                    throw invalid('A command in the source package is missing or outside the package.');
                }
                if (group === 'workflow' && !remote && readdirSync(workspaceEntry(root, sourcePath).target).some(name => name !== filename)) {
                    throw invalid('This workflow carries companion files whose effects cannot be previewed. Use a standalone reviewed workflow definition.');
                }
                if (group === 'step' && !workspaceEntry(root, `${sourcePath}/__init__.py`)?.stat.isFile()) {
                    throw invalid('This step package must contain a reviewed __init__.py.');
                }
                if (group === 'preset') {
                    if (!Array.isArray(manifest.provides?.templates) || !manifest.provides.templates.length) throw invalid('This preset does not declare any templates.');
                    for (const template of manifest.provides.templates) {
                        if (!safeId(template?.name) || typeof template.file !== 'string' || !workspaceEntry(root, `${sourcePath}/${template.file}`)?.stat.isFile()) {
                            throw invalid('A preset template is missing or outside its source directory.');
                        }
                        packagePaths.push(`${base}/${key}/${template.file}`);
                    }
                }
                const enabled = !['workflow', 'preset'].includes(group) || record?.enabled !== false;
                Object.defineProperty(registry[property], key, { value: { ...record, version: meta.version, enabled, source: remote?.url ?? 'local' }, enumerable: true, configurable: true, writable: true });
                overrides.set(manifestPath, manifest);
                args = [...prefix, 'add', ...(group === 'step' ? [key] : []), '--dev', sourcePath,
                    ...(operation === 'update' && group !== 'workflow' ? ['--force'] : [])];
                if (replacement) {
                    const installed = load(file(root, manifestPath) ?? '', { schema: JSON_SCHEMA });
                    const onlyTemplates = definition => Array.isArray(definition?.provides?.templates) &&
                        Object.keys(definition.provides).every(name => name === 'templates') &&
                        definition.provides.templates.every(template => template?.type === 'template' && template.name !== 'constitution-template');
                    if (!onlyTemplates(installed) || !onlyTemplates(manifest) || rows(manifest.requires?.extensions).length ||
                        before.nodes.some(item => item.id === 'preset:constitution-sync' && item.active)) {
                        throw invalid('Local preset replacement supports standalone template presets. Command, script, dependency, and constitution changes need their own review.');
                    }
                    const priority = Number.isSafeInteger(record.priority) && record.priority >= 1 ? record.priority : 10;
                    if (probe) {
                        const staged = mkdtempSync(join(tmpdir(), 'canvas-preset-'));
                        try {
                            writeTemporaryProject(staged, replacement);
                            await cli(staged, ['preset', 'add', '--dev', sourcePath, '--priority', String(priority)]);
                        } finally { rmSync(staged, { recursive: true, force: true }); }
                    }
                    args = ['preset', 'update', key, '--dev', sourcePath, '--priority', String(priority)];
                    restoreDisabledPreset = !enabled;
                }
            } else if (operation === 'remove') {
                delete registry[property][key];
                overrides.set(manifestPath, null);
                args = [...prefix, 'remove', key, ...(group === 'extension' ? ['--keep-config', '--force'] : [])];
            } else {
                record.enabled = operation === 'enable';
                args = [...prefix, operation, key];
            }
            overrides.set(registryPath, registry);
            paths = [registryPath, manifestPath, ...packagePaths, ...(group === 'preset' ? (node?.artifacts ?? []).filter(path => path.startsWith(`${base}/${key}/`)) : [])];
            const receiptPath = remote ? `${sourcePath}.json` : null;
            const receipt = remote ? json({ url: remote.url, sha256: remote.hash }) : null;
            if (remote) {
                const prior = file(root, receiptPath);
                if (prior !== null && prior !== receipt) throw invalid('These exact bytes already have a different retained source receipt.', 409);
                paths.push(sourcePath, receiptPath);
                validatePackage = () => registerPinnedWorkflow(root, sourcePath, remote.text, cli, true);
            }
            if (group === 'preset' && before.nodes.some(item => item.id === 'preset:constitution-sync' && item.active)) paths.push(CONSTITUTION);
            if (group === 'step') paths.push(`${base}/${key}/__init__.py`);
            if (group === 'extension') {
                const hooks = structuredClone(current.hookDocument ?? {});
                const manifest = overrides.get(manifestPath);
                const declared = Object.entries(manifest?.hooks ?? {}).flatMap(([event, value]) => rows(value).map(row => ({ event, optional: row?.optional !== false, priority: row?.priority ?? 10, command: row?.command })));
                if (declared.some(row => !safeId(row.event) || !safeId(row.command))) throw invalid('The local package declares an unsupported lifecycle hook.');
                projectHooks(hooks, key, operation, declared);
                overrides.set(HOOK_PATH, hooks);
                paths.push(HOOK_PATH);
            }
            if (probe) {
                const help = await cli(root, [...args.slice(0, prefix.length + 1), '--help'], true);
                for (const flag of args.filter(word => word.startsWith('--'))) if (!help.includes(flag)) throw invalid(`Installed Spec Kit does not support ${flag} for ${args.slice(0, prefix.length + 1).join(' ')}. Upgrade Spec Kit or use a supported alternative.`);
            }
            title = `${operation[0].toUpperCase()}${operation.slice(1)} ${node?.name ?? key}`;
            invocation = remote ? 'specify workflow add --dev <verified temporary YAML>' :
                ['specify', ...args].map(word => word.includes(' ') ? JSON.stringify(word) : word).join(' ');
            if (restoreDisabledPreset) invocation += `\nspecify preset disable ${key}`;
            affected = node ? [node] : [];
            notes = ['Spec Kit applies this change and regenerates its owned files. Review the refreshed graph for the actual result.',
                ...(remote ? ['Spec Kit validates the YAML in a temporary project. Confirmation rechecks the digest and registers a separate temporary copy, not the retained workspace file. The source and its receipt remain for inspection if registration fails. No workflow steps run.'] :
                    sourcePath ? [`Reviewed local source: ${sourcePath}. The preview predicts registration from the exact source digest; it does not execute package code.`] : []),
                ...(group === 'preset' && operation === 'update' ? ['The CLI validated the replacement in a temporary project. Its update removes the previous version before installing the replacement; restore the previous source if the update fails.'] : []),
                ...(group === 'step' && sourcePath ? ['Workflow step packages contain Python code that Spec Kit can execute later. Only register a source whose code you have reviewed.'] : [])];
            execute = async () => {
                if (group === 'workflow' && ['install', 'update'].includes(operation)) requireWorkflowRegistrationWithoutPlugins(root);
                if (remote) {
                    if (file(root, manifestPath) !== packageDefinition.before || file(root, registryPath) !== registryBase) {
                        throw invalid('The installed definition or registry changed. Open a new preview.', 409);
                    }
                    retainWorkflowSource(root, sourcePath, remote.text);
                    retainWorkflowSource(root, receiptPath, receipt);
                }
                const output = remote ? await registerPinnedWorkflow(root, sourcePath, remote.text, cli, false) : await cli(root, args);
                if (remote && file(root, manifestPath) !== remote.text) {
                    throw invalid('Spec Kit did not leave the reviewed bytes installed. Inspect the workflow before using it.', 409);
                }
                if (restoreDisabledPreset) await cli(root, ['preset', 'disable', key]);
                return { output: output.slice(0, 6000) };
            };
        } else {
            throw invalid('There is no verified mutation adapter for this item. Inspect the installed definition or use a reviewed source supported by this runtime.');
        }

        const after = overrides.size ? read(overrides).graph : before;
        const signature = finding => JSON.stringify([finding.code, finding.message, finding.nodeIds]);
        const existing = new Set(before.findings.filter(item => item.severity === 'blocked').map(signature));
        const existingAdvisories = new Set(before.findings.filter(item => item.severity === 'advisory').map(signature));
        const advisories = after.findings.filter(item => item.severity === 'advisory' && !existingAdvisories.has(signature(item)));
        const activation = ['install', 'update', 'enable', 'hook-toggle', 'hook-up', 'hook-down', 'hook-behavior',
            'native-override-add', 'native-override-up', 'native-override-down', 'native-override-configure', 'embedded-up', 'embedded-down', 'overlay-enable'].includes(operation);
        const newBlockers = after.findings.filter(item => item.severity === 'blocked' && (!existing.has(signature(item)) ||
            (activation && item.nodeIds.some(id => id === node?.id || id === edge?.owner) && !(operation === 'hook-toggle' && edge?.active))));
        if (probe && !newBlockers.length) await validatePackage?.();
        const diff = graphDiff(before, after);
        const changedNodes = [...affected, ...diff.nodes.added, ...diff.nodes.removed, ...diff.nodes.changed.map(item => item.after)];
        const changedEdges = [...diff.edges.added, ...diff.edges.removed, ...diff.edges.changed.map(item => item.after), ...triggered];
        const signatureInputs = [...current.inputs, sourcePath, sourceStamp];
        if (operation === 'run') {
            for (const path of [node?.commands.find(item => item.id === request.command)?.file, ...paths, ...readPaths].filter(Boolean)) {
                const entry = workspaceEntry(root, path);
                signatureInputs.push([path, entry?.stat.mtimeMs, entry?.stat.size]);
            }
        }
        const stamps = createHash('sha256').update(JSON.stringify(signatureInputs)).digest('hex');
        return {
            revision, root, stamps, execute, allowed: newBlockers.length === 0,
            preview: { title, invocation, diff, notes, paths: [...new Set(paths.filter(Boolean))], readPaths,
                artifacts: [...new Set([...changedNodes.flatMap(item => item.outputs), ...changedEdges.flatMap(item => item.writes ?? []),
                    ...(documentChange ? [documentChange.path] : []), ...(productChange?.documents ?? []).map(item => item.path)])],
                commands: [...new Set([...changedNodes.flatMap(item => item.commands.map(cmd => cmd.id)), ...changedEdges.map(item => item.command).filter(Boolean)])],
                hooks: [...new Set(changedEdges.map(item => item.hook).filter(Boolean))],
                external: [...new Set([...changedNodes.filter(item => item.effect === 'external-write').flatMap(item => item.outputs), ...changedEdges.flatMap(item => item.external ?? [])])],
                findings: newBlockers, advisories, ready: newBlockers.length === 0,
                config: operation === 'configure' ? request.values : null, documentChange, productChange, productArchive, externalChange, reviewChange, guidedChange, packageDefinition, localEvidence,
            },
        };
    }

    return {
        get changing() { return applying; },
        snapshot,
        async inspectComposition(id) {
            const { root, revision } = context();
            const node = snapshot().nodes.find(item => item.id === id && item.kind === 'Workflows' && item.installed);
            if (!node || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(node.key) ||
                ['overlays', 'runs', 'steps', 'functions'].includes(node.key)) throw invalid('Select an installed workflow to inspect.');
            const files = new Map([[node.source, file(root, node.source)]]);
            if (files.get(node.source) == null) throw invalid('The installed workflow definition is not readable.');
            for (const path of workflowOverlayPaths(root, node.key)) {
                const text = file(root, path);
                if (text == null) throw invalid(`The overlay ${path} is not a readable project file.`);
                files.set(path, text);
            }
            const staged = mkdtempSync(join(tmpdir(), 'canvas-compose-'));
            try {
                writeTemporaryProject(staged, files);
                await cli(staged, ['workflow', 'resolve', '--help'], true);
                const text = await cli(staged, ['workflow', 'resolve', node.key]);
                if (!text.trim()) throw invalid('Spec Kit returned no step attribution.');
                if (context().revision !== revision) throw invalid('The selected repository changed while inspecting composition.', 409);
                return { text, sources: [...files.keys()] };
            } finally { rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
        },
        githubTarget({ id, url }) {
            requireGitHubWriter(snapshot(), id);
            return github.inspect(url, true);
        },
        inspectConfig(id, path) {
            const { root } = context();
            const node = snapshot().nodes.find(item => item.id === id);
            if (node?.editableCharterSource && path === node.editableCharterSource) {
                return { path, text: readReviewedMarkdown(root, path).text, newFile: false };
            }
            if (node?.editableConstitution && path === node.editableConstitution) {
                const text = file(root, path);
                return { path, text: text ?? '', newFile: text == null };
            }
            if (node?.templateOverride && path === node.templateOverride) {
                const local = file(root, path);
                const text = local ?? file(root, node.source);
                if (text == null) throw invalid('No readable template is available.');
                return { path, text, newFile: local == null };
            }
            const config = node?.configs?.find(item => item.path === path);
            if (!config) throw invalid('Select a configuration from the inspector.');
            const local = file(root, path);
            const template = local ?? (typeof config.template === 'string' ? file(root, `.specify/extensions/${node.key}/${config.template}`) : null);
            const parsed = template == null ? null : load(template, { schema: JSON_SCHEMA });
            if (!object(parsed)) throw invalid('No editable configuration mapping is available.');
            return { path, newFile: local == null, fields: Object.entries(parsed).filter(([, value]) => ['string', 'boolean', 'number'].includes(typeof value)).map(([key, value]) => ({ key, value })) };
        },
        async testHook(id, fixtureKey) {
            const graph = snapshot();
            const edge = graph.edges.find(item => item.id === id && item.kind === 'hook');
            if (!edge) throw invalid('Select a Spec Kit lifecycle hook.');
            const { root, specs, specDirs } = context();
            const current = readWorkflow(root, specs, specDirs);
            const fixture = structuredClone(current.hookDocument);
            rows(fixture.hooks[edge.hook])[edge.index].enabled = true;
            const simulated = readWorkflow(root, specs, specDirs, new Map([[HOOK_PATH, fixture]])).graph;
            const fixtureResult = fixtureKey ? await testHookFixture(edge, fixtureKey) : null;
            return { edge: simulated.edges.find(item => item.id === id), findings: simulated.findings.filter(item => item.edgeIds.includes(id) || item.nodeIds.includes(edge.owner)),
                executed: Boolean(fixtureResult), fixture: fixtureResult };
        },
        async preview(request) {
            const reviewedAt = now();
            const proposal = await plan(request, true, reviewedAt);
            const issuedAt = now();
            for (const [id, entry] of pending) if (issuedAt - entry.issuedAt > 5 * 60_000 || entry.revision !== proposal.revision) pending.delete(id);
            if (pending.size >= 24) pending.delete(pending.keys().next().value);
            const id = proposal.allowed ? randomUUID() : null;
            if (id) pending.set(id, { request, revision: proposal.revision, root: proposal.root, stamps: proposal.stamps, reviewedAt, issuedAt });
            return { id, ...proposal.preview };
        },
        async apply(id) {
            if (applying || context().busy) throw invalid('Wait for the current canvas operation to finish.', 409);
            const pendingChange = pending.get(id);
            pending.delete(id);
            if (!pendingChange || now() - pendingChange.issuedAt > 5 * 60_000) throw invalid('Preview this operation again before confirming.', 409);
            applying = true;
            try {
                const proposal = await plan(pendingChange.request, false, pendingChange.reviewedAt);
                const active = context();
                if (!proposal.allowed || proposal.stamps !== pendingChange.stamps || proposal.root !== pendingChange.root ||
                    proposal.revision !== pendingChange.revision || active.revision !== proposal.revision || active.busy) {
                    throw invalid('The repository or validation changed after preview. Review a new preview before applying.', 409);
                }
                const result = await proposal.execute();
                changed();
                return { ...(result ?? {}), graph: snapshot() };
            } finally { applying = false; }
        },
    };
}
