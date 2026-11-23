import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const GROUPS = [
    { label: 'Project instructions', files: ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'] },
    { label: 'Workspace settings', files: ['.vscode/settings.json'] },
    { label: 'Instructions', directory: '.github/instructions', match: name => name.endsWith('.instructions.md') },
    { label: 'Steering documents', directory: '.claude/steering', match: name => name.endsWith('.md') },
    { label: 'Agents', directory: '.github/agents', match: name => name.endsWith('.agent.md') },
    { label: 'Skills', directory: '.github/skills', match: name => name === 'SKILL.md' },
    { label: 'Shared skills', directory: '.agents/skills', match: name => name === 'SKILL.md' },
    { label: 'Spec Kit', files: ['.specify/memory/constitution.md'] },
    { label: 'Spec Kit templates', directory: '.specify/templates', match: name => name.endsWith('.md') },
    { label: 'Spec Kit scripts', directory: '.specify/scripts', match: name => /\.(sh|ps1|py)$/.test(name) },
];
const MAX_FILE_BYTES = 512 * 1024;

function inside(root, file) {
    const part = relative(root, file);
    return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function safeFile(root, path) {
    const file = join(root, path);
    if (!existsSync(file)) return null;
    if (lstatSync(file).isSymbolicLink()) return null;
    const realRoot = realpathSync(root);
    const real = realpathSync(file);
    if (!inside(realRoot, real) || !lstatSync(real).isFile()) return null;
    return real;
}

function filesIn(root, group) {
    if (group.files) return group.files.filter(path => safeFile(root, path));
    const base = join(root, group.directory);
    if (!existsSync(base)) return [];
    if (!inside(realpathSync(root), realpathSync(base))) return [];
    const found = [];
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const file = join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile() && group.match(entry.name)) found.push(relative(root, file).split(sep).join('/'));
        }
    }
    walk(base);
    return found.sort();
}

export function createProjectFiles() {
    let opened = null;
    function list(root, settings = {}) {
        return GROUPS.filter(group => settings['views.steering.visible'] !== false || !['Project instructions', 'Instructions', 'Steering documents'].includes(group.label))
            .map(group => ({ label: group.label, files: filesIn(root, group) })).filter(group => group.files.length);
    }
    function openPath(root, path, base) {
        const file = safeFile(root, path);
        if (!file) throw new Error('That project file is outside the project or no longer exists.');
        if (base && (!inside(realpathSync(root), realpathSync(base)) || !inside(realpathSync(base), file))) throw new Error('That document is outside its spec folder.');
        if (statSync(file).size > MAX_FILE_BYTES) throw new Error('This file is too large to edit on the board.');
        const content = readFileSync(file, 'utf8');
        const token = randomBytes(24).toString('base64url');
        opened = { root, file, path, content, token, base };
        return { path, content, token };
    }
    function open(root, path) {
        if (typeof path !== 'string' || !list(root).some(group => group.files.includes(path))) throw new Error('That project file is no longer available.');
        return openPath(root, path);
    }
    function save(root, token, content) {
        if (!opened || opened.root !== root || opened.token !== token || typeof content !== 'string') throw new Error('Reopen the file before saving.');
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('This file is too large to save on the board.');
        const { file, path, content: original, base } = opened;
        if (safeFile(root, path) !== file) throw new Error('The file changed since it was opened. Reopen it before saving.');
        if (base && !inside(realpathSync(base), file)) throw new Error('The spec folder changed since the document was opened.');
        const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
        try {
            const mode = statSync(file).mode;
            writeFileSync(temp, content, { flag: 'wx', mode });
            chmodSync(temp, mode);
            if (lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== original) throw new Error('The file changed since it was opened. Reopen it before saving.');
            renameSync(temp, file);
        } finally {
            if (existsSync(temp)) unlinkSync(temp);
        }
        opened.content = content;
        return { path };
    }
    function current(root, token) {
        if (!opened || opened.root !== root || opened.token !== token || safeFile(root, opened.path) !== opened.file) throw new Error('Reopen the file before refining it.');
        return opened.path;
    }
    function reviewed(root, token) {
        return { path: current(root, token), content: opened.content };
    }
    function forget() {
        opened = null;
    }
    return { list, open, openPath, save, current, reviewed, forget };
}
