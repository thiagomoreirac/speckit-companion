import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, applyEdits, modify, parse, schemas } from './vendor/settings.mjs';
import { isCompanionInstalled } from './prompts.mjs';

export const SETTINGS_PATH = '.vscode/settings.json';
const MAX_BYTES = 512 * 1024;
const groups = {
    'Project & workflows': ['specDirectories', 'assessmentsDirectory', 'projectFolder', 'defaultWorkflow', 'customWorkflows', 'customCommands'],
    Assistant: ['aiProvider', 'permissionMode', 'commandFormat', 'aiContextInstructions'],
    Interface: ['viewer.activityPanel', 'companion.installPrompt', 'views.steering.visible', 'views.settings.visible', 'notifications.stepComplete', 'telemetry'],
};
const notes = {
    projectFolder: 'VS Code multi-root only. Use Repository directory on this board to change projects.',
    aiProvider: 'This canvas sends to Copilot chat. Choose the agent in the session composer; the VS Code provider is a machine setting.',
    permissionMode: 'Set Tool permissions in the Copilot session or app settings. A repository cannot grant tool permissions.',
    commandFormat: 'Controls built-in command spelling sent by this canvas. VS Code still uses its machine-level setting.',
    'views.settings.visible': 'Controls the VS Code sidebar entry only. Canvas Settings is always available.',
    telemetry: 'Controls the VS Code extension only. This canvas does not send Companion telemetry.',
    customWorkflows: 'The canvas sends custom Specify, Plan, Tasks and Implement commands. For new specs, check that the assistant recorded the workflow ID before continuing. Extra phases, provider flags and terminal-specific options stay in VS Code.',
    customCommands: 'Slash commands are sent to Copilot chat. Commands with autoExecute: false are offered for copying instead.',
};
const readOnly = new Set(['aiProvider', 'permissionMode']);
const titles = {
    specDirectories: 'Spec directories', assessmentsDirectory: 'Assessments directory', projectFolder: 'VS Code project folder',
    defaultWorkflow: 'Default workflow', customWorkflows: 'Custom workflows', customCommands: 'Custom commands',
    aiProvider: 'Assistant provider', permissionMode: 'Tool permissions', commandFormat: 'Command spelling',
    aiContextInstructions: 'AI context instructions', 'views.steering.visible': 'Show project guidance',
    'views.settings.visible': 'Show VS Code Settings view', 'notifications.stepComplete': 'Step completion notices',
    'companion.installPrompt': 'Offer Companion installation', 'viewer.activityPanel': 'Show Activity tab', telemetry: 'VS Code Companion telemetry',
};
const descriptors = Object.entries(groups).flatMap(([group, keys]) => keys.map(name => {
    const key = `speckit.${name}`;
    const schema = schemas[key];
    return { key, group, label: titles[name], type: schema.type, choices: schema.enum ?? null, description: notes[name] ?? schema.description ?? schema.markdownDescription, readOnly: readOnly.has(name), fallback: schema.default };
}));
const ajv = new Ajv({ strict: false });
const validators = new Map(descriptors.map(({ key }) => [key, ajv.compile(schemas[key])]));

function entry(path) {
    try { return lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function read(root) {
    const directory = join(realpathSync(root), '.vscode');
    const dir = entry(directory);
    if (dir && (!dir.isDirectory() || dir.isSymbolicLink())) throw new Error('The .vscode directory must not be a link.');
    const file = join(directory, 'settings.json');
    const stat = entry(file);
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)) throw new Error('Settings must be a regular file of at most 512 KB.');
    const text = stat ? readFileSync(file, 'utf8') : null;
    const errors = [];
    const values = parse((text ?? '{}').replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
    if (errors.length || !values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('Fix the JSON in .vscode/settings.json before editing Companion settings.');
    }
    const version = text === null ? 'missing' : createHash('sha256').update(text).digest('hex');
    return { directory, file, text, values, version, stat };
}

function relativeProjectPath(value, glob = false) {
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f<>|:]/.test(value)) return false;
    const pattern = value.replaceAll('\\', '/');
    return !pattern.startsWith('/') && !pattern.split('/').includes('..')
        && (glob || !/[*?[\]{}]/.test(pattern));
}

function valueError(key, value) {
    const validate = validators.get(key);
    if (!validate(value)) {
        const error = validate.errors?.[0];
        return `${key}${error?.instancePath ?? ''} ${error?.message ?? 'has an invalid value'}.`;
    }
    if (key === 'speckit.specDirectories' && !value.every(pattern => relativeProjectPath(pattern, true))) return `${key} requires repository-relative paths or globs.`;
    if (key === 'speckit.assessmentsDirectory' && !relativeProjectPath(value)) return `${key} requires a repository-relative directory.`;
    return null;
}

export function inspectSettings(root) {
    try {
        const { values, version } = read(root);
        const fields = descriptors.map(field => {
            const { key, readOnly } = field;
            const fallback = key === 'speckit.defaultWorkflow' && isCompanionInstalled(root) ? 'companion' : field.fallback;
            const explicit = Object.hasOwn(values, key);
            const error = explicit && !readOnly ? valueError(key, values[key]) : null;
            return { ...field, fallback, value: !readOnly && explicit ? values[key] : fallback, source: readOnly ? 'Host' : explicit ? 'Repository' : 'Default', error };
        });
        return { root, version, fields };
    } catch (error) {
        return { root, error: error.message, fields: [] };
    }
}

export function settingValues(settings) {
    return Object.fromEntries(settings.fields.filter(field => field.source === 'Repository' && !field.error).map(field => [field.key.slice('speckit.'.length), field.value]));
}

export function saveSettings(root, version, changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Provide settings changes as an object.');
    const original = read(root);
    const conflict = () => Object.assign(new Error('Settings changed on disk. Copy your edits if needed, then reload Settings before saving.'), { status: 409 });
    if (original.version !== version) throw conflict();
    const bom = original.text?.startsWith('\uFEFF') ? '\uFEFF' : '';
    let text = original.text?.slice(bom.length) ?? '{}\n';
    const formattingOptions = { insertSpaces: !/^\t+"/m.test(text), tabSize: /^ {4}"/m.test(text) ? 4 : 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
    for (const [key, value] of Object.entries(changes)) {
        const field = descriptors.find(field => field.key === key);
        if (!field || field.readOnly) throw new Error(`${key} is not editable here.`);
        if (value !== null) {
            const error = valueError(key, value);
            if (error) throw new Error(error);
        } else if (!Object.hasOwn(original.values, key)) continue;
        text = applyEdits(text, modify(text, [key], value === null ? undefined : value, { formattingOptions }));
    }
    text = bom + text;
    if (text === (original.text ?? '{}\n')) return inspectSettings(root);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Settings are too large to save on the board.');
    if (!entry(original.directory)) mkdirSync(original.directory);
    if (read(root).version !== version) throw conflict();
    const temp = join(original.directory, `.settings-${randomUUID()}.tmp`);
    try {
        writeFileSync(temp, text, { flag: 'wx', mode: original.stat?.mode ?? 0o644 });
        if (read(root).version !== version) throw conflict();
        renameSync(temp, original.file);
    } finally {
        if (entry(temp)) unlinkSync(temp);
    }
    return inspectSettings(root);
}
