const statuses = { paused: 'Paused', uncertain: 'Uncertain', completed: 'Completed', aborted: 'Aborted' };
const evidenceChecks = {
    matches: 'Local bytes match the recorded evidence.',
    stale: 'Stale in this checkout: the local evidence differs from the recorded bytes.',
    unavailable: 'Could not check the evidence bytes in this checkout.',
};

export function createDecisionsPage({ api, el, panel, root, sendResult }) {
    let request = 0;
    const heading = el('h2', { id: 'decisions-heading', tabindex: -1 }, 'Needs your decision');
    const refresh = el('button', { type: 'button', class: 'btn btn-quiet',
        onclick: () => { if (!refresh.hasAttribute('aria-disabled')) open(); } }, 'Refresh decisions');
    const content = el('div', {});
    panel.append(el('div', { class: 'ecosystem-panel decisions-page' },
        el('header', { class: 'board-heading' },
            el('div', {}, heading, el('p', {}, 'Decisions happen on GitHub. Companion shows local records only, not live gate status.')),
            refresh),
        content));

    const link = (url, label) => el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
    function deliverySummary(delivery) {
        if (!delivery) return null;
        const parts = [`Delivery: ${delivery.kind} ${delivery.id}`, `(${delivery.state})`];
        if (delivery.pr?.url) parts.push(' · ', link(delivery.pr.url, `PR #${delivery.pr.number}`));
        if (delivery.session?.name) parts.push(` · Session: ${delivery.session.name}`);
        return el('p', { class: 'board-muted' }, ...parts);
    }

    function matchDelivery(deliveryLinks, item, fallbackBranch) {
        if (!Array.isArray(deliveryLinks) || !deliveryLinks.length) return null;
        return deliveryLinks.find(d =>
            (d.gate?.id && d.gate.id === item.runId) ||
            (d.issue?.number && d.issue.number === item.issue) ||
            (d.branch && d.branch === (item.branch ?? fallbackBranch)),
        ) ?? null;
    }

    function row(item, delivery = null, showBranch = false) {
        return el('li', { class: 'decision-row' },
            el('div', { class: 'decision-row-heading' },
                el('h4', {}, item.gate),
                el('span', { class: 'board-state', 'data-tone': item.status === 'uncertain' ? 'reviewing' : null },
                    statuses[item.status], item.choice ? ` · ${item.choice === 'approve' ? 'Approve' : 'Reject'} recorded` : '')),
            el('p', {},
                showBranch && item.branch ? ['Branch ', el('code', {}, item.branch), ' · '] : null,
                'Run ', el('code', {}, item.runId), ' · ', link(item.issueUrl, `GitHub issue #${item.issue}`),
                item.commentUrl ? [' · ', link(item.commentUrl, 'Receipt comment')] : null),
            deliverySummary(delivery),
            el('dl', { class: 'decision-evidence' },
                el('dt', {}, 'Evidence'), el('dd', {}, link(item.evidenceUrl, item.evidencePath)),
                el('dt', {}, 'Revision'), el('dd', {}, el('code', {}, item.evidenceRevision))),
            item.evidenceCheck ? el('p', { class: 'decision-check', 'data-check': item.evidenceCheck }, evidenceChecks[item.evidenceCheck]) : null,
            item.status === 'uncertain' ? el('p', {}, el('strong', {}, 'Reconcile with the trusted run owner. Do not retry.')) : null);
    }

    function show(model) {
        const { branch, repository, paused, past, problem, skipped, limited, crossBranch = [], deliveryLinks = [], adrPromotions = null, canHandoff = false } = model;
        const candidates = Array.isArray(adrPromotions?.candidates) ? adrPromotions.candidates : [];
        const hasMultichannel = crossBranch.length > 0 || deliveryLinks.length > 0 || candidates.length > 0;
        const notices = [
            problem,
            skipped.invalid ? `Skipped ${skipped.invalid} malformed or unreadable local gate record(s).` : null,
            skipped.foreign ? `Skipped ${skipped.foreign} record(s) that do not match this checkout's GitHub origin.` : null,
            skipped.otherBranch ? `Skipped ${skipped.otherBranch} record(s) for another branch.` : null,
            limited ? 'The local gate folder exceeded the scan limit. This list may be incomplete.' : null,
        ].filter(Boolean);
        const empty = !problem && !paused.length && !past.length && !notices.length && !hasMultichannel;

        const feedback = hasMultichannel ? el('p', { class: 'board-muted' }) : null;
        const reconcileBtn = hasMultichannel && (crossBranch.length || deliveryLinks.length || paused.length) && canHandoff && sendResult && repository
            ? el('button', {
                type: 'button',
                class: 'btn btn-quiet',
                onclick: async event => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        await sendResult(await api('/api/decisions/reconcile-prompt', { expectedRoot: model.root }), 'live GitHub decision reconciliation');
                        if (feedback) feedback.textContent = 'Sent live GitHub gate reconciliation request to chat.';
                    } catch (error) {
                        if (feedback) feedback.textContent = error.message;
                    } finally {
                        button.disabled = false;
                    }
                },
            }, 'Check live GitHub gates in chat')
            : null;

        const promoteBtn = candidates.length && canHandoff && sendResult && repository
            ? el('button', {
                type: 'button',
                class: 'btn btn-primary',
                onclick: async event => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        await sendResult(await api('/api/decisions/promote-prompt', { expectedRoot: model.root }), 'ADR promotion preview');
                        if (feedback) feedback.textContent = 'Sent ADR promotion proposal to chat for review.';
                    } catch (error) {
                        if (feedback) feedback.textContent = error.message;
                    } finally {
                        button.disabled = false;
                    }
                },
            }, 'Propose ADR PR in chat')
            : null;

        content.replaceChildren(
            repository ? el('p', { class: 'decision-scope' }, repository, ' · ', el('code', {}, branch ?? 'detached')) : '',
            notices.length ? el('ul', { class: 'decision-notices', role: 'status' }, notices.map(notice => el('li', {}, notice))) : '',
            empty ? el('p', {}, 'No cloud gate records are available in this checkout.') : '',
            (!problem && !empty && (paused.length || past.length || notices.length)) || paused.length ? el('section', { 'aria-labelledby': 'decisions-paused' },
                el('h3', { id: 'decisions-paused' }, 'Paused'),
                paused.length ? el('ul', { class: 'decision-list' }, paused.map(item => row(item, matchDelivery(deliveryLinks, item, branch)))) :
                    el('p', {}, 'No paused decisions found in the records shown for this checkout.')) : '',
            past.length ? el('section', { 'aria-labelledby': 'decisions-past' },
                el('h3', { id: 'decisions-past' }, 'Past and uncertain'),
                el('ul', { class: 'decision-list' }, past.map(item => row(item, matchDelivery(deliveryLinks, item, branch))))) : '',
            crossBranch.length ? el('section', { 'aria-labelledby': 'decisions-cross-branch' },
                el('div', { class: 'board-heading' },
                    el('div', {},
                        el('h3', { id: 'decisions-cross-branch' }, 'Other branches (offline Git refs)'),
                        el('p', { class: 'board-muted' }, 'Read offline from local branch and origin refs so decisions across worktrees stay visible.')),
                    reconcileBtn),
                el('ul', { class: 'decision-list' }, crossBranch.map(item => row(item, matchDelivery(deliveryLinks, item, item.branch), true)))) : (
                reconcileBtn ? el('div', { class: 'ecosystem-actions' }, reconcileBtn) : ''
            ),
            candidates.length ? el('section', { 'aria-labelledby': 'decisions-adr-promotions' },
                el('div', { class: 'board-heading' },
                    el('div', {},
                        el('h3', { id: 'decisions-adr-promotions' }, 'ADR promotion preview'),
                        el('p', { class: 'board-muted' }, `Spec-level decisions ready to propose for .specify/decisions.json (${adrPromotions?.existingCount ?? 0} currently on default branch).`)),
                    promoteBtn),
                el('ul', { class: 'decision-list' }, candidates.map(c => el('li', { class: 'decision-row' },
                    el('div', { class: 'decision-row-heading' },
                        el('h4', {}, c.id),
                        el('span', { class: 'board-state' }, c.status)),
                    el('p', {}, c.summary),
                    el('p', { class: 'board-muted' }, 'Source: ', el('code', {}, c.sourceFile)))))) : '',
            feedback ?? '');
    }

    async function open(focus = false) {
        const token = ++request;
        refresh.setAttribute('aria-disabled', 'true');
        content.replaceChildren(el('p', { role: 'status' }, 'Reading local gate records…'));
        if (focus) heading.focus();
        try {
            const model = await api('/api/decisions');
            if (token !== request || panel.hidden || (root() && model.root !== root())) return;
            show(model);
        } catch {
            if (token === request && !panel.hidden) content.replaceChildren(el('p', { role: 'alert' }, 'Could not read the inbox. Refresh decisions to try again.'));
        } finally {
            if (token === request) refresh.removeAttribute('aria-disabled');
        }
    }

    return { open };
}
