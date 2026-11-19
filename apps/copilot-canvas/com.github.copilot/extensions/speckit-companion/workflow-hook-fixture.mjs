import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const branches = { sequential: 'design/012-checkout', timestamp: '20260319-143022-checkout', invalid: 'main' };
export function hookFixtures(edge) {
    return edge.owner === 'extension:git' && edge.command === 'speckit.git.validate' ?
        [['sequential', 'Sequential feature branch'], ['timestamp', 'Timestamp feature branch'], ['invalid', 'Non-feature branch']] : [];
}

export async function testHookFixture(edge, key) {
    if (!hookFixtures(edge).some(([id]) => id === key)) {
        throw Object.assign(new Error('This hook has no isolated executable fixture. Use its wiring test instead.'), { status: 400 });
    }
    const root = await mkdtemp(join(tmpdir(), 'canvas-hook-'));
    try {
        const name = branches[key];
        const prefix = /^(?:\d{8}-\d{6}|\d{3,})-/.exec(name.split('/').at(-1))?.[0];
        await mkdir(join(root, 'specs'), { recursive: true });
        if (prefix) await mkdir(join(root, 'specs', `${prefix}checkout`));
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
        Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-global-config'), GIT_TERMINAL_PROMPT: '0' });
        const git = async (...args) => {
            try { return await exec('git', args, { cwd: root, env, windowsHide: true, timeout: 20_000 }); }
            catch (error) {
                if (error.killed) throw Object.assign(new Error(`Git ${args[0]} timed out in the disposable hook fixture.`), { status: 503 });
                if (error.code === 'ENOENT') throw Object.assign(new Error('Git is not on the canvas host PATH.'), { status: 503 });
                throw error;
            }
        };
        await git('init', '--template=', `--initial-branch=${name}`);
        const { stdout } = await git('symbolic-ref', '--short', 'HEAD');
        const branch = stdout.trim();
        const marker = /^(?:\d{8}-\d{6}|\d{3,})-/.exec(branch.split('/').at(-1))?.[0];
        const match = marker && (await readdir(join(root, 'specs'))).find(dir => dir.startsWith(marker));
        return { adapter: 'Git feature branch validation', fixture: key, branch, expected: key !== 'invalid',
            feature: Boolean(marker), artifact: match ? `specs/${match}` : null };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
