import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { githubDeliveryTarget } from './workspace.mjs';

const GATE_DIR = ['.speckit-companion', 'cloud-gates'];
const MAX_ENTRIES = 256;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const EVIDENCE_BUDGET = 16 * MAX_EVIDENCE_BYTES;
const filenamePattern = /^([a-f0-9]{8})\.json$/;
const fieldNames = [
    'schema', 'repository', 'branch', 'issue', 'runId', 'gate', 'evidencePath', 'evidenceRevision',
    'evidenceSha256', 'status', 'choice', 'commentId',
];
const decoder = new TextDecoder('utf-8', { fatal: true });

function isBranch(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(value) &&
        !value.endsWith('.') && !value.includes('..') &&
        value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

function evidenceParts(value) {
    if (typeof value !== 'string' || value.length > 512) return null;
    const parts = value.split('/');
    return parts.length <= 16 && parts.every(part =>
        /^[a-zA-Z0-9._-][a-zA-Z0-9._ -]{0,127}$/.test(part) &&
        !/[. ]$/.test(part) && !/^\.git$/i.test(part) &&
        !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]) *(?:\.|$)/i.test(part)
    ) ? parts : null;
}

function directory(root, parts) {
    let path = root;
    for (const part of parts) {
        path = join(path, part);
        if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Not an ordinary directory');
    }
    return path;
}

function ordinaryFile(root, parts) {
    const path = join(directory(root, parts.slice(0, -1)), parts.at(-1));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== path) throw new Error('Not an ordinary file');
    return { path, stat };
}

function sameFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function readOrdinary(root, parts, limit) {
    const { path, stat } = ordinaryFile(root, parts);
    if (stat.size > limit) throw new Error('File exceeds read limit');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || !sameFile(stat, opened) ||
            !sameFile(stat, ordinaryFile(root, parts).stat)) throw new Error('File changed before reading');
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, length);
            if (!count) break;
            length += count;
        }
        if (length !== stat.size || !sameFile(stat, fstatSync(fd)) ||
            !sameFile(stat, ordinaryFile(root, parts).stat)) throw new Error('File changed while reading');
        return bytes.subarray(0, length);
    } finally {
        closeSync(fd);
    }
}

function parseRecord(bytes, id) {
    const record = JSON.parse(decoder.decode(bytes));
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        Object.keys(record).length !== fieldNames.length || !fieldNames.every(key => Object.hasOwn(record, key))) {
        throw new Error('Invalid v1 fields');
    }
    const { schema, repository, branch, issue, runId, gate, evidencePath, evidenceRevision, evidenceSha256, status, choice, commentId } = record;
    const parts = evidenceParts(evidencePath);
    const comment = typeof commentId === 'string' && /^[1-9][0-9]{0,19}$/.test(commentId);
    const decision = (status === 'paused' && choice === null && commentId === null) ||
        (comment && ((status === 'completed' && choice === 'approve') || (status === 'aborted' && choice === 'reject') ||
            (status === 'uncertain' && (choice === 'approve' || choice === 'reject'))));
    if (schema !== 1 || typeof repository !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(repository) ||
        !isBranch(branch) || !Number.isSafeInteger(issue) || issue < 1 || runId !== id ||
        typeof gate !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(gate) ||
        !parts || typeof evidenceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(evidenceRevision) ||
        typeof evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceSha256) || !decision) {
        throw new Error('Invalid v1 record');
    }
    return { record, parts };
}

function checkoutBranch(root) {
    const git = (...args) => execFileSync('git', ['--no-pager', ...args], {
        cwd: root, encoding: 'utf8', timeout: 2000, maxBuffer: 8192, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/, '');
    try {
        if (realpathSync(git('rev-parse', '--show-toplevel')) !== root) return null;
        const ref = git('symbolic-ref', '--quiet', 'HEAD');
        const prefix = 'refs/heads/';
        return ref.startsWith(prefix) && isBranch(ref.slice(prefix.length)) ? ref.slice(prefix.length) : null;
    } catch {
        return null;
    }
}

export function cloudGateInbox(root) {
    const model = { root, branch: null, repository: null, problem: null, paused: [], past: [],
        skipped: { invalid: 0, foreign: 0, otherBranch: 0 }, limited: false };
    let checkout;
    let source;
    try {
        checkout = realpathSync(root);
    } catch {
        model.problem = 'The selected checkout is not readable.';
        return model;
    }
    try {
        source = directory(checkout, GATE_DIR);
    } catch (error) {
        if (error.code !== 'ENOENT') model.problem = 'The cloud gate folder is not a readable, ordinary directory in this checkout.';
        return model;
    }
    const { target } = githubDeliveryTarget(checkout);
    if (!target) {
        model.problem = 'The checkout needs one direct github.com origin before Companion can link to decisions.';
        return model;
    }
    const branch = checkoutBranch(checkout);
    if (!branch) {
        model.problem = 'Companion could not identify the branch at the selected checkout root. Select a worktree on a branch.';
        return model;
    }
    Object.assign(model, { repository: target, branch });
    const base = `https://github.com/${target}`;
    const digests = new Map();
    let remaining = EVIDENCE_BUDGET;
    function evidenceDigest(path, parts) {
        if (!digests.has(path)) {
            let hash = null;
            try {
                if (remaining > 0) {
                    const bytes = readOrdinary(checkout, parts, Math.min(remaining, MAX_EVIDENCE_BYTES));
                    hash = createHash('sha256').update(bytes).digest('hex');
                    remaining -= bytes.length;
                }
            } catch {
                // Unavailable evidence is not evidence that the file changed.
            }
            digests.set(path, hash);
        }
        return digests.get(path);
    }
    try {
        const dir = opendirSync(source);
        try {
            let count = 0;
            for (let entry; (entry = dir.readSync());) {
                if (++count > MAX_ENTRIES) {
                    model.limited = true;
                    break;
                }
                if (!/\.json$/i.test(entry.name)) continue;
                const id = filenamePattern.exec(entry.name)?.[1];
                let parsed;
                try {
                    if (!id) throw new Error('Invalid filename');
                    parsed = parseRecord(readOrdinary(checkout, [...GATE_DIR, entry.name], MAX_RECORD_BYTES), id);
                } catch {
                    model.skipped.invalid++;
                    continue;
                }
                const { record, parts } = parsed;
                if (record.repository.toLowerCase() !== target) {
                    model.skipped.foreign++;
                    continue;
                }
                if (record.branch !== branch) {
                    model.skipped.otherBranch++;
                    continue;
                }
                const { runId, gate, issue, evidencePath, evidenceRevision, evidenceSha256, status, choice, commentId } = record;
                const hash = evidenceDigest(evidencePath, parts);
                const issueUrl = `${base}/issues/${issue}`;
                const item = { runId, gate, issue, evidencePath, evidenceRevision, status, choice, commentId, issueUrl,
                    evidenceUrl: `${base}/blob/${evidenceRevision}/${parts.map(encodeURIComponent).join('/')}`,
                    commentUrl: commentId ? `${issueUrl}#issuecomment-${commentId}` : null,
                    evidenceCheck: hash === null ? 'unavailable' : hash === evidenceSha256 ? 'matches' : 'stale' };
                (status === 'paused' ? model.paused : model.past).push(item);
            }
        } finally {
            dir.closeSync();
        }
    } catch {
        model.problem = 'Companion could not finish reading the local cloud gate folder. Refresh after checking the folder.';
    }
    model.paused.sort((a, b) => a.issue - b.issue || a.runId.localeCompare(b.runId));
    model.past.sort((a, b) => (b.status === 'uncertain') - (a.status === 'uncertain') || a.issue - b.issue || a.runId.localeCompare(b.runId));
    return model;
}
