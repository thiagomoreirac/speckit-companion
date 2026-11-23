// Reads spec folders off disk and hands what it read to the shared rules in spec-rules.mjs.

import { readdirSync, readFileSync, statSync, existsSync, globSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, isAbsolute, relative, sep } from 'node:path';
import { inspectSettings, settingValues } from './settings.mjs';
import { listTasks, phaseProgress } from './tasks.mjs';
import { renderMarkdown, setCurrentTask, setHasSpecContext, setTaskSummaries } from './vendor/viewer-markdown.mjs';
import { renderOverview } from './overview.mjs';
import {
    DEFAULT_SPEC_DIRS,
    buildSpecRow,
    currentTask,
    isSpecFolder,
    parseSpecContext,
    pickFeatureSpecName,
    recordLiveIn,
    writtenDocs,
    sortSpecs,
    stepTiming,
} from './spec-rules.mjs';

export { PIPELINE_STEPS, DEFAULT_SPEC_DIRS, specStatusLabel, deriveStepBadges, deriveBadgesFromFiles, findSpec } from './spec-rules.mjs';

/** `spec.md`, or the folder's own `<name>.spec.md` when the living-spec naming is in use. */
export function featureSpecName(specDir) {
    try {
        return pickFeatureSpecName(basename(specDir), readdirSync(specDir));
    } catch {
        return 'spec.md';
    }
}

/** The spec directories to scan: `speckit.specDirectories` from workspace settings when set, else the defaults. */
export function resolveSpecDirs(root) {
    return (settingValues(inspectSettings(root)).specDirectories ?? DEFAULT_SPEC_DIRS).map(dir => dir.replaceAll('\\', '/').replace(/\/+$/, ''));
}

const GLOB = /[*?[\]{}]/;
export function specWatchBase(pattern) {
    const parts = pattern.split('/');
    const wildcard = parts.findIndex(part => GLOB.test(part));
    return wildcard < 0 ? pattern : parts.slice(0, wildcard).join('/') || '.';
}

function holdsSpec(dir) {
    try {
        return isSpecFolder(readdirSync(dir));
    } catch {
        return false;
    }
}

/** Every spec folder under the spec directories, as root-relative POSIX ids. */
export function listSpecFolders(root, specDirs = DEFAULT_SPEC_DIRS) {
    const ids = new Set();
    const settings = settingValues(inspectSettings(root));
    const exclusions = (settings.customWorkflows ?? []).flatMap(w => (w.steering ?? []).map(s => s.path.replaceAll('\\', '/').replace(/\/+$/, '')));
    const realRoot = realpathSync(root);
    const add = id => {
        id = id.split(sep).join('/');
        if (exclusions.some(p => id === p || id.startsWith(`${p}/`))) return;
        const path = join(root, id);
        let real;
        try { real = realpathSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        const rel = relative(realRoot, real);
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
        if (!holdsSpec(path)) return;
        ids.add(id);
    };
    for (const specDir of specDirs) {
        if (GLOB.test(specDir)) {
            const pattern = GLOB.test(specDir.split('/').at(-1)) ? specDir : `${specDir}/*`;
            for (const match of globSync(pattern, { cwd: root, exclude: ['**/node_modules', '**/.git'] })) add(match);
            continue;
        }
        const base = join(root, specDir);
        let entries;
        try {
            entries = readdirSync(base, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            add(relative(root, join(base, entry.name)));
        }
    }
    return [...ids];
}

export function readSpecContext(dir) {
    return parseSpecContext(readText(join(dir, '.spec-context.json')));
}

function readText(path) {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

function latestMtime(dir) {
    let latest = 0;
    try {
        for (const name of readdirSync(dir)) {
            try {
                latest = Math.max(latest, statSync(join(dir, name)).mtimeMs);
            } catch { /* vanished mid-scan */ }
        }
    } catch { /* unreadable */ }
    return latest ? new Date(latest).toISOString() : null;
}

/** Whether Companion's recorder owns the run records of this project. */
export function recordLive(root) {
    return recordLiveIn(path => existsSync(join(root, path)));
}

/** The templates Spec Kit copies into a new spec folder, to tell a copied file from a written one. */
export function readTemplates(root) {
    const template = name => readText(join(root, '.specify', 'templates', `${name}-template.md`));
    return { spec: template('spec'), plan: template('plan'), tasks: template('tasks') };
}

/** The board row for one spec folder. */
export function scanSpec(root, id, templates = readTemplates(root)) {
    const dir = join(root, id);
    const specFile = featureSpecName(dir);
    const ctx = readSpecContext(dir);
    const texts = { spec: readText(join(dir, specFile)), plan: readText(join(dir, 'plan.md')), tasks: readText(join(dir, 'tasks.md')) };
    const files = { spec: texts.spec != null ? specFile : null, plan: texts.plan != null ? 'plan.md' : null, tasks: texts.tasks != null ? 'tasks.md' : null };
    return { ...buildSpecRow({ id, ctx, specText: texts.spec, files, written: writtenDocs(texts, templates), tasksText: texts.tasks, updatedAt: latestMtime(dir), recordLive: recordLive(root) }), sortName: typeof ctx?.specName === 'string' ? ctx.specName : null, source: typeof ctx?.source === 'string' ? ctx.source : null };
}

/** The repository's name, even from a linked worktree (the Copilot app runs sessions in one). */
export function repoName(root) {
    try {
        const gitFile = readFileSync(join(root, '.git'), 'utf8');
        const main = gitFile.match(/^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/m)?.[1];
        if (main) return basename(main);
    } catch { /* a normal checkout keeps .git as a directory */ }
    return basename(root);
}

/** Every spec, most recently touched first. */
export function buildSnapshot(root, specDirs = resolveSpecDirs(root)) {
    const templates = readTemplates(root);
    return {
        generatedAt: new Date().toISOString(),
        root,
        repoName: repoName(root),
        specDirs,
        missingSpecDirectories: !specDirs.some(dir => GLOB.test(dir) ? globSync(dir, { cwd: root }).length > 0 : statSync(join(root, dir), { throwIfNoEntry: false })?.isDirectory()),
        specs: sortSpecs(listSpecFolders(root, specDirs).map(id => scanSpec(root, id, templates))),
    };
}

const DOC_ORDER = ['spec', 'plan', 'tasks', 'research', 'data-model', 'quickstart'];
const DOC_LABELS = { spec: 'Spec', plan: 'Plan', tasks: 'Tasks', research: 'Research', 'data-model': 'Data model', quickstart: 'Quickstart' };

function listDocuments(dir, specFile) {
    const docs = [];
    let names = [];
    try {
        names = readdirSync(dir).filter(n => n.endsWith('.md')).sort();
    } catch { /* unreadable */ }
    for (const fileName of names) {
        const type = fileName === specFile ? 'spec' : fileName.replace(/\.md$/, '');
        docs.push({ type, fileName, label: DOC_LABELS[type] ?? type.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()) });
    }
    try {
        for (const fileName of readdirSync(join(dir, 'checklists')).filter(n => n.endsWith('.md')).sort()) {
            const type = `checklists/${fileName.replace(/\.md$/, '')}`;
            docs.push({ type, fileName: `checklists/${fileName}`, label: `Checklist: ${fileName.replace(/\.md$/, '').replace(/[-_]/g, ' ')}` });
        }
    } catch { /* no checklists */ }
    const rank = d => (DOC_ORDER.includes(d.type) ? DOC_ORDER.indexOf(d.type) : DOC_ORDER.length);
    return docs.sort((a, b) => rank(a) - rank(b) || a.fileName.localeCompare(b.fileName));
}

function asText(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value.what ?? value.decision ?? value.summary ?? null;
    return null;
}

/** Everything the detail pane shows for one spec: rendered documents, tasks, history, and the record's narrative. */
export function readSpecDetail(root, id, { html = true } = {}) {
    const spec = scanSpec(root, id);
    const dir = join(root, id);
    const ctx = readSpecContext(dir) ?? {};
    const hasContext = spec.hasContext;
    setHasSpecContext(hasContext);
    setCurrentTask(currentTask(ctx));
    setTaskSummaries(ctx.task_summaries && typeof ctx.task_summaries === 'object' ? ctx.task_summaries : null);
    const documents = listDocuments(dir, featureSpecName(dir)).map(doc => {
        const raw = readText(join(dir, doc.fileName));
        return html ? { ...doc, html: renderMarkdown(raw ?? ''), version: raw === null ? null : createHash('sha256').update(raw).digest('hex') } : doc;
    });
    const overviewHtml = html ? renderOverview(ctx, root, { steps: spec.steps, boardTimed: !recordLive(root) }) : undefined;
    const tasksText = spec.files.tasks ? readText(join(dir, 'tasks.md')) ?? '' : '';
    const history = (Array.isArray(ctx.history) ? ctx.history : [])
        .filter(e => e && typeof e.step === 'string' && typeof e.at === 'string')
        .map(e => ({ step: e.step, substep: e.substep ?? null, task: e.task ?? null, kind: e.kind ?? null, by: e.by ?? null, at: e.at }));
    const list = key => (Array.isArray(ctx[key]) ? ctx[key].map(asText).filter(Boolean) : []);

    return {
        spec,
        documents,
        taskList: listTasks(tasksText),
        phases: phaseProgress(tasksText),
        overviewHtml,
        timing: stepTiming(ctx),
        customPhaseRuns: Array.isArray(ctx.customPhaseRuns) ? ctx.customPhaseRuns : [],
        checkpointStatus: ctx.checkpointStatus && typeof ctx.checkpointStatus === 'object' && !Array.isArray(ctx.checkpointStatus)
            ? Object.fromEntries(Object.entries(ctx.checkpointStatus).filter(([, status]) => ['pending', 'completed', 'skipped'].includes(status)))
            : {},
        history,
        reviewComments: (Array.isArray(ctx.reviewComments) ? ctx.reviewComments : []).filter(c =>
            c && typeof c.id === 'string' && typeof c.doc === 'string' && typeof c.comment === 'string' &&
            ['pending', 'applied'].includes(c.status) && c.anchor &&
            typeof c.anchor.blockText === 'string' && Number.isInteger(c.anchor.line) &&
            (c.anchor.heading === null || typeof c.anchor.heading === 'string')),
        intent: typeof ctx.intent === 'string' ? ctx.intent : null,
        approach: typeof ctx.approach === 'string' ? ctx.approach : null,
        decisions: list('decisions'),
        verified: list('verified'),
        concerns: Array.isArray(ctx.concerns) ? ctx.concerns.map(asText).filter(Boolean) : (typeof ctx.concerns === 'string' ? [ctx.concerns] : []),
        lastAction: typeof ctx.last_action === 'string' ? ctx.last_action : null,
    };
}
