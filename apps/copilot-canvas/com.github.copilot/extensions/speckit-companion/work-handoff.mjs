import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { githubDeliveryTarget } from './workspace.mjs';

const sha = /^[0-9a-f]{40}$/;
const pathPart = /^[a-z0-9_.-]+$/i;

export function dedicatedWorkHandoff(root, kind, id, path) {
    if (typeof path !== 'string' || path.length > 512 || !path.split('/').every(part =>
        pathPart.test(part) && !part.endsWith('.') && part.toLowerCase() !== '.git')) {
        throw new Error('This work item does not have a supported repository-relative path.');
    }
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(name))),
        GIT_NO_LAZY_FETCH: '1',
        GIT_ALLOW_PROTOCOL: '',
    };
    const readGit = (...args) => execFileSync('git', ['--no-pager', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', ...args], {
        cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
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
