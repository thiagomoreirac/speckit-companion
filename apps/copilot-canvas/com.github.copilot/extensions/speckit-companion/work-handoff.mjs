import { execFileSync } from 'node:child_process';
import { githubDeliveryTarget } from './workspace.mjs';

const sha = /^[0-9a-f]{40}$/;
const pathPart = /^[a-z0-9_.-]+$/i;

export function dedicatedWorkHandoff(root, kind, id, path) {
    if (typeof path !== 'string' || path.length > 512 || !path.split('/').every(part =>
        pathPart.test(part) && !part.endsWith('.') && part.toLowerCase() !== '.git')) {
        throw new Error('This work item does not have a supported repository-relative path.');
    }
    const { target: repository } = githubDeliveryTarget(root);
    if (!repository) throw new Error('Choose a checkout with one direct github.com origin before starting dedicated work.');
    const git = (...args) => execFileSync('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', ...args], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
    let ref, revision, tracked, entry;
    try {
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
