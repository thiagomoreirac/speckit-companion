import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load, JSON_SCHEMA } from './vendor/workflow-yaml.mjs';
import { AUTOMATIC_HOOKS, PHASES, INTEGRATIONS, INTEGRATION_LINKS, MANAGEMENT, lifecycleNodes, hookStage, scopeProblem, validScope, validateGraph } from './workflow-model.mjs';
import { resolveCommand } from './prompts.mjs';
import { hookFixtures } from './workflow-hook-fixture.mjs';
import { composeReviewOverlay, isReviewArtifactPath, reviewGates, reviewOverlayPath } from './workflow-review-run.mjs';
import { issueLabelStep } from './workflow-github.mjs';
import { guidedReview } from './workflow-guided-run.mjs';
import { sourceFile, validPinnedUrl } from './workflow-remote.mjs';
import { ROADMAP_CONFIG, ROADMAP_PATH, ROADMAP_STATUSES, parseRoadmap } from './workflow-roadmap.mjs';
import { WIREFRAME_CONFIG, standardWireframeFeature } from './workflow-wireframe.mjs';
import { ADR_DIR, standardAdr } from './workflow-adr.mjs';
import { PRODUCT_ARCHIVE, PRODUCT_CHANGES, PRODUCT_CONFIG, PRODUCT_MODEL, productChangeStatus, standardProductChange } from './workflow-product.mjs';

export const POLICY_PATH = '.speckit-companion/workflow-policy.json';
export const HOOK_PATH = '.specify/extensions.yml';
export const NATIVE_HOOK_PATH = '.specify/integration-events.yml';
export const TEMPLATE_OVERRIDES = '.specify/templates/overrides';
export const BUNDLE_RECORDS = '.specify/bundle-records.json';
export const CONSTITUTION = '.specify/memory/constitution.md';
export const CHARTER_CONFIG = '.specify/charter/config.yml';
export const CHARTER_STATE = '.specify/charter/state.yml';
export const CATALOG_TYPES = ['extension', 'preset', 'workflow', 'step', 'bundle'];
export const catalogPath = type => `.specify/${type}-catalogs.yml`;
export const catalogKey = (type, row) => type === 'bundle' ? row?.id : row?.name;
export function catalogPolicy(type, row) {
    if (type === 'bundle') {
        const policy = typeof row?.install_policy === 'string' ? row.install_policy.trim().toLowerCase() : null;
        return policy === 'install-allowed' ? true : policy === 'discovery-only' ? false : null;
    }
    const policy = row?.install_allowed;
    if (typeof policy === 'string') return ['true', 'yes', '1'].includes(policy.trim().toLowerCase());
    if (typeof policy === 'boolean' || policy == null) return Boolean(policy);
    return null;
}
export const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
export const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : typeof value === 'string' ? [value] : [];
export const hookPriority = value => Number.isSafeInteger(value) && value >= 1 ? value : 10;
const list = value => Array.isArray(value) ? value : value == null ? [] : [value];
const entries = value => object(value) ? Object.entries(value) : [];
const unique = values => [...new Set(values.filter(Boolean))];
const MAX_FILE = 512 * 1024;
const MAX_DIR = 384;
const WORKFLOW_RUNS = '.specify/workflows/runs';
const WORKFLOW_OVERLAYS = '.specify/workflows/overlays';
const OVERLAY_OPERATIONS = ['insert_after', 'insert_before', 'replace', 'remove'];
const validOverlayId = value => safeId(value) && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) && value !== 'overlays';
const RUN_STATES = new Set(['created', 'running', 'paused', 'completed', 'failed', 'aborted']);
const BUILTIN_STEP_TYPES = new Set(['command', 'prompt', 'gate', 'shell', 'github', 'workflow', 'init', 'if', 'switch', 'while', 'do-while', 'fan-out', 'fan-in', 'slot']);
const nestedSteps = step => [
    ...['then', 'else', 'steps', 'default'].flatMap(key => Array.isArray(step[key]) ? [[key, step[key]]] : []),
    ...entries(step.cases).filter(([, values]) => Array.isArray(values)).map(([key, values]) => [`case ${key}`, values]),
    ...(object(step.step) ? [['fan-out template', [step.step]]] : []),
];

function overlayEdits(config, workflow) {
    if (!validOverlayId(config?.id) || config.extends !== workflow ||
        (Object.hasOwn(config, 'enabled') && typeof config.enabled !== 'boolean') ||
        !Array.isArray(config.edits) || !config.edits.length || config.edits.length > MAX_DIR) return null;
    const edits = [];
    for (const edit of config.edits) {
        if (!object(edit)) return null;
        const keys = OVERLAY_OPERATIONS.filter(key => Object.hasOwn(edit, key));
        if (keys.length > 1 || (keys.length && Object.hasOwn(edit, 'operation'))) return null;
        const operation = keys[0] ?? edit.operation;
        const anchor = keys.length ? edit[operation] : edit.anchor;
        if (!OVERLAY_OPERATIONS.includes(operation) || typeof anchor !== 'string' || !anchor.trim() ||
            (operation === 'remove' ? edit.step != null : !object(edit.step) || !safeId(edit.step.id))) return null;
        edits.push({ operation, anchor, step: edit.step });
    }
    return edits;
}

function overlayTypes(edits) {
    const pending = edits.flatMap(edit => edit.step ? [edit.step] : []);
    const types = new Set();
    for (let count = 0; pending.length; count++) {
        const step = pending.pop();
        if (!object(step) || count >= MAX_DIR) { types.add('unknown'); break; }
        types.add(typeof step.type === 'string' ? step.type : 'command');
        for (const [, children] of nestedSteps(step)) {
            if (pending.length + children.length > MAX_DIR) { types.add('unknown'); return [...types]; }
            for (const child of children) pending.push(child);
        }
    }
    return [...types].sort();
}

const NATIVE_EVENTS = new Map([
    ['session_start', 'intent'], ['user_prompt_submit', 'intent'],
    ['pre_tool_use', 'implement'], ['post_tool_use', 'implement'],
    ['stop', 'verify'], ['session_end', 'verify'],
]);

const validNativeHandler = handler => object(handler) && typeof handler.command === 'string' && Boolean(handler.command.trim()) &&
    (!Object.hasOwn(handler, 'matcher') || typeof handler.matcher === 'string') &&
    (!Object.hasOwn(handler, 'timeout') || Number.isSafeInteger(handler.timeout) && handler.timeout > 0);

function hookBoundary(provider, approval) {
    const effect = provider?.effect ?? 'unknown';
    return {
        effect, approval: provider?.approval === 'confirm' ? 'confirm' : approval,
        reads: provider?.inputs ?? [], writes: effect === 'read-only' ? [] : provider?.outputs ?? [],
        external: effect === 'external-write' ? provider.outputs : [],
    };
}

export function workspaceEntry(root, path) {
    if (typeof path !== 'string' || path.length > 420) return null;
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)
        || (process.platform === 'win32' && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))))) return null;
    let target = root, stat;
    for (const part of parts) {
        target = join(target, part);
        try { stat = lstatSync(target); }
        catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
            throw error;
        }
        if (stat.isSymbolicLink()) return null;
    }
    return { target, stat };
}

function document(root, path) {
    const entry = workspaceEntry(root, path);
    if (!entry?.stat.isFile()) return null;
    if (entry.stat.size > MAX_FILE) throw new Error('File exceeds the inspection size limit.');
    return readFileSync(entry.target, 'utf8');
}

function directory(root, path) {
    const entry = workspaceEntry(root, path);
    if (!entry?.stat.isDirectory()) return [];
    return readdirSync(entry.target, { withFileTypes: true })
        .filter(item => item.isFile() || item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_DIR);
}

export function workflowOverlayPaths(root, key) {
    if (!safeId(key)) throw new Error('Invalid workflow identifier for project overlays.');
    const relative = `${WORKFLOW_OVERLAYS}/${key}`;
    let target = root;
    for (const part of relative.split('/')) {
        target = join(target, part);
        const stat = lstatSync(target, { throwIfNoEntry: false });
        if (!stat) return [];
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project overlays must use regular repository directories.');
    }
    const entries = readdirSync(target, { withFileTypes: true })
        .filter(item => /\.ya?ml$/.test(item.name) && !item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > 32) throw new Error('The canvas can inspect at most 32 project overlays per workflow.');
    if (entries.some(item => !item.isFile())) throw new Error('Project overlays must be regular files, not symbolic links.');
    return entries.map(item => `${relative}/${item.name}`);
}

export function inspectWorkflowArtifact(root, graph, id, path) {
    const node = graph.nodes.find(item => item.id === id);
    if (!node?.artifacts.includes(path)) throw new Error('Select an artifact from the inspector.');
    const text = document(root, path);
    if (text == null) throw new Error('This artifact is a directory or is no longer available.');
    return { path, text };
}

const health = (code, message) => ({ code, message });

function readInput(root, path, format, findings, overrides, inputs) {
    try {
        const text = document(root, path);
        inputs.set(path, text === null ? null : createHash('sha256').update(text).digest('hex'));
        if (overrides.has(path)) return overrides.get(path);
        if (text == null) return null;
        const parsed = format === 'json' ? JSON.parse(text) : load(text, { schema: JSON_SCHEMA });
        if (!object(parsed)) throw new Error('Expected a mapping.');
        return parsed;
    } catch (error) {
        findings.push({ code: 'malformed-file', severity: 'blocked', message: `${path}: ${String(error.reason ?? error.message).split('\n')[0]}`, nodeIds: [], edgeIds: [], path });
        return null;
    }
}

function compatibility(version, constraint) {
    if (!constraint) return null;
    const parse = text => typeof text === 'string' && /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.]?(dev|a|b|rc)[.-]?(\d*)|\+[\w.-]+)?$/.exec(text);
    const base = parse(version);
    if (!base || typeof constraint !== 'string') return health('unverified-version', `Cannot verify the required Spec Kit version (${constraint}). Use a runtime with a recorded compatible version.`);
    const phase = value => ({ dev: -4, a: -3, b: -2, rc: -1 })[value] ?? 0;
    for (const part of constraint.split(',')) {
        const match = /^\s*(>=|<=|==|!=|>|<|=)?\s*(\S+)\s*$/.exec(part);
        const required = match && parse(match[2]);
        if (!required) return health('unverified-version', `Version constraint ${constraint} is not understood by the canvas.`);
        const diff = [1, 2, 3].map(index => Number(base[index] ?? 0) - Number(required[index] ?? 0)).find(Boolean)
            || phase(base[4]) - phase(required[4]) || Number(base[5] ?? 0) - Number(required[5] ?? 0);
        const matches = { '>=': diff >= 0, '<=': diff <= 0, '==': diff === 0, '=': diff === 0, '!=': diff !== 0, '>': diff > 0, '<': diff < 0 };
        if (!matches[match[1] ?? '=']) return health('incompatible-version', `Spec Kit ${version} does not meet ${constraint}. Install a compatible version before enabling this integration.`);
    }
    return null;
}

const defaultNode = (id, name, kind, source, extras = {}) => ({
    id, key: id, name, kind, category: kind, stage: 'stage:intent', phase: 'intent', source,
    inputs: ['Repository configuration'], outputs: ['Runtime metadata'], active: true, state: 'installed',
    effect: 'read-only', approval: 'none', authority: 'Runtime inventory', artifacts: [], commands: [], ...extras,
});

export function readWorkflow(root, specs = [], specDirs = [], overrides = new Map()) {
    const findings = [], nodes = lifecycleNodes(), edges = [], inputs = new Map();
    const read = (path, format = 'yaml') => readInput(root, path, format, findings, overrides, inputs);
    const exists = path => Boolean(workspaceEntry(root, path)?.stat.isFile());
    const dirs = path => directory(root, path).filter(item => item.isDirectory() && safeId(item.name)).map(item => item.name);
    const files = path => directory(root, path).filter(item => item.isFile() && /\.(md|json|ya?ml|toml|svg|html|mmd)$/i.test(item.name)).map(item => `${path}/${item.name}`);
    const init = read('.specify/init-options.json', 'json');
    const integration = read('.specify/integration.json', 'json');
    const version = init?.speckit_version ?? integration?.version ?? null;
    const integrationKey = integration?.integration ?? init?.integration ?? null;
    const registryPath = '.specify/extensions/.registry';
    const extensionRegistry = read(registryPath, 'json');
    const hookDocument = read(HOOK_PATH);
    const policy = read(POLICY_PATH, 'json');
    const stage = key => nodes.find(item => item.id === key);
    const addEdge = (kind, source, target, label, extras = {}) => {
        edges.push({ id: `${kind}:${source}:${target}:${label}`, kind, source, target, label, hook: null, effect: 'read-only', approval: 'none', active: true, ...extras });
    };
    const warning = (code, severity, message, nodeIds = [], edgeIds = []) => findings.push({ code, severity, message, nodeIds, edgeIds });
    const overlaysByWorkflow = new Map();
    function overlaysFor(key) {
        if (!overlaysByWorkflow.has(key)) {
            try {
                const paths = workflowOverlayPaths(root, key);
                const candidate = reviewOverlayPath(key);
                if (overrides.has(candidate) && !paths.includes(candidate)) paths.push(candidate);
                overlaysByWorkflow.set(key, { layers: paths.filter(path => overrides.get(path) !== null).map(path => [path, read(path)]) });
            } catch (error) { overlaysByWorkflow.set(key, { error: error.message }); }
        }
        return overlaysByWorkflow.get(key);
    }
    const nativeDocument = read(NATIVE_HOOK_PATH);
    const nativeSettings = nativeDocument?.integrations;
    const hasNativeOverride = safeId(integrationKey) && object(nativeSettings) && Object.hasOwn(nativeSettings, integrationKey);
    const overrideEvents = hasNativeOverride ? nativeSettings[integrationKey]?.events : null;
    const validOverride = object(overrideEvents) && entries(overrideEvents).every(([event, value]) => {
        const handlers = list(value).filter(object);
        return NATIVE_EVENTS.has(event) && handlers.length && handlers.every(validNativeHandler);
    });
    if ((hasNativeOverride && !validOverride) || (nativeDocument && Object.hasOwn(nativeDocument, 'integrations') && !object(nativeSettings))) {
        findings.push({ code: 'malformed-native-override', severity: 'blocked',
            message: `${NATIVE_HOOK_PATH} does not provide a valid event override for the selected integration. Spec Kit may keep its inherited handlers.`,
            nodeIds: [], edgeIds: [], path: NATIVE_HOOK_PATH });
    }
    if (extensionRegistry && !object(extensionRegistry.extensions)) {
        findings.push({ code: 'malformed-registry', severity: 'blocked', message: 'The extension registry must declare an extensions mapping.', nodeIds: [], edgeIds: [], path: registryPath });
    }
    const malformedRegistry = findings.some(item => item.path === registryPath);
    if (hookDocument?.hooks != null && !object(hookDocument.hooks)) {
        findings.push({ code: 'malformed-file', severity: 'blocked', message: `${HOOK_PATH}: expected a hooks mapping.`, nodeIds: [], edgeIds: [], path: HOOK_PATH });
    }

    for (const [id, name, kind, paths, key] of [
        ['presets', 'Preset overlays', 'Presets', ['.specify/presets/.registry'], 'intent'],
        ['workflows', 'Workflow definitions', 'Workflows', ['.specify/workflows/workflow-registry.json'], 'intent'],
        ['bundles', 'Integration bundles', 'Bundles', [BUNDLE_RECORDS], 'intent'],
        ['catalogs', 'Catalog & install policy', 'Catalogs', ['.specify/extension-catalogs.yml'], 'intent'],
        ['commands', 'Commands & agent skills', 'Commands and skills', ['.specify/integration.json'], 'specify'],
        ['templates', 'Templates & schemas', 'Templates and schemas', [], 'specify'],
        ['runs', 'Companion run record', 'Features and specs', [], 'verify'],
    ]) {
        const path = paths.find(exists);
        const checkpoint = stage(`stage:${key}`);
        const node = defaultNode(`inventory:${id}`, name, 'Workflow inputs', path ?? 'Spec Kit runtime inventory', {
            stage: checkpoint.id, phase: checkpoint.phase, state: path ? 'installed' : 'available', category: kind, artifacts: paths.filter(exists),
            authority: id === 'runs' ? 'Companion run record' : 'Runtime inventory',
        });
        nodes.push(node);
        addEdge('reference', node.id, checkpoint.id, name);
    }

    for (const [source, target] of [
        ['intent', 'ideas'], ['ideas', 'intake'], ['intent', 'constitution'], ['constitution', 'product'],
        ['product', 'decisions'], ['intake', 'specify'], ['product', 'specify'], ['specify', 'clarify'],
        ['clarify', 'design'], ['clarify', 'plan'], ['decisions', 'roadmap'], ['roadmap', 'plan'],
        ['design', 'plan'], ['plan', 'tasks'], ['tasks', 'implement'], ['implement', 'verify'],
        ['tasks', 'sync'], ['verify', 'release'], ['release', 'archive'],
    ]) {
        const node = stage(`stage:${target}`);
        addEdge('lifecycle', `stage:${source}`, node.id, node.name, { effect: node.effect, approval: node.approval });
    }

    const registered = new Map(entries(extensionRegistry?.extensions));
    const configured = new Set(strings(hookDocument?.installed));
    const owners = new Map(INTEGRATIONS.map(item => [item.key, item]));
    const keys = unique([...owners.keys(), ...registered.keys(), ...configured, ...dirs('.specify/extensions').filter(key => !key.startsWith('.')),
        ...[...overrides.keys()].flatMap(path => /^\.specify\/extensions\/([^/]+)\/extension\.yml$/.exec(path)?.[1] ?? [])]);
    for (const key of keys.filter(safeId)) {
        const proposed = owners.get(key);
        const id = `extension:${key}`;
        const base = `.specify/extensions/${key}`;
        const path = `${base}/extension.yml`;
        const manifest = read(path);
        const meta = manifest?.extension;
        const registry = registered.get(key);
        if (overrides.get(path) === null && !registry && !configured.has(key) && !proposed) continue;
        const present = registry != null || configured.has(key) || manifest != null || (!overrides.has(path) && exists(path));
        let problem = present && !manifest ? health(exists(path) ? 'malformed-extension' : 'missing-manifest', `${path} is ${exists(path) ? 'not a readable manifest' : 'missing'}. Reinstall or repair the registration.`) : null;
        if (present && (malformedRegistry || (registry != null && (!object(registry) || registry.enabled != null && typeof registry.enabled !== 'boolean')))) {
            problem ??= health('malformed-registration', `Repair ${key}'s extension registry entry before running this integration.`);
        }
        if (manifest && (manifest.schema_version !== '1.0' || meta?.id !== key || !/^[a-z0-9-]+$/.test(key) ||
                !['name', 'version', 'description'].every(field => typeof meta?.[field] === 'string') ||
                typeof manifest.requires?.speckit_version !== 'string' || !object(manifest.provides) ||
                (manifest.provides.commands != null && !Array.isArray(manifest.provides.commands)) ||
                (manifest.hooks != null && !object(manifest.hooks)) || (manifest.events != null && !object(manifest.events)))) {
            problem = health('malformed-extension', `${path} must declare a supported schema, matching extension metadata, version requirement and valid command declarations.`);
        }
        if (manifest && !registry && !configured.has(key)) problem ??= health('orphaned-extension', `${path} is not registered. Register the source with Spec Kit before running it.`);
        problem ??= compatibility(version, manifest?.requires?.speckit_version);
        if (meta?.version && registry?.version && meta.version !== registry.version) problem ??= health('version-drift', 'The manifest and registry versions differ. Repair or reinstall the extension.');
        if (list(manifest?.provides?.commands).some(command => !safeId(command?.name))) problem ??= health('malformed-extension', `${path} declares an invalid command.`);
        const enabled = present && (registry?.enabled !== false);
        const member = proposed ?? { id, key, name: key, category: 'Installed integration', stage: 'stage:implement', source: path, authority: null, inputs: ['Installed command context'], outputs: [], mode: 'manual', approval: 'manual' };
        const commands = list(manifest?.provides?.commands).filter(item => safeId(item?.name)).map(item => ({
            id: item.name, name: item.description ?? item.name,
            aliases: strings(item.aliases).filter(safeId), file: typeof item.file === 'string' ? `${base}/${item.file}` : null,
        }));
        const artifacts = unique([manifest && path, ...commands.map(item => item.file), ...['config', 'templates', 'scripts'].flatMap(group => list(manifest?.provides?.[group]).map(item => {
            const file = group === 'config' ? item?.name : item?.file;
            return typeof file === 'string' ? `${base}/${file}` : null;
        }))]).filter(exists);
        if (commands.some(command => !command.file || (!exists(command.file) && !overrides.has(path)))) {
            problem ??= health('broken-command-file', `${path} references a command file that is missing or outside its extension.`);
        }
        const declared = manifest?.['x-companion'];
        const hooks = entries(hookDocument?.hooks).flatMap(([, rows]) => list(rows).filter(row => row?.extension === key));
        const auto = hooks.some(row => row.enabled !== false) || entries(manifest?.events).some(([, value]) => list(value).length);
        const effect = member.effect === 'external-write' || declared?.effect === 'external-write' || ['write-external', 'external-write'].includes(meta?.effect) ? 'external-write'
            : member.effect ?? (key === 'git' ? 'local-write' : meta?.effect === 'read-only' ? 'read-only' : ['local-write', 'read-write'].includes(declared?.effect) ? 'local-write' : 'unknown');
        const authority = key === 'figma' && commands.some(command => /[.-](import|specify|import-to-spec)$/.test(command.id)) ? 'Screen-to-spec import'
            : member.authority ?? (typeof declared?.authority === 'string' ? declared.authority : null);
        const node = defaultNode(id, typeof meta?.name === 'string' ? meta.name : member.name, 'Extensions', present ? path : member.source, {
            ...member, name: member.name === key && typeof meta?.name === 'string' ? meta.name : member.name,
            source: manifest ? path : member.source, origin: registry?.source ?? meta?.repository ?? member.source,
            phase: stage(member.stage).phase, state: problem ? (problem.code === 'incompatible-version' ? 'incompatible' : problem.code === 'missing-manifest' ? 'missing' : 'blocked') : !present ? 'proposed' : enabled ? 'enabled' : 'disabled',
            installed: present, active: enabled, health: problem, note: meta?.description,
            version: meta?.version ?? registry?.version ?? null, requirement: manifest?.requires?.speckit_version ?? null,
            prerequisites: list(manifest?.requires?.tools).map(tool => `${tool?.name ?? tool}${tool?.required ? ' (required; availability not checked)' : ' (optional)'}`),
            mode: auto || member.mode === 'primary' || authority && authority !== member.authority || strings(declared?.writes).length ? 'primary' : 'manual',
            approval: effect === 'external-write' ? 'confirm' : member.approval, effect, authority,
            fixedAuthority: INTEGRATIONS.some(item => item.authority.toLowerCase() === authority?.toLowerCase()),
            declaredWrites: strings(declared?.writes),
            inputs: unique([...member.inputs, ...strings(declared?.reads)]),
            outputs: unique([...member.outputs, ...strings(declared?.writes)]),
            requires: unique([...(member.requires ?? []), ...strings(declared?.requires).map(dependency => dependency.includes(':') ? dependency : `extension:${dependency}`)]),
            artifacts, commands, hooks: [], configs: list(manifest?.provides?.config).filter(item => safeId(item?.name)).map(item => ({ name: item.name, template: item.template, path: `${base}/${item.name}` })),
            declaredHooks: entries(manifest?.hooks).flatMap(([event, rows]) => safeId(event) ? list(rows).filter(row => safeId(row?.command)).map(row => ({ event, command: row.command, optional: row.optional !== false, priority: Number.isInteger(row.priority) ? row.priority : 10 })) : []),
        });
        nodes.push(node);
        addEdge('participant', node.stage, id, node.category, { effect: node.effect, approval: node.approval, active: node.active });
        for (const dependency of node.requires) addEdge('dependency', dependency, id, 'Prerequisite', { active: node.active });
        for (const [event, value] of entries(manifest?.events)) {
            for (const [index, item] of list(value).entries()) {
                if (!NATIVE_EVENTS.has(event) || Array.isArray(value) || !validNativeHandler(item) || !safeId(item.command)) {
                    warning('malformed-native-event', 'blocked', `Invalid native event in ${node.name}: ${event}.`, [id]);
                    continue;
                }
                const command = commands.find(candidate => candidate.id === item.command || candidate.id === `speckit.${item.command}`)?.id ?? item.command;
                const life = `stage:${NATIVE_EVENTS.get(event)}`;
                const after = ['post_tool_use', 'stop', 'session_end'].includes(event);
                addEdge('native-hook', after ? life : id, after ? id : life, command, {
                    id: `native:${key}:${event}:${index}`, owner: id, hook: event, command, active: node.active,
                    ...hookBoundary(node, 'runtime'), path,
                    condition: item.matcher, timeout: item.timeout, nativeLayer: 'extension',
                    nativeConfiguration: validOverride ? 'replaced' : 'inherited',
                    description: validOverride ?
                        `The ${integrationKey} integration declares a replacement in ${NATIVE_HOOK_PATH}. This manifest hook may still apply to other integrations or stale generated agent settings.` :
                        'Native agent event declared by the extension. Disable the extension through Spec Kit to turn it off, then verify the integration refreshed.',
                });
                node.hooks.push(edges.at(-1).id);
            }
        }
    }

    const nativeEventOverrideSupported = ['claude', 'copilot'].includes(integrationKey) && /^1\.4\.1(?:\.dev0)?$/.test(version ?? '');
    const canMuteNativeEvents = nativeEventOverrideSupported && !findings.some(item => item.path === NATIVE_HOOK_PATH) &&
        (!validOverride || Object.keys(overrideEvents).length > 0);
    if (validOverride || canMuteNativeEvents) {
        const owner = defaultNode(`native-events:${integrationKey}`, `${integrationKey} native event override`, 'Hooks', NATIVE_HOOK_PATH, {
            installed: validOverride, active: validOverride, state: validOverride ? 'installed' : 'proposed',
            effect: 'unknown', approval: 'inspect', artifacts: validOverride ? [NATIVE_HOOK_PATH] : [],
            hooks: [], canMuteNativeEvents,
            note: validOverride
                ? 'This replaces inherited native handlers for the selected integration when Spec Kit regenerates its settings. The canvas cannot verify which generated settings an agent currently uses.'
                : 'No override is configured for this integration. Spec Kit can inherit built-in and extension handlers.',
        });
        nodes.push(owner);
        for (const [event, value] of validOverride ? entries(overrideEvents) : []) {
            const life = `stage:${NATIVE_EVENTS.get(event)}`;
            const after = ['post_tool_use', 'stop', 'session_end'].includes(event);
            for (const [order, handler] of list(value).filter(object).entries()) {
                const providers = nodes.filter(node => node.kind === 'Extensions' && node.active &&
                    node.commands.some(command => command.id === handler.command));
                const provider = providers.length === 1 ? providers[0] : null;
                const id = `native-override:${integrationKey}:${event}:${order}`;
                addEdge('native-hook', after ? life : owner.id, after ? owner.id : life, handler.command, {
                    id, owner: provider?.id ?? owner.id, hook: event, command: handler.command, order, runOrder: order + 1,
                    condition: handler.matcher, timeout: handler.timeout, path: NATIVE_HOOK_PATH, nativeLayer: 'override',
                    editable: list(value).every(object), canMoveLater: order + 1 < list(value).length,
                    ...hookBoundary(provider, 'runtime'),
                    description: 'Configured native override; the generated agent settings are not verified.',
                });
                owner.hooks.push(id);
                provider?.hooks.push(id);
            }
        }
    }

    for (const [source, target, label] of INTEGRATION_LINKS) addEdge('reference', `extension:${source}`, `extension:${target}`, label, { active: false });
    for (const [event, value] of entries(hookDocument?.hooks)) {
        if (!safeId(event)) continue;
        const ordered = list(value).map((row, index) => ({ row, index })).sort((a, b) => hookPriority(a.row?.priority) - hookPriority(b.row?.priority));
        let lastEnabled = 0;
        for (const [order, { row, index }] of ordered.entries()) {
            if (!safeId(row?.extension) || !safeId(row?.command) ||
                [row.enabled, row.optional].some(value => value != null && typeof value !== 'boolean') ||
                (row.priority != null && !Number.isInteger(row.priority))) {
                warning('malformed-hook', 'blocked', `Invalid hook entry at ${event}, row ${index + 1}.`);
                continue;
            }
            const owner = `extension:${row.extension}`;
            const node = stage(owner);
            const life = `stage:${hookStage(event)}`;
            const before = !event.startsWith('after');
            addEdge('hook', before ? owner : life, before ? life : owner, row.command, {
                id: `hook:${event}:${index}`, hook: event, index, owner, command: row.command,
                active: row.enabled !== false, ...hookBoundary(node, row.optional !== false ? 'optional' : 'required'),
                order, runOrder: row.enabled !== false ? ++lastEnabled : null, priority: hookPriority(row.priority),
                condition: typeof row.condition === 'string' ? row.condition : null,
                description: row.description ?? null, path: HOOK_PATH,
            });
            node?.hooks.push(edges.at(-1).id);
            for (const dependency of strings(row.depends_on)) addEdge('dependency', dependency, owner, `Hook dependency: ${event}`, { active: row.enabled !== false });
        }
    }
    const companionPath = '.specify/companion.yml';
    const companionConfig = read(companionPath);
    const recipe = typeof companionConfig?.workflow === 'string' ? companionConfig.workflow.trim() : '';
    const embeddedPath = recipe && safeId(recipe) ? `.specify/companion/workflows/${recipe}.yml` : companionPath;
    const embedded = recipe === 'shipped' ? null : !recipe ? companionConfig : safeId(recipe) ? read(embeddedPath) : null;
    if (recipe && recipe !== 'shipped' && !embedded) {
        warning('missing-companion-recipe', 'blocked', `The selected Companion workflow cannot be read from ${embeddedPath}.`, ['extension:companion']);
    }
    const companion = stage('extension:companion');
    if (companion) companion.artifacts.push(...unique([companionPath, recipe !== 'shipped' && embeddedPath]).filter(exists));
    for (const [command, config] of entries(embedded?.commands)) {
        for (const [timing, points] of entries(config?.hooks)) {
            if (!['before', 'after'].includes(timing)) continue;
            for (const [point, values] of entries(points)) {
                for (const [index, item] of list(values).entries()) {
                    if (!object(item) || !['node', 'skill', 'command', 'prompt'].includes(item.type)) {
                        warning('malformed-embedded-hook', 'advisory', `Companion ignores an invalid hook at ${command}.${timing}.${point}, item ${index + 1}.`, ['extension:companion']);
                        continue;
                    }
                    const owner = 'extension:companion', life = `stage:${hookStage(command)}`;
                    const active = Boolean(stage(owner)?.active && !stage(owner)?.health);
                    addEdge('embedded-hook', timing === 'before' ? owner : life, timing === 'before' ? life : owner, item.ref ?? item.type ?? 'Embedded hook', {
                        id: `embedded:${command}:${timing}:${point}:${index}`, owner, hook: `${timing}.${command}.${point}`, active,
                        effect: 'unknown', approval: 'inspect', path: embeddedPath, order: index,
                        runOrder: active ? index + 1 : null, background: item.background === true,
                        commandKey: command, timing, anchor: point, editable: Array.isArray(values), canMoveLater: index + 1 < list(values).length,
                        description: 'Order is local to this anchor. The Companion runtime resolves which anchors run; this view does not execute these agent instructions.',
                    });
                    companion?.hooks.push(edges.at(-1).id);
                    if (item.type === 'node' && safeId(item.ref) && !exists(`.specify/companion/nodes/${item.ref}.md`)) {
                        warning('broken-reference', 'advisory', `Embedded hook references ${item.ref}; verify it is supplied by the Companion package.`, [owner], [edges.at(-1).id]);
                    }
                    if (active) warning('unverified-embedded-effect', 'blocked',
                        `Embedded hook ${timing}.${command}.${point} has unverified effects. Use a command that does not trigger it, or remove it and regenerate the affected command before dispatch.`,
                        [], [edges.at(-1).id]);
                }
            }
        }
    }

    const bundleRecords = read(BUNDLE_RECORDS, 'json');
    const componentTypes = new Map([['presets', 'preset'], ['extensions', 'extension'], ['workflows', 'workflow'], ['steps', 'step-package']]);
    if (bundleRecords && (!Array.isArray(bundleRecords.bundles) || !/^1(?:\.\d+)?$/.test(bundleRecords.schema_version))) {
        warning('malformed-bundle', 'blocked', `${BUNDLE_RECORDS} must declare a supported schema version and bundles list.`);
    }
    for (const record of list(bundleRecords?.bundles)) {
        if (!safeId(record?.bundle_id)) {
            warning('malformed-bundle', 'blocked', `Invalid bundle record in ${BUNDLE_RECORDS}.`);
            continue;
        }
        const id = `bundle:${record.bundle_id}`;
        if (stage(id)) {
            warning('malformed-bundle', 'blocked', `Duplicate bundle record: ${record.bundle_id}.`, [id]);
            continue;
        }
        const node = defaultNode(id, record.bundle_id, 'Bundles', BUNDLE_RECORDS, {
            key: record.bundle_id, installed: true, version: record.version, origin: record.source, artifacts: [BUNDLE_RECORDS], approval: 'confirm',
            canRemoveRecord: Array.isArray(record.contributed_components) && record.contributed_components.length === 0,
            canRefreshRecord: Array.isArray(record.contributed_components) && record.contributed_components.length === 0 && !list(record.bundle_references).length,
        });
        nodes.push(node);
        for (const component of list(record.required_components ?? record.contributed_components)) {
            const type = componentTypes.get(component?.kind);
            if (!type || !safeId(component?.id)) {
                warning('malformed-bundle', 'blocked', `Invalid component in the ${record.bundle_id} bundle.`, [id]);
                continue;
            }
            const target = `${type}:${component.id}`;
            (node.requires ??= []).push(target);
            addEdge('dependency', target, id, 'Bundle component');
        }
    }
    const registrySpecs = [
        ['Presets', 'preset', '.specify/presets', '.registry', 'presets', 'preset.yml'],
        ['Workflows', 'workflow', '.specify/workflows', 'workflow-registry.json', 'workflows', 'workflow.yml'],
        ['Workflow steps', 'step-package', '.specify/workflows/steps', 'step-registry.json', 'steps', 'step.yml'],
    ];
    for (const [kind, type, base, registryName, property, filename] of registrySpecs) {
        const registryPath = `${base}/${registryName}`;
        const registry = read(registryPath, 'json');
        if (registry && !object(registry[property])) findings.push({
            code: 'malformed-registry', severity: 'blocked', message: `${registryPath} must contain a ${property} mapping.`,
            nodeIds: [], edgeIds: [], path: registryPath,
        });
        const records = new Map(entries(registry?.[property]));
        const candidates = [...overrides.keys()].flatMap(path => path.startsWith(`${base}/`) && path.endsWith(`/${filename}`) ? [path.slice(base.length + 1).split('/')[0]] : []);
        for (const key of unique([...records.keys(), ...dirs(base).filter(id => exists(`${base}/${id}/${filename}`)), ...candidates]).filter(safeId)) {
            const id = `${type}:${key}`, file = `${base}/${key}/${filename}`;
            if (overrides.get(file) === null && !records.has(key)) continue;
            const config = read(file);
            const record = records.get(key);
            const meta = config?.[type === 'step-package' ? 'step' : type];
            let problem = !config ? health('missing-definition', `${file} is missing or invalid.`) : compatibility(version, config.requires?.speckit_version);
            if (config && (type === 'step-package' ? meta?.type_key : meta?.id) !== key) {
                problem ??= health('malformed-package', `${file} does not declare ${key} as its identifier.`);
            }
            if (config && type === 'workflow' && (!Array.isArray(config.steps) || !config.steps.length)) {
                problem ??= health('malformed-package', `${file} must declare a non-empty step list.`);
            }
            const stepCode = type === 'step-package' ? `${base}/${key}/__init__.py` : null;
            if (stepCode && !overrides.has(file) && !exists(stepCode)) problem ??= health('missing-step-code', `${stepCode} is missing.`);
            const templates = type === 'preset' ? list(config?.provides?.templates) : [];
            const templatePaths = [];
            for (const template of templates) {
                if (!safeId(template?.name) || typeof template.type !== 'string' || typeof template.file !== 'string') {
                    problem ??= health('malformed-template', `${file} declares an invalid template reference.`);
                    continue;
                }
                const path = `${base}/${key}/${template.file}`;
                if (exists(path)) templatePaths.push(path);
                else if (!overrides.has(file)) problem ??= health('missing-template', `Preset template ${path} is missing.`);
            }
            const node = defaultNode(id, meta?.name ?? record?.name ?? key, kind, file, {
                key, state: problem ? 'blocked' : record?.enabled === false ? 'disabled' : record ? 'enabled' : 'proposed',
                installed: Boolean(record), active: Boolean(record && record.enabled !== false), health: problem,
                version: meta?.version ?? record?.version, origin: record?.source, note: meta?.description,
                artifacts: [file, registryPath, stepCode, ...templatePaths].filter(path => path && exists(path)), approval: 'manual',
                effect: type === 'preset' ? 'read-only' : 'unknown',
                inputs: Object.keys(object(config?.inputs) ? config.inputs : {}),
                outputs: type === 'preset' ? templates.filter(template => safeId(template?.name)).map(template => template.name) :
                    Object.keys(object(config?.outputs) ? config.outputs : {}),
                ...(type === 'preset' ? { priority: record?.priority ?? 10 } : {}),
            });
            nodes.push(node);
            if (type === 'workflow' && record && typeof record.source === 'string') {
                const digest = inputs.get(file);
                const path = digest && sourceFile(key, digest);
                const segments = record.source.split(/[\\/]/);
                if (path && segments.at(-2)?.startsWith('canvas-pinned-workflow-') && segments.at(-1) === path.split('/').at(-1)) {
                    const receiptPath = `${path}.json`;
                    const receipt = read(receiptPath, 'json');
                    if (receipt?.sha256 === digest && validPinnedUrl(receipt.url) &&
                        exists(path) && createHash('sha256').update(document(root, path)).digest('hex') === digest) {
                        node.origin = receipt.url;
                        node.artifacts.push(path, receiptPath);
                    } else {
                        node.origin = 'Temporary source (review receipt unavailable or changed)';
                        warning('pinned-source-drift', 'advisory', `${node.name} no longer matches an available reviewed source receipt.`, [id]);
                    }
                }
            }
            for (const [group, targetType] of [['extensions', 'extension'], ['presets', 'preset'], ['workflows', 'workflow']]) {
                for (const dependency of list(config?.components?.[group] ?? config?.requires?.[group])) {
                    const name = typeof dependency === 'string' ? dependency : dependency?.id;
                    if (!safeId(name)) continue;
                    const target = `${targetType}:${name}`;
                    (node.requires ??= []).push(target);
                    addEdge('dependency', target, id, group, { active: node.active });
                }
            }
            if (type !== 'workflow') continue;
            const overlays = overlaysFor(key);
            const declared = overlays.layers?.filter(([, layer]) => layer?.enabled !== false);
            const replacement = declared?.length === 1 && declared[0][0] === reviewOverlayPath(key) ?
                composeReviewOverlay(config, key, declared[0][1]) : null;
            const replaced = new Set(replacement ? declared[0][1].edits.map(edit => edit.replace) : []);
            const reviewDefinition = replacement ?? config;
            const review = reviewGates(reviewDefinition, key);
            if (review) {
                node.effect = 'read-only';
                node.approval = 'confirm';
                node.reviewGates = review;
                node.reviewDefinition = reviewDefinition;
                node.reviewOverlay = replacement ? reviewOverlayPath(key) : null;
                node.reviewDefinitionStamp = createHash('sha256').update(JSON.stringify(reviewDefinition)).digest('hex');
            }
            const guided = guidedReview(config, key);
            if (guided) {
                node.guidedReview = guided;
                node.guidedDefinitionStamp = createHash('sha256').update(JSON.stringify(config)).digest('hex');
            }
            let stepCount = 0;
            let incomplete = false;
            const stepIds = new Set();
            const addSteps = (steps, parent, branch, depth, seenIds) => {
                if (depth > 12) {
                    incomplete = true;
                    return;
                }
                for (const [index, step] of steps.entries()) {
                    if (++stepCount > 384) {
                        incomplete = true;
                        break;
                    }
                    if (!safeId(step?.id)) {
                        warning('malformed-step', node.active ? 'blocked' : 'advisory', `${node.name} has an invalid step at position ${index + 1}.`, [id, parent]);
                        continue;
                    }
                    const stepId = `${parent}:${step.id}`;
                    if (seenIds.has(step.id) || stepIds.has(stepId)) {
                        warning('duplicate-step', node.active ? 'blocked' : 'advisory', `${node.name} repeats workflow step ${step.id}.`, [id, parent]);
                        continue;
                    }
                    seenIds.add(step.id);
                    stepIds.add(stepId);
                    const stepType = Object.hasOwn(step, 'type') ? step.type : 'command';
                    const dependency = strings(step.depends_on ?? step.needs);
                    const command = typeof step.command === 'string' ? step.command : null;
                    const reviewArtifact = stepType === 'gate' && isReviewArtifactPath(step.show_file) ? step.show_file : null;
                    if (stepType === 'gate' && (typeof step.message !== 'string' || !step.message.trim())) {
                        warning('malformed-step', 'blocked', `Gate step ${step.id} must declare a review message.`, [id, stepId]);
                    }
                    if (!safeId(stepType) || (stepType === 'command' && !command?.trim())) {
                        warning('malformed-step', node.active ? 'blocked' : 'advisory', `${node.name} has an invalid step type or command at ${step.id}.`, [id, stepId]);
                    }
                    const stepStage = stage(`stage:${hookStage(command?.split('.').at(-1) ?? step.id)}`);
                    const stepSource = replaced.has(step.id) ? node.reviewOverlay : file;
                    const stepNode = defaultNode(stepId, step.id, 'Workflow steps', stepSource, {
                        stage: stepStage.id, phase: stepStage.phase, state: node.state, active: node.active,
                        inputs: [...Object.keys(object(step.input) ? step.input : {}), ...(reviewArtifact ? [reviewArtifact] : [])],
                        outputs: Object.keys(object(step.outputs) ? step.outputs : {}),
                        approval: stepType === 'gate' || stepType === 'github' ? 'confirm' : 'manual',
                        effect: stepType === 'github' ? 'external-write' : stepType === 'gate' ? 'read-only' : 'unknown',
                        commands: command ? [{ id: command, name: command }] : [], artifacts: unique([stepSource, file]), note: step.message,
                        stepType: safeId(stepType) ? stepType : null, reviewArtifact, workflowOwner: id,
                        issueLabelChange: depth === 0 ? issueLabelStep(step) : null,
                    });
                    nodes.push(stepNode);
                    addEdge('contains', parent, stepId, branch ?? 'Workflow step', { active: node.active, effect: stepNode.effect, approval: stepNode.approval });
                    const dependencies = dependency.length ? dependency : index && safeId(steps[index - 1]?.id) ? [steps[index - 1].id] : [];
                    for (const from of dependencies) addEdge('step', `${parent}:${from}`, stepId, 'Runs after', {
                        active: node.active, effect: stepNode.effect, approval: stepNode.approval,
                    });
                    const child = step.workflow ?? step.input?.workflow;
                    if (safeId(child)) addEdge('call', id, `workflow:${child}`, step.id, { active: node.active });
                    if (stepType === 'github') {
                        node.effect = 'external-write';
                        node.approval = 'confirm';
                        if (node.active) warning('unapproved-external-step', 'blocked', `Workflow step ${step.id} can write to GitHub without a reviewed change.`, [id, stepId]);
                    }
                    for (const [label, childSteps] of nestedSteps(step)) {
                        addSteps(childSteps, stepId, label, depth + 1, label === 'fan-out template' ? new Set() : seenIds);
                    }
                }
            };
            addSteps(list(reviewDefinition?.steps), id, null, 0, new Set());
            if (incomplete) warning('workflow-inspection-limit', node.active ? 'blocked' : 'advisory',
                `The canvas cannot inspect all steps in ${node.name}. Reduce nesting or split the workflow.`, [id]);
        }
    }
    for (const runId of dirs(WORKFLOW_RUNS)) {
        const path = `${WORKFLOW_RUNS}/${runId}/state.json`;
        try {
            const text = document(root, path);
            if (text == null) continue;
            const run = JSON.parse(text);
            const owner = stage(`workflow:${run?.installed_workflow_id ?? run?.workflow_id}`);
            if (!owner || run.run_id !== runId || !RUN_STATES.has(run.status) || !Number.isFinite(Date.parse(run.updated_at))) continue;
            if (owner.lastRun && Date.parse(owner.lastRun) >= Date.parse(run.updated_at)) continue;
            owner.lastRun = run.updated_at;
            owner.lastRunStatus = run.status;
            owner.lastRunId = runId;
            owner.lastRunStep = safeId(run.current_step_id) ? run.current_step_id : null;
        } catch {
            warning('unreadable-run', 'advisory', `Spec Kit run ${runId} has an unreadable state record. Reload after the runtime finishes writing.`);
        }
    }
    const workflowKeys = nodes.filter(node => node.kind === 'Workflows').map(node => node.key);
    for (const key of unique([...dirs(WORKFLOW_OVERLAYS), ...workflowKeys])) {
        const owner = stage(`workflow:${key}`);
        const overlayIds = new Map();
        const { layers, error } = overlaysFor(key);
        if (error) {
            if (owner) owner.hasProjectOverlay = true;
            warning('unreadable-overlay-directory', 'blocked', `${key}: ${error}`, owner ? [owner.id] : []);
            continue;
        }
        for (const [path, config] of layers) {
            const edits = overlayEdits(config, key);
            const declared = config?.enabled !== false;
            const canEnableOverlay = Boolean(!declared && edits && owner?.installed && owner.reviewDefinition &&
                path === reviewOverlayPath(key) && layers.every(([, layer]) => layer?.enabled === false) &&
                composeReviewOverlay(owner.reviewDefinition, key, { ...config, enabled: true }));
            const types = edits ? overlayTypes(edits) : [];
            const id = `overlay:${key}:${path.split('/').at(-1)}`;
            const node = defaultNode(id, config?.id && validOverlayId(config.id) ? config.id : path.split('/').at(-1), 'Workflow overlays', path, {
                state: !edits ? 'blocked' : declared ? 'enabled' : 'disabled', active: declared,
                artifacts: [path], approval: 'inspect', effect: path === owner?.reviewOverlay ? 'read-only' : types.includes('github') ? 'external-write' : 'unknown',
                workflowOwner: `workflow:${key}`, canDisableOverlay: Boolean(edits && declared), canEnableOverlay,
                inputs: edits?.map(edit => `${edit.operation}: ${edit.anchor}`) ?? [],
                outputs: types.map(type => `Declares ${type} step`),
                note: path === owner?.reviewOverlay ? 'This project override replaces literal review gate settings without changing the installed workflow.' :
                    'Project layer declaration only. Spec Kit resolves anchors, precedence, and effective steps when it composes a workflow.',
            });
            nodes.push(node);
            if (!edits) warning('malformed-overlay', declared ? 'blocked' : 'advisory', `${path} has an invalid or unsupported overlay declaration.`, [id]);
            if (!owner) {
                warning('missing-overlay-workflow', 'advisory', `No installed workflow definition for ${key} was found in the repository.`, [id]);
                continue;
            }
            owner.artifacts.push(path);
            const edgeId = `overlay-layer:${id}`;
            addEdge('overlay', id, owner.id, 'Project overlay declaration', { id: edgeId, active: declared && owner.active,
                effect: node.effect, approval: node.approval, path });
            if (declared) {
                owner.hasProjectOverlay = true;
                if (path === owner.reviewOverlay) continue;
                warning('unresolved-overlay', 'advisory', `${node.name} can change ${owner.name} at runtime. The graph shows declarations, not the composed order.`,
                    [owner.id, id], [edgeId]);
                const previous = edits && overlayIds.get(config.id);
                if (previous) warning('duplicate-overlay', 'blocked', `${owner.name} has duplicate enabled overlays named ${config.id}.`, [owner.id, previous, id], [edgeId]);
                if (edits) overlayIds.set(config.id, id);
                if (owner.active && types.includes('github')) {
                    owner.effect = 'external-write';
                    owner.approval = 'confirm';
                    warning('unapproved-external-step', 'blocked', `Project overlay ${node.name} declares a GitHub write without a reviewed change.`,
                        [owner.id, id], [edgeId]);
                } else if (owner.active) {
                    owner.effect = owner.effect === 'external-write' ? owner.effect : 'unknown';
                }
            }
        }
    }

    for (const category of CATALOG_TYPES) {
        const file = catalogPath(category);
        const config = read(file);
        if (!config) continue;
        const items = config.catalogs ?? [];
        const keys = new Set();
        if (!Array.isArray(items) || (category === 'bundle' && config.schema_version != null && !/^1(?:\.|$)/.test(String(config.schema_version)))) {
            findings.push({ code: 'malformed-catalog', severity: 'blocked', message: `${file} must use a supported catalog schema and list.`, nodeIds: [], edgeIds: [], path: file });
            continue;
        }
        for (const catalog of items) {
            const key = catalogKey(category, catalog);
            if (!safeId(key) || keys.has(key) || typeof catalog?.url !== 'string' || !catalog.url.trim()) {
                findings.push({ code: 'malformed-catalog', severity: 'blocked', message: `${file} has an invalid or duplicate catalog source.`, nodeIds: [], edgeIds: [], path: file });
                continue;
            }
            keys.add(key);
            const installAllowed = catalogPolicy(category, catalog);
            nodes.push(defaultNode(`catalog:${category}:${key}`, key, 'Catalogs', file, {
                key, category, origin: catalog?.url, approval: 'confirm', artifacts: [file],
                health: installAllowed == null ? health('malformed-catalog', `${file} has an unsupported installation policy for ${key}.`) : null,
                note: installAllowed == null ? 'Installation policy could not be verified for this catalog type.' :
                    installAllowed ? 'This repository permits installation from this source. User-level sources or environment overrides may also affect resolution.' :
                        'This repository registers this source for discovery only.',
                installAllowed, priority: catalog?.priority, effect: 'external-read',
            }));
        }
    }

    for (const [type, paths, pattern] of [
        ['Templates and schemas', ['.specify/templates', TEMPLATE_OVERRIDES, '.specify/schemas'], null],
        ['Constitution and Charter', ['.specify/memory', '.specify/extensions/charter/fragments', '.specify/charter', '.specify/charter/fragments'], /constitution|charter|fragment/i],
        ['Commands and skills', ['.github/agents', '.github/prompts', '.github/skills', '.agents/skills', '.claude/skills'], /^speckit[.-]/i],
    ]) {
        for (const base of paths) {
            const paths = unique([...files(base), ...(type === 'Commands and skills' ? dirs(base).map(key => `${base}/${key}/SKILL.md`).filter(exists) : []),
                ...[...overrides.keys()].filter(path => (base === TEMPLATE_OVERRIDES || path === CONSTITUTION) && path.startsWith(`${base}/`))]);
            for (const path of paths) {
                if (overrides.get(path) === null) continue;
                const name = path.slice(base.length + 1).replace(/\/SKILL\.md$/, '');
                if (pattern && !pattern.test(name)) continue;
                const templateOverride = (base === '.specify/templates' || base === TEMPLATE_OVERRIDES) && /^[a-z0-9-]+\.md$/.test(name) ?
                    `${TEMPLATE_OVERRIDES}/${name}` : null;
                nodes.push(defaultNode(`file:${path}`, name, type, path, {
                    artifacts: [path], stage: type === 'Constitution and Charter' ? 'stage:constitution' : 'stage:specify',
                    phase: type === 'Constitution and Charter' ? 'governance' : 'specification',
                    ...(templateOverride ? { templateOverride, category: base === TEMPLATE_OVERRIDES ? 'Project template override' : 'Core template' } : {}),
                }));
            }
        }
    }
    for (const node of nodes.filter(item => item.templateOverride && item.source === item.templateOverride)) {
        const upstream = stage(`file:.specify/templates/${node.name}`);
        addEdge('reference', node.id, upstream?.id ?? node.stage, 'Project template takes precedence');
    }
    const charter = stage('extension:charter');
    const charterConfig = read(CHARTER_CONFIG);
    const charterState = read(CHARTER_STATE);
    if (charter.installed || exists(CHARTER_CONFIG) || exists(CHARTER_STATE)) {
        const selected = charterState?.distributed_sub_constitutions;
        if (selected !== undefined && (!Array.isArray(selected) || selected.some(id => typeof id !== 'string') || selected.length > MAX_DIR)) {
            warning('malformed-charter-selection', 'blocked', 'Charter’s distributed selection must be a bounded list of source IDs.', [charter.id]);
        }
        for (const [path, name] of [[CHARTER_CONFIG, 'Charter configuration'], [CHARTER_STATE, 'Charter selection']]) {
            if (!exists(path)) continue;
            charter.artifacts.push(path);
            nodes.push(defaultNode(`file:${path}`, name, 'Constitution and Charter', path, {
                artifacts: [path], stage: 'stage:constitution', phase: 'governance', authority: charter.authority,
            }));
        }
        if (Array.isArray(selected) && selected.length <= MAX_DIR) {
            for (const id of unique(selected)) {
                const match = typeof id === 'string' && /^([a-z0-9_][a-z0-9_.-]*(?:\/[a-z0-9_][a-z0-9_.-]*){0,4})\/\.charter\/constitution$/i.exec(id);
                if (!match || !validScope(match[1]) || match[1].split('/').some(part => part.toLowerCase() === 'node_modules')) {
                    warning('invalid-charter-source', 'blocked', 'Charter selects a distributed constitution outside the supported package path format.', [charter.id]);
                    continue;
                }
                const path = `${id}.md`;
                const available = exists(path);
                const active = Boolean(charter.active && charterConfig?.distributed_sub_constitutions === true);
                const item = defaultNode(`file:${path}`, `${match[1]} charter rules`, 'Constitution and Charter', path, {
                    artifacts: available ? [path] : [], stage: 'stage:constitution', phase: 'governance', authority: charter.authority,
                    category: 'Distributed Charter source', state: available ? 'available' : 'missing', active,
                    inputs: [CHARTER_CONFIG, CHARTER_STATE], outputs: [path], effect: 'local-write', approval: 'confirm',
                    editableCharterSource: active && available && !charter.health &&
                        exists('.specify/extensions/charter/scripts/bash/distributed-read.sh') ? path : null,
                    note: 'Package-owned Markdown selected by Charter. The composed project constitution is generated separately.',
                });
                nodes.push(item);
                addEdge('input', item.id, charter.id, 'Selected Charter source', { active, reads: [path], approval: 'confirm' });
                if (!available) warning('missing-charter-source', active ? 'blocked' : 'advisory', `${path} is missing or is not a regular workspace file.`, [item.id, charter.id]);
            }
        }
    }
    stage('stage:constitution').artifacts = nodes.filter(node => node.kind === 'Constitution and Charter').flatMap(node => node.artifacts);
    const constitution = stage('stage:constitution');
    const memory = workspaceEntry(root, '.specify/memory');
    const generated = memory?.stat.isDirectory() && lstatSync(join(memory.target, '.constitution-template.json'), { throwIfNoEntry: false });
    const charterDirectory = workspaceEntry(root, '.specify/charter');
    const retainedCharter = charterDirectory?.stat.isDirectory() &&
        lstatSync(join(charterDirectory.target, 'state.yml'), { throwIfNoEntry: false });
    const managedConstitution = generated || retainedCharter || nodes.some(node => node.installed && (
        ['extension:charter', 'preset:constitution-sync'].includes(node.id) ||
        node.kind === 'Extensions' && (node.writes ?? node.outputs).includes(CONSTITUTION)));
    if (!managedConstitution && memory?.stat.isDirectory() &&
        !findings.some(item => item.code === 'malformed-registry' || ['.specify/presets/.registry', registryPath].includes(item.path))) {
        constitution.editableConstitution = CONSTITUTION;
    }
    const roadmap = stage('extension:roadmap');
    const roadmapDirectory = roadmap.installed ? workspaceEntry(root, '.specify/extensions/roadmap') : null;
    if (roadmapDirectory?.stat.isDirectory()) {
        const configuredPath = lstatSync(join(root, ROADMAP_CONFIG), { throwIfNoEntry: false });
        const artifact = workspaceEntry(root, ROADMAP_PATH);
        const writeCommand = roadmap.commands.find(command => command.id === 'speckit.roadmap.write');
        const manifest = !roadmap.health && roadmap.version === '0.1.1' && document(root, roadmap.source);
        roadmap.roadmapStatus = { note: 'Status edits require Roadmap 0.1.1, its standard ledger, and no path or project configuration override.' };
        if (artifact?.stat.isFile() && !configuredPath && !process.env.SPECKIT_ROADMAP_PATH && manifest && !/^\s*path:/m.test(manifest)) {
            roadmap.artifacts.push(ROADMAP_PATH);
            if (roadmap.active && !roadmap.health && writeCommand?.file && exists(writeCommand.file) && artifact.stat.size <= 24 * 1024) {
                try {
                    const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(artifact.target));
                    const text = overrides.get(ROADMAP_PATH) ?? original;
                    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new TypeError('Unreadable Markdown');
                    const { entries } = parseRoadmap(text);
                    roadmap.roadmapStatus = { entries: entries.map(({ id, title, status }) => ({ id, title, status })), statuses: ROADMAP_STATUSES };
                } catch (error) {
                    if (error.status !== 400 && !(error instanceof TypeError)) throw error;
                    roadmap.roadmapStatus = { note: error instanceof TypeError ? 'The roadmap is not readable UTF-8 Markdown.' : error.message };
                }
            }
        }
    }
    for (const dir of specDirs) {
        nodes.push(defaultNode(`directory:${dir}`, dir, 'Features and specs', dir, { stage: 'stage:specify', phase: 'specification', state: workspaceEntry(root, dir)?.stat.isDirectory() ? 'available' : 'missing', active: Boolean(workspaceEntry(root, dir)?.stat.isDirectory()) }));
    }
    const wireframe = stage('extension:wireframe');
    const wireframeHome = wireframe.installed ? workspaceEntry(root, '.specify/extensions/wireframe') : null;
    const standardWireframe = wireframe.active && !wireframe.health && wireframe.version === '0.1.1' &&
        wireframeHome?.stat.isDirectory() && !lstatSync(join(root, WIREFRAME_CONFIG), { throwIfNoEntry: false }) &&
        wireframe.commands.some(command => command.id === 'speckit.wireframe.review' && command.file && exists(command.file));
    if (wireframe.installed) wireframe.wireframeSignoff = { features: [], note: standardWireframe ?
        'Initial sign-off requires a standard feature spec and passing Wireframe reports.' :
        'Initial sign-off supports enabled Wireframe 0.1.1 with the default configuration.' };
    const adrkit = stage('extension:adrkit');
    if (adrkit.installed) {
        const records = directory(root, ADR_DIR).filter(item => item.isFile() && standardAdr.test(item.name))
            .map(item => ({ id: standardAdr.exec(item.name)[1], path: `${ADR_DIR}/${item.name}` }));
        adrkit.artifacts.push(...records.map(item => item.path));
        if (adrkit.active && !adrkit.health && adrkit.version === '0.1.5' && records.length) {
            adrkit.adrRecords = records;
        } else {
            adrkit.adrNote = 'ADR acceptance requires compatible Spec Kit and adrkit extension 0.1.5, adrkit CLI 0.20.0, and a standard docs/adr corpus.';
        }
    }
    const product = stage('extension:pdac-product');
    if (product.installed) {
        const config = read(PRODUCT_CONFIG);
        if (exists(PRODUCT_CONFIG)) product.artifacts.push(PRODUCT_CONFIG);
        const productRecords = directory => {
            const candidates = new Set(dirs(directory));
            for (const path of overrides.keys()) {
                if (path.startsWith(`${directory}/`) && path.endsWith('/change.md')) candidates.add(path.slice(directory.length + 1, -'/change.md'.length));
            }
            return [...candidates].filter(name => {
                const path = `${directory}/${name}/change.md`;
                return standardProductChange.test(name) && (overrides.get(path) ?? exists(path));
            }).sort();
        };
        const changes = productRecords(PRODUCT_CHANGES);
        product.artifacts.push(...changes.map(name => `${PRODUCT_CHANGES}/${name}/change.md`));
        product.artifacts.push(...productRecords(PRODUCT_ARCHIVE).map(name => `${PRODUCT_ARCHIVE}/${name}/change.md`));
        if (product.active && !product.health && product.version === '0.1.0' && config?.version === 'v1alpha1' &&
            config['product-root'] === 'docs/product' && !Object.hasOwn(config, 'product') &&
            workspaceEntry(root, PRODUCT_MODEL)?.stat.isDirectory()) {
            product.productChanges = changes;
            product.approvedProductChanges = [];
            product.appliedProductChanges = [];
            for (const name of changes) {
                const path = `${PRODUCT_CHANGES}/${name}/change.md`;
                const entry = workspaceEntry(root, path);
                const text = overrides.get(path) ?? (entry?.stat.isFile() && entry.stat.size <= MAX_FILE ? document(root, path) : null);
                const status = typeof text === 'string' ? productChangeStatus(text) : null;
                if (status === 'approved') product.approvedProductChanges.push(name);
                if (status === 'applied') product.appliedProductChanges.push(name);
            }
        }
        if (!product.productChanges?.length) {
            product.productNote = 'Apply and archive require enabled PDaC and PDaC Product 0.1.0, ProductShape CLI 0.26.1, and a hosted change in the standard v1alpha1 workspace.';
        }
    }
    for (const spec of specs.slice(0, MAX_DIR)) {
        const id = `feature:${spec.id}`;
        const knownFiles = Object.values(spec.files ?? {}).filter(file => typeof file === 'string').map(file => file.startsWith(`${spec.id}/`) ? file : `${spec.id}/${file}`);
        const related = unique([...knownFiles, ...files(spec.id), ...(exists(`${spec.id}/.spec-context.json`) ? [`${spec.id}/.spec-context.json`] : [])]).filter(exists);
        const output = new Map(related.map(path => [path.split('/').at(-1), path]));
        const tracked = ['spec.md', 'plan.md', 'tasks.md'];
        for (let index = 1; index < tracked.length; index++) {
            const path = output.get(tracked[index]), upstream = output.get(tracked[index - 1]);
            if (path && !upstream) warning('orphaned-artifact', 'advisory', `${path} has no ${tracked[index - 1]} in this feature.`, [id]);
            else if (path && workspaceEntry(root, path).stat.mtimeMs + 2000 < (workspaceEntry(root, upstream)?.stat.mtimeMs ?? 0)) {
                warning('stale-artifact', 'advisory', `${path} is older than ${upstream}. Review it before continuing.`, [id]);
            }
            if (related.some(path => path.endsWith('.spec-context.json'))) {
                for (const path of related.filter(item => /\.(svg|html|mmd)$/i.test(item))) {
                    if (!knownFiles.includes(path)) warning('undocumented-artifact', 'advisory', `${path} is not referenced by the feature's known files.`, [id]);
                }
            }
        }
        nodes.push(defaultNode(id, spec.title ?? spec.id, 'Features and specs', spec.id, {
            key: spec.id, state: spec.status ?? 'available', stage: 'stage:specify', phase: 'specification',
            artifacts: related, lastRun: spec.updatedAt, outputs: related, note: spec.id,
        }));
        if (standardWireframe && standardWireframeFeature(spec.id) && related.includes(`${spec.id}/spec.md`) &&
            workspaceEntry(root, `${spec.id}/wireframes`)?.stat.isDirectory()) {
            wireframe.wireframeSignoff.features.push({ id: spec.id, name: spec.title ?? spec.id });
            addEdge('input', id, wireframe.id, 'Sign-off target', { reads: [`${spec.id}/spec.md`, `${spec.id}/wireframes/`], approval: 'confirm' });
        }
    }
    const featureArtifacts = new Map(nodes.filter(node => node.id.startsWith('feature:'))
        .flatMap(node => node.artifacts.map(path => [path, node.id])));
    for (const node of nodes.filter(item => item.reviewArtifact)) {
        const path = node.reviewArtifact;
        const feature = featureArtifacts.get(path);
        if (feature) {
            node.artifacts.push(path);
            addEdge('input', feature, node.id, `Review ${path}`, { active: node.active, approval: 'confirm', reads: [path] });
        } else {
            warning('missing-gate-artifact', 'advisory', `Gate ${node.name} references ${path}, which is not an inventoried feature artifact.`,
                [node.id, node.workflowOwner]);
        }
    }
    for (const node of lifecycleNodes()) {
        const actual = stage(node.id);
        for (const command of actual.commands) {
            const spelling = resolveCommand(root, command.id, 'speckit');
            command.invocation = spelling.name;
            command.available = spelling.registered || Boolean(spelling.instructions && exists(spelling.instructions));
            command.file = exists(spelling.instructions) ? spelling.instructions : null;
        }
    }
    for (const node of nodes.filter(item => item.kind === 'Workflow steps' && item.active && item.stepType)) {
        const provider = stage(`step-package:${node.stepType}`);
        if (!BUILTIN_STEP_TYPES.has(node.stepType)) {
            if (!provider?.installed) warning('missing-step-package', 'blocked', `Workflow step ${node.name} needs a registered ${node.stepType} step package.`, [node.id]);
            const providerId = `step-package:${node.stepType}`;
            (node.requires ??= []).push(providerId);
            addEdge('dependency', providerId, node.id, `Step type: ${node.stepType}`, { effect: 'unknown', approval: 'inspect' });
        }
        for (const command of node.commands) {
            const providers = nodes.filter(item => (item.kind === 'Extensions' && item.active && !item.health || item.kind === 'Lifecycle') &&
                item.commands.some(candidate => (item.kind !== 'Lifecycle' || candidate.available) &&
                    (candidate.id === command.id || candidate.aliases?.includes(command.id) || `speckit.${candidate.id}` === command.id)));
            if (!providers.length) warning('broken-reference', 'blocked', `Workflow step ${node.name} references an unavailable command: ${command.id}.`, [node.id]);
            for (const provider of providers) addEdge('command', provider.id, node.id, command.id, { active: true, effect: provider.effect, approval: provider.approval });
        }
    }
    const decisions = Array.isArray(policy?.decisions) ? policy.decisions.filter(decision => object(decision) && safeId(decision.primary) && safeId(decision.secondary)
        && decision.primary !== decision.secondary && ['primary', 'manual', 'disabled-hook', 'scoped'].includes(decision.strategy)
        && (decision.strategy !== 'scoped' || validScope(decision.primaryScope) && validScope(decision.secondaryScope))
        && typeof decision.owner === 'string' && Boolean(decision.owner.trim()) && typeof decision.rationale === 'string' && Boolean(decision.rationale.trim())
        && decision.approval?.method === 'canvas-confirmation' && typeof decision.approval.at === 'string' && Number.isFinite(Date.parse(decision.approval.at))) : [];
    if (policy && (policy.version !== 1 || !Array.isArray(policy.decisions) || decisions.length !== policy.decisions.length)) {
        warning('malformed-policy', 'blocked', `${POLICY_PATH} contains invalid decisions.`);
    }
    if (policy) nodes.push(defaultNode('policy:workflow', 'Workflow ownership decisions', 'Versions and sources', POLICY_PATH, { artifacts: [POLICY_PATH], approval: 'confirm' }));
    for (const decision of decisions) {
        const primary = stage(`extension:${decision.primary}`), secondary = stage(`extension:${decision.secondary}`);
        if (decision.strategy === 'scoped') {
            const problem = scopeProblem(primary, secondary, decision, edges);
            if (problem && primary?.active && secondary?.active) warning('ownership-decision-drift', 'blocked', problem, [primary.id, secondary.id]);
            continue;
        }
        const enabledHooks = edges.filter(edge => edge.owner === secondary?.id && edge.active && AUTOMATIC_HOOKS.includes(edge.kind));
        if (secondary?.active && (decision.strategy === 'primary' || secondary.mode === 'primary' || enabledHooks.length)) {
            warning('ownership-decision-drift', 'blocked', `${secondary.name} no longer follows the recorded ${decision.strategy} boundary. Disable the competing integration or hooks before continuing.`,
                [primary?.id, secondary.id].filter(Boolean), enabledHooks.map(edge => edge.id));
        }
    }
    const validation = validateGraph(nodes, edges, findings, decisions);
    for (const node of nodes) {
        const related = validation.filter(item => item.nodeIds.includes(node.id));
        node.healthStatus = related.some(item => item.severity === 'blocked') ? 'blocked' : node.approval === 'confirm' ? 'confirm' : related.length || !node.active ? 'advisory' : 'valid';
        if (node.kind === 'Extensions' && node.active) node.lastRun = node.key === 'companion' ? specs.find(item => item.updatedAt)?.updatedAt : null;
        if (node.id === 'inventory:runs') node.lastRun = specs.find(item => item.updatedAt)?.updatedAt;
    }
    for (const edge of edges) {
        if (edge.kind === 'hook') edge.fixtures = hookFixtures(edge);
        const related = validation.filter(item => item.edgeIds.includes(edge.id));
        const blockedNode = edge.active && [edge.source, edge.target].some(id => stage(id)?.healthStatus === 'blocked');
        edge.status = blockedNode || related.some(item => item.severity === 'blocked') ? 'blocked' : edge.approval === 'confirm' ? 'confirm' : related.length || !edge.active ? 'advisory' : 'valid';
    }
    return {
        graph: { phases: PHASES, management: MANAGEMENT, nodes, edges, findings: validation, decisions,
            runtime: { version, integration: integrationKey, nativeEventOverrideSupported } },
        inputs, hookDocument, policy,
    };
}
