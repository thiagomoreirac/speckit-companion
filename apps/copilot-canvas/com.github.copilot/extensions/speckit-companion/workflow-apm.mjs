import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { dump, load, JSON_SCHEMA } from './vendor/workflow-yaml.mjs';

const version = '0.36.1';
const commit = 'e69486a5f809ede45c63c0a31358c12912bd5168';
const source = '.github/agents/code-review/functional-code-review.agent.md';
const packageRef = `microsoft/hve-core/${source}#${commit}`;
const profileDigest = 'sha256:d8e18f66997087a1dc0f254e5f1e3492ae2d5e2b6aaa83acaf754ae91e956d0e';
const packageDigest = 'sha256:f72fb0576c878f16201a96a3b69a92b3c3a9e94e371dc7b543b2cae94b07c83b';
const exportFormat = 'speckit-companion-hve-v1';
const targets = new Map([
    ['copilot', { label: 'Copilot', directory: '.github', filename: 'functional-code-review.agent.md' }],
    ['claude', { label: 'Claude Code', directory: '.claude', filename: 'functional-code-review.md' }],
]);
const importTargets = new Map([
    ...[...targets].map(([harness, { label }]) => [harness, { label, harnesses: [harness] }]),
    ['both', { label: 'Copilot and Claude Code', harnesses: ['copilot', 'claude'] }],
]);
const absentPaths = ['apm.lock.yaml', 'apm.yaml', '.apm', '.apmrc', '.apm-local', 'apm_modules'];
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const executeFile = promisify(execFile);
const mapping = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const emptyList = value => Array.isArray(value) && value.length === 0;
const exactItems = (actual, expected) => Array.isArray(actual) && actual.length === expected.length &&
    expected.every(item => actual.includes(item));
const allowedManifestKeys = new Set(['name', 'version', 'description', 'author', 'targets', 'dependencies', 'includes', 'scripts']);
const bounded = text => typeof text === 'string' && Buffer.byteLength(text) <= 24 * 1024;
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function lockReceipt(target) {
    const owner = `microsoft/hve-core/${source}`;
    const profiles = [...target.profiles].sort((a, b) => a.harness.localeCompare(b.harness, 'en'));
    return {
        lockfile_version: '1',
        apm_version: version,
        dependencies: [{
            repo_url: 'microsoft/hve-core', name: 'hve-core-functional-code-review', host: 'github.com',
            resolved_commit: commit, resolved_ref: commit, version: '1.0.0', virtual_path: source,
            is_virtual: true, package_type: 'apm_package',
            deployed_files: profiles.map(item => item.path),
            deployed_file_hashes: Object.fromEntries(profiles.map(item => [item.path, profileDigest])),
            content_hash: packageDigest,
        }],
        deployments: profiles.map(({ harness, path }) => ({
            kind: 'project-relative', target: harness, value: path, runtime: null, scope: 'project',
            owners: [owner], active_owner: owner, content_hash: profileDigest,
        })),
    };
}

export function readApmExport(target, data) {
    if (!mapping(data) || !exactItems(Object.keys(data), ['format', 'lock', 'profile']) ||
        data.format !== exportFormat || !bounded(data.lock) || !bounded(data.profile)) {
        throw invalid('Choose the Companion HVE Core JSON export prepared in the Codespace.');
    }
    if (digest(data.profile) !== profileDigest) throw invalid('The exported reviewer does not match the reviewed pin.');
    let receipt;
    try { receipt = load(data.lock, { schema: JSON_SCHEMA }); }
    catch (error) {
        if (error.name !== 'YAMLException') throw error;
        throw invalid('The export does not contain a readable APM lock receipt.');
    }
    const expected = lockReceipt(target);
    if (!isDeepStrictEqual(receipt, expected)) {
        throw invalid('The exported lock receipt does not match the reviewed package and selected targets.');
    }
    return {
        commit, source: 'export',
        documents: [
            { path: 'apm.yml', before: target.before, after: target.after },
            { path: 'apm.lock.yaml', before: null, after: dump(expected, { schema: JSON_SCHEMA, lineWidth: -1 }) },
            ...target.profiles.map(({ path }) => ({ path, before: null, after: data.profile })),
        ],
    };
}

function initializedManifest(entry, harnesses, label) {
    const unsupported = () => invalid(`Use APM directly unless apm.yml targets exactly ${label} and has no packages, services, or custom configuration.`, 409);
    if (!entry.stat.isFile() || entry.stat.size > 24 * 1024) throw unsupported();
    try {
        const bytes = readFileSync(entry.target);
        if (bytes.length > 24 * 1024) throw unsupported();
        const before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const config = load(before, { schema: JSON_SCHEMA });
        if (!mapping(config) || !Object.keys(config).every(key => allowedManifestKeys.has(key)) ||
            typeof config.name !== 'string' || !config.name.trim() ||
            typeof config.version !== 'string' || !config.version.trim() ||
            !['description', 'author'].every(key => !Object.hasOwn(config, key) || typeof config[key] === 'string') ||
            !exactItems(config.targets, harnesses) ||
            !mapping(config.dependencies) || !emptyList(config.dependencies.apm) ||
            !Object.entries(config.dependencies).every(([key, value]) => ['apm', 'mcp'].includes(key) && emptyList(value)) ||
            Object.hasOwn(config, 'includes') && config.includes !== 'auto' ||
            Object.hasOwn(config, 'scripts') && (!mapping(config.scripts) || Object.keys(config.scripts).length)) throw unsupported();
        const emptyApm = /^([ ]{2,})apm:[ \t]*\[\][ \t]*(#[^\r\n]*)?(?=\r?$)/gm;
        if ([...before.matchAll(emptyApm)].length !== 1) throw unsupported();
        const eol = before.includes('\r\n') ? '\r\n' : '\n';
        const after = before.replace(emptyApm, (_line, indent, comment) =>
            `${indent}apm:${comment ? ` ${comment}` : ''}${eol}${indent}  - ${packageRef}`);
        const expected = { ...config, dependencies: { ...config.dependencies, apm: [packageRef] } };
        if (!isDeepStrictEqual(load(after, { schema: JSON_SCHEMA }), expected)) throw unsupported();
        return { before, after };
    } catch (error) {
        if (error.name === 'YAMLException' || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw unsupported();
        throw error;
    }
}

export function requireApmImportTarget(root, workspaceEntry, harness = 'copilot') {
    const config = importTargets.get(harness);
    if (!config) throw invalid('Choose Copilot, Claude Code, or both for the HVE Core import.');
    const { label, harnesses } = config;
    const profiles = harnesses.map(harness => {
        const { directory, filename } = targets.get(harness);
        const agents = `${directory}/agents`;
        return { harness, directory, agents, filename, path: `${agents}/${filename}` };
    });
    const directories = profiles.flatMap(({ directory, agents }) => [directory, agents]);
    try {
        for (const dir of directories) {
            const entry = workspaceEntry(root, dir, { rejectSymlinks: true });
            if (entry && !entry.stat.isDirectory()) throw invalid(`Cannot write to ${dir}.`);
        }
        for (const path of [...absentPaths, ...profiles.map(item => item.path)]) {
            if (workspaceEntry(root, path, { rejectSymlinks: true })) {
                throw invalid(`This import does not replace an existing APM setup or destination profile. Found ${path}.`, 409);
            }
        }
        const entry = workspaceEntry(root, 'apm.yml', { rejectSymlinks: true });
        const document = entry ? initializedManifest(entry, harnesses, label) : {
            before: null,
            after: `name: companion-agent-imports\nversion: 1.0.0\ntargets:\n${harnesses.map(item => `  - ${item}\n`).join('')}dependencies:\n  apm:\n    - ${packageRef}\n`,
        };
        return { ...document, label, harnesses, directories, profiles };
    } catch (error) {
        if (error.code === 'ELOOP') throw invalid('The APM configuration or profile path traverses a symbolic link.', 409);
        throw error;
    }
}

export function apmImportOptions(root, workspaceEntry) {
    return [...importTargets].flatMap(([harness, { label }]) => {
        try { requireApmImportTarget(root, workspaceEntry, harness); return [{ harness, label }]; }
        catch (error) {
            if (error.status) return [];
            throw error;
        }
    });
}

export async function stageApmImport(workspaceEntry, target) {
    const { harnesses, profiles } = target;
    const profilePaths = profiles.map(item => item.path);
    const apmImportPaths = ['apm.yml', 'apm.lock.yaml', ...profilePaths];
    const staged = mkdtempSync(join(tmpdir(), 'companion-apm-'));
    try {
        const root = join(staged, 'project'), home = join(staged, 'home');
        mkdirSync(root);
        mkdirSync(home);
        const path = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
        const executable = path.map(dir => join(dir, process.platform === 'win32' ? 'apm.exe' : 'apm')).find(candidate => {
            try { accessSync(candidate, constants.X_OK); return true; }
            catch (error) {
                if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
                return false;
            }
        });
        if (!executable) throw invalid(`Install APM ${version} on the canvas host and make it available on PATH.`);
        const env = Object.fromEntries(Object.entries(process.env)
            .filter(([key]) => /^(systemroot|windir|comspec|temp|tmp|tmpdir|pathext)$/i.test(key)));
        Object.assign(env, { PATH: path.join(delimiter), APM_HOME: join(home, 'apm'), HOME: home, USERPROFILE: home,
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'no-git-config'), GIT_TERMINAL_PROMPT: '0' });
        const run = async args => {
            try {
                return (await executeFile(executable, args, { cwd: root, env, windowsHide: true, timeout: 55_000, maxBuffer: 256 * 1024 })).stdout;
            } catch (error) {
                if (error.code === 'ENOENT') throw invalid(`Install APM ${version} on the canvas host and make it available on PATH.`);
                throw invalid('APM could not stage the pinned HVE Core profile. Check the installed version and access to public GitHub.');
            }
        };
        if ((await run(['--version'])).trim() !== `Agent Package Manager (APM) CLI version ${version}`) {
            throw invalid(`This import requires APM ${version}; the installed version has not been verified for this operation.`);
        }
        writeFileSync(join(root, 'apm.yml'), target.after, { flag: 'wx' });
        await run(['install', '--target', harnesses.join(','), '--only', 'apm']);
        const expected = new Set(['.apm-local', ...profiles.map(item => item.directory), 'apm_modules', '.gitignore', 'apm.yml', 'apm.lock.yaml']);
        function onlyEntries(path, names) {
            const dir = workspaceEntry(root, path, { rejectSymlinks: true });
            return dir?.stat.isDirectory() && readdirSync(dir.target).every(name => names.has(name));
        }

        if (readdirSync(root).some(name => !expected.has(name)) || profiles.some(({ directory, agents, filename }) =>
            !onlyEntries(directory, new Set(['agents'])) || !onlyEntries(agents, new Set([filename])))) {
            throw invalid('APM staged additional files outside the supported reviewer deployment.');
        }
        const files = apmImportPaths.map(path => {
            const entry = workspaceEntry(root, path, { rejectSymlinks: true });
            if (!entry?.stat.isFile() || entry.stat.size > 24 * 1024) throw invalid(`APM did not stage a bounded ${path}.`);
            const bytes = readFileSync(entry.target);
            if (bytes.length > 24 * 1024) throw invalid(`APM did not stage a bounded ${path}.`);
            if (profilePaths.includes(path) && digest(bytes) !== profileDigest) {
                throw invalid('A staged profile does not match the reviewed pin.');
            }
            return bytes.toString('utf8');
        });
        let lock;
        try { lock = load(files[1], { schema: JSON_SCHEMA }); }
        catch (error) {
            if (error.name !== 'YAMLException') throw error;
            throw invalid('APM did not produce a readable lock receipt.');
        }
        const [dependency] = Array.isArray(lock?.dependencies) ? lock.dependencies : [];
        const deployments = Array.isArray(lock?.deployments) ? lock.deployments : [];
        if (files[0] !== target.after || lock?.apm_version !== version || lock.dependencies?.length !== 1 || deployments.length !== profiles.length ||
            dependency?.repo_url !== 'microsoft/hve-core' || dependency?.resolved_commit !== commit || dependency?.virtual_path !== source ||
            !exactItems(dependency?.deployed_files, profilePaths) ||
            !isDeepStrictEqual(dependency.deployed_file_hashes, Object.fromEntries(profilePaths.map(path => [path, profileDigest]))) ||
            profiles.some(({ harness, path }) => !deployments.some(item => item?.target === harness && item.scope === 'project' &&
                item.value === path && item.content_hash === profileDigest))) {
            throw invalid('The staged APM manifest, profile, or lock receipt does not match the reviewed pin.');
        }
        return { commit, source: 'local', documents: apmImportPaths.map((path, index) => ({ path, before: index === 0 ? target.before : null, after: files[index] })) };
    } finally { rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

export async function exportApmImport(workspaceEntry, harness) {
    const root = mkdtempSync(join(tmpdir(), 'companion-hve-export-'));
    try {
        const target = requireApmImportTarget(root, workspaceEntry, harness);
        const { documents } = await stageApmImport(workspaceEntry, target);
        const data = { format: exportFormat, lock: documents[1].after, profile: documents[2].after };
        readApmExport(target, data);
        return data;
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
