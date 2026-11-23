import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { renderMarkdown } from './vendor/viewer-markdown.mjs';
import { buildAnswerPrompt, buildIdeaDecision, bugActions, clarificationsIn, commandForAction, ensureCacheFolder, gateChoice, ideaActions, ideaSpecDescription, normaliseSlug, PROCESS_TEXT_LIMIT, processExtensionInfo, readBugReports, readIdeaReportsAt, repeatsFromFolder, resolveIdeasDir, resumeCommand, slugFromText } from './vendor/report-host.mjs';
import { resolveCommand } from './prompts.mjs';
import { parseWorkspaceSettings } from './spec-rules.mjs';
import { inspectSettings, settingValues } from './settings.mjs';

const kinds = { bugs: 'bug', ideas: 'assess' };
const safeSlug = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function kind(value) {
    if (!Object.hasOwn(kinds, value)) throw new Error('Choose Bugs or Ideas.');
    return value;
}

function items(root, value) {
    return value === 'bugs' ? readBugReports(root) : readIdeaReportsAt(root, ideasDirectory(root));
}

export function ideasDirectory(root) {
    const file = join(root, '.vscode', 'settings.json');
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return resolveIdeasDir(root, undefined);
        throw error;
    }
    let settings;
    try {
        settings = parseWorkspaceSettings(raw);
    } catch {
        throw new Error('Cannot read workspace settings. Fix .vscode/settings.json before opening ideas.');
    }
    return resolveIdeasDir(root, settings?.['speckit.assessmentsDirectory']);
}

function actions(value, item) {
    return value === 'bugs' ? bugActions(item) : ideaActions(item);
}

function lookup(root, value, slug) {
    kind(value);
    if (typeof slug !== 'string' || !safeSlug.test(slug)) throw new Error('Invalid report folder name.');
    const item = items(root, value).find(candidate => candidate.slug === slug);
    if (!item) throw new Error('That report is no longer available.');
    return item;
}

function inside(root, target) {
    const part = relative(realpathSync(root), realpathSync(target));
    return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function text(root, file) {
    if (!inside(root, file) || statSync(file).size > 1024 * 1024) throw new Error('This report is outside the project or too large to open.');
    return readFileSync(file, 'utf8');
}

function command(root, value, name) {
    const extension = processExtensionInfo(root, kinds[value]);
    if (extension.state !== 'present') throw new Error(`Install Spec Kit's ${kinds[value]} extension before running this action.`);
    if (extension.disabled) throw new Error(`The ${kinds[value]} extension is turned off. Enable it before running this action.`);
    const spelling = resolveCommand(root, name, 'speckit', settingValues(inspectSettings(root)).commandFormat);
    if (!spelling.registered && !spelling.instructions) throw new Error(`The ${spelling.name} command is not available in this project.`);
    const instruction = spelling.instructions ? `\n\nIf the command is not already loaded, read \`${spelling.instructions}\` and follow it.` : '';
    return { ...spelling, instruction };
}

export function listReports(root, value) {
    kind(value);
    return {
        kind: value,
        directory: value === 'bugs' ? '.specify/bugs' : ideasDirectory(root).split(sep).join('/'),
        extension: processExtensionInfo(root, kinds[value]),
        items: items(root, value).map(({ slug, title, state, verdict, severity, stages, latestStage }) => ({ slug, title, state, verdict, severity, stages, latestStage })),
    };
}

export function reportDetail(root, value, slug) {
    const item = lookup(root, value, slug);
    const extension = processExtensionInfo(root, kinds[value]);
    const documents = Object.values(item.reports).filter(report => report.exists).map(report => {
        const content = text(root, report.path);
        return { kind: report.kind, label: report.label, html: renderMarkdown(content), questions: clarificationsIn(content) };
    });
    let description;
    if (value === 'ideas' && item.verdict === 'go' && item.reports.decision?.exists) {
        const decision = buildIdeaDecision(text(root, item.reports.decision.path));
        description = ideaSpecDescription({ title: item.title, folder: relative(root, item.directory).split(sep).join('/'), rationale: [decision?.lead, decision?.rationale].filter(Boolean).join(' '), decision });
    }
    const available = extension.state === 'present' && !extension.disabled;
    const gate = value === 'bugs' && available && gateChoice(item.engine, 'approve')
        ? [{ id: 'bug.approve', label: 'Approve assessment', primary: true }, { id: 'bug.reject', label: 'Reject assessment', primary: false }]
        : [];
    return { ...listReports(root, value), item: { slug, title: item.title, state: item.state, documents, actions: available ? [...gate, ...actions(value, item)] : [], canAnswer: available, description } };
}

export function reportAction(root, value, slug, action) {
    const item = lookup(root, value, slug);
    if (value === 'bugs' && (action === 'bug.approve' || action === 'bug.reject')) {
        const extension = processExtensionInfo(root, kinds[value]);
        const verdict = action === 'bug.approve' ? 'approve' : 'reject';
        const choice = gateChoice(item.engine, verdict);
        const resume = item.engine && resumeCommand(item.engine.runId);
        if (extension.state !== 'present' || extension.disabled || !choice || !resume) throw new Error('This review gate is no longer available.');
        return `Resume the selected bug workflow at its review gate: run \`${resume}\` in an interactive terminal and choose ${choice} (${verdict}) at the assessment review prompt. Do not answer any other gate.`;
    }
    if (!actions(value, item).some(candidate => candidate.id === action)) throw new Error('That action is no longer available for this report.');
    const actionCommand = commandForAction(action);
    if (!actionCommand) throw new Error('That action opens the new spec form instead of running a command.');
    const resolved = command(root, value, actionCommand.replace(/^speckit\./, ''));
    const folder = relative(root, item.directory).split(sep).join('/');
    return `/${resolved.name} slug=${slug}${repeatsFromFolder(action) ? ` Start again from the existing reports in ${folder}.` : ''}${resolved.instruction}`;
}

export function processExtensionPrompt(root, value) {
    kind(value);
    const id = kinds[value];
    const extension = processExtensionInfo(root, id);
    if (extension.disabled) return `Run \`specify extension enable ${id}\` in this repository to turn the ${id} extension back on.`;
    if (extension.state === 'absent') return `Run \`specify extension add ${id} --force\` in this repository to install Spec Kit's ${id} extension.`;
    throw new Error('This extension is already enabled.');
}

export function reportAnswerPrompt(root, value, slug, document, question, answer) {
    const item = lookup(root, value, slug);
    const extension = processExtensionInfo(root, kinds[value]);
    if (extension.state !== 'present' || extension.disabled) throw new Error('Enable the report extension before sending answers.');
    const report = item.reports[document];
    if (!report?.exists || !Object.hasOwn(item.reports, document)) throw new Error('That report is no longer available.');
    if (typeof question !== 'string' || !question.trim() || question.length > 500 || /[\r\n]/.test(question)) throw new Error('The question is invalid.');
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 4000) throw new Error('Enter an answer of at most 4,000 characters.');
    if (!clarificationsIn(text(root, report.path)).includes(question.trim())) throw new Error('This report no longer asks that question.');
    const folder = relative(root, item.directory).split(sep).join('/');
    const staged = `.speckit-companion/report-answers/${value}-${slug}-${document}-${randomBytes(8).toString('hex')}.md`;
    const cache = ensureCacheFolder(root, 'report-answers');
    writeFileSync(join(cache, staged.split('/').at(-1)), `## Question\n${question.trim()}\n\n## Answer\n${answer.trim()}\n\n`, { flag: 'wx' });
    return buildAnswerPrompt({ kind: value === 'bugs' ? 'bug' : 'idea', folder, document, staged, reviseDecision: value === 'ideas' && document !== 'decision' && item.reports.decision?.exists });
}

export function createReportPrompt(root, value, input) {
    kind(value);
    const textValue = typeof input.text === 'string' ? input.text.trim() : '';
    const extra = typeof input.extra === 'string' ? input.extra.trim() : '';
    const slug = normaliseSlug(typeof input.slug === 'string' && input.slug.trim() ? input.slug : slugFromText(textValue));
    if (!textValue || !slug) throw new Error('Enter a description and a folder name.');
    if (textValue.length > PROCESS_TEXT_LIMIT || extra.length > PROCESS_TEXT_LIMIT) throw new Error('The description is too long.');
    const folder = value === 'bugs' ? '.specify/bugs' : ideasDirectory(root);
    let parent = join(root, folder);
    while (!existsSync(parent)) parent = dirname(parent);
    if (parent !== root && !inside(root, parent)) throw new Error('The reports folder resolves outside this project.');
    if (existsSync(join(root, folder, slug))) throw new Error(`A report named ${slug} already exists.`);
    const resolved = command(root, value, value === 'bugs' ? 'bug.assess' : 'assess.intake');
    const cache = ensureCacheFolder(root, 'process-create');
    const filename = `${value}-${slug}-${randomBytes(8).toString('hex')}.md`;
    writeFileSync(join(cache, filename), extra ? `${textValue}\n\n## Additional context\n\n${extra}\n` : `${textValue}\n`, { flag: 'wx' });
    const where = value === 'ideas' && folder !== join('.specify', 'assessments') ? ` Write the idea reports into ${folder.split(sep).join('/')}/${slug}/ instead of .specify/assessments/${slug}/.` : '';
    return `/${resolved.name} slug=${slug} Read the ${value === 'bugs' ? 'bug report' : 'idea'} in the file at .speckit-companion/process-create/${filename} and treat that file as the text to assess.${where}${resolved.instruction}`;
}
