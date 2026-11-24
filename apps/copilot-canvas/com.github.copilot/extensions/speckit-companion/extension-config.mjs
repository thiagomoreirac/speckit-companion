import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isScalar, parseDocument, Scalar, visit } from './vendor/extension-config-yaml.mjs';
import { applyEdits, modify } from './vendor/settings.mjs';
import { digest, projectPath } from './vendor/work-evidence.mjs';

const REGISTRY = '.specify/extensions/.registry';
const HOOKS = '.specify/extensions.yml';
const MAX_BYTES = 128 * 1024;
const MAX_FIELDS = 40;
const MAX_FILES = 16;
const schemaSuffix = '.companion-schema.json';
const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const keyPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const secretName = /password|passwd|secret|token|credential|authorization|authentication|oauth|api[_-]?key|private[_-]?key|access[_-]?key|(?:^|[_-])auth(?:[_-]|$)/i;
const reservedName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const stale = 'The checkout, installation, or settings changed. Reopen setup and review the changes again.';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = (value, fallback = '') => typeof value === 'string' ? value.trim().slice(0, 240) || fallback : fallback;
const identity = stat => [stat.dev, stat.ino, stat.birthtimeMs];
const fileStamp = stat => [...identity(stat), stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink];
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const withoutBom = text => text.replace(/^\uFEFF/, '');

function regularFile(root, path) {
    const file = projectPath(root, path);
    if (!file) {
        if (lstatSync(join(root, path), { throwIfNoEntry: false })) throw new Error('Setup cannot use linked or non-regular files.');
        return null;
    }
    const stat = lstatSync(file);
    if (stat.nlink !== 1) throw new Error('Setup cannot use linked files.');
    return { file, stat };
}

function read(root, path, limit = MAX_BYTES) {
    const entry = regularFile(root, path);
    if (!entry) return null;
    const { file, stat } = entry;
    if (stat.size > limit) throw new Error('A setup file exceeds the size limit.');
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        if (!isDeepStrictEqual(fileStamp(fstatSync(fd)), fileStamp(stat))) throw new Error(stale);
        const bytes = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < bytes.length) {
            const n = readSync(fd, bytes, count, bytes.length - count);
            if (!n) break;
            count += n;
        }
        if (count !== stat.size || !isDeepStrictEqual(fileStamp(fstatSync(fd)), fileStamp(stat))) throw new Error(stale);
        return { text: decode.decode(bytes.subarray(0, count)), file, stat };
    } finally {
        closeSync(fd);
    }
}

function yamlDocument(text, version = '1.2') {
    const doc = parseDocument(withoutBom(text), { version, uniqueKeys: true, stringKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error('Unsupported YAML.');
    return doc;
}

const yamlMetadata = text => yamlDocument(text).toJS({ maxAliasCount: 0 });
const json = text => JSON.parse(withoutBom(text));
const fileName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(name) && !/[.]$/.test(name) && !reservedName.test(name);
const editableName = name => /\.(?:json|ya?ml)$/i.test(name) &&
    !/^(?:extension|package|package-lock|tsconfig|manifest|workflow|preset|bundle)\./i.test(name) &&
    !/(?:^|[._-])(?:local|env|secrets?|credentials?|tokens?|template)(?:[._-]|$)/i.test(name) &&
    !name.toLowerCase().endsWith(schemaSuffix);

function docsLink(value) {
    return typeof value === 'string' && /^https:\/\/github\.com\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_][a-z0-9_.-]{0,99}\/?$/i.test(value)
        ? value : null;
}

function valid(field, value) {
    if (field.type === 'string') {
        return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) && value === value.toWellFormed() &&
            [...value].length >= Math.max(field.minLength ?? 1, 1) && [...value].length <= (field.maxLength ?? 512) &&
            (!field.choices || field.choices.includes(value));
    }
    if (field.type === 'boolean') return typeof value === 'boolean';
    return typeof value === 'number' && Number.isFinite(value) &&
        (field.type !== 'integer' || Number.isSafeInteger(value)) &&
        value >= (field.minimum ?? -Number.MAX_SAFE_INTEGER) && value <= (field.maximum ?? Number.MAX_SAFE_INTEGER);
}

function schemaFields(text) {
    const schema = json(text);
    const { properties, required = [], type } = schema ?? {};
    if (schema?.['x-companion-version'] !== 1 || type !== 'object' || !record(properties) || !Array.isArray(required) ||
        Object.keys(schema).some(key => !['x-companion-version', '$schema', 'type', 'properties', 'required', 'title', 'description'].includes(key))) {
        throw new Error('Unsupported schema.');
    }
    const keys = Object.keys(properties);
    if (!keys.length || keys.length > MAX_FIELDS || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))) {
        throw new Error('Unsupported schema properties.');
    }
    return keys.map(key => {
        const def = properties[key];
        if (!keyPattern.test(key) || ['constructor', 'prototype'].includes(key) || !record(def)) throw new Error('Unsupported field.');
        const field = { key, title: label(def.title, key), description: label(def.description), type: def.type, required: required.includes(key) };
        if (def.writeOnly === true || def['x-companion-host-only'] === true || def.format === 'password' || secretName.test(key)) {
            return { ...field, type: null, hostOnly: true };
        }
        const annotations = ['title', 'description', 'type', 'writeOnly', 'x-companion-host-only'];
        const rules = { string: ['enum', 'minLength', 'maxLength'], boolean: [], integer: ['minimum', 'maximum'], number: ['minimum', 'maximum'] };
        if (!Object.hasOwn(rules, field.type) || Object.keys(def).some(key => !annotations.includes(key) && !rules[field.type].includes(key))) {
            throw new Error('Unsupported field constraints.');
        }
        for (const name of ['minLength', 'maxLength', 'minimum', 'maximum']) {
            if (!Object.hasOwn(def, name)) continue;
            const value = def[name];
            if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER ||
                (name.endsWith('Length') && (!Number.isInteger(value) || value < 0 || value > 512))) throw new Error('Unsupported field bounds.');
            field[name] = value;
        }
        if (Math.max(field.minLength ?? 1, 1) > (field.maxLength ?? 512) || field.minimum > field.maximum) throw new Error('Unsupported field bounds.');
        if (Object.hasOwn(def, 'enum')) {
            if (!Array.isArray(def.enum) || !def.enum.length || def.enum.length > 20 ||
                def.enum.some(value => !valid(field, value)) || new Set(def.enum).size !== def.enum.length) throw new Error('Unsupported choices.');
            field.choices = def.enum;
        }
        return field;
    });
}

function packageSetup(root, id, registration) {
    if (!idPattern.test(id) || reservedName.test(id) || !record(registration)) return { files: [], problem: 'No supported installed manifest.' };
    const base = `.specify/extensions/${id}`;
    const directory = projectPath(root, base, 'directory');
    if (!directory) return { files: [], problem: 'The installed package folder is missing or linked.' };
    let manifestFile, manifest;
    try {
        manifestFile = read(root, `${base}/extension.yml`);
        if (!manifestFile) return { files: [], problem: 'No installed extension.yml manifest was found.' };
        manifest = yamlMetadata(manifestFile.text);
        if (manifest?.extension?.id !== id || (registration.version != null && manifest.extension.version !== registration.version)) {
            return { files: [], problem: 'The manifest does not match the registered extension or version.' };
        }
    } catch {
        return { files: [], problem: 'The installed manifest is unreadable or unsupported.' };
    }
    const { name, repository } = manifest.extension;
    const info = { name: label(name, id), docs: docsLink(repository), files: [], base, directory, manifestFile };
    const entries = manifest.provides?.config;
    if (entries == null) return info;
    if (!Array.isArray(entries) || entries.length > MAX_FILES) return { ...info, problem: 'The config declarations are unsupported.' };
    const seen = new Set();
    const templates = new Set(entries.filter(entry => typeof entry?.template === 'string').map(entry => entry.template.toLowerCase()));
    for (const entry of entries) {
        const name = entry?.name;
        if (!fileName(name) || seen.has(name.toLowerCase())) return { ...info, files: [], problem: 'The manifest has an unsafe or duplicate config filename.' };
        seen.add(name.toLowerCase());
        const file = { name, description: label(entry.description), required: entry.required === true, template: null, fields: null };
        info.files.push(file);
        if (entry.template != null) {
            if (fileName(entry.template) && projectPath(root, `${base}/${entry.template}`) &&
                lstatSync(join(directory, entry.template)).nlink === 1) file.template = entry.template;
            else file.templateUnavailable = true;
        }
        if (!editableName(name) || templates.has(name.toLowerCase())) continue;
        try {
            file.schema = read(root, `${base}/${name}${schemaSuffix}`);
            if (!file.schema) continue;
            file.fields = schemaFields(file.schema.text);
        } catch {
            file.schemaProblem = true;
        }
    }
    return info;
}

const editable = file => file.fields?.some(field => !field.hostOnly);

export function extensionSetupSummary(root, item) {
    const setup = packageSetup(root, item.id, item);
    return { name: setup.name ?? item.id, mode: setup.files.some(editable) ? 'configure' : setup.files.length ? 'view' : 'manual' };
}

function configDocument(raw, name) {
    const source = raw ? withoutBom(raw.text) : null;
    if (/\.json$/i.test(name)) {
        const text = source ?? '{}\n';
        const values = json(text);
        if (!record(values)) throw new Error('Expected a JSON object.');
        // JSON.parse silently accepts duplicate keys, so also check the document structure.
        yamlDocument(text);
        return { values, write(changes) {
            const eol = text.includes('\r\n') ? '\r\n' : '\n';
            let updated = text;
            for (const [key, value] of Object.entries(changes)) {
                updated = applyEdits(updated, modify(updated, [key], value, { formattingOptions: {
                    insertSpaces: true, tabSize: 2, eol,
                } }));
            }
            return updated;
        } };
    }
    const doc = yamlDocument(source ?? '', '1.1');
    if (doc.contents !== null && !isMap(doc.contents)) throw new Error('Expected a YAML mapping.');
    visit(doc, (_, node) => {
        if (isAlias(node) || node?.anchor || node?.tag || node?.key?.value === '<<') throw new Error('Unsupported YAML syntax.');
    });
    const values = doc.toJS({ maxAliasCount: 0 }) ?? {};
    return { values, write(changes) {
        for (const [key, value] of Object.entries(changes)) {
            const previous = doc.get(key, true);
            if (isScalar(previous)) {
                previous.value = value;
                previous.type = typeof value === 'string' ? Scalar.QUOTE_DOUBLE : Scalar.PLAIN;
                delete previous.format;
                delete previous.source;
            } else {
                const next = doc.createNode(value);
                if (typeof value === 'string') next.type = Scalar.QUOTE_DOUBLE;
                if (previous?.commentBefore) next.commentBefore = previous.commentBefore;
                if (previous?.comment) next.comment = previous.comment;
                doc.set(key, next);
            }
        }
        const output = doc.toString({ lineWidth: 0 });
        return source?.includes('\r\n') ? output.replace(/\n/g, '\r\n') : output;
    } };
}

function inspectFile(root, setup, file) {
    const path = `${setup.base}/${file.name}`;
    let state;
    try {
        const raw = file.fields?.some(field => !field.hostOnly) ? read(root, path) : regularFile(root, path);
        const doc = editable(file) ? configDocument(raw, file.name) : null;
        state = { path, raw, doc };
    } catch {
        state = { path, problem: 'This file cannot be checked safely. Open the extension documentation and configure it manually.' };
    }
    const fields = file.fields?.map(field => ({
        ...field, status: field.hostOnly ? 'host-only' : !state.doc ? 'unchecked' :
            !Object.hasOwn(state.doc.values, field.key) ? 'unset' : valid(field, state.doc.values[field.key]) ? 'set' : 'invalid',
    }));
    const view = {
        path, name: file.name, description: file.description, required: file.required, template: file.template,
        templateUnavailable: file.templateUnavailable, problem: state.problem,
        present: state.problem ? null : Boolean(state.raw), canEdit: !state.problem && Boolean(editable(file)), fields,
        reason: file.schemaProblem ? 'The declared field schema is unreadable or unsupported.' : !fields ? 'No supported field schema is declared.' : null,
    };
    return { ...state, view };
}

function configuredHooks(root, id) {
    try {
        const file = read(root, HOOKS);
        if (!file) return { known: false, hooks: [] };
        const { hooks = {} } = yamlMetadata(file.text) ?? {};
        if (!record(hooks)) return { known: false, hooks: [] };
        const matches = [];
        for (const [phase, bindings] of Object.entries(hooks)) {
            if (!keyPattern.test(phase) || !Array.isArray(bindings)) continue;
            const owned = bindings.filter(binding => binding?.extension === id);
            if (owned.length) matches.push({ phase, enabled: owned.filter(binding => binding.enabled === true).length,
                disabled: owned.filter(binding => binding.enabled === false).length });
        }
        return { known: true, hooks: matches };
    } catch {
        return { known: false, hooks: [] };
    }
}

export function createExtensionConfig() {
    const revisionKey = randomBytes(32);
    let pending;

    function installation(root, id) {
        if (typeof id !== 'string' || !idPattern.test(id) || reservedName.test(id)) throw new Error('Choose a registered extension.');
        let registry, registration;
        try {
            registry = read(root, REGISTRY, 2 * 1024 * 1024);
            const entries = registry && json(registry.text)?.extensions;
            if (record(entries) && Object.hasOwn(entries, id)) registration = entries[id];
        } catch {
            throw new Error('The installed extension registry could not be read.');
        }
        if (!record(registration)) throw new Error('This extension is no longer registered in the selected checkout.');
        return { registry, registration, setup: packageSetup(root, id, registration) };
    }

    function revision(root, generation, registry, setup, file, raw) {
        const stamps = [registry, setup.manifestFile, file.schema, raw].map(entry =>
            entry ? [fileStamp(entry.stat), digest(entry.text)] : null);
        return createHmac('sha256', revisionKey).update(JSON.stringify([
            root, generation, file.name, identity(lstatSync(root)), identity(lstatSync(setup.directory)), stamps,
        ])).digest('base64url');
    }

    function open(root, generation, id, owner) {
        const { registry, registration, setup } = installation(root, id);
        const files = setup.files.map(file => {
            const { view, raw } = inspectFile(root, setup, file);
            view.canEdit &&= owner;
            if (view.canEdit) view.revision = revision(root, generation, registry, setup, file, raw);
            return view;
        });
        return { id, name: setup.name ?? id, docs: setup.docs ?? null, enabled: registration.enabled !== false,
            files, problem: setup.problem, ...configuredHooks(root, id) };
    }

    function target(root, generation, id, name) {
        const { registry, setup } = installation(root, id);
        const file = setup.files.find(file => file.name === name);
        if (!editable(file ?? {})) throw new Error('Choose a file with a supported field schema.');
        const state = inspectFile(root, setup, file);
        if (state.problem) throw new Error(state.problem);
        return { ...state, file, directory: setup.directory, revision: revision(root, generation, registry, setup, file, state.raw) };
    }

    function preview(root, generation, body) {
        pending = null;
        const state = target(root, generation, body.id, body.file);
        if (body.revision !== state.revision) throw new Error(stale);
        if (!record(body.changes) || !Object.keys(body.changes).length || Object.keys(body.changes).length > MAX_FIELDS) {
            throw new Error('Enter at least one project value to review.');
        }
        const changes = Object.create(null);
        const reviewed = [];
        for (const [key, value] of Object.entries(body.changes)) {
            const field = state.file.fields.find(field => field.key === key && !field.hostOnly);
            if (!field) throw new Error('Only declared project fields can be edited.');
            if (!valid(field, value)) throw new Error(`Enter a valid value for ${field.title}.`);
            if (Object.hasOwn(state.doc.values, key) && state.doc.values[key] === value) continue;
            changes[key] = value;
            reviewed.push({ key, title: field.title, value, replaces: Object.hasOwn(state.doc.values, key) });
        }
        if (!reviewed.length) throw new Error('Those values already match the project file.');
        for (const field of state.file.fields) {
            if (field.required && !field.hostOnly && !valid(field, Object.hasOwn(changes, field.key) ? changes[field.key] :
                Object.hasOwn(state.doc.values, field.key) ? state.doc.values[field.key] : undefined)) {
                throw new Error(`Set a valid value for required field ${field.title} before saving.`);
            }
        }
        let content;
        try {
            const bom = state.raw?.text.startsWith('\uFEFF') ? '\uFEFF' : '';
            content = bom + state.doc.write(changes);
            if (Buffer.byteLength(content) > MAX_BYTES) throw new Error();
            const { values } = configDocument({ text: content }, body.file);
            const expected = { ...state.doc.values, ...changes };
            if (!isDeepStrictEqual(values, expected)) throw new Error();
        } catch {
            throw new Error('The edit cannot safely preserve this file. Configure it manually.');
        }
        const token = randomBytes(24).toString('base64url');
        pending = { root, generation, token, id: body.id, file: body.file, revision: state.revision, content, expires: Date.now() + 5 * 60_000 };
        return { root, path: state.path, token, changes: reviewed, creates: !state.raw };
    }

    function save(root, generation, token) {
        if (!pending || pending.root !== root || pending.generation !== generation || pending.token !== token || pending.expires <= Date.now()) {
            throw new Error('Review the settings changes before saving.');
        }
        const approved = pending;
        pending = null;
        const check = () => {
            let state;
            try { state = target(root, generation, approved.id, approved.file); } catch { throw new Error(stale); }
            if (state.revision !== approved.revision) throw new Error(stale);
            return state;
        };
        const state = check();
        const directory = realpathSync(state.directory);
        const file = join(directory, state.file.name);
        const temp = join(directory, `.companion-config-${randomBytes(12).toString('hex')}.tmp`);
        if (directory !== join(realpathSync(root), dirname(state.path))) throw new Error(stale);
        let fd;
        try {
            fd = openSync(temp, 'wx', state.raw ? state.raw.stat.mode & 0o777 : 0o600);
            writeFileSync(fd, approved.content);
            const current = check();
            if (current.directory !== state.directory || realpathSync(current.directory) !== directory) throw new Error(stale);
            const stat = lstatSync(temp);
            if (!stat.isFile() || stat.nlink !== 1 || !isDeepStrictEqual(fileStamp(stat), fileStamp(fstatSync(fd)))) throw new Error(stale);
            closeSync(fd);
            fd = null;
            if (state.raw) renameSync(temp, file);
            else linkSync(temp, file);
        } catch (error) {
            if (error.message === stale) throw error;
            throw new Error('Could not save the reviewed file. Check that the checkout is writable and reopen setup.');
        } finally {
            if (fd !== undefined) {
                if (fd !== null) closeSync(fd);
                try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
        }
        return { root, path: state.path };
    }

    return { open, preview, save, forget() { pending = null; } };
}
