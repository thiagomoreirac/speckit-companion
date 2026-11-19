import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path/posix';
import { governanceCli } from './workflow-governance-cli.mjs';

export const PRODUCT_CONFIG = '.product/config.yaml';
export const PRODUCT_CHANGES = '.specify/productshape/changes';
export const PRODUCT_ARCHIVE = '.specify/productshape/archive';
export const PRODUCT_MODEL = 'docs/product/model';
export const standardProductChange = /^[a-z0-9][a-z0-9-]{0,62}$/;
const markdown = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*){0,7}\.md$/;
const digest = text => `sha256:${createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex')}`;
const invalid = message => Object.assign(new Error(message), { status: 400 });
const productHeader = text => /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0];

export function productChangeStatus(text) {
    const header = productHeader(text);
    if (!header || [...header.matchAll(/^status[ \t]*:/gm)].length !== 1) return null;
    return /^status:[ \t]*([a-z-]+)[ \t]*$/m.exec(header)?.[1] ?? null;
}

function stampProductInputs(root, read, workspaceEntry) {
    const stamp = createHash('sha256');
    let entries = 0, bytes = 0;
    function walk(path, depth) {
        const directory = workspaceEntry(root, path);
        if (!directory?.stat.isDirectory() || depth > 10) throw invalid(`Unsupported ProductShape directory: ${path}.`);
        for (const entry of readdirSync(directory.target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const child = `${path}/${entry.name}`;
            if (++entries > 1000 || !entry.isDirectory() && !entry.isFile()) {
                throw invalid('ProductShape review supports up to 1,000 regular entries and no links in the product and hosted-change directories.');
            }
            if (entry.isDirectory()) walk(child, depth + 1);
            else if (/\.(md|ya?ml|json)$/i.test(entry.name)) {
                const text = read(child);
                bytes += Buffer.byteLength(text);
                if (bytes > 2 * 1024 * 1024) throw invalid('ProductShape review inputs exceed 2 MiB.');
                stamp.update(JSON.stringify([child, text]));
            }
        }
    }
    walk('docs/product', 0);
    walk(PRODUCT_CHANGES, 0);
    return stamp.digest('hex');
}

export async function planProductApply(root, name, read, workspaceEntry) {
    const changeFile = `${PRODUCT_CHANGES}/${name}/change.md`;
    const proposalRoot = `${PRODUCT_CHANGES}/${name}/proposed/`;
    const configuration = read(PRODUCT_CONFIG);
    const baseline = read(changeFile);
    const inputStamp = stampProductInputs(root, read, workspaceEntry);
    const call = await governanceCli('prodshape', root, root);
    let result;
    try { result = JSON.parse(await call(['speckit-product', 'apply', name, '--dry-run', '--format', 'json'], { refusalJson: true })); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw invalid('ProductShape did not return a readable dry-run plan.');
    }
    const { plan, change, affectedCitations } = result ?? {};
    if (result?.outcome === 'refused' && Array.isArray(plan?.diagnostics)) {
        const diagnostics = plan.diagnostics.slice(0, 4).map(item => `${item?.code ?? 'ProductShape'}: ${String(item?.message ?? '').slice(0, 180)}`).join('; ');
        throw invalid(`ProductShape refused the change.${diagnostics ? ` ${diagnostics}` : ''}`);
    }
    if (result?.outcome !== 'dry-run' || change?.file !== changeFile || change.digest !== digest(baseline) ||
        change.status !== 'approved' || !Array.isArray(plan?.diagnostics) || plan.diagnostics.length ||
        !Array.isArray(plan.actions) || !Array.isArray(affectedCitations) || plan.actions.length < 2 || plan.actions.length > 9) {
        throw invalid('Select a human-approved Product Change with one to eight model changes and no unresolved diagnostics.');
    }
    if (configuration !== read(PRODUCT_CONFIG)) throw invalid('The ProductShape configuration changed during the preview.');
    const documents = [], sources = [], targets = new Set();
    const modelPath = path => typeof path === 'string' && path.startsWith(`${PRODUCT_MODEL}/`) &&
        markdown.test(path.slice(PRODUCT_MODEL.length + 1));
    for (const [index, action] of plan.actions.entries()) {
        let path, before, after;
        if (action?.kind === 'set-status' && action.from === changeFile && index === plan.actions.length - 1) {
            path = changeFile;
            before = baseline;
            if (read(changeFile) !== before || !productHeader(before)) {
                throw invalid('The hosted Product Change changed or has unrecognized frontmatter.');
            }
            const header = productHeader(before);
            if (productChangeStatus(before) !== 'approved') {
                throw invalid('The hosted Product Change must contain the literal frontmatter status: approved.');
            }
            after = header.replace(/^status:[ \t]*approved[ \t]*$/m, 'status: applied') + before.slice(header.length);
        } else if (action?.kind === 'write' && modelPath(action.to) && typeof action.from === 'string' &&
            action.from.startsWith(proposalRoot) && markdown.test(action.from.slice(proposalRoot.length))) {
            path = action.to;
            after = read(action.from);
            const expected = [...(plan.diff?.added ?? []), ...(plan.diff?.modified ?? [])].find(item => item.file === path);
            if (expected?.digest !== digest(after)) throw invalid('The proposed artifact no longer matches the ProductShape output digest.');
            const current = workspaceEntry(root, path);
            if (!workspaceEntry(root, dirname(path))?.stat.isDirectory() || (expected.kind === 'added') === Boolean(current)) {
                throw invalid('Model additions require an existing destination directory and a new filename; replacements require an existing file.');
            }
            before = current ? read(path) : null;
            sources.push({ path: action.from, text: after });
        } else if (action?.kind === 'delete' && modelPath(action.from) &&
            plan.diff?.removed?.some(item => item.file === action.from)) {
            path = action.from;
            before = read(path);
            after = null;
        } else {
            throw invalid('The ProductShape plan contains an unsupported operation or path.');
        }
        if (targets.has(path.toLowerCase())) throw invalid('The ProductShape plan targets the same file more than once.');
        targets.add(path.toLowerCase());
        documents.push({ path, before, after });
    }
    if (documents.at(-1)?.path !== changeFile) throw invalid('ProductShape did not end its plan with the reviewed change status.');
    if (inputStamp !== stampProductInputs(root, read, workspaceEntry)) {
        throw invalid('ProductShape inputs changed during preflight. Open a new preview.');
    }
    const citations = affectedCitations.map(item => ({
        path: item?.citation?.source, id: item?.citation?.id, status: item?.prospectiveStatus,
    }));
    return { documents, citations, sources, configuration, inputStamp };
}

export async function planProductArchive(root, name, read, workspaceEntry) {
    if (!standardProductChange.test(name)) throw invalid('Choose an inventoried Product Change.');
    const from = `${PRODUCT_CHANGES}/${name}`, to = `${PRODUCT_ARCHIVE}/${name}`;
    const stale = message => Object.assign(new Error(message), { status: 409 });
    const configuration = read(PRODUCT_CONFIG);
    const archiveRoot = join(root, PRODUCT_ARCHIVE);
    function checkDestination() {
        if (lstatSync(archiveRoot, { throwIfNoEntry: false }) && !workspaceEntry(root, PRODUCT_ARCHIVE)?.stat.isDirectory()) {
            throw invalid('The ProductShape archive must be a regular project directory.');
        }
        if (lstatSync(join(root, to), { throwIfNoEntry: false })) throw invalid('The Product Change archive destination already exists.');
    }
    function tree(path, workspace = root, slot = null) {
        const entries = [];
        let total = 0;
        function walk(relative, depth) {
            const entry = workspaceEntry(workspace, `${path}${relative ? `/${relative}` : ''}`);
            if (!entry || depth > 10 || entries.length >= 1000) throw invalid('The Product Change has unsupported paths, links, or too many entries.');
            if (entry.stat.isDirectory()) {
                if (relative) entries.push({ relative, kind: 'directory' });
                if (slot) mkdirSync(join(slot, path, relative), { recursive: true });
                for (const name of readdirSync(entry.target).sort()) walk(relative ? `${relative}/${name}` : name, depth + 1);
            } else if (relative && entry.stat.isFile() && entry.stat.size <= 2 * 1024 * 1024 - total) {
                const bytes = readFileSync(entry.target);
                total += bytes.length;
                if (total > 2 * 1024 * 1024) throw invalid('The Product Change exceeds the 2 MiB archive review limit.');
                entries.push({ relative, kind: 'file', sha256: createHash('sha256').update(bytes).digest('hex') });
                if (slot) writeFileSync(join(slot, path, relative), bytes, { flag: 'wx' });
            } else throw invalid('The Product Change contains an unsupported file or exceeds the 2 MiB archive review limit.');
        }
        walk('', 0);
        return entries;
    }
    checkDestination();
    const staged = mkdtempSync(join(tmpdir(), 'canvas-product-archive-'));
    let entries;
    try {
        entries = tree(from, root, staged);
        mkdirSync(join(staged, '.product'));
        writeFileSync(join(staged, PRODUCT_CONFIG), configuration, { flag: 'wx' });
        const call = await governanceCli('prodshape', root, staged);
        let result;
        try { result = JSON.parse(await call(['speckit-product', 'archive', name, '--format', 'json'])); }
        catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw invalid('ProductShape did not return a readable archive result.');
        }
        if (result?.archived !== to || workspaceEntry(staged, from) ||
            JSON.stringify(tree(to, staged)) !== JSON.stringify(entries)) {
            throw invalid('ProductShape did not preserve the exact reviewed Product Change tree.');
        }
    } finally { rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    const stamp = JSON.stringify(entries);
    function recheck() {
        checkDestination();
        if (read(PRODUCT_CONFIG) !== configuration || JSON.stringify(tree(from)) !== stamp) {
            throw stale('The Product Change or configuration changed. Open a new preview.');
        }
    }
    recheck();
    return {
        from, to, entries, configuration,
        execute() {
            recheck();
            if (!workspaceEntry(root, PRODUCT_ARCHIVE)) mkdirSync(archiveRoot);
            checkDestination();
            renameSync(join(root, from), join(root, to));
        },
    };
}
