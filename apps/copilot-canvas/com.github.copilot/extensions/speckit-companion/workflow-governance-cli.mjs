import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const tools = {
    adr: { name: 'adrkit', version: '0.20.0', package: '@adrkit/cli', entry: 'index.js' },
    prodshape: { name: 'ProductShape', version: '0.26.1', package: '@prodshape/cli', entry: 'bin.js' },
};
const invalid = message => Object.assign(new Error(message), { status: 400 });
const inside = (parent, path) => {
    const tail = relative(parent, path);
    return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`);
};

function commandFor(tool, root, metadata) {
    const liveRoot = realpathSync(root);
    const hostFile = path => statSync(path, { throwIfNoEntry: false })?.isFile() &&
        !inside(liveRoot, realpathSync(path));
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
        const executable = resolve(dir, tool);
        if (inside(root, executable)) continue;
        if (process.platform !== 'win32') {
            if (hostFile(executable)) return [executable];
        } else {
            const npmGlobal = join(dir, 'node_modules', ...metadata.package.split('/'), 'dist', metadata.entry);
            const npmLocal = resolve(dir, '..', ...metadata.package.split('/'), 'dist', metadata.entry);
            for (const path of [npmGlobal, npmLocal]) {
                if (!inside(root, path) && hostFile(path)) return [process.execPath, path];
            }
        }
    }
    throw invalid(`${metadata.name} ${metadata.version} must be installed on the canvas host PATH, outside this repository.`);
}

export async function governanceCli(tool, root, cwd) {
    const metadata = tools[tool];
    const [executable, ...prefix] = commandFor(tool, root, metadata);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(?:NODE_OPTIONS$|NODE_PATH$|GIT_)/i.test(key)) delete env[key];
    }
    Object.assign(env, { NO_COLOR: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0' });
    const call = async (args, { refusalJson = false } = {}) => {
        try {
            const { stdout } = await exec(executable, [...prefix, ...args], { cwd, env, windowsHide: true, timeout: 30_000, maxBuffer: 512 * 1024 });
            return stdout.trim();
        } catch (error) {
            if (refusalJson && typeof error.code === 'number' && error.stdout?.trim()) return error.stdout.trim();
            const reason = error.killed ? `The runtime timed out during ${args.slice(0, 2).join(' ')}.` :
                String(error.stderr || error.stdout || error.message).trim().slice(0, 1000);
            throw invalid(`${metadata.name} refused the operation: ${reason}`);
        }
    };
    if (await call(['--version']) !== metadata.version) throw invalid(`This canvas adapter requires ${metadata.name} ${metadata.version}.`);
    return call;
}
