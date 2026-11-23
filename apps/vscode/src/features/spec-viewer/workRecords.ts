import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkLink, WorkRecord, WorkSource } from '../../protocol/workEvidence';

const WORK = '.speckit-companion/work-items';
const LINKS = '.speckit-companion/work-links';
const RECORD_ID = /^(business-plan|epic)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const IDEA_SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;
const BUG_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const TYPES: ReadonlySet<string> = new Set(['business-plan', 'epic']);
export const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function projectPath(root: string, name: unknown, kind: 'file' | 'directory' = 'file'): string | null {
    if (typeof name !== 'string' || !name || name.includes('\\')) return null;
    let path = root;
    const parts = name.split('/');
    for (const [index, part] of parts.entries()) {
        if (!part || part === '.' || part === '..' || /[:\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) return null;
        path = join(path, part);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (!stat || stat.isSymbolicLink() || (index < parts.length - 1 || kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) return null;
    }
    return path;
}

export function projectDirectory(root: string, name: string) {
    let prefix = '';
    for (const part of name.split('/')) {
        prefix += `${prefix ? '/' : ''}${part}`;
        const path = join(root, prefix);
        if (!lstatSync(path, { throwIfNoEntry: false })) {
            try {
                mkdirSync(path);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
        }
        if (!projectPath(root, prefix, 'directory')) throw new Error('A Companion data folder is not a regular repository directory.');
    }
    return join(root, name);
}

function text(value: unknown, label: string, limit: number, required = false) {
    if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error(`Enter ${label} (${limit} characters or fewer).`);
    return value.trim();
}

function objects<T>(root: string, directory: string): T[] {
    const base = projectPath(root, directory, 'directory');
    if (!base) {
        if (lstatSync(join(root, directory), { throwIfNoEntry: false })) throw new Error('Companion linked-work storage is not a regular repository directory.');
        return [];
    }
    return readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^[a-z0-9-]+\.json$/.test(entry.name))
        .map(entry => {
            const path = projectPath(root, `${directory}/${entry.name}`);
            if (!path || lstatSync(path).size > 96 * 1024) throw new Error(`Cannot read ${entry.name} in linked work.`);
            return JSON.parse(readFileSync(path, 'utf8'));
        });
}

function sourceId(source: Pick<WorkSource, 'kind' | 'id'>) {
    if (source?.kind === 'idea' && typeof source.id === 'string' && IDEA_SLUG.test(source.id)) return `idea:${source.id}`;
    if (source?.kind === 'bug' && typeof source.id === 'string' && BUG_SLUG.test(source.id)) return `bug:${source.id}`;
    if (TYPES.has(source?.kind) && typeof source.id === 'string' && RECORD_ID.test(source.id) && source.id.startsWith(`${source.kind}-`)) return source.id;
    throw new Error('Select a valid source record.');
}

export function listWork(root: string) {
    const records = objects<WorkRecord>(root, WORK);
    const links = objects<WorkLink>(root, LINKS);
    for (const record of records) {
        if (record?.schema !== 1 || !TYPES.has(record.kind) || typeof record.title !== 'string' ||
            typeof record.description !== 'string' || typeof record.outcome !== 'string' || !Array.isArray(record.dependencies) ||
            sourceId(record) !== record.id) throw new Error('A Companion work record has an unsupported format.');
    }
    for (const link of links) {
        if (link?.schema !== 1 || typeof link.spec !== 'string' || typeof link.source?.title !== 'string') throw new Error('A Companion spec link has an unsupported format.');
        sourceId(link.source);
    }
    return { records, links };
}

export function writeWork(root: string, input: { kind: WorkRecord['kind']; title: string; description: string; outcome?: string; parent?: string; dependencies?: string[] }) {
    if (!TYPES.has(input.kind)) throw new Error('Select Business plan or Epic.');
    const directory = projectDirectory(root, WORK);
    const { records } = listWork(root);
    const parent = input.parent ? records.find(record => record.id === input.parent && record.kind === 'business-plan') : null;
    if (input.parent && (!parent || input.kind !== 'epic')) throw new Error('Choose an existing business plan for this epic.');
    const dependencies = input.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.length > 30 || dependencies.some(id => input.kind !== 'epic' || !records.some(record => record.kind === 'epic' && record.id === id))) {
        throw new Error('Choose existing epics as dependencies.');
    }
    const record: WorkRecord = {
        schema: 1, id: `${input.kind}-${randomUUID()}`, kind: input.kind,
        title: text(input.title, 'a title', 160, true),
        description: text(input.description, 'a description', 12000, true),
        outcome: text(input.outcome ?? '', 'an outcome', 3000), parent: parent?.id ?? null,
        dependencies: [...new Set(dependencies)], createdAt: new Date().toISOString(),
    };
    writeFileSync(join(directory, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    return record;
}

export function writeWorkLink(root: string, spec: string, source: WorkSource) {
    if (!projectPath(root, spec, 'directory')) throw new Error('The selected spec folder no longer exists.');
    const key = sourceId(source);
    const directory = projectDirectory(root, LINKS);
    const record: WorkLink = { schema: 1, spec, source: { kind: source.kind, id: source.id, title: text(source.title, 'a title', 500, true) }, createdAt: new Date().toISOString() };
    const filename = `${digest(`${spec}\0${key}`)}.json`;
    try {
        writeFileSync(join(directory, filename), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = projectPath(root, `${LINKS}/${filename}`);
        if (!existing || lstatSync(existing).size > 96 * 1024) throw new Error('The existing link is not a readable Companion record.');
        const link: WorkLink = JSON.parse(readFileSync(existing, 'utf8'));
        if (link?.schema !== 1 || link.spec !== spec || sourceId(link.source) !== key || typeof link.source.title !== 'string') {
            throw new Error('An existing Companion link has conflicting data.');
        }
        return link;
    }
    return record;
}

export function linkedMarker(root: string, spec: string, specFile: string | null | undefined, marker: string) {
    const path = specFile && projectPath(root, `${spec}/${specFile}`);
    return Boolean(path && lstatSync(path).size < 1024 * 1024 &&
        readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line === `<!-- Companion source: ${marker} -->`).length === 1);
}
