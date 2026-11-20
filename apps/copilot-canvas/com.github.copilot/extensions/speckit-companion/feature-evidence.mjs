import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dump, load, JSON_SCHEMA } from './vendor/workflow-yaml.mjs';
import { HOOK_PATH, object, safeId, workspaceEntry } from './workflow-inventory.mjs';
import { parseErModel } from './er-model.mjs';
import { parseSequenceModel } from './sequence-model.mjs';
import { parseFlowchartModel } from './flowchart-model.mjs';

const MAX_SOURCE = 256 * 1024;
const MAX_EVIDENCE = 48;
const MAX_DIRECTORIES = 48;
const CORE_DOCUMENTS = ['spec', 'plan', 'tasks'];
const APM_LOCK = 'apm.lock.yaml';
const REGISTRY = '.specify/extensions/.registry';
const ASSIGN_MANIFEST = '.specify/extensions/agent-assign/extension.yml';
const ASSIGN_VALIDATE = 'speckit.agent-assign.validate';
const ASSIGN_VALIDATE_FILE = 'commands/validate.md';
const MAX_ASSIGNMENTS = 256;
const kinds = [
    { match: /^(?:architecture|diagrams)\/|^architecture\.md$/i, phase: 'Architecture' },
    { match: /^(?:figma|design-context)\/|^(?:figma|design-context)\.(?:md|json)$/i, phase: 'Design context' },
    { match: /^(?:data-model|model-diagrams)\/|^data-model-diagram\.mmd$/i, phase: 'Data model' },
    { match: /^wireframes?\//i, phase: 'Wireframes' },
    { match: /^preview\//i, phase: 'Prototypes' },
    { match: /^prototypes?\//i, phase: 'Prototypes' },
    { match: /^(?:adr|decisions)\/|^adr[-_]/i, phase: 'Decisions' },
    { match: /^(?:evidence|validation)\//i, phase: 'Evidence' },
];
const formatFor = path => /\.svg$/i.test(path) ? 'svg' : /\.png$/i.test(path) ? 'png' : /\.md$/i.test(path) ? 'markdown'
    : /\.(?:html?|mmd|json|ya?ml|txt)$/i.test(path) ? 'source' : null;
const safeName = name => /^[\w][\w .-]{0,127}$/.test(name);

function document(root, path, limit = MAX_SOURCE) {
    const entry = workspaceEntry(root, path);
    if (!entry?.stat.isFile() || entry.stat.size > limit) return null;
    const bytes = readFileSync(entry.target);
    return bytes.length <= limit ? bytes : null;
}

function readYaml(root, path) {
    const value = document(root, path);
    if (!value) return null;
    return load(value.toString('utf8'), { schema: JSON_SCHEMA });
}

export function featureEvidence(root, id) {
    const spec = workspaceEntry(root, id);
    if (!spec?.stat.isDirectory()) return [];
    const result = [];
    let remainingDirectories = MAX_DIRECTORIES;
    function add(path, group) {
        const existing = result.find(item => item.path === path && item.phase === group.phase);
        if (existing) {
            if (group.provider && !existing.providers.includes(group.provider)) existing.providers.push(group.provider);
            for (const doc of group.documents ?? []) if (!existing.documents.includes(doc)) existing.documents.push(doc);
            return;
        }
        const format = formatFor(path);
        const entry = format && workspaceEntry(root, path);
        if (result.length >= MAX_EVIDENCE || !entry?.stat.isFile() || entry.stat.size > MAX_SOURCE) return;
        result.push({ path, format, phase: group.phase, providers: group.provider ? [group.provider] : [],
            documents: group.documents ?? [],
            label: path.startsWith(`${id}/`) ? path.slice(id.length + 1) : path, revision: `${entry.stat.mtimeMs}:${entry.stat.size}` });
    }
    function visit(relative, depth, group) {
        if (depth > 3 || result.length >= MAX_EVIDENCE || remainingDirectories-- <= 0) return;
        const directory = workspaceEntry(root, relative ? `${id}/${relative}` : id);
        if (!directory?.stat.isDirectory()) return;
        for (const entry of readdirSync(directory.target, { withFileTypes: true })
            .filter(entry => safeName(entry.name) && (entry.isFile() || entry.isDirectory()))
            .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 160)) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            const category = group ?? kinds.find(kind => kind.match.test(name + (entry.isDirectory() ? '/' : '')));
            if (!category) continue;
            if (entry.isDirectory()) visit(name, depth + 1, category);
            else add(`${id}/${name}`, category);
        }
    }
    visit('', 0);
    // Repository-wide decisions belong to a feature only when a core document links them explicitly.
    for (const name of ['spec.md', 'plan.md', 'research.md', 'tasks.md']) {
        const text = document(root, `${id}/${name}`)?.toString('utf8') ?? '';
        for (const match of text.matchAll(/\]\(((?:\.\.\/){1,6})docs\/adr\/([a-zA-Z0-9][a-zA-Z0-9_.-]*\.md)\)/g)) {
            if (match[1].length / 3 !== id.split('/').length) continue;
            const path = `docs/adr/${match[2]}`;
            add(path, { phase: 'Decisions', documents: [name.slice(0, -3)] });
        }
    }
    let registry;
    try { registry = readYaml(root, REGISTRY)?.extensions; }
    catch { return result; } // The configuration graph diagnoses an invalid registry.
    for (const [key, record] of Object.entries(object(registry) ? registry : {}).slice(0, 128)) {
        if (!safeId(key) || !object(record) || record.enabled === false) continue;
        let manifest;
        try { manifest = readYaml(root, `.specify/extensions/${key}/extension.yml`); }
        catch { continue; } // The configuration graph diagnoses unreadable manifests.
        const views = manifest?.['x-companion']?.specViews;
        if (manifest?.extension?.id !== key || !Array.isArray(views)) continue;
        for (const view of views.slice(0, 16)) {
            if (typeof view?.phase !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9 &-]{0,47}$/.test(view.phase) ||
                typeof view.path !== 'string' || !view.path.split('/').every(safeName)) continue;
            const documents = CORE_DOCUMENTS.filter(name => Array.isArray(view.documents) && view.documents.slice(0, 3).includes(name));
            add(`${id}/${view.path}`, { phase: view.phase, provider: key, documents });
        }
    }
    return result;
}

export function readFeatureEvidence(root, id, path) {
    const item = featureEvidence(root, id).find(entry => entry.path === path);
    const bytes = item && document(root, path);
    if (!bytes) throw Object.assign(new Error('This evidence file is not available for the selected spec.'), { status: 404 });
    if (item.format === 'png') return { ...item, image: `data:image/png;base64,${bytes.toString('base64')}` };
    const text = bytes.toString('utf8');
    const model = /\.mmd$/i.test(path) && parseErModel(text);
    const sequence = !model && /\.mmd$/i.test(path) && parseSequenceModel(text);
    const flowchart = !model && !sequence && /\.mmd$/i.test(path) && parseFlowchartModel(text);
    return { ...item, text, ...(model ? { model } : {}), ...(sequence ? { sequence } : {}), ...(flowchart ? { flowchart } : {}) };
}

const assignmentError = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const parse = bytes => bytes ? load(bytes.toString('utf8'), { schema: JSON_SCHEMA }) : null;
function frontmatter(bytes) {
    const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes.toString('utf8'));
    return header ? parse(header[1]) : null;
}

function hveReceipt(root) {
    const bytes = document(root, APM_LOCK);
    const lock = parse(bytes);
    const records = new Map();
    for (const dep of Array.isArray(lock?.dependencies) ? lock.dependencies.slice(0, 128) : []) {
        if (typeof dep?.repo_url !== 'string' || !/^(?:https:\/\/github\.com\/)?microsoft\/hve-core(?:\.git)?$/i.test(dep.repo_url)) continue;
        for (const path of Array.isArray(dep.deployed_files) ? dep.deployed_files.slice(0, 512) : []) {
            if (typeof path !== 'string' || !/^\.(?:github|claude)\/agents\/[\w.-]+(?:\/[\w.-]+)*\.md$/.test(path)) continue;
            if (records.size >= 256 && !records.has(path)) continue;
            const hash = dep.deployed_file_hashes?.[path];
            if (!records.has(path)) records.set(path, typeof hash === 'string' ? hash : null);
            else if (records.get(path) !== hash) records.set(path, null);
        }
    }
    return { records, stamp: bytes && digest(bytes) };
}

function projectClaudeAgents(root) {
    const directory = workspaceEntry(root, '.claude/agents');
    const agents = new Map();
    if (!directory?.stat.isDirectory()) return agents;
    const paths = readdirSync(directory.target, { withFileTypes: true })
        .filter(entry => safeName(entry.name) && entry.name.endsWith('.md') && (entry.isFile() || entry.isSymbolicLink()));
    if (paths.length > 256 || paths.some(entry => entry.isSymbolicLink())) {
        throw assignmentError('The canvas cannot verify every project Claude Code agent definition.');
    }
    for (const entry of paths) {
        const path = `.claude/agents/${entry.name}`;
        const bytes = document(root, path);
        if (!bytes) throw assignmentError(`Cannot verify the project agent file ${path}.`);
        const meta = frontmatter(bytes);
        const name = meta?.name ?? entry.name.slice(0, -3);
        if (!safeId(name) || name === 'default') continue;
        if (agents.has(name)) agents.set(name, null);
        else agents.set(name, { path, hash: digest(bytes), description: typeof meta?.description === 'string' ? meta.description.trim().slice(0, 300) : '' });
    }
    return agents;
}

function supportedAssignmentManifest(root) {
    const registry = readYaml(root, REGISTRY)?.extensions?.['agent-assign'];
    if (registry?.enabled === false || registry?.version !== '1.1.0') return null;
    const manifest = readYaml(root, ASSIGN_MANIFEST);
    return manifest?.extension?.id === 'agent-assign' && manifest.extension.version === '1.1.0' ? manifest : null;
}

function editableAssignmentAgents(agents, records) {
    return [...agents].flatMap(([name, agent]) => agent?.description && records.get(agent.path) === agent.hash
        ? [{ ...agent, name }] : []);
}

export function featureAssignments(root, id, taskIds) {
    const path = `${id}/agent-assignments.yml`;
    const exists = Boolean(workspaceEntry(root, path));
    try {
        const raw = exists ? readYaml(root, path) : { assignments: {}, agents_scanned: [] };
        if (!object(raw?.assignments)) return { path, error: 'Agent Assign did not provide a readable assignments mapping.' };
        const scanRecorded = Array.isArray(raw.agents_scanned);
        let records = new Map(), importError = null, projectAgents = null, checkError = null, validationCommand = null;
        try {
            ({ records } = hveReceipt(root));
        } catch (error) {
            importError = error.status ? error.message : `Could not verify local APM imports (${error.name}).`;
        }
        try {
            if (exists || records.size) {
                const manifest = supportedAssignmentManifest(root);
                const commands = manifest?.provides?.commands;
                if (scanRecorded && exists && taskIds.length && Array.isArray(commands) && commands.some(command =>
                    command?.name === ASSIGN_VALIDATE && command.file === ASSIGN_VALIDATE_FILE) &&
                    workspaceEntry(root, `.specify/extensions/agent-assign/${ASSIGN_VALIDATE_FILE}`, { rejectSymlinks: true })?.stat.isFile()) {
                    validationCommand = `/${ASSIGN_VALIDATE}`;
                }
                if (manifest) projectAgents = projectClaudeAgents(root);
            }
        } catch (error) {
            checkError = error.status ? error.message : `Could not check project Claude Code agents (${error.name}).`;
        }
        if (!exists && !records.size && !importError) return null;
        const editableAgents = scanRecorded && projectAgents ? editableAssignmentAgents(projectAgents, records) : [];
        const eligiblePaths = new Set(editableAgents.map(agent => agent.path));
        const deployed = new Map();
        const imports = [];
        for (const [agentPath, hash] of records) {
            const bytes = document(root, agentPath);
            const basename = agentPath.split('/').at(-1).replace(/(?:\.agent)?\.md$/, '');
            let name = basename;
            try { if (bytes) name = frontmatter(bytes)?.name ?? basename; }
            catch { /* An unreadable header cannot supply a declared name. */ }
            if (!safeId(name)) continue;
            const agent = { path: agentPath, verified: Boolean(bytes && hash === digest(bytes)),
                harness: agentPath.startsWith('.claude/') ? 'Claude Code' : 'Copilot' };
            imports.push({ ...agent, name, available: Boolean(bytes), assignable: eligiblePaths.has(agentPath) });
            if (!bytes) continue;
            const matches = deployed.get(name) ?? [];
            matches.push(agent);
            deployed.set(name, matches);
        }
        const foundTasks = new Map();
        for (const task of taskIds) foundTasks.set(task, (foundTasks.get(task) ?? 0) + 1);
        const rows = Object.entries(raw.assignments);
        const visible = rows.slice(0, MAX_ASSIGNMENTS);
        const invalidRows = visible.filter(([task, row]) => !safeId(task) || !/^T\d+$/.test(task) || !safeId(row?.agent)).length;
        return { path, exists, imports, importError, validationCommand, editableAgents: editableAgents.map(({ name, path }) => ({ name, path })),
            checks: exists ? { projectAgentsChecked: projectAgents !== null, error: checkError,
                invalidRows, omittedRows: rows.length - visible.length, scanRecorded } : null,
            unassignedTasks: editableAgents.length ? [...foundTasks].flatMap(([task, count]) =>
                count === 1 && /^T\d+$/.test(task) && !Object.hasOwn(raw.assignments, task) ? [task] : []).slice(0, MAX_ASSIGNMENTS) : [],
            assignments: visible.flatMap(([task, row]) => {
                if (!safeId(task) || !safeId(row?.agent)) return [];
                const matches = deployed.get(row.agent) ?? [];
                const claude = matches.filter(agent => agent.harness === 'Claude Code');
                const imports = claude.length ? claude : matches;
                const profile = projectAgents?.get(row.agent);
                const agentCheck = row.agent === 'default' || !projectAgents ? null : profile === null ? 'ambiguous'
                    : !profile ? 'not-found' : !profile.description ? 'missing-description' : 'found';
                return [{ task, agent: row.agent, reason: typeof row.reason === 'string' ? row.reason.slice(0, 240) : null,
                    taskExists: foundTasks.has(task), taskAmbiguous: (foundTasks.get(task) ?? 0) > 1, agentCheck,
                    import: imports.length === 1 ? imports[0] : null }];
            }) };
    } catch (error) {
        return { path, error: `Could not read Agent Assign metadata (${error.name}).` };
    }
}

export function planAgentAssignment(root, feature, task, agentName, reason, taskIds, adding) {
    if (!/^T\d+$/.test(task) || taskIds.filter(id => id === task).length !== 1) {
        throw assignmentError('Select one current, unambiguous task from Tasks.');
    }
    const path = `${feature}/agent-assignments.yml`;
    const directory = workspaceEntry(root, feature, { rejectSymlinks: true });
    if (!directory?.stat.isDirectory()) throw assignmentError('Select a feature in the project, not a linked directory.');
    const target = lstatSync(join(directory.target, 'agent-assignments.yml'), { throwIfNoEntry: false });
    if (target && !target.isFile()) throw assignmentError('Agent Assign metadata must be a regular project file.');
    const base = target ? document(root, path, 128 * 1024)?.toString('utf8') : null;
    const raw = target ? parse(base) : { assignments: {}, agents_scanned: [] };
    if (!object(raw?.assignments) || !Array.isArray(raw.agents_scanned)) {
        throw assignmentError('Repair the Agent Assign metadata before changing this task.');
    }
    const assigned = Object.hasOwn(raw.assignments, task);
    if (adding ? assigned : !assigned || !object(raw.assignments[task])) {
        throw assignmentError(adding ? 'This task already has an assignment. Review the existing assignment instead.' :
            'This task no longer has an editable assignment.', 409);
    }
    const receipt = hveReceipt(root);
    const agent = supportedAssignmentManifest(root)
        ? editableAssignmentAgents(projectClaudeAgents(root), receipt.records).find(item => item.name === agentName) : null;
    if (!agent) throw assignmentError('Choose an APM-verified HVE Core agent deployed for Claude Code by the project.');
    if (raw.assignments[task]?.agent === agent.name && raw.assignments[task]?.reason === reason) throw assignmentError('The assignment is unchanged.');
    raw.assignments[task] = { ...raw.assignments[task], agent: agent.name, reason };
    if (!raw.agents_scanned.some(row => row?.name === agent.name && row.source === 'project')) {
        raw.agents_scanned.push({ name: agent.name, source: 'project', description: agent.description });
    }
    const next = `# Agent Assign metadata reviewed in SpecKit Companion\n${dump(raw, { schema: JSON_SCHEMA, lineWidth: -1 })}`;
    if (Buffer.byteLength(next) > 128 * 1024) throw assignmentError('The edited assignment file is too large.');
    return { path, before: base, after: next, agent, readPaths: [APM_LOCK, agent.path, ASSIGN_MANIFEST],
        stamp: digest(JSON.stringify([base, next, agent.hash, receipt.stamp])) };
}

export function specDocumentHooks(root) {
    let hooks, registry;
    try {
        hooks = readYaml(root, HOOK_PATH)?.hooks;
        registry = readYaml(root, REGISTRY)?.extensions;
    } catch (error) {
        return { error: `Could not read the lifecycle hook configuration (${error.name}).` };
    }

    if (!object(hooks) || !object(registry)) return {};
    return Object.fromEntries([['spec', 'specify'], ['plan', 'plan'], ['tasks', 'tasks']].map(([doc, phase]) => [
        doc, ['before', 'after'].flatMap(when => {
            const rows = hooks[`${when}_${phase}`];
            return (Array.isArray(rows) ? rows : rows ? [rows] : []).slice(0, 64).flatMap(row => {
                if (!safeId(row?.extension) || !safeId(row?.command) || !Object.hasOwn(registry, row.extension)) return [];
                return [{ when, extension: row.extension, command: row.command,
                    enabled: row.enabled !== false && registry[row.extension]?.enabled !== false, optional: row.optional !== false }];
            });
        }),
    ]));
}

const figmaHeadings = { spec: 'Figma Design Context', plan: 'Figma Design Plan', tasks: 'Figma-derived tasks' };
export function embeddedFigmaSections(root, id) {
    return Object.keys(figmaHeadings).filter(phase => {
        const text = document(root, `${id}/${phase}.md`)?.toString('utf8') ?? '';
        const marker = new RegExp(`^ {0,3}<!--\\s*speckit-figma:section phase=${phase}(?:\\s|-->)`);
        let fence = null;
        return text.split(/\r?\n/).some(line => {
            const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
            if (opening) {
                if (!fence) fence = opening[1];
                else if (opening[1].startsWith(fence) && !opening[2].trim()) fence = null;
                return false;
            }
            return !fence && (line.trimEnd() === `## ${figmaHeadings[phase]}` || marker.test(line));
        });
    });
}
