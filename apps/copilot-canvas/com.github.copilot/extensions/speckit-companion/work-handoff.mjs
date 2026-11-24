import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { githubDeliveryTarget, validateRepositoryRoot, validateRoot } from './workspace.mjs';

const sha = /^[0-9a-f]{40}$/;
const pathPart = /^[a-z0-9_.-]+$/i;

function offlineGit(root) {
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(name))),
        GIT_NO_LAZY_FETCH: '1',
        GIT_ALLOW_PROTOCOL: '',
    };
    return (...args) => execFileSync('git', ['--no-pager', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', ...args], {
        cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
}

export function dedicatedWorkHandoff(root, kind, id, path) {
    if (typeof path !== 'string' || path.length > 512 || !path.split('/').every(part =>
        pathPart.test(part) && !part.endsWith('.') && part.toLowerCase() !== '.git')) {
        throw new Error('This work item does not have a supported repository-relative path.');
    }
    const readGit = offlineGit(root);
    const git = (...args) => readGit(...args).replace(/\r?\n$/, '');
    const { target: repository } = githubDeliveryTarget(root, readGit);
    if (!repository) throw new Error('Choose a checkout with one direct github.com origin before starting dedicated work.');
    let ref, revision, tracked, entry;
    try {
        if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) throw new Error('Not at repository root');
        ref = git('symbolic-ref', 'HEAD');
        if (!ref.startsWith('refs/heads/')) throw new Error('Not on a branch');
        revision = git('rev-parse', '--verify', 'HEAD');
        tracked = git('show-ref', '--hash', '--verify', `refs/remotes/origin/${ref.slice('refs/heads/'.length)}`);
        entry = git('ls-tree', revision, '--', path);
    } catch {
        throw new Error('Choose a checkout on a branch with a known matching origin branch. Companion does not fetch or publish branches.');
    }
    const baseBranch = ref.slice('refs/heads/'.length);
    if (!sha.test(revision) || revision !== tracked) {
        throw new Error('This checkout is not at its recorded origin branch tip. Dedicated work starts from an exact published revision.');
    }
    const [object, committedPath] = entry.split('\t');
    if (!/^100(?:644|755) blob [0-9a-f]{40}$/.test(object) || committedPath !== path) {
        throw new Error('Commit and publish the selected work record as a regular file before handing it off.');
    }
    if (kind === 'idea') {
        let saved;
        try {
            saved = JSON.parse(git('cat-file', 'blob', `${revision}:${path}`));
        } catch {
            throw new Error('Companion could not read the committed idea triage record.');
        }
        if (saved?.schema !== 1 || saved.id !== id || saved.status !== 'ready') {
            throw new Error('Commit and publish the Ready status before handing off this idea.');
        }
    }
    return {
        repository, baseBranch, baseRevision: revision, item: { kind, id, path },
        recordUrl: `https://github.com/${repository}/blob/${revision}/${path}`,
    };
}

const appId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const activities = ['busy', 'idle', 'unknown'];

export function coordinatedSession(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).some(key => !['sessionId', 'cwd', 'name', 'activity', 'url'].includes(key)) ||
        typeof row.sessionId !== 'string' || !row.sessionId.trim() ||
        typeof row.name !== 'string' || !row.name.trim() ||
        (row.activity !== undefined && !activities.includes(row.activity))) {
        throw new Error('Each session requires an id, name and absolute directory or canonical app link, with optional activity.');
    }
    const sessionId = row.sessionId.trim();
    const local = row.cwd !== undefined;
    if (row.url !== undefined ? !appId.test(sessionId) || row.url !== `ghapp://sessions/${sessionId}` : !local) {
        throw new Error('Use the exact canonical app link for this session.');
    }
    return { sessionId, name: row.name.trim(), ...(row.activity ? { activity: row.activity } : {}),
        ...(local ? { cwd: validateRoot(row.cwd) } : {}), ...(row.url ? { url: row.url } : {}) };
}

const pending = row => ['requested', 'delivering-unknown', 'verifying'].includes(row?.status);
const itemKey = handoff => JSON.stringify([handoff.repository.toLowerCase(), handoff.item.kind, handoff.item.id]);

function verifyLocalCheckout(checkout, row) {
    const git = offlineGit(checkout);
    const { baseBranch, baseRevision, repository } = row.handoff;
    try {
        if (checkout === row.root || githubDeliveryTarget(checkout, git).target !== repository
            || realpathSync(git('rev-parse', '--show-toplevel').trim()) !== checkout
            || git('symbolic-ref', 'HEAD').trim() === `refs/heads/${baseBranch}`) throw new Error('Not an isolated checkout');
        if (row.assignment) git('merge-base', '--is-ancestor', baseRevision, 'HEAD');
        else if (git('rev-parse', '--verify', 'HEAD').trim() !== baseRevision) throw new Error('Wrong baseline');
    } catch {
        throw new Error('The confirmed checkout must be on a separate branch of the requested repository at the verified baseline.');
    }
}

export function createDedicatedWork({ storage, send, changed }) {
    const view = row => ({
        kind: row.handoff.item.kind, id: row.handoff.item.id, status: row.status,
        ...(row.detail ? { detail: row.detail } : {}),
        ...(row.status === 'confirmed' ? { session: row.assignment } : {}),
    });
    function find(requestId) {
        const entries = storage.dedicatedWork();
        const index = entries.findIndex(row => row.requestId === requestId);
        if (index < 0) throw new Error('No matching dedicated work request in this coordinator session.');
        return { entries, index, row: entries[index] };
    }
    function save(entries, index, row, session) {
        const next = entries.slice();
        next[index] = row;
        storage.writeDedicatedWork(next, session);
        changed();
        return view(row);
    }
    return {
        forRoot: root => storage.dedicatedWork().filter(row => row.root === root).map(view),
        canAutoFollow: (root, sessionId) => !storage.dedicatedWork().some(row =>
            row.assignment?.sessionId === sessionId || (row.root === root && pending(row))),
        async request(root, handoff) {
            const entries = storage.dedicatedWork();
            const key = itemKey(handoff);
            const index = entries.findIndex(row => row.key === key);
            const prior = entries[index];
            if (pending(prior)) return view(prior);
            const requestId = randomUUID();
            const row = { key, root, handoff, requestId, status: 'requested', assignment: prior?.assignment, assignedRevision: prior?.assignedRevision };
            save(entries, index < 0 ? entries.length : index, row);
            try {
                await send(requestId);
            } catch {
                const latest = storage.dedicatedWork().find(entry => entry.key === key);
                if (latest.requestId === requestId && latest.status === 'requested') {
                    const current = find(requestId);
                    return save(current.entries, current.index, { ...current.row, status: 'delivering-unknown' });
                }
                return view(latest);
            }
            const latest = storage.dedicatedWork().find(entry => entry.key === key);
            return view(latest);
        },
        claim(requestId) {
            const { row, entries, index } = find(requestId);
            if (!['requested', 'delivering-unknown'].includes(row.status)) throw new Error('This request has already been claimed or settled. Do not create another session.');
            save(entries, index, { ...row, status: 'verifying' });
            return { ...row.handoff, assignedSession: row.assignment ?? null, assignedRevision: row.assignedRevision ?? null };
        },
        finish({ requestId, session, baseRevision, blocked }) {
            const { row, entries, index } = find(requestId);
            if (row.status !== 'verifying') throw new Error('Claim the exact outstanding request before reporting a result.');
            if (blocked !== undefined) {
                if (session !== undefined || baseRevision !== undefined || typeof blocked !== 'string' || !blocked.trim() || blocked.length > 300) {
                    throw new Error('Report one concise blocker or a verified session, not both.');
                }
                return save(entries, index, { ...row, status: 'blocked', detail: blocked.trim() });
            }
            if (baseRevision !== row.handoff.baseRevision) throw new Error('The confirmed starting revision does not match the requested baseline.');
            if (row.assignedRevision && row.assignedRevision !== baseRevision) throw new Error('This item is assigned to a session started at a different revision.');
            if (!session?.url) throw new Error('The verified session must have its canonical app link.');
            const confirmed = coordinatedSession(session);
            if (row.assignment && row.assignment.sessionId !== confirmed.sessionId) throw new Error('This item is already assigned to a different session.');
            if (entries.some(other => other.key !== row.key && other.assignment?.sessionId === confirmed.sessionId)) {
                throw new Error('This session is already assigned to a different work item.');
            }
            if (confirmed.cwd) verifyLocalCheckout(validateRepositoryRoot(confirmed.cwd), row);
            return save(entries, index, { ...row, status: 'confirmed', assignment: confirmed, assignedRevision: baseRevision }, confirmed);
        },
    };
}
