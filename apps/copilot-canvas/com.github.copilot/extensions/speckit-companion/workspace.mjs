import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export function validateRoot(root) {
    if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) {
        throw new Error('Choose an absolute repository directory path.');
    }
    const resolved = realpathSync(root);
    if (!statSync(resolved).isDirectory()) throw new Error('The repository path must be a directory.');
    return resolved;
}

export function validateRepositoryRoot(root) {
    const resolved = validateRoot(root);
    if (!existsSync(join(resolved, '.git')) && !existsSync(join(resolved, '.specify'))) {
        throw new Error('Choose the root of a repository: a folder with .git or .specify in it.');
    }
    return resolved;
}

function githubRepoName(url) {
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/|ssh:\/\/git@ssh\.github\.com:443\/)([a-z0-9][a-z0-9_-]{0,38})\/([a-z0-9_.-]{1,104})\/?$/i.exec(url);
    if (!match) return null;
    const repo = match[2].replace(/\.git$/i, '');
    return repo && repo.length <= 100 && repo !== '.' && repo !== '..' ? `${match[1]}/${repo}`.toLowerCase() : null;
}

export function githubDeliveryTarget(root) {
    const git = (...args) => execFileSync('git', ['--no-pager', ...args], {
        cwd: root, encoding: 'utf8', timeout: 2000, maxBuffer: 8192, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let configured;
    let effective;
    try {
        configured = git('config', '--null', '--get-all', 'remote.origin.url').slice(0, -1).split('\0');
        effective = git('remote', 'get-url', '--all', 'origin').replace(/\r?\n$/, '').split(/\r?\n/);
    } catch {
        return { target: null, blocked: 'Git could not read an origin remote for this checkout. Configure origin before creating issues.' };
    }
    if (configured.length !== 1 || effective.length !== 1) {
        return { target: null, blocked: 'Configure exactly one origin URL before creating issues.' };
    }
    const target = githubRepoName(configured[0]);
    if (!target || target !== githubRepoName(effective[0])) {
        return { target: null, blocked: 'Set origin to a direct github.com repository URL without embedded credentials or a rewrite to another destination.' };
    }
    return { target, blocked: null };
}

export function linkedDraftStorage(workspacePath, instanceId) {
    if (!workspacePath || typeof instanceId !== 'string') return undefined;
    const key = createHash('sha256').update(instanceId).digest('hex');
    const file = join(workspacePath, 'files', 'speckit-companion', `linked-draft-${key}.json`);
    return {
        read() {
            const stat = statSync(file, { throwIfNoEntry: false });
            if (!stat) return null;
            if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('Saved linked draft is not a valid session record.');
            return JSON.parse(readFileSync(file, 'utf8'));
        },
        write(draft) {
            const data = `${JSON.stringify(draft)}\n`;
            if (Buffer.byteLength(data) > 512 * 1024) throw new Error('Too many existing specs to track this linked draft.');
            mkdirSync(dirname(file), { recursive: true });
            const temporary = `${file}.${randomUUID()}.tmp`;
            try {
                writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
                renameSync(temporary, file);
            } finally {
                rmSync(temporary, { force: true });
            }
        },
        clear: () => rmSync(file, { force: true }),
    };
}

export function rootSelection(workspacePath) {
    const file = workspacePath && join(workspacePath, 'files', 'speckit-companion', 'board.json');
    function load() {
        if (!file) return {};
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
            throw error;
        }
    }
    function save(data) {
        if (!file) throw new Error('Session storage is unavailable; the repository selection cannot be saved.');
        mkdirSync(dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
        renameSync(temporary, file);
    }
    return {
        read() {
            const { root } = load();
            return root ? validateRoot(root) : null;
        },
        clear() {
            if (!file) return;
            const data = load();
            delete data.root;
            delete data.source;
            if (Object.keys(data).length) save(data);
            else rmSync(file, { force: true });
        },
        source() {
            if (!file) return null;
            try {
                const { source } = JSON.parse(readFileSync(file, 'utf8'));
                return source && typeof source.sessionId === 'string' ? { sessionId: source.sessionId, name: String(source.name ?? source.sessionId) } : null;
            } catch {
                return null;
            }
        },
        write(root, source) {
            const data = load();
            delete data.source;
            save({ ...data, root, ...(source ? { source } : {}) });
        },
        sessions() {
            const { coordinatedSessions } = load();
            return Array.isArray(coordinatedSessions) ? coordinatedSessions : [];
        },
        writeSessions(coordinatedSessions, root, source) {
            const data = load();
            delete data.root;
            delete data.source;
            save({ ...data, ...(root ? { root } : {}), ...(source ? { source } : {}), coordinatedSessions });
        },
        sortMode(root) {
            return load().sortModes?.[root] ?? 'recent';
        },
        writeSortMode(root, mode) {
            const data = load();
            save({ ...data, sortModes: { ...data.sortModes, [root]: mode } });
        },
    };
}
