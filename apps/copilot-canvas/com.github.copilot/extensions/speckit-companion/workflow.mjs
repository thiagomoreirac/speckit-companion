import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { nodeFile, readableNode, readPipelineBuildState, readStockWorkflow, setHookEnabled, stockFileToOpen } from './vendor/pipeline-host.mjs';

const exec = promisify(execFile);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
const string = value => typeof value === 'string';
const within = (base, target) => {
    const part = relative(base, target);
    return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

function python() {
    return process.platform === 'win32' ? 'python' : 'python3';
}

async function script(root, name, args = []) {
    const file = join(root, '.specify', 'extensions', 'companion', 'scripts', name);
    if (!existsSync(file)) throw new Error('The Companion Spec Kit extension is not installed in this project.');
    try {
        return await exec(python(), [file, '--project', root, ...args], {
            cwd: root, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
        });
    } catch (error) {
        throw new Error([error.stdout, error.stderr].filter(Boolean).join('\n').trim() || error.message);
    }
}

function required(value, label) {
    if (!string(value) || !value) throw new Error(`${label} is required.`);
    return value;
}

function name(value, label) {
    if (!identifier(value) && !(label === 'node' && value === '_frame')) throw new Error(`Invalid ${label}.`);
    return value;
}

function phases(value) {
    if (!Array.isArray(value) || value.some(p => !p || !string(p.name) || !Array.isArray(p.nodes) || p.nodes.some(n => !identifier(n)))) {
        throw new Error('Invalid phase grouping.');
    }
    return JSON.stringify(value);
}

function order(value) {
    if (!Array.isArray(value) || value.some(n => !identifier(n))) throw new Error('Invalid node order.');
    return value.join(',');
}

function hookArgs(hook) {
    const { hookType, value, note } = hook;
    if (!['command', 'prompt', 'node', 'skill'].includes(hookType) || !string(value) || (note !== undefined && !string(note))) throw new Error('Invalid hook.');
    return ['--hook', hookType, '--ref', ['node', 'skill'].includes(hookType) ? value : '',
        '--run', hookType === 'command' ? value : '', '--text', hookType === 'prompt' ? value : (note ?? '')];
}

function hookPlace(place, label) {
    if (!place || !['before', 'after'].includes(place.when) || !string(place.anchor) || !place.anchor) throw new Error(`Invalid ${label}.`);
    return place;
}

function writeArgs(message) {
    const { type } = message;
    if (type === 'selectWorkflow') {
        if (!string(message.name)) throw new Error('Invalid workflow name.');
        return ['--workflow', message.name];
    }
    if (type === 'newWorkflow') {
        if (!string(message.from)) throw new Error('Invalid source workflow.');
        return ['--new-workflow', name(message.name, 'workflow name'), '--seed-from', message.from];
    }
    if (type === 'newStep') return ['--new-step', name(message.name, 'step name'), '--label', message.label ?? '', '--after', message.after ?? '', '--writes', message.writes ?? ''];
    const args = ['--command', name(message.command, 'step')];
    if (type === 'reorderNodes') return [...args, '--nodes', order(message.order)];
    if (['addNode', 'removeNode', 'moveNode', 'useVariant', 'setPhases'].includes(type)) {
        args.push('--phases', phases(message.phases));
        if (message.order !== undefined) args.push('--nodes', order(message.order));
        const renamed = type === 'useVariant' ? { from: message.replaces, to: message.variant } : message.renamed;
        if (renamed) args.push('--renamed', required(renamed.from, 'Original name'), required(renamed.to, 'New name'));
        return args;
    }
    if (type === 'setTemplateSection') return [...args, '--template-section', required(message.heading, 'Heading'), '--fragment', message.fragment ?? ''];
    if (type === 'addHook') {
        const place = hookPlace(message, 'hook location');
        args.push('--when', place.when, '--anchor', place.anchor, ...hookArgs(message));
        if (message.editIndex !== undefined) {
            if (!Number.isInteger(message.editIndex) || message.editIndex < 0) throw new Error('Invalid hook index.');
            args.push('--edit-index', String(message.editIndex));
        }
        return args;
    }
    if (type === 'removeHook') {
        const place = hookPlace(message, 'hook location');
        if (!Number.isInteger(message.index) || message.index < 0) throw new Error('Invalid hook index.');
        return [...args, '--when', place.when, '--anchor', place.anchor, '--remove-index', String(message.index)];
    }
    if (type === 'moveHook') {
        const from = hookPlace(message.from, 'original hook location');
        const to = hookPlace(message.to, 'new hook location');
        if (!Number.isInteger(from.index) || from.index < 0 || !['node', 'phase'].includes(to.boundary) ||
            (to.index !== undefined && (!Number.isInteger(to.index) || to.index < 0))) throw new Error('Invalid hook move.');
        args.push('--move-from', from.when, from.anchor, String(from.index), '--when', to.when, '--anchor', to.anchor, '--boundary', to.boundary);
        if (to.index !== undefined) args.push('--to-index', String(to.index));
        if (message.hook) args.push(...hookArgs(message.hook));
        return args;
    }
    if (['setDecision', 'restoreDecision'].includes(type)) {
        args.push('--decision', name(message.node, 'decision node'), required(message.verdict, 'Verdict'));
        if (type === 'restoreDecision') return [...args, '--restore-decision'];
        if (!Array.isArray(message.folds) || message.folds.some(step => !identifier(step)) || !string(message.warns)) throw new Error('Invalid decision.');
        return [...args, '--folds', message.folds.join(','), '--warns', message.warns];
    }
    throw new Error(`The ${type} action is not available in this board.`);
}

function nodeIn(graph, command, nodeId) {
    const step = graph.steps?.find(s => s.name === command);
    if (!step) throw new Error('That step is no longer in the workflow.');
    if (nodeId === '_frame') return step.frame;
    const node = step.phases?.flatMap(p => p.nodes).find(n => n.id === nodeId);
    if (!node) throw new Error('That node is no longer in the workflow.');
    return node;
}

function safeNode(root, source) {
    const path = realpathSync(source);
    const extension = realpathSync(join(root, '.specify', 'extensions', 'companion'));
    const projectNodes = join(root, '.specify', 'companion', 'nodes');
    const project = existsSync(projectNodes) ? realpathSync(projectNodes) : null;
    if ((!project || !within(realpathSync(root), project) || !within(project, path)) && !within(extension, path)) {
        throw new Error('The node is outside the project nodes and its installed extension.');
    }
    return path;
}

function projectNode(root, command, nodeId) {
    name(command, 'step');
    name(nodeId, 'node');
    const target = join(root, '.specify', 'companion', 'nodes', command, `${nodeId}.md`);
    let parent = dirname(target);
    while (!existsSync(parent)) parent = dirname(parent);
    if (!within(realpathSync(root), realpathSync(parent))) throw new Error('The node directory is outside the project.');
    return target;
}

function atomicReplace(file, old, content) {
    const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        writeFileSync(temp, content, { flag: 'wx' });
        if (lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== old) {
            throw new Error('The file changed since it was opened. Reopen it before saving.');
        }
        renameSync(temp, file);
    } finally {
        if (existsSync(temp)) unlinkSync(temp);
    }
}

export function createWorkflowHost({ send }) {
    let selectedStock;
    let dismissed = false;
    let nodeRead = null;
    let fileRead = null;
    let pendingUndo = null;
    let queue = Promise.resolve();

    async function graph(root) {
        if (!existsSync(join(root, '.specify', 'extensions', 'companion'))) {
            return { type: 'stock', view: readStockWorkflow(root, selectedStock) };
        }
        try {
            const { stdout } = await script(root, 'pipeline-graph.py');
            const value = JSON.parse(stdout);
            if (!value.error) value.firstRun = !dismissed;
            return { type: 'graph', graph: value, buildState: readPipelineBuildState(root).kind };
        } catch (error) {
            return { type: 'graph', graph: { error: error.message }, buildState: 'unconfigured' };
        }
    }

    async function perform(root, message) {
        if (!message || typeof message !== 'object' || !string(message.type)) throw new Error('Invalid workflow action.');
        const { type } = message;
        if (!['ready', 'readNode', 'readFrame', 'openNode', 'openConfig', 'openStockFile', 'dismissFirstRun', 'undo'].includes(type)) pendingUndo = null;
        if (type === 'ready') return [await graph(root)];
        if (type === 'dismissFirstRun') { dismissed = true; return [await graph(root)]; }
        if (['selectStockWorkflow', 'runStockCommand', 'setStockHook'].includes(type) &&
            existsSync(join(root, '.specify', 'extensions', 'companion'))) throw new Error('This action is only available for stock Spec Kit.');
        if (type === 'selectStockWorkflow') {
            if (!readStockWorkflow(root).workflows.some(w => w.id === message.id)) throw new Error('That workflow is not installed.');
            selectedStock = message.id;
            return [await graph(root)];
        }
        if (type === 'runStockCommand') {
            if (message.command !== 'constitution') throw new Error('Unknown stock command.');
            const sent = await send();
            return [{ type: 'notice', text: sent ? 'Sent constitution to the chat.' : 'No chat is available to run constitution.' }];
        }
        if (type === 'setStockHook') {
            if (!identifier(message.step) || !['before', 'after'].includes(message.when) ||
                !Number.isInteger(message.index) || message.index < 0 || typeof message.enabled !== 'boolean') {
                throw new Error('Invalid stock hook.');
            }
            const file = join(root, '.specify', 'extensions.yml');
            if (!within(realpathSync(root), realpathSync(file)) || lstatSync(file).isSymbolicLink()) throw new Error('The extension registry must be a file inside the project.');
            const old = readFileSync(file, 'utf8');
            const result = setHookEnabled(old, message);
            if ('error' in result) throw new Error(result.error);
            atomicReplace(file, old, result.text);
            return [await graph(root), { type: 'status', status: { tone: 'done', text: 'Hook saved to .specify/extensions.yml' } }];
        }
        if (['openConfig', 'openStockFile', 'openNode'].includes(type)) {
            let file;
            let readOnly = false;
            if (type === 'openConfig') {
                file = join(root, '.specify', 'companion.yml');
                if (!existsSync(file)) throw new Error('This project has no companion.yml yet; the pipeline runs the shipped default.');
            } else if (type === 'openStockFile') {
                if (!string(message.path) || existsSync(join(root, '.specify', 'extensions', 'companion'))) throw new Error('That stock file is unavailable.');
                file = stockFileToOpen(root, message.path, selectedStock);
                if (!file) throw new Error('That file is not one this board drew.');
            } else {
                const command = name(message.command, 'step');
                const nodeId = name(message.nodeId, 'node');
                const drawn = await graph(root);
                if (drawn.type !== 'graph' || drawn.graph.error) throw new Error('The Companion graph is unavailable.');
                file = safeNode(root, nodeIn(drawn.graph, command, nodeId).source);
                readOnly = !within(join(realpathSync(root), '.specify', 'companion', 'nodes'), file);
            }
            if (lstatSync(file).isSymbolicLink() || !within(realpathSync(root), realpathSync(file))) throw new Error('The file must be inside the project and cannot be a symlink.');
            const content = readFileSync(file, 'utf8');
            const token = randomBytes(16).toString('hex');
            fileRead = { root, file, content, readOnly, token };
            return [{ type: 'fileEditor', path: relative(root, file), content, readOnly, token }];
        }
        if (type === 'saveWorkflowFile') {
            if (!fileRead || fileRead.root !== root || fileRead.readOnly || message.token !== fileRead.token || !string(message.content)) throw new Error('That file is not open for editing.');
            const { file, content } = fileRead;
            if (!within(realpathSync(root), realpathSync(file))) throw new Error('The file is no longer inside the project.');
            atomicReplace(file, content, message.content);
            fileRead = null;
            nodeRead = null;
            return [await graph(root), { type: 'fileSaved' }, { type: 'status', status: { tone: 'done', text: 'File saved', detail: 'Build to apply' } }];
        }
        if (type === 'undo') {
            if (!pendingUndo || pendingUndo.root !== root || pendingUndo.token !== message.token) throw new Error('That undo is no longer available.');
            const { target, backup } = pendingUndo;
            if (existsSync(target)) throw new Error('A project copy already exists. The backup was kept.');
            if (!within(realpathSync(root), realpathSync(dirname(target))) ||
                !within(realpathSync(root), realpathSync(backup))) throw new Error('The backup or node directory is outside the project.');
            renameSync(backup, target);
            pendingUndo = null;
            return [await graph(root), { type: 'status', status: { tone: 'done', text: 'Project node restored', detail: 'Build to apply' } }];
        }
        if (type === 'restoreNode') {
            const command = name(message.command, 'step');
            const nodeId = name(message.nodeId, 'node');
            const drawn = await graph(root);
            if (drawn.type !== 'graph' || drawn.graph.error) throw new Error('The Companion graph is unavailable.');
            const node = nodeIn(drawn.graph, command, nodeId);
            const shipped = join(root, '.specify', 'extensions', 'companion', 'nodes', command, `${nodeId}.md`);
            const target = projectNode(root, command, nodeId);
            if (!node.replaced || !existsSync(shipped) || !existsSync(target) ||
                lstatSync(target).isSymbolicLink() || safeNode(root, node.source) !== realpathSync(target)) {
                throw new Error('This node has no project copy that can be returned to a shipped node.');
            }
            const home = join(realpathSync(root), '.speckit-companion');
            if (!existsSync(home)) mkdirSync(home);
            if (!within(realpathSync(root), realpathSync(home))) throw new Error('The backup directory is outside the project.');
            const ignore = join(home, '.gitignore');
            if (!lstatSync(ignore, { throwIfNoEntry: false })) writeFileSync(ignore, '*\n', { flag: 'wx' });
            const backups = join(home, 'workflow-backups');
            if (!existsSync(backups)) mkdirSync(backups);
            if (!within(realpathSync(root), realpathSync(backups))) throw new Error('The backup directory is outside the project.');
            const backup = join(backups, `${command}-${nodeId}-${randomBytes(12).toString('hex')}.md`);
            renameSync(target, backup);
            const token = randomBytes(16).toString('hex');
            pendingUndo = { root, target, backup, token };
            nodeRead = null;
            return [await graph(root), { type: 'status', status: { tone: 'done', text: `${nodeId} runs the shipped node again`, detail: 'Your copy is saved under .speckit-companion/workflow-backups', undo: { token } } }];
        }
        if (type === 'replaceStep') {
            const command = name(message.command, 'step');
            const drawn = await graph(root);
            if (drawn.type !== 'graph' || drawn.graph.error) throw new Error('The Companion graph is unavailable.');
            const step = drawn.graph.steps.find(s => s.name === command);
            if (!step) throw new Error('That step is no longer in the workflow.');
            const nodeId = `${command}-ours`;
            const target = projectNode(root, command, nodeId);
            let seed = null;
            if (existsSync(target)) {
                if (lstatSync(target).isSymbolicLink() || !within(realpathSync(root), realpathSync(target))) {
                    throw new Error('The project node must be a file inside the project.');
                }
            } else {
                const bodies = [step.frame, ...step.phases.flatMap(p => p.nodes)].map(node => readableNode(readFileSync(safeNode(root, node.source), 'utf8')).body).filter(Boolean);
                seed = ['---', `id: ${nodeId}`, `name: ${command} - ours`, 'kind: author', '---', '', bodies.join('\n\n'), ''].join('\n');
                mkdirSync(dirname(target), { recursive: true });
                if (!within(realpathSync(root), realpathSync(dirname(target)))) throw new Error('The node directory is outside the project.');
                writeFileSync(target, seed, { flag: 'wx' });
            }
            try {
                await script(root, 'config_write.py', ['--command', command, '--phases', phases([{ name: `our ${command}`, nodes: [nodeId] }]), '--nodes', nodeId]);
            } catch (error) {
                if (seed !== null && existsSync(target) && !lstatSync(target).isSymbolicLink() && readFileSync(target, 'utf8') === seed) unlinkSync(target);
                throw error;
            }
            return [await graph(root), ...(await perform(root, { type: 'openNode', command, nodeId })), { type: 'status', status: { tone: 'done', text: `${command} runs one document of yours`, detail: 'Build to apply' } }];
        }
        if (['readNode', 'readFrame', 'saveNode'].includes(type)) {
            const command = name(message.command, 'step');
            const nodeId = type === 'readFrame' ? '_frame' : name(message.nodeId, 'node');
            const drawn = await graph(root);
            if (drawn.type !== 'graph' || drawn.graph.error) throw new Error('The Companion graph is unavailable.');
            const node = nodeIn(drawn.graph, command, nodeId);
            const source = safeNode(root, node.source);
            const raw = readFileSync(source, 'utf8');
            const version = createHash('sha256').update(raw).digest('hex');
            if (type !== 'saveNode') {
                nodeRead = { root, command, nodeId, source, version };
                const { body, parts, editable } = readableNode(raw);
                return [{ type: 'nodeBody', command, nodeId, body, parts, editable }];
            }
            if (!string(message.body)) throw new Error('Node instructions must be text.');
            if (!nodeRead || nodeRead.root !== root || nodeRead.command !== command || nodeRead.nodeId !== nodeId || nodeRead.source !== source || nodeRead.version !== version) {
                throw new Error('The node changed since it was opened. Reopen it before saving.');
            }
            const target = projectNode(root, command, nodeId);
            if (existsSync(target) && (lstatSync(target).isSymbolicLink() || realpathSync(target) !== source)) throw new Error('A project copy appeared since this node was opened. Reopen it before saving.');
            mkdirSync(dirname(target), { recursive: true });
            if (!within(realpathSync(root), realpathSync(dirname(target)))) throw new Error('The node directory is outside the project.');
            const temp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
            try {
                writeFileSync(temp, nodeFile(readableNode(raw).meta, message.body), { flag: 'wx' });
                renameSync(temp, target);
            } finally {
                if (existsSync(temp)) unlinkSync(temp);
            }
            const saved = readFileSync(target, 'utf8');
            nodeRead = { root, command, nodeId, source: realpathSync(target), version: createHash('sha256').update(saved).digest('hex') };
            const { body, parts, editable } = readableNode(saved);
            return [await graph(root), { type: 'nodeBody', command, nodeId, body, parts, editable }, { type: 'status', status: { tone: 'done', text: `${nodeId} is yours now`, detail: 'Build to apply' } }];
        }
        if (type === 'preview' || type === 'build') {
            const dryRun = type === 'preview';
            const { stdout, stderr } = await script(root, 'build-pipeline.py', dryRun ? ['--dry-run'] : []);
            const output = [stdout, stderr].filter(Boolean).join('\n').trim();
            const commands = Number(/\[build\] (?:would build|built) (\d+) commands?/.exec(output)?.[1] ?? 0);
            const preview = output.split('[build] what would change:')[1]?.split('\n[build]')[0] ?? '';
            const changed = [...preview.matchAll(/^  (\S+): (?!unchanged\b)(.+)$/gm)].map(match => match[1]);
            return [await graph(root), { type: 'buildReport', report: { ok: true, at: new Date().toLocaleTimeString(), commands, changed, dryRun, output } }];
        }
        if (type === 'repair') {
            await script(root, 'config_repair.py', ['--apply', required(message.repairId, 'Repair')]);
        } else {
            await script(root, 'config_write.py', writeArgs(message));
        }
        return [await graph(root), { type: 'status', status: { tone: 'done', text: 'Workflow saved', detail: 'Build to apply' } }];
    }

    return {
        run(root, message) {
            const next = queue.then(() => perform(root, message));
            queue = next.catch(() => undefined);
            return next;
        },
    };
}
