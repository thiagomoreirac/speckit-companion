import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { load, JSON_SCHEMA } from './vendor/workflow-yaml.mjs';

const version = '0.36.1';
const commit = 'e69486a5f809ede45c63c0a31358c12912bd5168';
const source = '.github/agents/code-review/functional-code-review.agent.md';
const profile = '.github/agents/functional-code-review.agent.md';
const packageRef = `microsoft/hve-core/${source}#${commit}`;
const profileDigest = 'sha256:d8e18f66997087a1dc0f254e5f1e3492ae2d5e2b6aaa83acaf754ae91e956d0e';
const manifest = `name: companion-agent-imports\nversion: 1.0.0\ntargets:\n  - copilot\ndependencies:\n  apm:\n    - ${packageRef}\n`;
const apmImportPaths = ['apm.yml', 'apm.lock.yaml', profile];
const absentPaths = [...apmImportPaths.slice(1), 'apm.yaml', '.apm', '.apmrc', '.apm-local', 'apm_modules'];
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const executeFile = promisify(execFile);
const mapping = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const emptyList = value => Array.isArray(value) && value.length === 0;
const allowedManifestKeys = new Set(['name', 'version', 'description', 'author', 'targets', 'dependencies', 'includes', 'scripts']);

function initializedManifest(entry) {
    const unsupported = () => invalid('Use APM directly unless apm.yml is an initialized Copilot project with no packages, services, or custom configuration.', 409);
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
            !isDeepStrictEqual(config.targets, ['copilot']) ||
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

export function requireApmImportTarget(root, workspaceEntry) {
    try {
        for (const dir of ['.github', '.github/agents']) {
            const entry = workspaceEntry(root, dir, { rejectSymlinks: true });
            if (entry && !entry.stat.isDirectory()) throw invalid(`Cannot write to ${dir}.`);
        }
        for (const path of absentPaths) {
            if (workspaceEntry(root, path, { rejectSymlinks: true })) {
                throw invalid(`This import does not replace an existing APM setup or destination profile. Found ${path}.`, 409);
            }
        }
        const entry = workspaceEntry(root, 'apm.yml', { rejectSymlinks: true });
        return entry ? initializedManifest(entry) : { before: null, after: manifest };
    } catch (error) {
        if (error.code === 'ELOOP') throw invalid('The APM configuration or profile path traverses a symbolic link.', 409);
        throw error;
    }
}

export function canOfferApmImport(root, workspaceEntry) {
    try { requireApmImportTarget(root, workspaceEntry); return true; }
    catch (error) {
        if (error.status) return false;
        throw error;
    }
}

export async function stageApmImport(workspaceEntry, target) {
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
        await run(['install', '--target', 'copilot', '--only', 'apm']);
        const expected = new Set(['.apm-local', '.github', 'apm_modules', '.gitignore', 'apm.yml', 'apm.lock.yaml']);
        function onlyEntries(path, names) {
            const dir = workspaceEntry(root, path, { rejectSymlinks: true });
            return dir?.stat.isDirectory() && readdirSync(dir.target).every(name => names.has(name));
        }

        if (readdirSync(root).some(name => !expected.has(name)) || !onlyEntries('.github', new Set(['agents'])) ||
            !onlyEntries('.github/agents', new Set([profile.split('/').at(-1)]))) {
            throw invalid('APM staged additional files outside the supported one-profile deployment.');
        }
        const files = apmImportPaths.map(path => {
            const entry = workspaceEntry(root, path, { rejectSymlinks: true });
            if (!entry?.stat.isFile() || entry.stat.size > 24 * 1024) throw invalid(`APM did not stage a bounded ${path}.`);
            return readFileSync(entry.target, 'utf8');
        });
        let lock;
        try { lock = load(files[1], { schema: JSON_SCHEMA }); }
        catch (error) {
            if (error.name !== 'YAMLException') throw error;
            throw invalid('APM did not produce a readable lock receipt.');
        }
        const [dependency] = Array.isArray(lock?.dependencies) ? lock.dependencies : [];
        const [deployment] = Array.isArray(lock?.deployments) ? lock.deployments : [];
        const digest = `sha256:${createHash('sha256').update(files[2]).digest('hex')}`;
        if (files[0] !== target.after || lock?.apm_version !== version || lock.dependencies?.length !== 1 || lock.deployments?.length !== 1 ||
            dependency?.repo_url !== 'microsoft/hve-core' || dependency?.resolved_commit !== commit || dependency?.virtual_path !== source ||
            !Array.isArray(dependency?.deployed_files) || dependency.deployed_files.length !== 1 || dependency.deployed_files[0] !== profile ||
            deployment?.target !== 'copilot' || deployment?.scope !== 'project' || deployment?.value !== profile ||
            deployment?.content_hash !== digest || dependency?.deployed_file_hashes?.[profile] !== digest || digest !== profileDigest) {
            throw invalid('The staged APM manifest, profile, or lock receipt does not match the reviewed pin.');
        }
        return { commit, documents: apmImportPaths.map((path, index) => ({ path, before: index === 0 ? target.before : null, after: files[index] })) };
    } finally { rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
