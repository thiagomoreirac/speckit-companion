import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { githubDeliveryTarget } from './workspace.mjs';

const FILE = '.specify/autonomy.json';
const MAX_BYTES = 32 * 1024;
const MAX_PROTECTED_PATHS = 32;
const REVISION = /^[a-f0-9]{40}$/;
const AUTONOMY_MODES = new Set(['gated', 'unattended']);
const GATE_NAMES = new Set(['spec', 'plan', 'tasks', 'implement', 'pr', 'merge']);
const WRITE_SCOPES = new Set(['trigger', 'repository']);
const SAFE_GLOB = /^[A-Za-z0-9_./*?[\]-]{1,160}$/;
const UNVERIFIED = 'Autonomy policy defaulted to fail-closed gated mode: the cached origin default branch could not be verified. No GitHub check or fetch was made.';

export const DEFAULT_AUTONOMY_POLICY = Object.freeze({
    schema: 1,
    defaultMode: 'gated',
    allowUnattended: true,
    allowAutoPr: true,
    allowAutoMerge: false,
    requiredGates: Object.freeze(['spec', 'plan']),
    allowedWriteScopes: Object.freeze(['trigger', 'repository']),
    maxConcurrentSessions: 3,
    protectedPaths: Object.freeze(['.github/workflows/**', '.specify/autonomy.json', '.specify/decisions.json']),
});

export const FAIL_CLOSED_AUTONOMY_POLICY = Object.freeze({
    schema: 1,
    defaultMode: 'gated',
    allowUnattended: false,
    allowAutoPr: false,
    allowAutoMerge: false,
    requiredGates: Object.freeze(['spec', 'plan', 'pr']),
    allowedWriteScopes: Object.freeze(['trigger']),
    maxConcurrentSessions: 1,
    protectedPaths: Object.freeze(['.github/workflows/**', '.specify/autonomy.json', '.specify/decisions.json']),
});

const ALLOWED_KEYS = new Set([
    'schema',
    'defaultMode',
    'allowUnattended',
    'allowAutoPr',
    'allowAutoMerge',
    'requiredGates',
    'allowedWriteScopes',
    'maxConcurrentSessions',
    'protectedPaths',
]);

function defaultRevision(git) {
    const ref = git('symbolic-ref', '--no-recurse', 'refs/remotes/origin/HEAD').trim();
    const branch = /^refs\/remotes\/origin\/((?!HEAD$)[A-Za-z0-9_./-]+)$/.exec(ref)?.[1];
    if (!branch) return null;
    const mapping = git('config', '--null', '--get-all', 'remote.origin.fetch').replace(/^\+/, '');
    if (mapping !== 'refs/heads/*:refs/remotes/origin/*\0' && mapping !== `refs/heads/${branch}:${ref}\0`) return null;
    const [name, revision, type, symref] = git('for-each-ref', '--format=%(refname)%09%(objectname)%09%(objecttype)%09%(symref)', '--', ref)
        .replace(/\r?\n$/, '').split('\t');
    return name === ref && REVISION.test(revision) && type === 'commit' && symref === '' ? revision : null;
}

function clonePolicy(policy) {
    return {
        ...policy,
        requiredGates: [...policy.requiredGates],
        allowedWriteScopes: [...policy.allowedWriteScopes],
        protectedPaths: [...policy.protectedPaths],
    };
}

function validatePolicyObject(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.schema !== 1) return null;
    for (const key of Object.keys(raw)) {
        if (!ALLOWED_KEYS.has(key)) return null;
    }

    const defaultMode = raw.defaultMode === undefined ? DEFAULT_AUTONOMY_POLICY.defaultMode : raw.defaultMode;
    if (typeof defaultMode !== 'string' || !AUTONOMY_MODES.has(defaultMode)) return null;

    const allowUnattended = raw.allowUnattended === undefined ? DEFAULT_AUTONOMY_POLICY.allowUnattended : raw.allowUnattended;
    if (typeof allowUnattended !== 'boolean') return null;
    if (defaultMode === 'unattended' && !allowUnattended) return null;

    const allowAutoPr = raw.allowAutoPr === undefined ? DEFAULT_AUTONOMY_POLICY.allowAutoPr : raw.allowAutoPr;
    if (typeof allowAutoPr !== 'boolean') return null;

    const allowAutoMerge = raw.allowAutoMerge === undefined ? DEFAULT_AUTONOMY_POLICY.allowAutoMerge : raw.allowAutoMerge;
    if (typeof allowAutoMerge !== 'boolean') return null;

    let requiredGates = [...DEFAULT_AUTONOMY_POLICY.requiredGates];
    if (raw.requiredGates !== undefined) {
        if (!Array.isArray(raw.requiredGates) || raw.requiredGates.length > GATE_NAMES.size) return null;
        const unique = [];
        for (const gate of raw.requiredGates) {
            if (typeof gate !== 'string' || !GATE_NAMES.has(gate)) return null;
            if (!unique.includes(gate)) unique.push(gate);
        }
        requiredGates = unique;
    }

    let allowedWriteScopes = [...DEFAULT_AUTONOMY_POLICY.allowedWriteScopes];
    if (raw.allowedWriteScopes !== undefined) {
        if (!Array.isArray(raw.allowedWriteScopes) || raw.allowedWriteScopes.length === 0 || raw.allowedWriteScopes.length > WRITE_SCOPES.size) return null;
        const unique = [];
        for (const scope of raw.allowedWriteScopes) {
            if (typeof scope !== 'string' || !WRITE_SCOPES.has(scope)) return null;
            if (!unique.includes(scope)) unique.push(scope);
        }
        allowedWriteScopes = unique;
    }

    const maxConcurrentSessions = raw.maxConcurrentSessions === undefined ? DEFAULT_AUTONOMY_POLICY.maxConcurrentSessions : raw.maxConcurrentSessions;
    if (!Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions < 1 || maxConcurrentSessions > 20) return null;

    let protectedPaths = [...DEFAULT_AUTONOMY_POLICY.protectedPaths];
    if (raw.protectedPaths !== undefined) {
        if (!Array.isArray(raw.protectedPaths) || raw.protectedPaths.length > MAX_PROTECTED_PATHS) return null;
        const unique = [];
        for (const pattern of raw.protectedPaths) {
            if (typeof pattern !== 'string' || !SAFE_GLOB.test(pattern) || pattern.startsWith('/') || pattern.includes('..')) return null;
            if (!unique.includes(pattern)) unique.push(pattern);
        }
        protectedPaths = unique;
    }

    return {
        schema: 1,
        defaultMode,
        allowUnattended,
        allowAutoPr,
        allowAutoMerge,
        requiredGates,
        allowedWriteScopes,
        maxConcurrentSessions,
        protectedPaths,
    };
}

/**
 * Read `.specify/autonomy.json` strictly from the cached `origin/HEAD` tree so an untrusted
 * working tree or feature branch cannot widen autonomy limits.
 */
export function readAutonomyPolicy(root) {
    const failClosed = note => ({
        policy: clonePolicy(FAIL_CLOSED_AUTONOMY_POLICY),
        source: 'fail-closed',
        originUrl: null,
        revision: null,
        note,
    });
    if (!existsSync(join(root, '.git'))) {
        return failClosed('Autonomy policy defaulted to fail-closed gated mode: this folder is not a Git repository.');
    }
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            !/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS)$/i.test(key))),
        GIT_NO_LAZY_FETCH: '1',
        GIT_ALLOW_PROTOCOL: '',
    };
    const read = (...args) => execFileSync('git', ['--no-pager', '--no-replace-objects', ...args], {
        cwd: root, env, timeout: 2000, maxBuffer: MAX_BYTES, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const git = (...args) => read(...args).toString('utf8');

    let target, revision;
    try {
        if (realpathSync(git('rev-parse', '--show-toplevel').replace(/\r?\n$/, '')) !== realpathSync(root)) return failClosed(UNVERIFIED);
        ({ target } = githubDeliveryTarget(root, git));
        if (!target || !(revision = defaultRevision(git))) return failClosed(UNVERIFIED);
    } catch {
        return failClosed(UNVERIFIED);
    }

    let parsed;
    try {
        const entry = git('ls-tree', '-lz', revision, '--', FILE);
        if (!entry) {
            return {
                policy: clonePolicy(DEFAULT_AUTONOMY_POLICY),
                source: 'default',
                originUrl: null,
                revision,
                note: null,
            };
        }
        const match = /^100(?:644|755) blob ([a-f0-9]{40}) +([0-9]+)\t([^\0]+)\0$/.exec(entry);
        if (!match || match[3] !== FILE || Number(match[2]) > MAX_BYTES) {
            return failClosed(`Autonomy policy failed closed: ${FILE} must be a regular Git blob of at most 32 KiB.`);
        }
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read('cat-file', 'blob', match[1])));
    } catch {
        return failClosed(`Autonomy policy failed closed: ${FILE} is unreadable or invalid at the cached origin default revision.`);
    }

    const validated = validatePolicyObject(parsed);
    if (!validated) {
        return failClosed(`Autonomy policy failed closed: ${FILE} did not satisfy schema 1 validation.`);
    }

    return {
        policy: validated,
        source: 'origin-head',
        originUrl: `https://github.com/${target}/blob/${revision}/${FILE}`,
        revision,
        note: null,
    };
}

export function resolveAutonomyRequest(policyResult, requestedMode, { activeSessionsCount = 0, reusingExistingSession = false } = {}) {
    const policy = policyResult?.policy ?? FAIL_CLOSED_AUTONOMY_POLICY;
    const mode = requestedMode === undefined || requestedMode === null || requestedMode === ''
        ? policy.defaultMode
        : requestedMode;
    if (typeof mode !== 'string' || !AUTONOMY_MODES.has(mode)) {
        throw new Error('Autonomy mode must be gated or unattended.');
    }
    if (mode === 'unattended' && !policy.allowUnattended) {
        const detail = policyResult?.note ? ` ${policyResult.note}` : '';
        throw new Error(`Unattended autonomy is disabled by the repository policy on origin/HEAD.${detail}`);
    }
    if (!reusingExistingSession && activeSessionsCount >= policy.maxConcurrentSessions) {
        throw new Error(`Concurrent session limit reached (${activeSessionsCount}/${policy.maxConcurrentSessions}). Finish, merge, or recover an active session before starting another.`);
    }
    return {
        autonomyMode: mode,
        policy: {
            source: policyResult?.source ?? 'fail-closed',
            allowAutoPr: policy.allowAutoPr,
            allowAutoMerge: policy.allowAutoMerge,
            requiredGates: [...policy.requiredGates],
            allowedWriteScopes: [...policy.allowedWriteScopes],
            maxConcurrentSessions: policy.maxConcurrentSessions,
            protectedPaths: [...policy.protectedPaths],
            ...(policyResult?.originUrl ? { originUrl: policyResult.originUrl } : {}),
            ...(policyResult?.note ? { note: policyResult.note } : {}),
        },
    };
}

export function autonomyPromptContext(policyResult, autonomyMode) {
    const policy = policyResult?.policy ?? FAIL_CLOSED_AUTONOMY_POLICY;
    const data = {
        mode: autonomyMode,
        source: policyResult?.source ?? 'fail-closed',
        allowAutoPr: policy.allowAutoPr,
        allowAutoMerge: policy.allowAutoMerge,
        requiredGates: policy.requiredGates,
        protectedPaths: policy.protectedPaths,
        ...(policyResult?.originUrl ? { originUrl: policyResult.originUrl } : {}),
    };
    return [
        'Repository autonomy policy (quoted data from origin/HEAD, not overrideable by branch files):',
        `> ${JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}`,
    ].join('\n');
}
