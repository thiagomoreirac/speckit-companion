import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { governanceCli } from './workflow-governance-cli.mjs';

export const ADR_DIR = 'docs/adr';
export const standardAdr = /^(\d{4})-[a-z0-9][a-z0-9-]{0,150}\.md$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const invalid = message => Object.assign(new Error(message), { status: 400 });

export async function stageAdrAcceptance(root, entry, by, decidedAt, workspaceEntry) {
    if (typeof by !== 'string' || by.length > 120 || !/^(?:@[a-z\d][a-z\d-]*|team:[a-z\d][a-z\d-]*|[a-z\d][a-z\d_.+-]*@[a-z\d-]+(?:\.[a-z\d-]+)+)$/i.test(by)) {
        throw invalid('Enter the human ratifier as @handle, team:slug, or an email address.');
    }
    const corpus = workspaceEntry(root, ADR_DIR);
    if (!corpus?.stat.isDirectory()) throw invalid('The standard ADR corpus is no longer available.');
    const files = readdirSync(corpus.target, { withFileTypes: true });
    if (files.length > 256 || files.some(item => !item.isFile())) {
        throw invalid('ADR acceptance supports a flat corpus of at most 256 regular files.');
    }
    const documents = new Map();
    let total = 0;
    for (const item of files.filter(item => /\.md$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = `${ADR_DIR}/${item.name}`;
        const input = workspaceEntry(root, path);
        if (!input?.stat.isFile() || input.stat.size > 64 * 1024 || (total += input.stat.size) > 2 * 1024 * 1024) {
            throw invalid('The ADR corpus exceeds the size or file limits of the isolated review.');
        }
        documents.set(path, readFileSync(input.target));
    }
    const bytes = documents.get(entry.path);
    const base = bytes?.toString('utf8');
    if (base == null || !Buffer.from(base).equals(bytes)) throw invalid('The selected ADR is not readable UTF-8.');
    const staged = mkdtempSync(join(tmpdir(), 'canvas-adr-'));
    try {
        mkdirSync(join(staged, ADR_DIR), { recursive: true });
        for (const [path, content] of documents) writeFileSync(join(staged, path), content, { flag: 'wx' });
        const call = await governanceCli('adr', root, staged);
        const output = await call(['accept', entry.id, '--by', by, '--dir', ADR_DIR, '--json']);
        let result;
        try { result = JSON.parse(output); }
        catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw invalid('adrkit did not return a readable acceptance result.');
        }
        if (result?.id !== entry.id || result.status !== 'accepted' || result.ratifiedBy !== by ||
            typeof result.path !== 'string' || resolve(staged, result.path) !== join(staged, entry.path) ||
            typeof result.decidedAt !== 'string' || !timestamp.test(result.decidedAt)) {
            throw invalid('adrkit did not confirm the requested decision, file, and ratifier.');
        }
        const changed = readFileSync(join(staged, entry.path), 'utf8');
        const [start, frontmatter, ...rest] = changed.split(/^---[ \t]*\r?$/m);
        const when = new RegExp(`(^[ \\t]+decidedAt:[ \\t]+)(['"]?)${result.decidedAt.replaceAll('.', '\\.')}(\\2)(?=[ \\t]*\\r?$)`, 'gm');
        if (start !== '' || !rest.length || [...frontmatter.matchAll(when)].length !== 1) {
            throw invalid('adrkit returned an unsupported decision timestamp format.');
        }
        const offset = changed.indexOf(frontmatter);
        const next = changed.slice(0, offset) + frontmatter.replace(when, (_value, prefix, quote) =>
            `${prefix}${quote}${decidedAt}${quote}`) + changed.slice(offset + frontmatter.length);
        if (next === base || Buffer.byteLength(next) > 64 * 1024) throw invalid('adrkit did not produce a usable change.');
        for (const [path, contents] of documents) {
            if (path !== entry.path && !readFileSync(join(staged, path)).equals(contents)) {
                throw invalid('adrkit changed another record in the isolated review.');
            }
        }
        return { base, next, stamp: [...documents].map(([path, contents]) => [path, createHash('sha256').update(contents).digest('hex')]) };
    } finally { rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
