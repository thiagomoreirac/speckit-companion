import { selectState, setupStatesSelect } from '/states-select.mjs';
import { resolveAnchorLine } from '/reanchor.mjs';
import { fuzzyMatch, normalize } from '/fuzzy-match.mjs';
import { createSettingsPage } from '/settings.js';
import { createEcosystemView } from '/ecosystem.js';
import { createRoutinesPage } from '/routines.js';
import { createDecisionsPage } from '/decisions.js';

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';

const forcedTheme = ['light', 'dark'].includes(params.get('theme')) ? params.get('theme') : null;
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
const applyTheme = () => {
    const theme = forcedTheme ?? (systemLight.matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
    document.body.classList.toggle('vscode-light', theme === 'light');
    document.body.classList.toggle('vscode-dark', theme === 'dark');
};
applyTheme();
systemLight.addEventListener('change', applyTheme);

const STEPS = ['specify', 'plan', 'tasks', 'implement'];
const STEP_LABELS = { specify: 'Specify', plan: 'Plan', tasks: 'Tasks', implement: 'Implement' };
const BADGE_LABELS = { completed: 'Done', 'in-progress': 'Running', 'not-started': 'Not started' };
const STEP_WHY = {
    plan: 'Writes plan.md: the approach, research and design for this spec.',
    tasks: 'Breaks the plan into tasks.md, phased by user story.',
    implement: 'Works through tasks.md in order and checks each task off.',
};
const STATUS_TIERS = {
    specifying: 'active', planning: 'active', tasking: 'active', implementing: 'active',
    draft: 'info', specified: 'info', planned: 'info', 'ready-to-implement': 'info',
    implemented: 'success', completed: 'done', archived: 'muted',
};
const SECONDARY = [
    ['converge', 'Converge', 'Check the code against the spec and add missing tasks'],
    ['status', 'Status', 'Ask for the resolved position and the next action'],
    ['resume', 'Resume', 'Pick the run back up where it stopped'],
    ['doctor', 'Doctor', 'Check the run health: unfinished steps, drift, missing files'],
    ['ask', 'Ask Copilot', 'Ask where this spec stands (read only)'],
];
const DOCUMENT_ACTIONS = {
    'doc:spec': [['clarify', 'Clarify', 'Ask questions to clarify the spec']],
    'doc:plan': [['checklist', 'Checklist', 'Check the plan against a quality checklist']],
    'doc:tasks': [['analyze', 'Analyze', 'Check the spec, plan and tasks for consistency'], ['taskstoissues', 'Create issues', 'Create GitHub issues from the tasks']],
};

const state = {
    snapshot: null,
    selected: null,
    detail: null,
    shown: null,
    filter: 'active',
    closedFilter: 'all',
    query: '',
    tab: null,
    detailRequest: 0,
    workflow: null,
    bpWorkflow: null,
    install: { dismissed: false, open: false },
    reviewDraft: null,
    project: { root: null, document: null, groups: [], request: 0 },
    reports: { kind: 'bugs', list: null, slug: null, item: null, document: null, request: 0, drafts: new Map() },
};

const $ = (id) => document.getElementById(id);
const els = {
    list: $('spec-list'),
    listEmpty: $('list-empty'),
    detail: $('detail'),
    layout: $('layout'),
    repoLine: $('repo-line'),
    repositoryForm: $('repository-form'),
    repositoryRoot: $('repository-root'),
    repositoryBrowse: $('repository-browse'),
    repositoryWarning: $('repository-warning'),
    settingsWarning: $('settings-warning'),
    repositoryFollow: $('repository-follow'),
    coordinatedSession: $('coordinated-session'),
    coordinatedHint: $('coordinated-session-hint'),
    childrenBox: $('repository-children'),
    childrenHint: $('repository-children-hint'),
    childrenList: $('repository-children-list'),
    live: $('live'),
    liveLabel: $('live-label'),
    search: $('search'),
    sort: $('spec-sort'),
    closedFilter: $('closed-filter'),
    lifecycleBulk: $('lifecycle-bulk'),
    refresh: $('refresh'),
    toast: $('toast'),
    toastMsg: $('toast-msg'),
    toastActions: $('toast-actions'),
    toastPrompt: $('toast-prompt'),
    toastFile: $('toast-file'),
    newSpec: $('new-spec'),
    newSpecToggle: $('new-spec-toggle'),
    newSpecText: $('new-spec-text'),
    newSpecWorkflow: $('new-spec-workflow'),
    newSpecHint: $('new-spec-hint'),
    newSpecInstall: $('new-spec-install'),
    newBpWorkflow: $('new-bp-workflow'),
    newBpHint: $('new-bp-hint'),
    newBpPhases: $('new-bp-phases'),
    workflowToggle: $('workflow-toggle'),
    workflowPanel: $('workflow-panel'),
    workflowFrame: $('workflow-frame'),
    businessPlanToggle: $('business-plan-toggle'),
    businessPlanPanel: $('business-plan-panel'),
    businessPlanFrame: $('business-plan-frame'),
    projectToggle: $('project-toggle'),
    projectPanel: $('project-panel'),
    projectRefresh: $('project-refresh'),
    projectGroups: $('project-groups'),
    projectEmpty: $('project-empty'),
    projectDocument: $('project-document'),
    projectPath: $('project-path'),
    projectStatus: $('project-status'),
    projectContent: $('project-content'),
    projectDiscard: $('project-discard'),
    projectSave: $('project-save'),
    projectRefine: $('project-refine'),
    projectCreate: $('project-create'),
    projectCreateKind: $('project-create-kind'),
    projectCreateDescription: $('project-create-description'),
    projectCreateButton: $('project-create-button'),
    reportsTitle: $('reports-title'),
    reportsPanel: $('reports-panel'),
    reportsRefresh: $('reports-refresh'),
    reportsExtension: $('reports-extension'),
    reportsExtensionAction: $('reports-extension-action'),
    reportsList: $('reports-list'),
    reportDetail: $('report-detail'),
    reportExtra: $('report-extra'),
    reportSlug: $('report-slug'),
};

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

async function api(path, body) {
    const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-speckit-token': token },
        body: body ? JSON.stringify({ ...body, expectedRoot: state.snapshot?.root }) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

const settingsPanel = $('settings-panel');
const settingsToggle = $('settings-toggle');
const linkedWorkPanel = $('linked-work-panel');
const linkedWorkToggle = $('linked-work-toggle');
const routinesPanel = $('routines-panel');
const routinesToggle = $('routines-toggle');
const decisionsPanel = $('decisions-panel');
const decisionsToggle = $('decisions-toggle');
const boardTools = $('board-tools');
const toolsToggle = $('board-tools-toggle');
const specsReturn = $('specs-return');
const reportButtons = [...document.querySelectorAll('[data-report-kind]')];
const settingsPage = createSettingsPage({ api, el, root: () => state.snapshot?.root,
    saved: () => { if (!els.projectPanel.hidden) refreshProjectFiles(); } });
const ecosystem = createEcosystemView({
    api, el, root: () => state.snapshot?.root, notify: toast, sendResult: reportSend,
    openSpec: id => { showBoardPanel(null); select(id, { pushView: true }); },
    startSpec: source => draftLinkedSpec(source, [
        source.title, source.description, source.outcome && `Expected outcome: ${source.outcome}`,
    ].filter(Boolean).join('\n\n')),
    startWork: (kind, parent = '') => {
        selectEntryKind(kind);
        if (kind === 'epic' && parent) epicRelations = { parent, dependencies: [] };
        showBoardPanel(null);
        setNewEntryOpen(true);
    },
    openWork: id => {
        showBoardPanel(linkedWorkPanel);
        linkedWorkPanel.replaceChildren(ecosystem.linkedWork(null, id));
    },
    openReport: (kind, slug) => showReport(kind, slug),
});
const routines = createRoutinesPage({ api, el, root: () => state.snapshot?.root, notify: toast, sendResult: reportSend });
const decisions = createDecisionsPage({ api, el, panel: decisionsPanel, root: () => state.snapshot?.root, sendResult: reportSend });

function showBoardPanel(active) {
    for (const [panel, toggle] of [[els.workflowPanel, els.workflowToggle], [els.businessPlanPanel, els.businessPlanToggle], [els.projectPanel, els.projectToggle], [settingsPanel, settingsToggle], [linkedWorkPanel, linkedWorkToggle], [routinesPanel, routinesToggle], [decisionsPanel, decisionsToggle]]) {
        panel.hidden = panel !== active;
        toggle.setAttribute('aria-expanded', String(panel === active));
    }
    els.reportsPanel.hidden = active !== els.reportsPanel;
    for (const button of reportButtons) {
        button.setAttribute('aria-expanded', String(!els.reportsPanel.hidden && button.dataset.reportKind === state.reports.kind));
    }
    els.layout.hidden = Boolean(active);
    specsReturn.hidden = !active;
}

function closeBoardTools(restoreFocus = false) {
    if (!boardTools.open) return;
    boardTools.open = false;
    if (restoreFocus) toolsToggle.focus();
}

document.addEventListener('click', event => {
    if (!boardTools.contains(event.target)) closeBoardTools();
});
boardTools.addEventListener('focusout', event => {
    if (event.relatedTarget && !boardTools.contains(event.relatedTarget)) closeBoardTools();
});
boardTools.addEventListener('keydown', event => {
    if (event.key === 'Escape' && boardTools.open) {
        event.preventDefault();
        closeBoardTools(true);
    }
});
specsReturn.addEventListener('click', () => {
    closeBoardTools(true);
    showBoardPanel(null);
});

function bindBoardTool(toggle, panel, onOpen) {
    toggle.addEventListener('click', () => {
        const open = panel.hidden;
        closeBoardTools(true);
        showBoardPanel(open ? panel : null);
        if (open) onOpen();
    });
}
bindBoardTool(settingsToggle, settingsPanel, () => settingsPage.open());
bindBoardTool(linkedWorkToggle, linkedWorkPanel, () => linkedWorkPanel.replaceChildren(ecosystem.linkedWork()));
bindBoardTool(routinesToggle, routinesPanel, () => routines.open(routinesPanel));
decisionsToggle.addEventListener('click', () => {
    const open = decisionsPanel.hidden;
    closeBoardTools();
    showBoardPanel(open ? decisionsPanel : null);
    if (open) decisions.open(true);
});

const TOAST_MS = 4000;

function hideToast() {
    clearTimeout(toast.timer);
    els.toast.classList.remove('is-visible');
}

function armToast() {
    clearTimeout(toast.timer);
    if (!toast.pinned) toast.timer = setTimeout(hideToast, TOAST_MS);
}

/** A short line that fades; with `prompt`, the message that was sent sits behind Show prompt and Copy, with the path of its instruction file. `pinned` keeps it up. */
function showToast({ message, prompt = null, file = null, pinned = false }) {
    toast.pinned = pinned;
    els.toastMsg.replaceChildren(...[message].flat());
    els.toastPrompt.textContent = prompt ?? '';
    els.toastPrompt.hidden = !(prompt && pinned);
    els.toastFile.replaceChildren(...(prompt && file ? fileLine(file) : []));
    els.toastFile.hidden = els.toastPrompt.hidden || !file;
    els.toastActions.replaceChildren(...(prompt ? promptActions(prompt, file) : []));
    els.toast.classList.add('is-visible');
    armToast();
}

function toast(...message) {
    showToast({ message });
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

function copyButton(text, label = 'Copy') {
    const button = el('button', {
        class: 'btn btn-chip',
        type: 'button',
        onclick: async () => { button.textContent = await copyText(text) ? 'Copied' : 'Copy failed'; },
    }, label);
    return button;
}

function fileLine(file) {
    return ['Run instructions: ', el('code', {}, file), ' ', copyButton(file, 'Copy path')];
}

function promptActions(prompt, file) {
    const label = () => (els.toastPrompt.hidden ? 'Show prompt' : 'Hide prompt');
    const toggle = el('button', {
        class: 'btn btn-chip',
        type: 'button',
        'aria-controls': 'toast-prompt',
        'aria-expanded': String(!els.toastPrompt.hidden),
        onclick: () => {
            els.toastPrompt.hidden = !els.toastPrompt.hidden;
            els.toastFile.hidden = els.toastPrompt.hidden || !file;
            toggle.setAttribute('aria-expanded', String(!els.toastPrompt.hidden));
            toggle.textContent = label();
            if (!els.toastPrompt.hidden) {
                toast.pinned = true;
                armToast();
            }
        },
    }, label());
    const close = el('button', { class: 'btn btn-icon toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: hideToast }, '×');
    return [toggle, copyButton(prompt), close];
}

async function reportSend({ prompt, sent, targetSessionId = null, instructionsFile: file = null }, what = 'your question') {
    if (sent) {
        const command = prompt.split(/\s/, 1)[0];
        const destination = targetSessionId ? 'the selected session' : 'the chat';
        showToast({ message: command.startsWith('/') ? ['Sent ', el('code', {}, command), ` to ${destination}`] : `Sent ${what} to ${destination}`, prompt, file });
        return;
    }
    const copied = await copyText(prompt);
    showToast({
        message: copied ? 'No chat session here, so the prompt was copied. Paste it into the chat.' : 'No chat session here. Copy the prompt and paste it into the chat.',
        prompt,
        file,
        pinned: true,
    });
}

const INSTALL_DISMISSED = 'speckit-install-hint-dismissed';
try {
    state.install.dismissed = sessionStorage.getItem(INSTALL_DISMISSED) === '1';
} catch { /* no storage: the line stays dismissible for this page */ }

function refreshInstallHints() {
    renderSpecifyChoices();
    if (state.detail) renderDetail();
}

async function askInstall(button) {
    button.disabled = true;
    try {
        await reportSend(await api('/api/install', {}), 'the install request');
    } catch (error) {
        toast(`Could not send: ${error.message}`);
    } finally {
        button.disabled = false;
    }
}

const hintNodes = {};

/** The install line for one place on the page, the same node for as long as it says the same thing, so a redraw keeps a "Copied" in it. */
function installHint(place) {
    const command = state.snapshot?.specify?.installCommand;
    if (!command || state.install.dismissed || state.snapshot.installPrompt === false) return null;
    const key = `${command}\n${state.install.open}`;
    if (hintNodes[place]?.key !== key) hintNodes[place] = { key, node: buildInstallHint(command) };
    return hintNodes[place].node;
}

/** One quiet line, shown only where SpecKit Companion is not installed, that opens to the install command. */
function buildInstallHint(command) {
    const { open } = state.install;
    return el('div', { class: 'install-hint' },
        el('p', { class: 'install-hint__line' },
            'SpecKit Companion is not installed in this project, so the standard Spec Kit commands run. ',
            el('button', {
                class: 'btn-link',
                type: 'button',
                'aria-expanded': String(open),
                onclick: () => {
                    state.install.open = !open;
                    refreshInstallHints();
                },
            }, 'Install it'),
            el('button', {
                class: 'btn btn-icon install-hint__dismiss',
                type: 'button',
                'aria-label': 'Dismiss the install note',
                onclick: () => {
                    state.install.dismissed = true;
                    try {
                        sessionStorage.setItem(INSTALL_DISMISSED, '1');
                    } catch { /* dismissed for this page only */ }
                    refreshInstallHints();
                },
            }, '×')),
        open ? el('div', { class: 'install-hint__how' },
            el('button', { class: 'btn btn-chip', type: 'button', onclick: () => {
                setNewEntryOpen(false);
                showBoardPanel(els.workflowPanel);
                showWorkflowView('integrations');
                workflowIntegrationsView.focus();
            } }, 'Open setup'),
            el('code', {}, command),
            copyButton(command),
            el('button', { class: 'btn btn-chip', type: 'button', onclick: (e) => askInstall(e.currentTarget) }, 'Ask Copilot to install it')) : null);
}

els.toast.addEventListener('pointerenter', () => clearTimeout(toast.timer));
els.toast.addEventListener('pointerleave', armToast);
els.toast.addEventListener('focusin', () => clearTimeout(toast.timer));
els.toast.addEventListener('focusout', (event) => { if (!els.toast.contains(event.relatedTarget)) armToast(); });

function relativeTime(iso) {
    if (!iso) return '';
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return 'just now';
    const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
    for (const [unit, size] of units) {
        if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
    }
    return 'just now';
}

const DELIVERY_STATE_META = {
    queued: ['Queued', 'muted'],
    assigned: ['Assigned', 'info'],
    'in-progress': ['In progress', 'active'],
    'awaiting-gate': ['Awaiting gate', 'review'],
    'pr-open': ['PR open', 'info'],
    merged: ['Merged', 'success'],
    blocked: ['Blocked', 'active'],
    expired: ['Session expired', 'active'],
};

function deliveryFor(kind, specOrId) {
    const records = state.snapshot?.deliveryLedger ?? [];
    const candidates = typeof specOrId === 'string'
        ? [specOrId]
        : [specOrId?.id, specOrId?.name, specOrId?.path].filter(Boolean);
    return records.find(r => {
        const rKind = r.kind ?? r.item?.kind;
        if (rKind !== kind) return false;
        const rId = r.itemId ?? r.item?.id;
        const rPath = r.path ?? r.item?.path;
        return candidates.includes(rId) || (rPath && candidates.includes(rPath));
    }) ?? null;
}

function checkGlyph(checks) {
    if (checks === 'passing') return ' ✓';
    if (checks === 'failing') return ' ✗';
    if (checks === 'pending') return ' …';
    return '';
}

function renderDeliveryStrip(record) {
    if (!record) return null;
    const [label, tier] = DELIVERY_STATE_META[record.state] ?? [record.state, 'muted'];
    return el('span', { class: 'delivery-strip' },
        el('span', { class: `pill tier-${tier}` }, label),
        record.pr ? el('span', { class: 'pill tier-muted', title: `PR #${record.pr.number} (${record.pr.state}${record.pr.checks ? `, checks ${record.pr.checks}` : ''})` },
            `PR #${record.pr.number}${checkGlyph(record.pr.checks)}`) : null,
        record.issue ? el('span', { class: 'pill tier-muted', title: `Issue #${record.issue.number}` }, `#${record.issue.number}`) : null,
        record.autonomyMode === 'unattended' ? el('span', { class: 'pill tier-info', title: 'Policy-driven unattended autonomy mode' }, 'Unattended') : null);
}

function renderDeliveryPanel(spec, record) {
    if (!record) return null;
    const [label, tier] = DELIVERY_STATE_META[record.state] ?? [record.state, 'muted'];
    const extLink = (href, text) => typeof href === 'string' && /^(?:https?|ghapp):\/\//i.test(href)
        ? el('a', { class: 'btn btn-chip', href, target: '_blank', rel: 'noopener noreferrer' }, text)
        : el('span', { class: 'pill tier-muted' }, text);
    const expired = record.state === 'expired' || record.session?.status === 'expired';
    const links = [
        record.issue?.url ? extLink(record.issue.url, `Issue #${record.issue.number}`) : null,
        record.pr?.url ? extLink(record.pr.url, `PR #${record.pr.number}${checkGlyph(record.pr.checks)}`) : null,
        record.session?.url ? extLink(record.session.url, `Session: ${record.session.name}`) : record.session ? el('span', { class: 'pill tier-muted' }, `Session: ${record.session.name} (${record.session.status})`) : null,
        record.gate ? el('span', { class: 'pill tier-review', title: `Gate ${record.gate.id}` }, `Gate ${record.gate.id} · ${record.gate.status}`) : null,
    ].filter(Boolean);

    const reconcileBtn = el('button', {
        class: 'btn btn-chip',
        type: 'button',
        onclick: async event => {
            const btn = event.currentTarget;
            btn.disabled = true;
            try {
                await reportSend(await api('/api/decisions/reconcile-prompt', {
                    branch: record.branch ?? null,
                    issue: record.issue?.number ?? null,
                    runId: record.gate?.id ?? null,
                }), 'GitHub delivery reconciliation');
            } catch (error) {
                toast(error.message);
            } finally {
                btn.disabled = false;
            }
        },
    }, 'Reconcile from GitHub');

    const recoverBtn = expired ? el('button', {
        class: 'btn btn-primary',
        type: 'button',
        onclick: () => confirmDeliveryRecovery('spec', record.itemId ?? record.item?.id ?? spec.id, record),
    }, 'Recover expired session…') : null;

    return el('section', { class: 'delivery-panel', 'aria-label': 'Delivery status' },
        el('div', { class: 'delivery-panel__head' },
            el('div', { class: 'head-pills' },
                el('span', { class: `pill tier-${tier}` }, label),
                el('span', { class: 'pill tier-muted' }, record.autonomyMode === 'unattended' ? 'Autonomy: Unattended' : 'Autonomy: Gated'),
                record.branch ? el('code', { class: 'delivery-branch' }, record.branch) : null),
            el('div', { class: 'delivery-panel__actions' }, reconcileBtn, recoverBtn)),
        links.length ? el('div', { class: 'delivery-panel__links' }, links) : null);
}

function confirmDeliveryRecovery(kind, id, record) {
    const expectedRoot = state.snapshot?.root;
    const dialog = el('dialog', { class: 'confirm-dialog', 'aria-label': 'Recover expired session' });
    const cancel = el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel');
    const recover = el('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        recover.disabled = true;
        try {
            if (state.snapshot?.root !== expectedRoot) throw new Error('The repository changed. Review delivery recovery again.');
            const result = await api('/api/delivery/recover-prompt', { kind, id });
            dialog.close();
            await reportSend(result, 'expired session recovery');
        } catch (error) {
            dialog.close();
            toast(error.message);
        }
    } }, 'Send recovery handoff');
    dialog.append(
        el('h2', {}, 'Recover expired session'),
        el('p', {}, `Continue delivery for ${id}${record.branch ? ` on branch ${record.branch}` : ''}${record.pr ? ` (PR #${record.pr.number})` : ''} from its last committed state.`),
        el('p', { class: 'command-hint' }, 'Copilot checks the existing branch and PR before creating a replacement session, avoiding duplicate branches or PRs.'),
        el('div', { class: 'confirm-actions' }, cancel, recover));
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
}

function statusPill(spec) {
    const tier = spec.status ? STATUS_TIERS[spec.status] ?? 'info' : 'muted';
    return el('span', { class: `pill tier-${tier}`, title: spec.status ? `Status: ${spec.statusLabel}` : 'No .spec-context.json: position read from the files' }, spec.statusLabel);
}

function miniRail(steps) {
    return el('span', { class: 'mini-rail', role: 'img', 'aria-label': STEPS.map(s => `${STEP_LABELS[s]} ${BADGE_LABELS[steps[s]].toLowerCase()}`).join(', ') },
        STEPS.map(s => el('span', { dataset: { state: steps[s] }, title: `${STEP_LABELS[s]}: ${BADGE_LABELS[steps[s]]}` })));
}

function visibleSpecs() {
    const specs = state.snapshot?.specs ?? [];
    els.sort.value = state.snapshot.sortMode;
    const q = state.query.trim().toLowerCase();
    return specs.filter(spec => {
        if (state.filter === 'active' && spec.done) return false;
        if (state.filter === 'done' && !spec.done) return false;
        if (state.filter === 'done' && state.closedFilter === 'archived' && spec.status !== 'archived') return false;
        if (state.filter === 'done' && state.closedFilter === 'completed' && spec.status === 'archived') return false;
        if (!q) return true;
        const fields = [spec.name, spec.title, spec.source].filter(value => typeof value === 'string');
        return fields.some(value => value.toLowerCase().includes(q))
            || (normalize(q).length > 0 && (fuzzyMatch(q, spec.name, spec.title) || fuzzyMatch(q, spec.source ?? undefined)));
    });
}

function renderChildren() {
    const children = state.snapshot.children ?? [];
    const note = state.snapshot.childNote;
    els.childrenBox.hidden = children.length === 0 && !note;
    els.childrenHint.textContent = children.length > 1 && !state.snapshot.boundSession
        ? 'This chat owns several sessions. Choose the one whose specs to show.'
        : note ?? '';
    els.childrenList.replaceChildren(...children.map(child => el('li', {},
        el('button', {
            class: 'btn btn-quiet',
            type: 'button',
            title: child.cwd,
            'aria-pressed': String(state.snapshot.boundSession?.sessionId === child.sessionId),
            onclick: async () => {
                try {
                    const result = await api('/api/root/child', { sessionId: child.sessionId });
                    toast(`Showing ${result.root}`);
                } catch (error) {
                    toast(`Could not select the session: ${error.message}`);
                }
            },
        }, child.name || child.sessionId))));
}

function renderCoordinatedSessions() {
    const sessions = state.snapshot.coordinatedSessions ?? [];
    const local = sessions.filter(session => session.cwd);
    const openOnly = sessions.filter(session => !session.cwd);
    const bound = state.snapshot.boundSession;
    const selected = bound && local.find(session => session.sessionId === bound.sessionId);
    const missing = bound && !selected;
    const moved = selected && selected.cwd !== state.snapshot.root;
    els.coordinatedSession.replaceChildren(el('option', { value: '', text: 'Choose a coordinated session' }));
    if (missing) els.coordinatedSession.append(el('option', { value: bound.sessionId, text: `${bound.name} (unavailable)` }));
    for (const session of local) {
        els.coordinatedSession.append(el('option', { value: session.sessionId, text: `${session.name}${session.activity ? ` · ${session.activity}` : ''}` }));
    }
    els.coordinatedSession.value = moved ? '' : bound?.sessionId ?? '';
    els.coordinatedHint.textContent = missing
        ? 'The selected session is not in the latest list. Its last repository remains open; ask the coordinator to refresh or disconnect.'
        : moved ? 'The selected session moved. Select it again to show its current checkout.'
            : bound ? 'Commands are sent to this selected session when the host permits session management.'
            : local.length ? 'Choose a session to show its checkout and route commands to it.'
                : openOnly.length ? 'Open these sessions in Copilot; this board cannot read their checkouts.'
                    : 'Start dedicated work from a work item, or ask the coordinator to refresh the session list.';
    const links = $('coordinated-open-only');
    links.replaceChildren(...openOnly.map(session => el('li', {}, session.name, ' · ',
        el('a', { href: session.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open session: ${session.name}` }, 'Open session'))));
    links.hidden = !openOnly.length;
}

function renderBoard() {
    const specs = state.snapshot?.specs ?? [];
    const active = specs.filter(s => !s.done).length;
    const completed = specs.filter(s => s.status === 'completed').length;
    const archived = specs.filter(s => s.status === 'archived').length;
    $('count-active').textContent = active;
    $('count-done').textContent = specs.length - active;
    $('count-all').textContent = specs.length;
    els.repoLine.textContent = `Spec board · ${state.snapshot.repoName} · ${active} active of ${specs.length}`;
    els.repoLine.title = state.snapshot.root;
    if (document.activeElement !== els.repositoryRoot) els.repositoryRoot.value = state.snapshot.root;
    els.repositoryWarning.hidden = !state.snapshot.missingSpecDirectories;
    els.settingsWarning.hidden = !state.snapshot.settingsErrors?.length;
    els.repositoryFollow.hidden = !['selected', 'bound'].includes(state.snapshot.rootSource);
    els.repositoryFollow.textContent = state.snapshot.boundSession ? `Disconnect from ${state.snapshot.boundSession.name}` : 'Follow session';
    els.repositoryFollow.title = state.snapshot.boundSession ? 'Stop showing the bound session and go back to this chat\'s own directory' : 'Drop the chosen directory and follow this session';
    els.repoLine.textContent += state.snapshot.boundSession ? ` · from ${state.snapshot.boundSession.name}` : '';
    els.repositoryWarning.textContent = `No spec directory found in ${state.snapshot.root}. Choose the repository containing your specs.`;
    els.settingsWarning.textContent = state.snapshot.settingsErrors?.length
        ? `Repository settings contain errors; commands are disabled until they are fixed. Use Settings for invalid values or Project files → Workspace settings to repair JSON syntax. ${state.snapshot.settingsErrors.join(' ')}`
        : '';
    renderChildren();
    renderCoordinatedSessions();
    renderLifecycleBulk({ active, completed, archived });

    const shown = visibleSpecs();
    els.listEmpty.hidden = shown.length > 0;
    els.listEmpty.textContent = specs.length === 0
        ? state.snapshot.missingSpecDirectories
            ? 'No spec directory found. Check the repository directory above.'
            : 'No specs here yet. Use New spec to start one.'
        : 'No specs match.';
    els.list.replaceChildren(...shown.map(spec => el('li', {},
        el('button', {
            class: 'spec-card',
            type: 'button',
            'aria-current': spec.id === state.selected ? 'true' : 'false',
            dataset: { id: spec.id },
            onclick: () => select(spec.id, { pushView: true }),
        },
        el('span', { class: 'card-top' },
            spec.number ? el('span', { class: 'card-num' }, spec.number) : null,
            el('span', { class: 'sb-title', title: spec.title }, spec.title)),
        el('span', { class: 'card-meta' },
            statusPill(spec),
            miniRail(spec.steps),
            spec.tasks && spec.tasks.total > 0 ? el('span', { class: 'card-tasks', title: 'Tasks done' }, `${spec.tasks.checked}/${spec.tasks.total}`) : null,
            el('span', { class: 'card-time', title: cardTime(spec) ?? '' }, relativeTime(cardTime(spec)))),
        renderDeliveryStrip(deliveryFor('spec', spec))))));
}

function renderLifecycleBulk({ active, completed, archived }) {
    const controls = [];
    if (state.filter === 'active') {
            if (active) controls.push(
                lifecycleButton('complete-active', `Mark ${active} active ${active === 1 ? 'spec' : 'specs'} complete`),
                lifecycleButton('archive-active', `Archive ${active} active ${active === 1 ? 'spec' : 'specs'}`),
            );
    } else if (state.filter === 'done') {
            const scope = state.closedFilter;
            const reactivateAction = scope === 'completed'
                ? 'reactivate-completed'
                : scope === 'archived' ? 'reactivate-archived' : 'reactivate-closed';
            const reactivateCount = scope === 'completed' ? completed : scope === 'archived' ? archived : completed + archived;
            if (reactivateCount) controls.push(lifecycleButton(reactivateAction, `Reactivate ${reactivateCount} ${reactivateCount === 1 ? 'closed spec' : 'closed specs'}`));
            if (scope !== 'archived' && completed) controls.push(lifecycleButton('archive-completed', `Archive ${completed} completed ${completed === 1 ? 'spec' : 'specs'}`));
    }
    els.lifecycleBulk.hidden = controls.length === 0;
    els.lifecycleBulk.replaceChildren(...controls);
}

function lifecycleButton(action, label) {
    return el('button', {
            class: 'btn btn-chip',
            type: 'button',
            onclick: () => confirmLifecycle(action),
    }, label);
}

// A checkout resets file times, so they stand in for activity only on a spec with no run record.
const cardTime = spec => spec.lastActivity ?? (spec.hasContext ? null : spec.updatedAt);

/** The commands this spec's buttons send: its own workflow's family, else the workspace's. */
function specCommands() {
    return {
        commandSet: state.detail?.commandSet ?? state.snapshot.commandSet,
        commands: state.detail?.commands ?? state.snapshot.commands,
    };
}

function nextAction(spec) {
    const { commands } = specCommands();
    const custom = state.detail?.customSteps;
    if (spec.workflowError) return { title: 'Workflow unavailable', why: spec.workflowError, command: null };
    if (custom) {
        const step = ['plan', 'tasks', 'implement'].find(s => custom[s] && spec.steps[s] !== 'completed');
        return step && !spec.done
            ? { title: `Next: ${STEP_LABELS[step]}`, why: custom[step], command: step, label: `Run ${step}` }
            : { title: 'Custom workflow', why: 'Use the configured commands or update the spec status.', command: null };
    }
    const running = STEPS.find(s => spec.steps[s] === 'in-progress');
    if (running && running !== 'specify') {
        return { title: `${STEP_LABELS[running]} is running`, why: 'Watch the pipeline move here, or pick the run back up if it stopped.', command: commands.includes('resume') ? 'resume' : running, label: commands.includes('resume') ? 'Resume' : `Run ${running}` };
    }
    const pending = ['plan', 'tasks', 'implement'].find(s => spec.steps[s] !== 'completed');
    if (pending) {
        return { title: `Next: ${STEP_LABELS[pending]}`, why: STEP_WHY[pending], command: pending, label: `Run ${pending}` };
    }
    if (!spec.done && commands.includes('mark-complete')) {
        return { title: 'Every step is done', why: 'Mark the spec complete to close the run.', command: 'mark-complete', label: 'Mark complete' };
    }
    return { title: 'This spec is finished', why: 'Every step ran. Ask the doctor if anything looks off.', command: commands.includes('doctor') ? 'doctor' : null, label: 'Run doctor' };
}

async function run(command, button, options = {}) {
    const spec = state.detail?.spec;
    if (!spec) return;
    button.disabled = true;
    try {
        const result = await api('/api/run', { spec: spec.id, command, ...options });
        if (result.sent) {
            button.classList.add('sent');
            setTimeout(() => button.classList.remove('sent'), 2400);
        }
        await reportSend(result);
    } catch (error) {
        toast(`Could not send: ${error.message}`);
    } finally {
        button.disabled = false;
    }
}

async function confirmIssues(specId) {
    const root = state.snapshot.root;
    let preview;
    try {
        preview = await api(`/api/delivery?id=${encodeURIComponent(specId)}`);
    } catch (error) {
        toast(error.message);
        return;
    }
    if (preview.root !== root || state.snapshot.root !== root || state.detail?.spec.id !== specId) {
        toast('The selected spec changed. Open its tasks and try again.');
        return;
    }
    const dialog = el('dialog', { class: 'confirm-dialog', 'aria-labelledby': 'confirm-issues-title' });
    const cancel = el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel');
    const create = el('button', { class: 'btn btn-primary', type: 'button', disabled: Boolean(preview.blocked), onclick: () => {
        dialog.close();
        if (state.snapshot.root !== root || state.detail?.spec.id !== specId) {
            toast('The selected spec changed. Open its tasks and try again.');
            return;
        }
        run('taskstoissues', create, { deliveryVersion: preview.version, deliveryOwner: preview.owner, deliveryTarget: preview.target });
    } }, 'Create issues');
    dialog.append(el('h2', { id: 'confirm-issues-title' }, 'Preview GitHub delivery'),
        ...(preview.target ? [el('p', { class: 'delivery-target' }, 'GitHub repository: ', el('strong', {}, preview.target))] : []),
        el('p', {}, `Tasks: ${preview.path}${preview.tasks ? ` · ${preview.tasks.total} listed` : ''}`),
        el('p', {}, `Delivery owner: ${preview.owner}`),
        el('p', {}, preview.blocked ?? 'This asks Copilot to create issues in the GitHub repository above. The preview itself creates nothing.'),
        el('div', { class: 'confirm-actions' }, cancel, create));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
}

async function confirmDedicatedWork(kind, id) {
    try {
        const preview = await api(`/api/dedicated-work?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
        if (state.snapshot?.root !== preview.root) throw new Error('The repository changed. Review the dedicated work request again.');
        const { handoff, autonomyPolicy } = preview;
        const policy = autonomyPolicy?.policy ?? autonomyPolicy;
        const unattendedAllowed = Boolean(policy?.allowUnattended);
        const defaultMode = policy?.defaultMode === 'unattended' && unattendedAllowed ? 'unattended' : 'gated';
        const modeSelect = el('select', { class: 'search', 'aria-label': 'Autonomy mode' },
            el('option', { value: 'gated' }, 'Gated (pause at human gates)'),
            el('option', { value: 'unattended', disabled: !unattendedAllowed },
                unattendedAllowed ? 'Unattended (policy-driven autopilot)' : 'Unattended (disabled by repository autonomy policy)'));
        modeSelect.value = defaultMode;
        const gatesSummary = Array.isArray(policy?.requiredGates) && policy.requiredGates.length
            ? ` · required gates: ${policy.requiredGates.join(', ')}` : '';
        const policyNote = unattendedAllowed
            ? `Policy (${autonomyPolicy?.source ?? 'default'}): auto-merge ${policy.allowAutoMerge ? 'permitted' : 'forbidden'} · max concurrent sessions ${policy.maxConcurrentSessions}${gatesSummary}.`
            : autonomyPolicy?.note ?? 'Repository autonomy policy restricts dedicated work to Gated mode.';
        const dialog = el('dialog', { class: 'confirm-dialog', 'aria-label': 'Start dedicated work' });
        const cancel = el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel');
        const start = el('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
            start.disabled = true;
            try {
                if (state.snapshot?.root !== preview.root) throw new Error('The repository changed. Review the dedicated work request again.');
                const mode = modeSelect.value;
                await api('/api/dedicated-work', { kind, id, version: preview.version, ...(mode !== 'gated' ? { autonomyMode: mode } : {}) });
                dialog.close();
            } catch (error) {
                dialog.close();
                toast(error.message);
            }
        } }, 'Start dedicated work');
        dialog.append(el('h2', {}, 'Start dedicated work'),
            el('p', {}, handoff.repository, ' · ', handoff.baseBranch, ' · ', el('code', { title: handoff.baseRevision }, handoff.baseRevision.slice(0, 12))),
            el('p', {}, 'Published record: ', el('code', {}, handoff.item.path)),
            el('label', { class: 'autonomy-field' }, el('span', {}, 'Autonomy mode'), modeSelect),
            el('p', { class: 'command-hint' }, policyNote),
            el('p', {}, 'Copilot verifies and creates or reuses an isolated session for this item. Your board stays on this checkout. This does not publish changes or open a pull request.'),
            el('div', { class: 'confirm-actions' }, cancel, start));
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        document.body.append(dialog);
        dialog.showModal();
    } catch (error) {
        toast(error.message);
    }
}

function updateDedicatedWorkControl(control) {
    const row = state.snapshot?.dedicatedWork?.find(entry => entry.kind === control.dataset.kind && entry.id === control.dataset.id);
    const listed = row?.session && state.snapshot.coordinatedSessions.find(session => session.sessionId === row.session.sessionId);
    control.querySelector('button').disabled = ['requested', 'verifying', 'delivering-unknown'].includes(row?.status);
    control.querySelector('[role=status]').textContent = ({
        requested: 'Requested. Waiting for the coordinator.',
        verifying: 'The coordinator is verifying the session.',
        'delivering-unknown': 'Delivery could not be confirmed. Check the coordinator chat before retrying.',
        blocked: row?.detail,
        confirmed: !listed ? 'The assigned session is not in the latest list.' : listed.cwd
            ? `${listed.name} is listed under Coordinated session.`
            : `${listed.name} is listed under Coordinated session as an Open session link.`,
    })[row?.status] ?? '';
}

function dedicatedWorkControl(kind, id) {
    const control = el('div', { class: 'report-actions', dataset: { dedicatedWork: '', kind, id } },
        el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => confirmDedicatedWork(kind, id) }, 'Start dedicated work'),
        el('span', { role: 'status' }));
    updateDedicatedWorkControl(control);
    return control;
}

function confirmCheckpoint(specId, checkpoint) {
    const root = state.snapshot.root;
    const title = checkpoint.id === 'commit' ? 'Ask Copilot to create a commit?' : 'Ask Copilot to create a pull request?';
    const explanation = checkpoint.id === 'commit'
        ? 'The request will ask Copilot to inspect the worktree and commit only changes for this spec. Unrelated or ambiguous changes must be left untouched.'
        : 'The request will ask Copilot to create a pull request from this repository. It will follow the repository template and stop if the target is unclear.';
    const dialog = el('dialog', { class: 'confirm-dialog', 'aria-labelledby': 'checkpoint-title' });
    const cancel = el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel');
    const confirm = el('button', { class: 'btn btn-primary', type: 'button', onclick: async event => {
        const button = event.currentTarget;
        if (state.snapshot.root !== root || state.detail?.spec.id !== specId) {
            dialog.close();
            toast('The repository or selected spec changed. Reopen it and try again.');
            return;
        }
        button.disabled = true;
        try {
            const result = await api('/api/checkpoint', { spec: specId, id: checkpoint.id, approved: true });
            dialog.close();
            await reportSend(result, 'the checkpoint request');
        } catch (error) {
            toast(`Could not send checkpoint: ${error.message}`);
            button.disabled = false;
        }
    } }, 'Send request');
    dialog.append(el('h2', { id: 'checkpoint-title' }, title),
        el('p', {}, explanation),
        el('p', { class: 'command-hint' }, 'The canvas sends the request to the selected chat or session; it does not run git or gh itself.'),
        el('div', { class: 'confirm-actions' }, cancel, confirm));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
}

function confirmCommitComplete(specId) {
    const root = state.snapshot.root;
    const dialog = el('dialog', { class: 'confirm-dialog', 'aria-labelledby': 'commit-complete-title' });
    const cancel = el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel');
    const confirm = el('button', { class: 'btn btn-primary', type: 'button', onclick: async event => {
        const button = event.currentTarget;
        if (state.snapshot.root !== root || state.detail?.spec.id !== specId) {
            dialog.close();
            toast('The repository or selected spec changed. Reopen it and try again.');
            return;
        }
        button.disabled = true;
        try {
            await api('/api/checkpoint/commit-complete', { spec: specId, confirmed: true });
            dialog.close();
            await loadDetail();
        } catch (error) {
            toast(`Could not record the checkpoint: ${error.message}`);
            button.disabled = false;
        }
    } }, 'Record completed commit');
    dialog.append(el('h2', { id: 'commit-complete-title' }, 'Record the commit checkpoint?'),
        el('p', {}, 'Only continue if the commit has already been created. This records your confirmation in .spec-context.json so after-commit workflow actions can run.'),
        el('div', { class: 'confirm-actions' }, cancel, confirm));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
}

function confirmLifecycle(action, specId = null) {
    const root = state.snapshot.root;
    const spec = specId ? state.detail?.spec : null;
    const force = action === 'force';
    const bulkLabels = {
        'complete-active': 'Mark all active specs completed?',
        'archive-active': 'Archive all active specs?',
        'archive-completed': 'Archive completed specs?',
        'reactivate-completed': 'Reactivate completed specs?',
        'reactivate-archived': 'Reactivate archived specs?',
        'reactivate-closed': 'Reactivate all closed specs?',
    };
    const title = force ? 'Force lifecycle status?' : spec
        ? ({ archive: 'Archive this spec?', complete: 'Mark this spec completed?', reactivate: 'Reactivate this spec?' }[action])
        : bulkLabels[action];
    const dialog = el('dialog', { class: 'confirm-dialog', 'aria-labelledby': 'lifecycle-title' });
    const cancel = el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel');
    let statusSelect;
    if (force) {
        statusSelect = el('select', { class: 'search', 'aria-label': 'Lifecycle status' },
            ...state.snapshot.lifecycleStatuses.map(status => el('option', { value: status }, status)));
        if (spec && state.snapshot.lifecycleStatuses.includes(spec.status)) statusSelect.value = spec.status;
    }
    const confirm = el('button', {
        class: 'btn btn-primary',
        type: 'button',
        onclick: async e => {
            const button = e.currentTarget;
            if (state.snapshot.root !== root || (specId && state.detail?.spec.id !== specId)) {
                dialog.close();
                toast('The repository or selected spec changed. Refresh and try again.');
                return;
            }
            button.disabled = true;
            try {
                const result = await api('/api/lifecycle', {
                    action,
                    ...(specId ? { spec: specId } : {}),
                    ...(force ? { status: statusSelect.value } : {}),
                });
                dialog.close();
                if (result.failures.length) {
                    toast(`Changed ${result.changed.length}; skipped ${result.skipped.length}; ${result.failures.length} failed. ${result.failures[0].error}`);
                } else if (result.changed.length) {
                    toast(specId
                        ? `${force ? 'Status set to ' + statusSelect.value : action === 'complete' ? 'Completed' : action === 'archive' ? 'Archived' : 'Reactivated'} ${specId}.`
                        : `Updated ${result.changed.length} ${result.changed.length === 1 ? 'spec' : 'specs'}${result.skipped.length ? `; skipped ${result.skipped.length}` : ''}.`);
                } else {
                    toast(specId ? 'No status change was needed.' : 'No specs needed a status change.');
                }
                await loadDetail();
            } catch (error) {
                toast(`Could not update lifecycle status: ${error.message}`);
                button.disabled = false;
            }
        },
    }, force ? 'Force status' : 'Confirm');
    const copy = force
        ? 'This recovery action realigns the current step and adds a history entry.'
        : spec
            ? `${spec.id} will be updated in .spec-context.json.`
            : 'This applies to every eligible spec in the selected group.';
    dialog.append(el('h2', { id: 'lifecycle-title' }, title),
        el('p', {}, copy),
        ...(statusSelect ? [statusSelect] : []),
        el('div', { class: 'confirm-actions' }, cancel, confirm));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
}

function renderRail(steps) {
    return el('ol', { class: 'rail', 'aria-label': 'Pipeline' }, STEPS.map((step, i) => el('li', { dataset: { state: steps[step] } },
        el('span', { class: 'rail-node', 'aria-hidden': 'true' }, steps[step] === 'completed' ? '✓' : String(i + 1)),
        el('span', { class: 'sb-rail-label' }, STEP_LABELS[step]),
        el('span', { class: 'rail-state' }, BADGE_LABELS[steps[step]]),
        el('span', { class: 'sr-only' }, `: ${BADGE_LABELS[steps[step]]}`))));
}

function renderNext(spec) {
    const next = nextAction(spec);
    const { commandSet, commands } = specCommands();
    const canConverge = ['implemented', 'completed'].includes(spec.status) || (!spec.status && spec.steps.implement === 'completed');
    const primary = next.command
        ? el('button', { class: 'btn btn-primary', type: 'button', onclick: (e) => run(next.command, e.currentTarget) }, next.label)
        : null;
    const documentActions = DOCUMENT_ACTIONS[state.tab] ?? [];
    const more = (spec.workflowError ? [] : [...documentActions, ...SECONDARY])
        .filter(([command]) => command === 'ask' || commands.includes(command))
        .filter(([command]) => command !== 'converge' || canConverge)
        .filter(([command]) => command !== next.command && !(command === 'resume' && spec.done))
        .map(([command, label, title]) => el('button', { class: 'btn btn-chip', type: 'button', title, onclick: (e) => command === 'taskstoissues' ? confirmIssues(spec.id) : run(command, e.currentTarget) }, label));
    const doc = state.tab?.startsWith('doc:') ? state.tab.slice(4) : null;
    if (!spec.done && !spec.workflowError) {
        for (const action of state.detail.customActions ?? []) {
            if (!['all', doc === 'spec' ? 'specify' : doc, doc].includes(action.step)) continue;
            more.push(action.autoExecute ? el('button', { class: 'btn btn-chip', type: 'button', title: action.tooltip, onclick: async event => {
                const button = event.currentTarget;
                button.disabled = true;
                try { await reportSend(await api('/api/custom-command', { spec: spec.id, id: action.id, command: action.command })); }
                catch (error) { toast(`Could not send: ${error.message}`); }
                finally { button.disabled = false; }
            } }, action.title) : copyButton(action.prompt, `Copy ${action.title}`));
        }
        const phaseStatus = {
            sent: 'Sent; waiting for chat',
            running: 'Running',
            completed: 'Output updated',
            unverified: 'Turn ended; verify result',
            unobserved: 'Sent; completion not observed',
            aborted: 'Interrupted',
        };
        for (const phase of state.detail.customPhases ?? []) {
            const status = Object.hasOwn(phaseStatus, phase.run?.status) ? phaseStatus[phase.run.status] : null;
            more.push(el('button', {
                class: 'btn btn-chip',
                type: 'button',
                disabled: phase.run?.pending || undefined,
                title: phase.file ? `Configured output: ${phase.file}` : 'Action-only workflow phase',
                onclick: async event => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try { await reportSend(await api('/api/custom-step', { spec: spec.id, step: phase.name })); }
                    catch (error) { toast(`Could not send workflow phase: ${error.message}`); }
                    finally { button.disabled = false; }
                },
            }, `Run ${phase.title}${status ? ` · ${status}` : ''}`));
        }
        const checkpointStatus = state.detail.checkpointStatus ?? {};
        for (const checkpoint of state.detail.checkpoints ?? []) {
            const ready = checkpoint.trigger === 'after-implement'
                ? spec.steps.implement === 'completed'
                : checkpoint.trigger === 'after-commit' && checkpointStatus.commit === 'completed';
            if (ready && checkpointStatus[checkpoint.id] !== 'completed') {
                more.push(el('button', {
                    class: 'btn btn-chip',
                    type: 'button',
                    title: `Approval required · ${checkpoint.trigger}`,
                    onclick: () => confirmCheckpoint(spec.id, checkpoint),
                }, checkpoint.id === 'commit' ? 'Create commit…' : 'Create pull request…'));
            }
        }
        if (spec.steps.implement === 'completed' && checkpointStatus.commit !== 'completed'
            && (state.detail.checkpoints ?? []).some(checkpoint => checkpoint.trigger === 'after-commit')) {
            more.push(el('button', {
                class: 'btn btn-chip',
                type: 'button',
                onclick: () => confirmCommitComplete(spec.id),
            }, 'Record commit complete…'));
        }
    }
    if (doc) more.unshift(el('button', {
        class: 'btn btn-chip', type: 'button',
        onclick: () => openSpecEditor(spec.id, doc),
    }, 'Edit document'));
    const pending = state.detail.reviewComments.filter(c => c.doc === doc && c.status === 'pending').length;
    if (pending && !spec.done) more.unshift(el('button', {
        class: 'btn btn-chip', type: 'button',
        onclick: async e => {
            const button = e.currentTarget;
            button.disabled = true;
            try {
                const result = await api('/api/refine', { spec: spec.id, doc });
                await reportSend(result, 'the refinement');
                if (result.warning) showToast({ message: result.warning, prompt: result.prompt, pinned: true });
                await loadDetail();
            } catch (error) {
                toast(`Could not refine: ${error.message}`);
            } finally {
                button.disabled = false;
            }
        },
    }, `Refine ${pending} ${pending === 1 ? 'note' : 'notes'}`));
    if (!spec.done) {
        more.push(el('button', {
            class: 'btn btn-chip', type: 'button',
            onclick: () => confirmLifecycle('complete', spec.id),
        }, 'Mark complete'));
        more.push(el('button', {
            class: 'btn btn-chip', type: 'button',
            onclick: () => confirmLifecycle('archive', spec.id),
        }, 'Archive'));
    } else {
        more.push(el('button', {
            class: 'btn btn-chip', type: 'button',
            onclick: () => confirmLifecycle('reactivate', spec.id),
        }, 'Reactivate'));
        if (spec.status === 'completed') more.push(el('button', {
            class: 'btn btn-chip', type: 'button',
            onclick: () => confirmLifecycle('archive', spec.id),
        }, 'Archive'));
    }
    more.push(el('button', {
        class: 'btn btn-chip', type: 'button',
        onclick: () => confirmLifecycle('force', spec.id),
    }, 'Set status…'));
    const pattern = state.detail?.commandHint ?? (commandSet === 'companion' ? '/speckit.companion.<step>' : '/speckit.<step>');
    const hint = installHint('card');
    const stockNote = commandSet === 'companion' || hint
        ? null
        : state.snapshot.commandSet === 'companion' ? ' This spec uses the Spec Kit workflow, so it runs the standard commands.' : ' Stock Spec Kit commands: SpecKit Companion is not installed in this workspace.';
    return el('section', { class: 'next', 'aria-label': 'Next step' },
        el('div', { class: 'next-main' },
            el('div', { class: 'next-copy' }, el('p', { class: 'next-title' }, next.title), el('p', { class: 'next-why' }, next.why)),
            primary),
        spec.workflowError ? el('p', { class: 'workflow-error', role: 'alert' }, spec.workflowError) : null,
        state.detail.customPhaseError ? el('p', { class: 'workflow-error', role: 'alert' }, state.detail.customPhaseError) : null,
        el('div', { class: 'next-more' }, more),
        state.detail.customSteps ? el('p', { class: 'command-hint' }, state.snapshot.boundSession ? 'Custom workflow commands are sent to the selected session.' : 'Custom workflow commands are sent to Copilot chat.') : el('p', { class: 'command-hint' }, 'Buttons send ', el('code', {}, `${pattern} ${spec.id}`), ' to the chat.',
            commandSet === 'companion' ? ' Clarify, Checklist, Analyze, Converge and Create issues use Spec Kit commands.' : null,
            stockNote ? el('span', { class: 'command-hint__stock' }, stockNote) : null),
        hint);
}

async function openSpecEditor(spec, doc) {
    try {
        const opened = await api('/api/spec-file/open', { spec, doc });
        const dialog = el('dialog', { class: 'spec-editor', 'aria-labelledby': 'spec-editor-title' });
        const textarea = el('textarea', { 'aria-label': `Contents of ${opened.path}`, spellcheck: 'false' });
        textarea.value = opened.content;
        const status = el('p', { role: 'status', 'aria-live': 'polite' }, 'Save writes this document to the repository.');
        const dirty = () => textarea.value !== opened.content;
        const close = el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => {
            if (dirty()) status.textContent = 'Save your changes or use Discard edits before closing.';
            else dialog.close();
        } }, 'Close');
        const discard = el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => dialog.close() }, 'Discard edits');
        const save = el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
            save.disabled = true;
            const content = textarea.value;
            try {
                await api('/api/spec-file/save', { token: opened.token, content });
                opened.content = content;
                status.textContent = 'Saved.';
                await loadDetail();
            } catch (error) {
                status.textContent = error.message;
            } finally {
                save.disabled = !dirty();
            }
        } }, 'Save');
        save.disabled = true;
        textarea.addEventListener('input', () => { save.disabled = !dirty(); });
        dialog.addEventListener('cancel', event => {
            if (dirty()) {
                event.preventDefault();
                status.textContent = 'Save your changes or use Discard edits before closing.';
            }
        });
        dialog.addEventListener('close', () => dialog.remove());
        dialog.append(el('h2', { id: 'spec-editor-title' }, opened.path), status, textarea, el('div', { class: 'project-actions' }, close, discard, save));
        document.body.append(dialog);
        dialog.showModal();
        textarea.focus();
    } catch (error) {
        toast(error.message);
    }
}

function tabsFor(detail) {
    const tabs = detail.overviewHtml ? [{ id: 'overview', label: 'Overview' }] : [];
    tabs.push(...detail.documents.map(doc => ({
        id: `doc:${doc.type}`,
        label: doc.label,
        count: doc.type === 'tasks' && detail.spec.tasks ? `${detail.spec.tasks.checked}/${detail.spec.tasks.total}` : null,
    })));
    for (const step of ['plan', 'tasks']) {
        if (!detail.documents.some(d => d.type === step)) tabs.push({ id: `missing:${step}`, label: STEP_LABELS[step], missing: true });
    }
    if (detail.showActivity !== false || !tabs.length) tabs.push({ id: 'activity', label: 'Activity', count: detail.history.length ? String(detail.history.length) : null });
    tabs.push({ id: 'linked-work', label: 'Linked work' }, { id: 'evidence', label: 'Evidence' }, { id: 'review', label: 'Review' });
    return tabs;
}

const STATES_LAYOUT = /^(left|top|width|height|max-width|aspect-ratio|--w)$/;

function viewerScope(...children) {
    const scope = el('div', { class: 'viewer-scope' }, el('main', { class: 'content-area' }, children));
    for (const name of scope.querySelectorAll('.file-ref')) name.disabled = true;
    // The page's policy drops style attributes in markup, so the states diagram's own layout is set again as properties, and nothing else is.
    for (const node of scope.querySelectorAll('.states-stage[style], .states-stage > .states-state[style]')) {
        for (const rule of node.getAttribute('style').split(';')) {
            const [name, value] = rule.split(':').map(part => part.trim());
            if (STATES_LAYOUT.test(name) && /^[\d.\s/%px]+$/.test(value ?? '')) node.style.setProperty(name, value);
        }
    }
    return scope;
}

const pickedStates = () => [...els.detail.querySelectorAll('.states-card')].map(card => card.querySelector('.states-state.is-selected')?.dataset.state);

/** A redraw starts every states card over, so the state picked in each is picked again. */
function restoreStates(picked) {
    els.detail.querySelectorAll('.states-card').forEach((card, i) => {
        const button = picked[i] === undefined ? null : card.querySelector(`.states-state[data-state="${CSS.escape(picked[i])}"]`);
        if (button && !button.classList.contains('is-selected')) selectState(button);
    });
}

function renderPanel(detail, tabId) {
    if (tabId === 'activity') return renderActivity(detail);
    if (tabId === 'linked-work') return ecosystem.linkedWork(detail);
    if (tabId === 'evidence') return ecosystem.evidence(detail);
    if (tabId === 'review') return ecosystem.review(detail);
    if (tabId === 'overview') {
        const dossier = el('div');
        dossier.innerHTML = detail.overviewHtml;
        return viewerScope(dossier.firstElementChild ?? dossier);
    }
    if (tabId.startsWith('missing:')) {
        const step = tabId.slice(8);
        return el('div', { class: 'doc-missing' }, `No ${step}.md yet. `, step === 'plan' ? 'Run plan to write it.' : 'Run tasks to write it.');
    }
    const doc = detail.documents.find(d => `doc:${d.type}` === tabId);
    const body = el('div', { id: 'markdown-content', dataset: { doc: doc?.type ?? '' } });
    body.innerHTML = doc?.html ?? '';
    if (doc) mountReviews(body, detail, doc);
    return viewerScope(body);
}

function reviewForm(detail, doc, draft) {
    const input = el('textarea', {
        rows: '3', required: true, 'aria-label': 'Review note',
        oninput: e => { draft.text = e.currentTarget.value; },
    });
    input.value = draft.text;
    return el('form', {
        class: 'review-form',
        onsubmit: async e => {
            e.preventDefault();
            const form = e.currentTarget;
            const submit = form.querySelector('button[type="submit"]');
            submit.disabled = true;
            try {
                await api('/api/review', {
                    spec: detail.spec.id, doc: doc.type,
                    action: draft.id ? 'edit' : 'add',
                    id: draft.id, line: draft.line, version: draft.version, comment: input.value,
                });
                if (state.reviewDraft === draft) {
                    state.reviewDraft = null;
                    renderDetail();
                }
                await loadDetail();
                toast('Review note saved.');
            } catch (error) {
                toast(`Could not save review note: ${error.message}`);
            } finally {
                submit.disabled = false;
            }
        },
    }, input, el('div', { class: 'review-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save note'),
        el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { state.reviewDraft = null; renderDetail(); } }, 'Cancel')));
}

function reviewCard(detail, doc, comment) {
    const draft = state.reviewDraft;
    if (!detail.spec.done && draft?.id === comment.id && draft.spec === detail.spec.id && draft.doc === doc.type) return reviewForm(detail, doc, draft);
    return el('div', { class: 'review-card' },
        el('p', { class: 'review-card__meta' }, comment.status === 'applied' ? 'Applied' : 'Pending', ` · line ${comment.anchor.line}`),
        el('p', { class: 'review-card__text' }, comment.comment),
        !detail.spec.done && el('div', { class: 'review-actions' },
            el('button', { class: 'btn btn-chip', type: 'button', onclick: () => {
                state.reviewDraft = { spec: detail.spec.id, doc: doc.type, id: comment.id, text: comment.comment };
                renderDetail();
                els.detail.querySelector('.review-form textarea')?.focus();
            } }, 'Edit'),
            el('button', { class: 'btn btn-chip', type: 'button', onclick: async e => {
                const button = e.currentTarget;
                button.disabled = true;
                try {
                    await api('/api/review', { spec: detail.spec.id, action: 'remove', id: comment.id });
                    await loadDetail();
                } catch (error) {
                    toast(`Could not remove review note: ${error.message}`);
                    button.disabled = false;
                }
            } }, 'Remove')));
}

function mountReviews(body, detail, doc) {
    const lines = [...body.querySelectorAll('.line[data-line]')];
    const rendered = lines.map((node, index) => ({
        index, line: Number(node.dataset.line),
        endLine: node.hasAttribute('data-line-end') ? Number(node.dataset.lineEnd) : undefined,
        content: node.querySelector('.line-content')?.textContent?.trim() ?? '',
    }));
    const unplaced = [];
    for (const comment of detail.reviewComments.filter(c => c.doc === doc.type)) {
        const anchor = resolveAnchorLine(comment, rendered);
        const node = anchor && lines[anchor.index];
        const slot = node?.querySelector('.line-comment-slot');
        if (slot) slot.append(reviewCard(detail, doc, comment));
        else unplaced.push(comment);
    }
    if (unplaced.length) body.append(el('section', { class: 'review-unplaced', 'aria-label': 'Other review notes' },
        el('h3', {}, 'Notes that could not be placed'), unplaced.map(comment => reviewCard(detail, doc, comment))));
    for (const node of lines) {
        const button = node.querySelector('.line-add-btn');
        if (!button) continue;
        if (!detail.spec.hasContext || detail.spec.done) {
            button.hidden = true;
            continue;
        }
        button.addEventListener('click', () => {
            state.reviewDraft = { spec: detail.spec.id, doc: doc.type, line: Number(button.dataset.line), version: doc.version, text: '' };
            renderDetail();
            els.detail.querySelector('.review-form textarea')?.focus();
        });
        const draft = state.reviewDraft;
        if (draft && !draft.id && draft.spec === detail.spec.id && draft.doc === doc.type && draft.line === Number(button.dataset.line)) {
            node.querySelector('.line-comment-slot')?.append(reviewForm(detail, doc, draft));
        }
    }
}

function historyLine(entry) {
    const step = STEP_LABELS[entry.step] ?? entry.step;
    if (entry.task) return [el('strong', {}, entry.task), entry.kind === 'complete' ? ' done' : ' started'];
    if (entry.substep) return [el('strong', {}, step), ` · ${entry.substep}`];
    return [el('strong', {}, step), entry.kind === 'complete' ? ' finished' : ' started'];
}

function renderActivity(detail) {
    if (!detail.history.length) {
        return el('div', { class: 'doc-missing' }, detail.spec.hasContext ? 'No history recorded yet.' : 'No run record. This spec was written without SpecKit Companion capture.');
    }
    const entries = [...detail.history].reverse().slice(0, 80);
    return el('ol', { class: 'timeline', 'aria-label': 'Run history, newest first' }, entries.map(entry => el('li', { dataset: { kind: entry.kind ?? '' } },
        el('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'tl-text' }, historyLine(entry), entry.by ? el('span', { class: 'tl-by' }, ` · by ${entry.by}`) : null),
        el('time', { class: 'tl-time', datetime: entry.at, title: new Date(entry.at).toLocaleString() }, relativeTime(entry.at)))));
}

function renderDetail() {
    const detail = state.detail;
    if (!detail) {
        els.detail.replaceChildren(el('div', { class: 'detail-empty' },
            el('p', {}, 'Pick a spec to see its pipeline, documents and history.')));
        return;
    }
    const { spec } = detail;
    document.body.dataset.hasSpecContext = spec.hasContext ? 'true' : 'false';
    const tabs = tabsFor(detail);
    if (!tabs.some(t => t.id === state.tab)) {
        const preferred = spec.steps.implement === 'in-progress' ? 'doc:tasks' : detail.overviewHtml ? 'overview' : 'doc:spec';
        state.tab = tabs.some(t => t.id === preferred) ? preferred : tabs[0].id;
    }
    const scrollTop = els.detail.scrollTop;
    const shown = `${spec.id} ${state.tab}`;
    const picked = shown === state.shown ? pickedStates() : [];
    const keepPanel = shown === state.shown && (state.tab === 'evidence' || state.tab === 'review');
    const currentHeader = keepPanel ? els.detail.querySelector('.detail-header') : null;
    state.shown = shown;
    const head = el('div', {},
        el('button', { class: 'btn btn-quiet back', type: 'button', onclick: () => showView('board') }, '← All specs'),
        el('p', { class: 'eyebrow' }, spec.id, spec.branch ? `  ·  ${spec.branch}` : ''),
        el('h2', {}, spec.title),
        el('div', { class: 'head-pills' },
            copyButton(spec.id, 'Copy path'),
            copyButton(spec.name, 'Copy name'),
            statusPill(spec),
            spec.workflow ? el('span', { class: 'pill tier-muted', title: 'Workflow' }, spec.workflow) : null,
            spec.pendingReviews ? el('span', { class: 'pill tier-review', title: 'Review comments not applied yet' }, `${spec.pendingReviews} review ${spec.pendingReviews === 1 ? 'note' : 'notes'}`) : null,
            spec.lastActivity ? el('span', { class: 'pill tier-muted', title: spec.lastActivity }, `active ${relativeTime(spec.lastActivity)}`) : null));

    const tabBar = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Documents' }, tabs.map(tab => el('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        'aria-selected': tab.id === state.tab ? 'true' : 'false',
        onclick: () => {
            state.tab = tab.id;
            renderDetail();
        },
    }, tab.label, tab.count ? el('span', { class: 'count' }, tab.count) : null)));

    const header = el('div', { class: 'detail-header' }, head, renderRail(spec.steps), renderNext(spec),
        renderDeliveryPanel(spec, deliveryFor('spec', spec)),
        spec.files.spec ? dedicatedWorkControl('spec', spec.id) : null, tabBar);
    if (currentHeader) {
        currentHeader.replaceWith(header);
    } else {
        els.detail.replaceChildren(el('div', { class: 'detail-inner' }, header,
            el('div', { class: 'panel', role: 'tabpanel' }, renderPanel(detail, state.tab))));
    }
    restoreStates(picked);
    els.detail.scrollTop = scrollTop;
}

async function loadDetail() {
    if (!state.selected) {
        state.detail = null;
        renderDetail();
        return;
    }
    const request = ++state.detailRequest;
    try {
        const detail = await api(`/api/spec?id=${encodeURIComponent(state.selected)}`);
        if (request !== state.detailRequest) return;
        // The same detail under the same project facts, as after a scan that changed nothing shown: keep the nodes that are there.
        const { specify, commandSet, commands } = state.snapshot ?? {};
        const key = JSON.stringify([detail, specify, commandSet, commands]);
        if (state.detail && key === state.detailKey) return;
        state.detailKey = key;
        state.detail = detail;
    } catch {
        if (request !== state.detailRequest) return;
        state.detail = null;
        state.selected = null;
    }
    renderDetail();
}

function showView(view) {
    els.layout.dataset.view = view;
    if (view === 'detail') els.detail.focus({ preventScroll: true });
}

function select(id, { pushView = false, fromServer = false } = {}) {
    if (state.selected !== id) {
        state.selected = id;
        state.tab = null;
        state.reviewDraft = null;
        els.detail.scrollTop = 0;
    }
    renderBoard();
    loadDetail();
    if (pushView) showView('detail');
    if (!fromServer) api('/api/focus', { spec: id }).catch(() => {});
}

const WORKFLOW_NOTES = {
    companion: 'Companion: the lean pipeline that records the run.',
    speckit: 'Spec Kit: the standard commands.',
    auto: 'Auto: runs every step without pausing.',
};

function renderSpecifyChoices() {
    const { specify } = state.snapshot;
    if (!specify) return;
    const current = specify.choices.find(c => c.id === state.workflow);
    if (!current || !current.available) state.workflow = specify.default;
    els.newSpecWorkflow.replaceChildren(...specify.choices.map(choice => el('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': choice.id === state.workflow ? 'true' : 'false',
        disabled: !choice.available,
        'aria-disabled': choice.available ? null : 'true',
        title: choice.reason ?? choice.description ?? WORKFLOW_NOTES[choice.id],
        onclick: () => {
            state.workflow = choice.id;
            renderSpecifyChoices();
        },
    }, choice.label)));
    const hint = installHint('form');
    const blocked = specify.choices.find(c => !c.available);
    els.newSpecHint.textContent = blocked && !hint
        ? blocked.reason
        : specify.choices.find(choice => choice.id === state.workflow)?.description ?? WORKFLOW_NOTES[state.workflow] ?? '';
    els.newSpecInstall.replaceChildren(...(hint ? [hint] : []));
    els.newSpecInstall.hidden = !hint;
}

function renderBusinessPlanChoices() {
    const bp = state.snapshot?.businessPlan;
    if (!bp?.installed) {
        els.newBpWorkflow.replaceChildren();
        els.newBpHint.textContent = '';
        els.newBpPhases.replaceChildren();
        return;
    }
    const current = bp.choices.find(c => c.id === state.bpWorkflow);
    if (!current || !current.available) state.bpWorkflow = bp.default;
    els.newBpWorkflow.replaceChildren(...bp.choices.map(choice => el('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': choice.id === state.bpWorkflow ? 'true' : 'false',
        disabled: !choice.available,
        'aria-disabled': choice.available ? null : 'true',
        title: choice.reason ?? choice.description ?? '',
        onclick: () => {
            const wasWork = state.bpWorkflow === 'work';
            const nextWork = choice.id === 'work';
            if (!wasWork && nextWork && !workTitle.value.trim() && bpTitle.value.trim()) {
                workTitle.value = bpTitle.value;
            } else if (wasWork && !nextWork && !bpTitle.value.trim() && workTitle.value.trim()) {
                bpTitle.value = workTitle.value;
                if (!bpGraphTouched) {
                    const slug = slugifyBp(bpTitle.value);
                    bpGraph.value = slug ? `business-plans/${slug}/traceability.json` : '';
                }
            }
            state.bpWorkflow = choice.id;
            renderBusinessPlanChoices();
            renderNewEntry();
        },
    }, choice.label)));
    const active = bp.choices.find(choice => choice.id === state.bpWorkflow);
    const versionPrefix = bp.bundleVersion ? `business-plan v${bp.bundleVersion} · ` : '';
    els.newBpHint.textContent = active?.description
        ? `${state.bpWorkflow === 'work' ? '' : versionPrefix}${active.description}`
        : bp.choices.find(c => !c.available)?.reason ?? '';
    const phases = bp.workflow?.phases ?? [];
    els.newBpPhases.replaceChildren(...phases.map((phase) => el('li', { class: 'new-bp-phase' },
        el('span', { class: 'new-bp-phase-step' }, phase.label),
        phase.gate ? el('span', { class: 'new-bp-phase-gate' }, 'Gate') : null,
    )));
}

function applySnapshot(snapshot) {
    const rootChanged = state.snapshot?.root !== snapshot.root;
    if (state.snapshot && rootChanged) {
        state.workflow = null;
        state.bpWorkflow = null;
        bpGraphTouched = false;
        bpDraft.checked = true;
        els.workflowFrame.removeAttribute('src');
        els.businessPlanFrame.removeAttribute('src');
        if (!els.newSpec.hidden) setNewEntryOpen(false);
        entryDrafts.clear();
        entryFields.forEach(field => { field.value = ''; });
        entrySource = null;
        epicRelations = { parent: '', dependencies: [] };
        entryRequest++;
        state.selected = null;
        state.detail = null;
        state.shown = null;
        state.detailRequest++;
        state.query = '';
        els.search.value = '';
        state.project.request++;
        state.project.root = null;
        state.project.groups = [];
        renderProjectFiles();
        if (state.project.document) {
            els.projectStatus.textContent = 'The repository changed. Copy or discard these edits before opening another file.';
            els.projectSave.disabled = true;
        }
        if (!els.projectPanel.hidden) refreshProjectFiles();
        state.reports.request++;
        state.reports.slug = null;
        state.reports.item = null;
        state.reports.list = null;
        renderReports();
        if (!els.reportsPanel.hidden) refreshReports();
    }
    const key = JSON.stringify({ ...snapshot, generatedAt: null });
    const same = key === state.snapshotKey;
    state.snapshotKey = key;
    const previous = state.snapshot;
    state.snapshot = snapshot;
    if (rootChanged && !els.workflowPanel.hidden) showWorkflowView(workflowView);
    if (rootChanged && !els.businessPlanPanel.hidden) showBusinessPlanView();
    if (rootChanged && !linkedWorkPanel.hidden) linkedWorkPanel.replaceChildren(ecosystem.linkedWork());
    if (rootChanged && !routinesPanel.hidden) routines.open(routinesPanel);
    if (rootChanged && !decisionsPanel.hidden) decisions.open();
    const boundSessionChanged = previous?.boundSession?.sessionId !== snapshot.boundSession?.sessionId
        || previous?.boundSession?.name !== snapshot.boundSession?.name;
    if (!els.newSpec.hidden && (rootChanged || (extensionIntakeRoute(entryKind) && boundSessionChanged))) refreshNewEntryExtension();
    if (rootChanged) settingsPage.rootChanged();
    if (previous?.specify && state.workflow === previous.specify.default && previous.specify.default !== snapshot.specify?.default) state.workflow = null;
    if (previous?.businessPlan && state.bpWorkflow === previous.businessPlan.default && previous.businessPlan.default !== snapshot.businessPlan?.default) state.bpWorkflow = null;
    if (same) return loadDetail();
    renderSpecifyChoices();
    renderBusinessPlanChoices();
    renderNewEntry();
    if (state.selected && !snapshot.specs.some(s => s.id === state.selected)) state.selected = null;
    if (!state.selected && window.matchMedia('(min-width: 761px)').matches) {
        state.selected = snapshot.selected ?? snapshot.specs.find(s => !s.done)?.id ?? snapshot.specs[0]?.id ?? null;
    }
    renderBoard();
    for (const control of document.querySelectorAll('[data-dedicated-work]')) updateDedicatedWorkControl(control);
    loadDetail();
}

function connect() {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.addEventListener('open', () => {
        els.live.dataset.state = 'live';
        els.liveLabel.textContent = 'Live';
    });
    source.addEventListener('error', () => {
        els.live.dataset.state = 'offline';
        els.liveLabel.textContent = 'Reconnecting';
    });
    source.addEventListener('snapshot', (event) => applySnapshot(JSON.parse(event.data)));
    source.addEventListener('dedicated-work', (event) => {
        const { root, coordinatedSessions, dedicatedWork, deliveryLedger } = JSON.parse(event.data);
        if (root !== state.snapshot?.root) return;
        Object.assign(state.snapshot, { coordinatedSessions, dedicatedWork, ...(deliveryLedger ? { deliveryLedger } : {}) });
        renderCoordinatedSessions();
        if (deliveryLedger) {
            renderBoard();
            if (state.detail) renderDetail();
        }
        for (const control of document.querySelectorAll('[data-dedicated-work]')) updateDedicatedWorkControl(control);
    });
    source.addEventListener('delivery-changed', (event) => {
        const { root, deliveryLedger } = JSON.parse(event.data);
        if (root !== state.snapshot?.root) return;
        state.snapshot.deliveryLedger = deliveryLedger;
        renderBoard();
        if (state.detail) renderDetail();
    });
    source.addEventListener('work-error', event => toast(JSON.parse(event.data).message));
    source.addEventListener('settings-changed', event => {
        settingsPage.diskChanged(JSON.parse(event.data));
        if (!els.projectPanel.hidden) refreshProjectFiles();
    });
    source.addEventListener('step-completed', event => {
        const { step, spec } = JSON.parse(event.data);
        toast(`${STEP_LABELS[step] ?? step} finished for ${spec}.`);
    });
    source.addEventListener('reports-changed', () => {
        if (!els.reportsPanel.hidden) reloadReports();
        if (!els.newSpec.hidden) refreshNewEntryExtension();
    });
    source.addEventListener('focus', (event) => {
        const { selected } = JSON.parse(event.data);
        if (selected && selected !== state.selected) {
            if (state.filter !== 'all' && !visibleSpecs().some(s => s.id === selected)) setFilter('all');
            select(selected, { pushView: true, fromServer: true });
            els.list.querySelector(`[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
        }
    });
}

function setFilter(filter) {
    state.filter = filter;
    els.closedFilter.hidden = filter !== 'done';
    for (const button of document.querySelectorAll('[data-filter]')) {
        button.setAttribute('aria-checked', button.dataset.filter === filter ? 'true' : 'false');
    }
    renderBoard();
}

els.closedFilter.addEventListener('change', () => {
    state.closedFilter = els.closedFilter.value;
    renderBoard();
});

for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => setFilter(button.dataset.filter));
}

els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderBoard();
});

els.sort.addEventListener('change', async () => {
    els.sort.disabled = true;
    try {
        await api('/api/sort', { mode: els.sort.value });
    } catch (error) {
        els.sort.value = state.snapshot.sortMode;
        toast(error.message);
    } finally {
        els.sort.disabled = false;
    }
});

els.refresh.addEventListener('click', async () => {
    els.refresh.classList.remove('spinning');
    void els.refresh.offsetWidth;
    els.refresh.classList.add('spinning');
    try {
        const { count } = await api('/api/refresh', {});
        toast(`Re-read ${count} specs`);
    } catch (error) {
        toast(`Refresh failed: ${error.message}`);
    }
});

els.repositoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
        const result = await api('/api/root', { root: els.repositoryRoot.value.trim() });
        els.repositoryRoot.blur();
        toast(`Scanning ${result.root}: ${result.count} specs`);
    } catch (error) {
        toast(`Could not select repository: ${error.message}`);
    }
});

els.repositoryBrowse.addEventListener('click', async () => {
    els.repositoryBrowse.disabled = true;
    try {
        const result = await api('/api/root/browse', {});
        if (!result.cancelled) {
            els.repositoryRoot.value = result.root;
            toast(`Scanning ${result.root}: ${result.count} specs`);
        }
    } catch (error) {
        toast(`Could not browse repositories: ${error.message}`);
    } finally {
        els.repositoryBrowse.disabled = false;
    }
});

els.repositoryFollow.addEventListener('click', async () => {
    try {
        const result = await api('/api/root/follow', {});
        toast(`Disconnected; showing this session: ${result.root}`);
    } catch (error) {
        toast(`Could not disconnect: ${error.message}`);
    }
});

els.coordinatedSession.addEventListener('change', async () => {
    if (!els.coordinatedSession.value) {
        renderCoordinatedSessions();
        return;
    }
    try {
        const result = await api('/api/root/coordinated', { sessionId: els.coordinatedSession.value });
        toast(`Showing ${result.root}`);
    } catch (error) {
        renderCoordinatedSessions();
        toast(`Could not select the session: ${error.message}`);
    }
});

const entryType = $('new-entry-kind');
const entryTextLabel = $('new-entry-text-label');
const entrySubmit = $('new-entry-submit');
const entryExtension = $('new-report-extension');
const workTitle = $('new-work-title');
const workOutcome = $('new-work-outcome');
const bpHeader = $('new-bp-header');
const bpTitleRow = $('new-bp-title-row');
const bpTitle = $('new-bp-title');
const bpDetails = $('new-bp-details');
const bpGraph = $('new-bp-graph');
const bpOwner = $('new-bp-owner');
const bpCriteria = $('new-bp-criteria');
const bpDraftRow = $('new-bp-draft-row');
const bpDraft = $('new-bp-draft');
const bpGraphOnly = $('new-bp-graph-only');
const epicParent = $('new-epic-parent');
const epicDependencies = $('new-epic-dependencies');
const productChangeName = $('new-product-change-name');
const reportTitle = $('report-title');
const reportCapture = $('new-report-capture');
const entryFields = [els.newSpecText, els.reportExtra, els.reportSlug, workTitle, workOutcome, productChangeName, reportTitle, bpTitle, bpGraph, bpOwner, bpCriteria];
const entryDrafts = new Map();
const entryCopy = {
    spec: ['Create spec', 'Starts the selected workflow and drafts spec.md.', 'Let people export their board as CSV'],
    bugs: ['Assess bug', 'Save the report in Companion or send it to Copilot for a Spec Kit assessment.', 'What happened, and what did you expect?'],
    ideas: ['Assess idea', 'Capture the idea here or use Copilot for a Spec Kit assessment.', 'What problem would this idea solve?'],
    prespec: ['Start discovery in chat', 'Explore alternative approaches. Copilot asks you to confirm the goal, motivation, and folder name before creating discovery cards.', 'What are you trying to achieve, and why?'],
    'business-plan': ['Save business plan', 'Capture product direction before starting a spec.', 'What customer or business outcome should this plan deliver?'],
    epic: ['Save epic', 'Group related work without starting a workflow.', 'What scope or customer outcome does this epic cover?'],
    'product-change': ['Draft Product Change in chat', 'Propose a change to the accepted product model. This sends a draft request; it does not approve or apply the change.', 'What product behavior should change, and why?'],
};
const BP_WORKFLOW_COPY = {
    workflow: [
        'Start business plan workflow',
        'Creates the starter traceability graph and starts the 4-phase Business Plan workflow with 3 human approval gates.',
        'Summarize the sponsor brief, business problem, and any reviewed evidence or constraints.',
    ],
    discovery: [
        'Start discovery in chat',
        'Creates the starter traceability graph and sends /speckit.business-plan.discovery with your sponsor brief.',
        'Summarize the sponsor brief, discovery questions, and reviewed evidence.',
    ],
    plan: [
        'Draft business plan in chat',
        'Creates the starter traceability graph and sends /speckit.business-plan.plan to draft Phase 1.',
        'Summarize the business problem, target audience, value proposition, and constraints.',
    ],
};
const slugifyBp = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
const defaultBpGraphPath = title => {
    const slug = slugifyBp(title);
    return slug ? `business-plans/${slug}/traceability.json` : '';
};
const bpBundleInstalled = () => Boolean(state.snapshot?.businessPlan?.installed);
const isBpBundleMode = () => entryKind === 'business-plan' && bpBundleInstalled() && state.bpWorkflow !== 'work';
const isReportKind = kind => kind === 'bugs' || kind === 'ideas';
const isWorkKind = kind => kind === 'business-plan' || kind === 'epic';
const extensionIntakeRoute = kind => kind === 'prespec' ? '/api/discovery' : kind === 'product-change' ? '/api/product-change' : null;
const needsIntakeCheck = kind => isReportKind(kind) || Boolean(extensionIntakeRoute(kind));
let entryKind = 'spec';
let entrySource = null;
let epicRelations = { parent: '', dependencies: [] };
let entryStatus = { ready: false, text: '' };
let entryRequest = 0;
let entrySending = false;
let bpGraphTouched = false;

function renderNewEntry() {
    const spec = entryKind === 'spec';
    const bpInstalled = entryKind === 'business-plan' && bpBundleInstalled();
    const bpBundle = bpInstalled && state.bpWorkflow !== 'work';
    const work = isWorkKind(entryKind) && !bpBundle;
    const productChange = entryKind === 'product-change';
    const [action, help, placeholder] = bpBundle
        ? (BP_WORKFLOW_COPY[state.bpWorkflow] ?? BP_WORKFLOW_COPY.workflow)
        : entryCopy[entryKind];
    $('new-spec-fields').hidden = !spec;
    $('new-report-fields').hidden = !isReportKind(entryKind);
    $('new-work-fields').hidden = !work;
    $('new-epic-fields').hidden = entryKind !== 'epic';
    $('new-product-change-fields').hidden = !productChange;
    bpHeader.hidden = !bpInstalled;
    bpTitleRow.hidden = !bpBundle;
    bpDetails.hidden = !bpBundle;
    els.newBpPhases.hidden = !bpBundle || !state.snapshot?.businessPlan?.workflow?.phases?.length;
    bpDraftRow.hidden = !bpBundle || state.bpWorkflow !== 'workflow';
    bpTitle.disabled = !bpBundle;
    bpTitle.required = bpBundle;
    bpGraph.disabled = !bpBundle;
    bpGraph.required = bpBundle;
    bpOwner.disabled = !bpBundle;
    bpCriteria.disabled = !bpBundle;
    productChangeName.disabled = !productChange;
    productChangeName.required = productChange;
    workTitle.disabled = !work;
    workTitle.required = work;
    workOutcome.disabled = !work;
    entryTextLabel.textContent = bpBundle ? 'Sponsor brief & reviewed evidence' : 'Description';
    $('new-work-source').hidden = !spec || !entrySource;
    $('new-source-label').textContent = entrySource ? `Source: ${entrySource.title}` : '';
    $('new-entry-help').textContent = help;
    els.newSpecText.placeholder = placeholder;
    if (spec) els.newSpecText.removeAttribute('maxlength');
    else els.newSpecText.maxLength = extensionIntakeRoute(entryKind) ? 3000 : (work || bpBundle) ? 12000 : 20000;
    $('new-intake-status').hidden = !needsIntakeCheck(entryKind) || !entryStatus.text;
    $('new-report-status').textContent = entryStatus.text;
    entryExtension.hidden = !entryStatus.action;
    entryExtension.textContent = entryStatus.action ?? '';
    entrySubmit.textContent = action;
    entrySubmit.disabled = entrySending || (needsIntakeCheck(entryKind) && !entryStatus.ready);
    bpGraphOnly.hidden = !bpBundle;
    bpGraphOnly.disabled = entrySending;
    reportCapture.hidden = !isReportKind(entryKind);
    reportCapture.disabled = entrySending;
}

async function refreshNewEntryExtension() {
    const request = ++entryRequest;
    const kind = entryKind;
    const name = kind === 'bugs' ? 'bug' : 'assess';
    entryStatus = { ready: false, text: needsIntakeCheck(kind) ? 'Checking the required Spec Kit extension…' : '' };
    renderNewEntry();
    if (kind === 'epic') {
        epicParent.disabled = epicDependencies.disabled = true;
        $('new-epic-status').textContent = 'Loading linked work…';
        try {
            const { records, root } = await api('/api/work');
            if (request !== entryRequest || root !== state.snapshot?.root) return;
            epicParent.replaceChildren(el('option', { value: '' }, 'No business plan'), ...records.filter(item => item.kind === 'business-plan')
                .map(item => el('option', { value: item.id }, item.title)));
            epicParent.value = epicRelations.parent;
            epicDependencies.replaceChildren(el('legend', {}, 'Depends on (optional)'), ...records.filter(item => item.kind === 'epic')
                .map(item => el('label', {}, el('input', { type: 'checkbox', value: item.id, checked: epicRelations.dependencies.includes(item.id),
                    onchange: event => {
                        const dependencies = new Set(epicRelations.dependencies);
                        if (event.currentTarget.checked) dependencies.add(item.id);
                        else dependencies.delete(item.id);
                        epicRelations.dependencies = [...dependencies];
                    } }), ` ${item.title}`)));
            $('new-epic-status').textContent = '';
            epicParent.disabled = epicDependencies.disabled = false;
        } catch (error) {
            if (request === entryRequest) $('new-epic-status').textContent = error.message;
        }
        return;
    }
    if (!needsIntakeCheck(kind)) return;
    try {
        const route = extensionIntakeRoute(kind);
        if (route) {
            const { reason, setup, revision, root, target } = await api(route);
            if (request !== entryRequest || root !== state.snapshot?.root) return;
            entryStatus = reason ? { ready: false, text: reason, action: setup ? 'Open Integrations' : null }
                : { ready: true, revision, text: `Destination: ${target}` };
        } else {
            const { extension } = await api(`/api/reports?kind=${kind}`);
            if (request !== entryRequest) return;
            entryStatus = extension.disabled ? { ready: false, text: `Enable the ${name} extension for chat assessment.`, action: 'Enable extension' }
                : extension.state === 'absent' ? { ready: false, text: `Install the ${name} extension for chat assessment.`, action: 'Install extension' }
                    : { ready: extension.state === 'present', text: '' };
        }
    } catch (error) {
        if (request !== entryRequest) return;
        entryStatus = { ready: false, text: `Could not check the extension: ${error.message}` };
    }
    renderNewEntry();
}

function selectEntryKind(kind) {
    if (entryKind === kind) return;
    entryDrafts.set(entryKind, entryFields.map(field => field.value));
    const draft = entryDrafts.get(kind);
    entryFields.forEach((field, index) => { field.value = draft?.[index] ?? ''; });
    entryKind = entryType.value = kind;
    if (kind === 'business-plan') {
        bpGraphTouched = Boolean(bpGraph.value.trim() && bpGraph.value !== defaultBpGraphPath(bpTitle.value));
    }
}

function draftLinkedSpec(source, description) {
    selectEntryKind('spec');
    if (entrySource?.id !== source.id || entrySource?.kind !== source.kind) {
        els.newSpecText.value = description;
    }
    entrySource = source;
    showBoardPanel(null);
    setNewEntryOpen(true);
}

function setNewEntryOpen(open) {
    els.newSpec.hidden = !open;
    els.newSpecToggle.setAttribute('aria-expanded', String(open));
    if (open) {
        refreshNewEntryExtension();
        (isBpBundleMode() ? bpTitle : isWorkKind(entryKind) ? workTitle : els.newSpecText).focus();
    } else {
        els.newSpecToggle.focus();
    }
}

bpTitle.addEventListener('input', () => {
    if (bpGraphTouched) return;
    bpGraph.value = defaultBpGraphPath(bpTitle.value);
});
bpGraph.addEventListener('input', () => {
    bpGraphTouched = Boolean(bpGraph.value.trim());
});

async function submitBusinessPlanIntake(workflowOverride = null) {
    if (!isBpBundleMode() || entrySending || !els.newSpec.reportValidity()) return;
    const root = state.snapshot?.root;
    const workflow = workflowOverride ?? state.bpWorkflow;
    const values = entryFields.map(field => field.value);
    const title = bpTitle.value.trim();
    const brief = els.newSpecText.value.trim();
    const graphPath = bpGraph.value.trim() || defaultBpGraphPath(title);
    const owner = bpOwner.value.trim();
    const criteria = bpCriteria.value.trim();
    const draft = bpDraft.checked;
    if (!title || !brief) return;
    entrySending = true;
    renderNewEntry();
    try {
        const result = await api('/api/business-plan/create', {
            expectedRoot: root,
            title,
            brief,
            graphPath,
            owner,
            criteria,
            workflow,
            draft,
        });
        if (root !== state.snapshot?.root) return;
        const active = entryKind === 'business-plan';
        const currentDraft = active ? entryFields.map(field => field.value) : entryDrafts.get('business-plan');
        if (values.every((value, i) => currentDraft?.[i] === value)) {
            entryDrafts.delete('business-plan');
            bpGraphTouched = false;
            bpDraft.checked = true;
            if (active) {
                entryFields.forEach(field => { field.value = ''; });
                if (!els.newSpec.hidden) setNewEntryOpen(false);
            }
        }
        showBoardPanel(els.businessPlanPanel);
        showBusinessPlanView(true);
        if (result.workflow === 'graph-only') {
            toast(`Created ${result.graphPath}.`);
        } else {
            await reportSend(result, 'the business plan workflow');
        }
    } catch (error) {
        toast(`Could not create business plan: ${error.message}`);
    } finally {
        entrySending = false;
        renderNewEntry();
    }
}

bpGraphOnly.addEventListener('click', () => {
    void submitBusinessPlanIntake('graph-only');
});

entryType.addEventListener('change', () => {
    selectEntryKind(entryType.value);
    refreshNewEntryExtension();
});
epicParent.addEventListener('change', () => { epicRelations.parent = epicParent.value; });
$('new-source-clear').addEventListener('click', () => {
    entrySource = null;
    renderNewEntry();
    els.newSpecText.focus();
});
entryExtension.addEventListener('click', async () => {
    if (extensionIntakeRoute(entryKind)) {
        showBoardPanel(els.workflowPanel);
        showWorkflowView('integrations');
        workflowIntegrationsView.focus();
        return;
    }
    entryExtension.disabled = true;
    try {
        await reportSend(await api('/api/report/extension', { kind: entryKind }), 'the extension request');
    } catch (error) {
        toast(error.message);
    } finally {
        entryExtension.disabled = false;
    }
});
els.newSpecToggle.addEventListener('click', () => {
    const open = els.newSpec.hidden || els.layout.hidden;
    if (els.layout.hidden) showBoardPanel(null);
    setNewEntryOpen(open);
});

reportCapture.addEventListener('click', async () => {
    if (!isReportKind(entryKind) || entrySending || !els.newSpec.reportValidity()) return;
    const kind = entryKind;
    const expectedRoot = state.snapshot?.root;
    const title = reportTitle.value.trim() || els.newSpecText.value.trim().split(/\r?\n/)[0].slice(0, 160);
    const slug = els.reportSlug.value.trim() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || `intake-${Date.now()}`;
    const description = [els.newSpecText.value.trim(), els.reportExtra.value.trim()].filter(Boolean).join('\n\n');
    entrySending = true;
    renderNewEntry();
    try {
        await api('/api/reports/triage', { kind, slug, title, description, status: 'new', revision: null });
        if (expectedRoot !== state.snapshot?.root) return;
        if (entryKind === kind) {
            entryFields.forEach(field => { field.value = ''; });
            setNewEntryOpen(false);
        }
        await showReport(kind, slug);
        toast('Saved to Companion. No chat request was sent.');
    } catch (error) {
        toast(error.message);
    } finally {
        entrySending = false;
        renderNewEntry();
    }
});

els.newSpec.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (entrySubmit.disabled) return;
    if (isBpBundleMode()) {
        await submitBusinessPlanIntake();
        return;
    }
    const kind = entryKind;
    const root = state.snapshot?.root;
    const source = kind === 'spec' ? entrySource : null;
    const values = entryFields.map(field => field.value);
    const [description, extra, slug, title, outcome, name] = values;
    const work = isWorkKind(kind);
    if (!description.trim()) return;
    entrySending = true;
    renderNewEntry();
    try {
        const result = work ? await api('/api/work/create', { kind, title, description, outcome, ...(kind === 'epic' ? epicRelations : {}) })
            : kind === 'spec'
            ? await api('/api/specify', { description: description.trim(), workflow: state.workflow, ...(source ? { source: { kind: source.kind, id: source.id } } : {}) })
            : kind === 'prespec' ? await api('/api/discovery', { idea: description, revision: entryStatus.revision })
                : kind === 'product-change' ? await api('/api/product-change', { name, description, revision: entryStatus.revision })
                : await api('/api/report/create', { kind, text: description, extra, slug });
        if (root !== state.snapshot?.root) return;
        if (work || result.sent) {
            const active = kind === entryKind;
            const draft = active ? entryFields.map(field => field.value) : entryDrafts.get(kind);
            if (values.every((value, i) => draft?.[i] === value) && (kind !== 'spec' || source === entrySource)) {
                entryDrafts.delete(kind);
                if (kind === 'epic') epicRelations = { parent: '', dependencies: [] };
                if (kind === 'spec') entrySource = null;
                if (active) {
                    entryFields.forEach(field => { field.value = ''; });
                    if (!els.newSpec.hidden) setNewEntryOpen(false);
                }
            }
        }
        if (work) {
            showBoardPanel(linkedWorkPanel);
            linkedWorkPanel.replaceChildren(ecosystem.linkedWork(null, result.id));
            toast(`Saved ${result.title}.`);
        } else if (kind === 'prespec') {
            toast('Discovery request sent. Review the goal, motivation, and folder name in the selected chat before confirming.');
        } else if (kind === 'product-change') {
            toast('Product Change draft request sent. Continue in the selected Copilot chat.');
        } else await reportSend(result, kind === 'spec' ? 'the spec request' : 'the assessment');
    } catch (error) {
        toast(`Could not send: ${error.message}`);
        if (extensionIntakeRoute(kind) && entryKind === kind && !els.newSpec.hidden) await refreshNewEntryExtension();
    } finally {
        entrySending = false;
        renderNewEntry();
    }
});

setupStatesSelect();
function workflowUrl() {
    const query = new URLSearchParams({ token });
    if (state.snapshot?.root) query.set('root', state.snapshot.root);
    if (forcedTheme) query.set('theme', forcedTheme);
    return `/workflow?${query}`;
}
const workflowGraphView = $('workflow-graph-view');
const workflowIntegrationsView = $('workflow-integrations-view');
const integrationsPanel = $('integrations-panel');
let workflowView = 'pipeline';
function showWorkflowView(view) {
    workflowView = view;
    const pipeline = view === 'pipeline';
    workflowGraphView.setAttribute('aria-pressed', String(pipeline));
    workflowIntegrationsView.setAttribute('aria-pressed', String(!pipeline));
    els.workflowFrame.hidden = !pipeline;
    integrationsPanel.hidden = pipeline;
    if (!pipeline) ecosystem.integrations(integrationsPanel);
    else if (!els.workflowFrame.getAttribute('src')) els.workflowFrame.src = workflowUrl();
}
workflowGraphView.addEventListener('click', () => showWorkflowView('pipeline'));
workflowIntegrationsView.addEventListener('click', () => showWorkflowView('integrations'));
bindBoardTool(els.workflowToggle, els.workflowPanel, () => showWorkflowView(workflowView));

function businessPlanUrl() {
    const query = new URLSearchParams({ token });
    if (state.snapshot?.root) query.set('root', state.snapshot.root);
    if (forcedTheme) query.set('theme', forcedTheme);
    return `/business-plan?${query}`;
}
function showBusinessPlanView(forceRefresh = false) {
    if (!els.businessPlanFrame.getAttribute('src')) {
        els.businessPlanFrame.src = businessPlanUrl();
        return;
    }
    if (forceRefresh) {
        els.businessPlanFrame.contentWindow?.postMessage(
            { type: 'speckit-canvas:refresh-business-plan' },
            location.origin,
        );
    }
}
bindBoardTool(els.businessPlanToggle, els.businessPlanPanel, () => showBusinessPlanView());
window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.type === 'speckit-canvas:open-settings') {
        showBoardPanel(settingsPanel);
        settingsPage.open();
    }
});
if (params.get('view') === 'business-plan') {
    showBoardPanel(els.businessPlanPanel);
    showBusinessPlanView();
}

function projectDirty() {
    return state.project.document && els.projectContent.value !== state.project.document.content;
}

function renderProjectFiles() {
    els.projectGroups.replaceChildren(...state.project.groups.map(group => el('details', { open: true },
        el('summary', {}, group.label),
        ...group.files.map(path => el('button', {
            type: 'button', class: 'project-file',
            'aria-current': String(state.project.document?.path === path && state.project.document?.root === state.project.root),
            onclick: () => openProjectFile(path),
        }, path)),
    )));
    if (!state.project.groups.length) els.projectGroups.append(el('p', {}, 'No project files found.'));
}

async function refreshProjectFiles() {
    const request = ++state.project.request;
    try {
        const result = await api('/api/project-files');
        if (request !== state.project.request) return;
        state.project.root = result.root;
        state.project.groups = result.groups;
        renderProjectFiles();
    } catch (error) {
        toast(error.message);
    }
}

async function openProjectFile(path) {
    if (projectDirty()) {
        els.projectStatus.textContent = 'Save or discard your edits before opening another file.';
        return;
    }
    const request = ++state.project.request;
    const root = state.project.root;
    try {
        const document = await api('/api/project-files/open', { path });
        if (request !== state.project.request || root !== state.snapshot?.root) return;
        state.project.document = { ...document, root };
        els.projectPath.textContent = path;
        els.projectContent.value = document.content;
        els.projectEmpty.hidden = true;
        els.projectDocument.hidden = false;
        els.projectStatus.textContent = 'Changes are saved to this repository.';
        els.projectSave.disabled = true;
        renderProjectFiles();
    } catch (error) {
        toast(error.message);
    }
}

els.projectContent.addEventListener('input', () => {
    els.projectSave.disabled = !projectDirty() || state.project.document?.root !== state.snapshot?.root;
});
els.projectDiscard.addEventListener('click', () => {
    if (state.project.document?.root !== state.snapshot?.root) {
        state.project.document = null;
        els.projectDocument.hidden = true;
        els.projectEmpty.hidden = false;
    } else {
        els.projectContent.value = state.project.document.content;
        els.projectStatus.textContent = 'Edits discarded.';
        els.projectSave.disabled = true;
    }
    renderProjectFiles();
});
els.projectSave.addEventListener('click', async () => {
    const document = state.project.document;
    const content = els.projectContent.value;
    els.projectSave.disabled = true;
    try {
        await api('/api/project-files/save', { token: document.token, content });
        document.content = content;
        els.projectStatus.textContent = 'Saved.';
    } catch (error) {
        els.projectStatus.textContent = error.message;
    }
    els.projectSave.disabled = !projectDirty() || document.root !== state.snapshot?.root;
});
els.projectRefine.addEventListener('click', async () => {
    if (projectDirty()) {
        els.projectStatus.textContent = 'Save or discard your edits before refining this file.';
        return;
    }
    els.projectRefine.disabled = true;
    try {
        await reportSend(await api('/api/project-files/refine', { token: state.project.document.token }), 'the refinement');
    } catch (error) {
        els.projectStatus.textContent = error.message;
    } finally {
        els.projectRefine.disabled = false;
    }
});
els.projectCreate.addEventListener('submit', async event => {
    event.preventDefault();
    const description = els.projectCreateDescription.value;
    els.projectCreateButton.disabled = true;
    try {
        const result = await api('/api/project-files/create', { kind: els.projectCreateKind.value, description });
        if (result.sent && els.projectCreateDescription.value === description) els.projectCreateDescription.value = '';
        await reportSend(result, 'the project guidance request');
    } catch (error) {
        toast(error.message);
    } finally {
        els.projectCreateButton.disabled = false;
    }
});
els.projectRefresh.addEventListener('click', refreshProjectFiles);
bindBoardTool(els.projectToggle, els.projectPanel, refreshProjectFiles);

const triageLabels = { new: 'New', reviewing: 'In review', ready: 'Ready', parked: 'Parked' };
const reportRows = data => [
    ...data.items,
    ...(data.triage ?? []).filter(record => record.captured && !data.items.some(item => item.slug === record.id))
        .map(record => ({ slug: record.id, title: record.title, state: 'draft' })),
];

function ideaUpdatePane(item) {
    const pane = el('section', { class: 'board-subsection', 'aria-label': 'Update product work' });
    const expectedRoot = state.snapshot?.root;
    const active = () => pane.isConnected && !els.reportsPanel.hidden && state.snapshot?.root === expectedRoot && state.reports.item === item;
    const result = el('p', { role: 'status' });
    const formHost = el('div');
    const start = el('button', { type: 'button', class: 'btn btn-quiet', onclick: async () => {
        start.disabled = true;
        try {
            const data = await api('/api/work');
            if (!active() || data.root !== expectedRoot) return;
            const targets = [...data.records, ...data.specs.map(spec => ({ ...spec, kind: 'spec' }))];
            const picker = el('select', { class: 'search', required: true }, el('option', { value: '' }, 'Choose a destination'),
                targets.map((target, index) => el('option', { value: String(index) },
                    `${{ 'business-plan': 'Business plan', epic: 'Epic', spec: 'Spec' }[target.kind]}: ${target.title}`)));
            const summary = el('textarea', { rows: '4', required: true, maxlength: '6000', placeholder: 'Describe the change to add, not the whole idea' });
            const review = el('div', { class: 'board-subsection', hidden: true });
            const preview = el('button', { type: 'submit', class: 'btn btn-quiet' }, 'Review proposed update');
            const form = el('form', { class: 'board-form', onsubmit: async event => {
                event.preventDefault();
                const target = targets[Number(picker.value)];
                const key = picker.value;
                const change = summary.value.trim();
                if (!target || !key || !change || !active()) return;
                preview.disabled = true;
                review.hidden = true;
                try {
                    const document = target.kind === 'spec' ? await api('/api/work/preview-idea', { idea: item.slug, spec: target.id }) : null;
                    if (!active() || picker.value !== key || summary.value.trim() !== change) return;
                    const apply = el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
                        if (!active() || picker.value !== key || summary.value.trim() !== change) return;
                        apply.disabled = true;
                        try {
                            await api('/api/work/apply-idea', { idea: item.slug, target: { kind: target.kind, id: target.id },
                                summary: change, confirmed: true, token: document?.token });
                            if (!active()) return;
                            toast(`Updated ${target.title}.`);
                            if (document) {
                                showBoardPanel(null);
                                select(target.id, { pushView: true });
                            } else await openReport(item.slug);
                        } catch (error) {
                            result.textContent = error.message;
                            apply.disabled = false;
                        }
                    } }, 'Apply update');
                    review.replaceChildren(el('h4', {}, target.title), el('p', {}, document ? `Append to ${document.path}` : 'Add to the product record’s update history'),
                        document ? el('details', {}, el('summary', {}, 'Current specification'), el('pre', { tabindex: '0' }, document.content)) : null,
                        el('p', { class: 'board-prose' }, change), apply);
                    review.hidden = false;
                    apply.focus();
                } catch (error) {
                    result.textContent = error.message;
                } finally {
                    preview.disabled = false;
                }
            } }, el('label', {}, 'Destination', picker), el('label', {}, 'Proposed update', summary), preview);
            for (const field of [picker, summary]) field.addEventListener('input', () => { review.hidden = true; });
            formHost.replaceChildren(form, review);
            picker.focus();
        } catch (error) {
            result.textContent = error.message;
        } finally {
            start.disabled = false;
        }
    } }, 'Update existing work');
    pane.append(el('h3', {}, 'Product updates'), el('p', {}, 'Review exactly what this idea adds to a business plan, epic, or spec.'),
        start, formHost, result,
        ...(item.updates ?? []).map(update => el('div', { class: 'board-subsection' },
            el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => {
                if (!active()) return;
                showBoardPanel(linkedWorkPanel);
                linkedWorkPanel.replaceChildren(ecosystem.linkedWork(null, update.target.id));
            } }, update.target.title), el('p', { class: 'board-prose' }, update.summary))));
    return pane;
}

function renderReports() {
    const data = state.reports.list;
    const isBug = state.reports.kind === 'bugs';
    els.reportsTitle.textContent = isBug ? 'Bugs' : 'Ideas';
    if (!data) {
        els.reportsExtension.textContent = 'Loading reports…';
        els.reportsExtensionAction.hidden = true;
        els.reportsList.replaceChildren();
        els.reportDetail.replaceChildren(el('p', {}, 'Choose a report to read its stages.'));
        return;
    }
    const extension = data.extension;
    els.reportsExtension.textContent = extension.disabled ? `The ${isBug ? 'bug' : 'assess'} extension is turned off. You can still triage work in Companion.`
        : extension.state === 'absent' ? `Install Spec Kit's ${isBug ? 'bug' : 'assess'} extension to run its commands.`
        : extension.foreign ? `A different ${isBug ? 'bug' : 'assess'} extension is installed; its stages may differ.` : '';
    if (!isBug && data.directory !== '.specify/assessments') els.reportsExtension.textContent += ` Reading ${data.directory}.`;
    els.reportsExtensionAction.hidden = !extension.disabled && extension.state !== 'absent';
    els.reportsExtensionAction.textContent = extension.disabled ? 'Enable extension' : 'Install extension';
    const rows = reportRows(data);
    els.reportsList.replaceChildren(el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => {
        selectEntryKind(state.reports.kind);
        showBoardPanel(null);
        setNewEntryOpen(true);
    } }, isBug ? 'New bug' : 'New idea'), ...rows.map(item => el('button', {
        type: 'button', class: 'project-file',
        'aria-current': String(item.slug === state.reports.item?.slug),
        onclick: () => openReport(item.slug),
    }, item.title, el('small', { class: 'report-state' }, ` · ${triageLabels[data.triage?.find(record => record.id === item.slug)?.status] ?? item.state.replaceAll('-', ' ')}`))));
    if (!rows.length) els.reportsList.append(el('p', {}, `No ${isBug ? 'bugs' : 'ideas'} yet.`));
    const item = state.reports.item;
    if (!item) {
        els.reportDetail.replaceChildren(el('p', {}, 'Choose a report to read its stages.'));
        return;
    }
    const tabs = el('div', { class: 'report-tabs', role: 'group', 'aria-label': 'Report stages' }, ...item.documents.map(doc => el('button', {
        type: 'button', class: 'btn btn-chip', 'aria-pressed': String(doc.kind === state.reports.document),
        onclick: () => { state.reports.document = doc.kind; renderReports(); },
    }, doc.label)));
    const selectedDocument = item.documents.find(doc => doc.kind === state.reports.document) ?? item.documents[0];
    const reportKind = state.reports.kind;
    const body = el('article', { class: 'report-body markdown-content' });
    body.innerHTML = selectedDocument?.html ?? '';
    const saved = data.triage?.find(record => record.id === item.slug);
    const canDerive = isBug || item.verdict === 'go' || saved?.status === 'ready';
    const triageStatus = el('select', { class: 'search' }, Object.entries(triageLabels).map(([value, name]) => el('option', { value }, name)));
    triageStatus.value = saved?.status ?? 'new';
    const triageNote = el('textarea', { rows: '3', maxlength: '3000' });
    triageNote.value = saved?.note ?? '';
    const triageSave = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save triage');
    const triageFeedback = el('p', { role: 'status' });
    const triage = el('form', { class: 'board-form', onsubmit: async event => {
        event.preventDefault();
        if (triageSave.disabled || !triage.isConnected || state.reports.item !== item || state.reports.kind !== reportKind || els.reportsPanel.hidden) return;
        triageSave.disabled = true;
        try {
            await api('/api/reports/triage', { kind: reportKind, slug: item.slug, status: triageStatus.value,
                note: triageNote.value, revision: saved?.revision ?? null });
            if (state.reports.item === item) await openReport(item.slug);
            toast('Triage saved in Companion.');
        } catch (error) {
            triageFeedback.textContent = error.message;
        } finally {
            triageSave.disabled = false;
        }
    } }, el('label', {}, 'Triage status', triageStatus), el('label', {}, 'Triage notes', triageNote), triageSave, triageFeedback);
    if (!selectedDocument) body.append(el('h3', {}, 'Original report'), el('p', { class: 'board-prose' }, item.description),
        el('p', { class: 'board-muted' }, 'No Spec Kit assessment yet.'));
    const questions = el('div', { class: 'report-questions' }, ...(item.canAnswer ? selectedDocument?.questions ?? [] : []).map(question => {
        const key = JSON.stringify([state.snapshot?.root, reportKind, item.slug, selectedDocument.kind, question]);
        const input = el('textarea', { required: true, maxlength: 4000, 'aria-label': `Answer: ${question}` });
        input.value = state.reports.drafts.get(key) ?? '';
        input.addEventListener('input', () => state.reports.drafts.set(key, input.value));
        const button = el('button', { type: 'submit', class: 'btn btn-quiet' }, 'Send answer');
        return el('form', { class: 'report-question', onsubmit: async event => {
            event.preventDefault();
            button.disabled = true;
            try {
                const answer = input.value;
                const result = await api('/api/report/answer', { kind: reportKind, slug: item.slug, document: selectedDocument.kind, question, answer });
                if (result.sent && state.reports.drafts.get(key) === answer) {
                    input.value = '';
                    state.reports.drafts.delete(key);
                }
                await reportSend(result, 'the answer');
            } catch (error) {
                toast(error.message);
            } finally {
                button.disabled = false;
            }
        } }, el('label', {}, question, input), button);
    }));
    const buttons = el('div', { class: 'report-actions' }, ...item.actions.map(action => el('button', {
        type: 'button', class: `btn ${action.primary ? 'btn-primary' : 'btn-quiet'}`,
        onclick: async event => {
            const button = event.currentTarget;
            if (action.id === 'idea.createSpec') {
                draftLinkedSpec({ kind: 'idea', id: item.slug, title: item.title }, item.description ?? item.title);
                return;
            }
            button.disabled = true;
            try {
                await reportSend(await api('/api/report/action', { kind: reportKind, slug: item.slug, action: action.id }), 'the report action');
            } catch (error) {
                toast(error.message);
            } finally {
                button.disabled = false;
            }
        },
    }, action.label)));
    if (canDerive && !item.actions.some(action => action.id === 'idea.createSpec')) {
        buttons.append(el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => {
            draftLinkedSpec({ kind: isBug ? 'bug' : 'idea', id: item.slug, title: item.title },
                [item.title, saved?.description || item.description || `Read the assessment under ${data.directory}/${item.slug} for context.`].join('\n\n'));
        } }, 'Draft linked spec'));
    }
    if (item.state === 'draft' && extension.state === 'present' && !extension.disabled) {
        buttons.append(el('button', { type: 'button', class: 'btn btn-quiet', onclick: async event => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                await reportSend(await api('/api/report/create', { kind: reportKind, slug: item.slug, text: saved.description, extra: saved.note }), 'the assessment');
            } catch (error) { toast(error.message); }
            finally { button.disabled = false; }
        } }, 'Assess in chat'));
    }
    const linked = item.linkedSpecs?.length ? el('div', { class: 'report-actions', role: 'group', 'aria-label': 'Linked specs' },
        ...item.linkedSpecs.map(spec => el('button', { type: 'button', class: 'btn btn-chip', onclick: () => {
            showBoardPanel(null);
            select(spec.id, { pushView: true });
        } }, `Open spec: ${spec.title}`))) : null;
    const triagePanel = el('details', { class: 'board-subsection', open: item.state === 'draft' },
        el('summary', {}, 'Companion triage'), el('p', {}, 'Your triage is separate from the Spec Kit assessment and workflow decisions.'), triage);
    els.reportDetail.replaceChildren(el('header', { class: 'board-heading' }, el('h2', {}, item.title),
        el('span', { class: 'board-state', 'data-tone': saved?.status }, triageLabels[saved?.status] ?? 'Not triaged')),
        tabs, body, questions, buttons, isBug || saved?.status === 'ready' ? dedicatedWorkControl(isBug ? 'bug' : 'idea', item.slug) : null,
        linked, triagePanel, !isBug && canDerive ? ideaUpdatePane(item) : null);
}

async function refreshReports() {
    const request = ++state.reports.request;
    const kind = state.reports.kind;
    try {
        const result = await api(`/api/reports?kind=${encodeURIComponent(kind)}`);
        if (request !== state.reports.request || (result.root && result.root !== state.snapshot?.root)) return false;
        state.reports.list = result;
        if (state.reports.slug && !reportRows(result).some(item => item.slug === state.reports.slug)) {
            state.reports.slug = null;
            state.reports.item = null;
        }
        renderReports();
        return true;
    } catch (error) {
        if (request === state.reports.request) toast(error.message);
        return false;
    }
}

async function openReport(slug) {
    const request = ++state.reports.request;
    const kind = state.reports.kind;
    if (state.reports.slug !== slug) {
        state.reports.slug = slug;
        state.reports.item = null;
        renderReports();
    }
    try {
        const result = await api(`/api/report?kind=${encodeURIComponent(kind)}&slug=${encodeURIComponent(slug)}`);
        if (request !== state.reports.request || (result.root && result.root !== state.snapshot?.root)) return;
        state.reports.list = result;
        state.reports.item = result.item;
        if (!result.item.documents.some(doc => doc.kind === state.reports.document)) state.reports.document = result.item.documents[0]?.kind;
        renderReports();
    } catch (error) {
        if (request === state.reports.request) toast(error.message);
    }
}

async function showReport(kind, slug) {
    if (state.reports.kind !== kind) {
        state.reports.kind = kind;
        state.reports.slug = null;
        state.reports.item = null;
        state.reports.list = null;
    }
    showBoardPanel(els.reportsPanel);
    if (slug) await openReport(slug);
    else await reloadReports();
}

for (const button of reportButtons) {
    button.addEventListener('click', () => {
        const kind = button.dataset.reportKind;
        if (!els.reportsPanel.hidden && state.reports.kind === kind) {
            showBoardPanel(null);
            return;
        }
        if (state.reports.kind !== kind) {
            state.reports.kind = kind;
            state.reports.slug = null;
            state.reports.item = null;
            state.reports.list = null;
        }
        showBoardPanel(els.reportsPanel);
        renderReports();
        reloadReports();
    });
}
async function reloadReports() {
    const selected = state.reports.slug;
    if (await refreshReports() && selected && state.reports.slug === selected) await openReport(selected);
}
els.reportsRefresh.addEventListener('click', reloadReports);
els.reportsExtensionAction.addEventListener('click', async () => {
    els.reportsExtensionAction.disabled = true;
    try {
        await reportSend(await api('/api/report/extension', { kind: state.reports.kind }), 'the extension request');
    } catch (error) {
        toast(error.message);
    } finally {
        els.reportsExtensionAction.disabled = false;
    }
});
connect();
