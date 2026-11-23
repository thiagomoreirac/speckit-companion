const statuses = { paused: 'Paused', uncertain: 'Uncertain', completed: 'Completed', aborted: 'Aborted' };
const evidenceChecks = {
    matches: 'Local bytes match the recorded evidence.',
    stale: 'Stale in this checkout: the local evidence differs from the recorded bytes.',
    unavailable: 'Could not check the evidence bytes in this checkout.',
};

export function createDecisionsPage({ api, el, panel, root }) {
    let request = 0;
    const heading = el('h2', { id: 'decisions-heading', tabindex: -1 }, 'Needs your decision');
    const refresh = el('button', { type: 'button', class: 'btn btn-quiet',
        onclick: () => { if (!refresh.hasAttribute('aria-disabled')) open(); } }, 'Refresh decisions');
    const content = el('div', {});
    panel.append(el('div', { class: 'ecosystem-panel decisions-page' },
        el('header', { class: 'board-heading' },
            el('div', {}, heading, el('p', {}, 'Decisions happen on GitHub. The trusted run owner consumes them manually. Companion shows local records only, not live gate status.')),
            refresh),
        content));

    const link = (url, label) => el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
    function row(item) {
        return el('li', { class: 'decision-row' },
            el('div', { class: 'decision-row-heading' },
                el('h4', {}, item.gate),
                el('span', { class: 'board-state', 'data-tone': item.status === 'uncertain' ? 'reviewing' : null },
                    statuses[item.status], item.choice ? ` · ${item.choice === 'approve' ? 'Approve' : 'Reject'} recorded` : '')),
            el('p', {}, 'Run ', el('code', {}, item.runId), ' · ', link(item.issueUrl, `GitHub issue #${item.issue}`),
                item.commentUrl ? [' · ', link(item.commentUrl, 'Receipt comment')] : null),
            el('dl', { class: 'decision-evidence' },
                el('dt', {}, 'Evidence'), el('dd', {}, link(item.evidenceUrl, item.evidencePath)),
                el('dt', {}, 'Revision'), el('dd', {}, el('code', {}, item.evidenceRevision))),
            el('p', { class: 'decision-check', 'data-check': item.evidenceCheck }, evidenceChecks[item.evidenceCheck]),
            item.status === 'uncertain' ? el('p', {}, el('strong', {}, 'Reconcile with the trusted run owner. Do not retry.')) : null);
    }

    function show(model) {
        const { branch, repository, paused, past, problem, skipped, limited } = model;
        const notices = [
            problem,
            skipped.invalid ? `Skipped ${skipped.invalid} malformed or unreadable local gate record(s).` : null,
            skipped.foreign ? `Skipped ${skipped.foreign} record(s) that do not match this checkout's GitHub origin.` : null,
            skipped.otherBranch ? `Skipped ${skipped.otherBranch} record(s) for another branch.` : null,
            limited ? 'The local gate folder exceeded the scan limit. This list may be incomplete.' : null,
        ].filter(Boolean);
        const empty = !problem && !paused.length && !past.length && !notices.length;
        content.replaceChildren(
            repository ? el('p', { class: 'decision-scope' }, repository, ' · ', el('code', {}, branch)) : '',
            notices.length ? el('ul', { class: 'decision-notices', role: 'status' }, notices.map(notice => el('li', {}, notice))) : '',
            empty ? el('p', {}, 'No cloud gate records are available in this checkout.') : '',
            (!problem && !empty) || paused.length ? el('section', { 'aria-labelledby': 'decisions-paused' },
                el('h3', { id: 'decisions-paused' }, 'Paused'),
                paused.length ? el('ul', { class: 'decision-list' }, paused.map(row)) :
                    el('p', {}, 'No paused decisions found in the records shown for this checkout.')) : '',
            past.length ? el('section', { 'aria-labelledby': 'decisions-past' },
                el('h3', { id: 'decisions-past' }, 'Past and uncertain'),
                el('ul', { class: 'decision-list' }, past.map(row))) : '');
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
