const statuses = {
    created: 'Created', running: 'Running', paused: 'Paused', completed: 'Completed', failed: 'Failed',
    aborted: 'Aborted', skipped: 'Skipped', pending: 'Pending', review: 'Needs a verdict',
    write: 'Needs GitHub approval', uncertain: 'GitHub result unknown',
};
const types = {
    'fan-out': 'Fan-out', 'fan-in': 'Join results', gate: 'Human review gate', if: 'Conditional',
    switch: 'Choose a branch', while: 'Loop', 'do-while': 'Loop', workflow: 'Subworkflow',
};
const verdicts = { approve: 'Approved', reject: 'Rejected', abort: 'Aborted by verdict' };
const cliId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const tiers = { running: 'active', paused: 'review', review: 'review', write: 'review', uncertain: 'review',
    completed: 'success', failed: 'review', aborted: 'muted', blocked: 'review', enabled: 'info' };
const preferredRun = node => node.guidedRun ?? node.isolatedRun ?? node.nativeRuns?.[0];
const railState = status => status === 'completed' ? status :
    ['running', 'paused', 'review', 'write'].includes(status) ? 'in-progress' : 'not-started';

export function runPurposeLabel(purpose) {
    return purpose === 'acceptance' ? 'Acceptance gate' : purpose === 'validation' ? 'Validation check' : 'Default step label';
}

export function renderWorkflowRuns({ root, graph, selection, el, button, copyButton, render, openFeature, openWorkflow,
    handleDecision, start, allowGuidedWrite, inspectEvidence, inspectDecision, configurePurpose, refresh }) {
    const installed = graph.nodes.filter(node => node.kind === 'Workflows' && node.installed);
    const history = graph.nativeHistory ?? [];
    const workflows = [...installed, ...history];
    const requested = workflows.find(node => node.id === selection.workflow);
    const selected = requested ?? workflows[0];
    const historyOnly = Boolean(selected && history.includes(selected));
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    const focusId = root.contains(document.activeElement) ? document.activeElement.id : '';
    const boardScroll = document.getElementById('run-list')?.scrollTop ?? 0;
    const detailScroll = document.getElementById('run-detail')?.scrollTop ?? 0;
    const selectDetail = ({ workflow, run = null, feature = null, tab = 'overview' }, focus = 'run-details-heading') => {
        Object.assign(selection, { workflow, run, feature, tab, pane: 'detail' });
        render();
        document.getElementById('run-detail')?.scrollTo(0, 0);
        document.getElementById(focus)?.focus();
    };
    const back = () => {
        root.dataset.view = selection.pane = 'board';
        (document.getElementById(`run-pick-${selected?.key}`) ?? document.getElementById('run-search'))?.focus();
    };
    const pill = (text, tier = 'muted') => el('span', { class: `pill tier-${tier}` }, text);
    const tag = status => el('span', { class: 'run-status', 'data-run-status': status }, statuses[status] ?? status);
    const p = text => el('p', {}, text);
    const roleButton = (text, action, attrs = {}) => button(text, action, attrs);
    const findings = id => graph.findings.filter(item => item.severity === 'blocked' && item.nodeIds.includes(id));
    const inbox = [];
    const omittedPauses = workflows.reduce((count, node) => count + (node.omittedPausedRuns ?? 0), 0);
    for (const node of workflows) {
        const guided = node.guidedRun;
        const isolated = node.isolatedRun;
        for (const [run, kind] of [[guided, 'guided'], [isolated, 'isolated']]) {
            if (!run?.error && !['review', 'write', 'uncertain', 'paused'].includes(run?.status)) continue;
            const guidedRun = kind === 'guided';
            const action = guidedRun
                ? (node.canRunGuided && run.matched && (run.status === 'review' ? 'guided-review' : run.status === 'write' && allowGuidedWrite ? 'guided-write' : null))
                : (node.canRunReview && run.resumable && 'isolated');
            inbox.push({ node, title: run.error ? 'Checkpoint unavailable' : run.status === 'paused' ? 'Needs a verdict' : statuses[run.status],
                detail: run.error ?? (run.status === 'uncertain' ? 'Inspect the issue on GitHub. The canvas will not retry this write.' : run.step),
                action, runKey: kind });
        }
        for (const run of node.nativeRuns ?? []) {
            if (run.status !== 'paused') continue;
            inbox.push({ node, title: run.gateWaiting ? 'Native gate needs input' : 'Native run paused', detail: run.step,
                runKey: `native:${run.id}` });
        }
    }

    const section = el('section', { class: 'run-inbox', 'aria-labelledby': 'decision-inbox-heading' },
        el('h3', { id: 'decision-inbox-heading' }, 'Decision inbox'),
        inbox.length ? el('ul', { class: 'run-lines' }, inbox.map(item => el('li', {},
            el('div', {}, el('strong', {}, item.title), el('p', { class: 'run-meta' }, [item.node.name, item.detail].filter(Boolean).join(' · '))),
            item.action ? roleButton(item.action === 'guided-write' ? 'Review GitHub change…' : 'Review verdict…',
                () => {
                    selectDetail({ workflow: item.node.id, run: item.runKey, feature: selection.workflow === item.node.id ? selection.feature : null });
                    handleDecision(item.node, item.action);
                }, { id: `run-decision-${item.node.key}-${item.runKey}` })
                : roleButton('Inspect checkpoint', () => {
                    selectDetail({ workflow: item.node.id, run: item.runKey });
                }, { id: `run-decision-${item.node.key}-${item.runKey}` })))) : p('No waiting decisions in the visible run records.'),
        omittedPauses ? p(`${omittedPauses} additional paused ${omittedPauses === 1 ? 'checkpoint is' : 'checkpoints are'} outside this view. Inspect native run records for the rest.`) : null);
    const pending = new Map();
    for (const { node } of inbox) pending.set(node.id, (pending.get(node.id) ?? 0) + 1);
    const listEmpty = el('p', { class: 'list-empty', role: 'status' });
    const list = el('ul', { class: 'spec-list', id: 'run-list', 'aria-label': 'Workflow list' });
    function renderList() {
        const query = selection.query.trim().toLowerCase();
        const groups = [
            ['installed', 'Installed workflows', installed],
            ['history', 'History without an installed workflow', history],
        ].filter(([id]) => selection.filter === 'all' || selection.filter === id)
            .map(([id, label, nodes]) => [id, label, nodes.filter(node =>
                [node.name, node.key, node.version].some(value => String(value ?? '').toLowerCase().includes(query)))]);
        const pick = (node, group) => {
            const latest = preferredRun(node), waiting = pending.get(node.id);
            const status = group === 'history' ? 'History only' : node.healthStatus === 'blocked' ? 'Blocked' : node.active ? 'Enabled' : 'Disabled';
            const steps = (latest?.steps ?? []).filter(step => !step.fanOutItem);
            return el('li', {}, el('button', { type: 'button', class: 'spec-card', id: `run-pick-${node.key}`,
                'aria-current': String(node.id === selected?.id), 'aria-label': node.name, 'aria-describedby': `run-meta-${node.key}`,
                onclick: () => selectDetail({ workflow: node.id }) },
            el('span', { class: 'card-top' }, el('span', { class: 'sb-title', title: node.name }, node.name)),
            el('span', { class: 'card-meta run-card-meta', id: `run-meta-${node.key}` },
                pill(status, tiers[status.toLowerCase()]), latest?.status ? pill(statuses[latest.status] ?? latest.status, tiers[latest.status]) : null,
                steps.length ? el('span', { class: 'mini-rail run-mini-rail', 'aria-hidden': 'true' },
                    steps.slice(0, 8).map(step => el('span', { dataset: { state: railState(step.status) } }))) : null,
                waiting ? el('span', { class: 'card-tasks' }, `${waiting} waiting`) : null)));
        };
        list.replaceChildren(...groups.flatMap(([id, label, nodes]) => nodes.length ? [
            el('li', {}, el('h3', { class: 'run-list-heading' }, label)), ...nodes.map(node => pick(node, id)),
        ] : []));
        listEmpty.hidden = Boolean(list.children.length);
        listEmpty.textContent = workflows.length ? 'No workflows match.' : 'No installed workflows or native run records were found.';
    }
    const filters = [['installed', 'Installed', installed.length], ['history', 'History', history.length], ['all', 'All', workflows.length]];
    const filterBar = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter workflows' },
        filters.map(([id, label, count]) => el('button', { type: 'button', id: `run-filter-${id}`,
            'aria-pressed': String(selection.filter === id),
            onclick: event => {
                selection.filter = id;
                for (const item of event.currentTarget.parentElement.children) item.setAttribute('aria-pressed', String(item === event.currentTarget));
                renderList();
            } }, label, ' ', el('span', { class: 'count' }, count))));
    const board = el('aside', { class: 'board', 'aria-label': 'Workflows' },
        el('div', { class: 'board-tools' },
            el('input', { class: 'search', id: 'run-search', type: 'search', value: selection.query, autocomplete: 'off',
                placeholder: 'Search by name or ID', 'aria-label': 'Search workflows',
                oninput: event => { selection.query = event.target.value; renderList(); } }),
            filterBar,
            el('div', { class: 'workflow-actions' },
                button(`Decision inbox${inbox.length ? ` (${inbox.length})` : ''}`,
                    () => selectDetail({ workflow: selected?.id, run: selection.run, feature: selection.feature, tab: 'inbox' }, 'run-tab-inbox'),
                    { id: 'run-show-inbox', 'aria-controls': 'run-panel', 'aria-pressed': String(selection.tab === 'inbox') }),
                button('Refresh runs', refresh, { id: 'run-refresh' }))),
        list, listEmpty);
    renderList();
    const nativeRuns = selected?.nativeRuns ?? [];
    const options = [...(!selected || historyOnly ? [] : [['definition', 'Current definition']]), ...nativeRuns.map(run => [`native:${run.id}`, `${run.id} · ${statuses[run.status]}`]),
        ...(selected?.guidedRun ? [['guided', 'Canvas guided run']] : []),
        ...(selected?.isolatedRun ? [['isolated', 'Canvas isolated review']] : [])];
    const key = options.some(([id]) => id === selection.run) ? selection.run
        : selected?.guidedRun ? 'guided' : selected?.isolatedRun ? 'isolated' : nativeRuns.length ? `native:${nativeRuns[0].id}` : 'definition';
    const native = nativeRuns.find(run => key === `native:${run.id}`);
    const question = native?.question;
    const issue = graph.findings.filter(item => item.severity === 'blocked' &&
        selected && item.nodeIds.some(id => id === selected.id || byId.get(id)?.workflowOwner === selected.id));
    const resumeCommand = !historyOnly && native?.status === 'paused' && !native.resumeHold && cliId.test(native.id)
        ? `specify workflow resume ${native.id}` : null;
    const startCommand = key === 'definition' && selected?.active && selected.state !== 'blocked' && !issue.length && cliId.test(selected.key)
        ? `specify workflow run ${selected.key}` : null;
    function nativeStart() {
        const fields = selected.nativeStartFields ?? [];
        const manual = selected.inputs.filter(name => !fields.some(field => field.name === name));
        const controls = fields.map(({ name, options, defaultValue, required, description }) => {
            const id = `native-start-${name}`;
            const control = el('select', { id, class: 'search', required, 'aria-describedby': description ? `${id}-help` : null },
                el('option', { value: '' }, required ? 'Choose a value' : defaultValue === null ? 'Do not supply' : `Use workflow default (${defaultValue})`),
                options.map(value => el('option', { value }, value)));
            return { name, options, required, control,
                row: el('div', {}, el('label', { for: id }, name), control, description ? el('p', { id: `${id}-help` }, description) : null) };
        });
        const invocation = el('code', {});
        const copy = el('div', { class: 'workflow-actions' });
        function compose() {
            const missing = controls.some(({ control, required }) => required && !control.value);
            const invalid = controls.some(({ control, name, options }) =>
                control.value && (!cliId.test(name) || !options.includes(control.value) || !cliId.test(control.value)));
            const command = [startCommand, ...controls.filter(({ control }) => control.value)
                .map(({ name, control }) => `--input ${name}=${control.value}`)].join(' ');
            invocation.textContent = invalid ? 'Choose a listed value to preview the command.' :
                missing ? 'Choose all required values to preview the command.' : command;
            copy.replaceChildren(...(missing || invalid ? [] : [copyButton(command, 'Copy start command', { id: 'run-copy-start' })]));
        }
        controls.forEach(({ control }) => control.addEventListener('change', compose));
        compose();
        return el('section', { class: 'run-native-start', 'aria-label': 'Native start command' },
            p('Review the command, then run it from the repository root in an interactive terminal. The canvas does not start the run.'),
            controls.length ? el('fieldset', {}, el('legend', {}, 'Native start inputs'), controls.map(({ row }) => row)) : null,
            manual.length ? p(`Declared inputs: ${manual.join(', ')}. Review any values you need to supply in the terminal. Answer gate prompts interactively.`) : null,
            el('p', { class: 'workflow-actions', 'aria-live': 'polite' }, invocation), copy);
    }
    const run = native ?? (key === 'guided' ? selected.guidedRun : key === 'isolated' ? selected.isolatedRun : null);
    const children = new Map(), incoming = new Map(), featureIds = new Set();
    for (const edge of graph.edges) {
        if (selected && edge.kind === 'contains' && byId.get(edge.target)?.workflowOwner === selected.id) {
            if (!children.has(edge.source)) children.set(edge.source, []);
            children.get(edge.source).push(edge);
        }
        if (selected && edge.kind === 'step' && byId.get(edge.target)?.workflowOwner === selected.id) {
            if (!incoming.has(edge.target)) incoming.set(edge.target, []);
            incoming.get(edge.target).push(byId.get(edge.source)?.name ?? edge.source.split(':').at(-1));
        }
        if (selected && edge.kind === 'input' && byId.get(edge.target)?.workflowOwner === selected.id && edge.source.startsWith('feature:')) {
            featureIds.add(edge.source);
        }
    }
    const topSteps = children.get(selected?.id) ?? [];
    const gateRecords = new Map([...(selected?.reviewGates ?? []), ...(selected?.guidedReview ?? []).map(pair => pair.gate)].map(gate => [gate.id, gate]));
    function diagram(parent) {
        const groups = new Map();
        for (const edge of children.get(parent) ?? []) {
            if (!groups.has(edge.label)) groups.set(edge.label, []);
            groups.get(edge.label).push(edge);
        }
        return el('div', { class: 'run-branches' },
            [...groups].map(([label, edges]) => el('div', {},
                parent !== selected.id ? el('h4', { class: 'run-branch-label' }, label) : null,
                el('ol', { class: 'run-steps', 'aria-label': parent === selected.id ? 'Workflow steps' : label }, edges.map(edge => {
                    const step = byId.get(edge.target);
                    const gate = step.stepType === 'gate' && gateRecords.get(step.name);
                    const active = !native && ['paused', 'review', 'write'].includes(run?.status) &&
                        (key === 'isolated' ? Boolean(gate) && step.name === run.step : key === 'guided' && step.name === run.step);
                    const stepLabel = step.runPurpose ? runPurposeLabel(step.runPurpose)
                        : types[step.stepType] ?? step.stepType ?? 'Unknown step';
                    return el('li', { class: 'run-step', 'data-current': String(active) },
                        el('div', { class: 'run-step-title' }, el('strong', {}, step.name),
                            el('div', { class: 'run-step-labels' }, tag(stepLabel),
                                active ? tag(run.status === 'paused' ? 'review' : run.status) : null)),
                        incoming.has(step.id) ? el('p', { class: 'run-meta' }, `After ${incoming.get(step.id).join(', ')}`) : null,
                        step.stepType === 'fan-out' ? p(step.fanOutConcurrency === 1 ? 'Runs one item at a time.' :
                            step.fanOutConcurrency > 1 ? `Up to ${step.fanOutConcurrency} items run in parallel.` : 'Concurrency is not a literal positive number.') : null,
                        step.joinSteps?.length ? p(`Collects results from ${step.joinSteps.join(', ')}.`) : null,
                        step.integration || step.agent ? p([step.integration && `Integration: ${step.integration}`, step.agent && `Declared agent: ${step.agent}`].filter(Boolean).join(' · ')) : null,
                        step.commands.length ? el('code', {}, step.commands.map(command => command.id).join(', ')) : null,
                        typeof step.note === 'string' ? p(step.note) : null,
                        step.gateRejection ? p(`On rejection: ${step.gateRejection}.`) : null,
                        step.inputs.length ? p(`Declared inputs: ${step.inputs.join(', ')}`) : null,
                        step.outputs.length ? p(`Declared outputs: ${step.outputs.join(', ')}`) : null,
                        step.definitionEvidence ? roleButton('Read definition evidence…',
                            () => inspectEvidence(step, step.definitionEvidence.path, step.definitionEvidence), { id: `run-evidence-${step.id}` }) : null,
                        gate?.artifact && gate.artifact !== step.reviewArtifact ? p(`Review evidence: ${gate.artifact}`) : null,
                        key === 'definition' && step.stepType ? button('Change step label…', () => configurePurpose(step), {
                            'aria-label': `Change step label: ${step.name}`, id: `run-purpose-${step.id}`,
                        }) : null,
                        byId.get(step.subworkflow)?.installed ? button('Inspect subworkflow', () => selectDetail({ workflow: step.subworkflow, run: 'definition', tab: 'steps' })) : null,
                        findings(step.id).map(item => el('p', { class: 'run-blocker' }, item.message)),
                        children.has(step.id) ? diagram(step.id) : null);
                })))));
    }

    const recordedEvidence = (result, id) => result?.evidence && el('div', {},
        el('p', { class: 'run-meta' }, result.evidence.path),
        roleButton('Read recorded evidence reference…',
            () => inspectEvidence(byId.get(result.evidence.feature), result.evidence.path, result.evidence, true), { id }));
    const recordedItems = new Map();
    for (const step of native?.steps ?? []) {
        const parent = step.fanOutItem?.parent;
        if (!parent) continue;
        if (!recordedItems.has(parent)) recordedItems.set(parent, []);
        recordedItems.get(parent).push(step);
    }
    function recordedStep(step) {
        const items = recordedItems.get(step.id);
        return el('li', {}, el('div', {}, el('code', {}, step.id),
            step.fanOutItem ? el('p', { class: 'run-meta' }, `Item ${step.fanOutItem.index + 1}`) : null,
            step.gate ? el('p', { class: 'run-meta' }, ['Human review gate', verdicts[step.verdict]].filter(Boolean).join(' · ')) : null,
            step.fanOut ? el('p', { class: 'run-meta' },
                `Fan-out expansion · ${step.fanOut.count} ${step.fanOut.count === 1 ? 'item' : 'items'} · ${
                    step.fanOut.concurrency == null ? 'No recorded concurrency limit' : `Recorded concurrency limit: ${step.fanOut.concurrency}`}`) : null,
            recordedEvidence(step, `run-recorded-evidence-${step.id}`)),
        tag(step.status),
        items?.length ? el('ul', { class: 'run-occurrences', 'aria-label': `Recorded items for ${step.id}` },
            items.sort((a, b) => a.fanOutItem.index - b.fanOutItem.index).map(recordedStep)) : null);
    }
    const activity = () => [
        !native && run?.startInputs?.length ? el('section', {},
            el('h4', {}, 'Recorded start inputs'),
            el('dl', {}, run.startInputs.flatMap(({ name, value }) => [el('dt', {}, name), el('dd', {}, value)]))) : null,
        !native && run?.decisions?.length ? el('section', {},
            el('h4', {}, 'Recorded gate decisions'),
            p('Each digest identifies the reviewed version. The run does not store a copy of the evidence or authorize an external change.'),
            el('ol', { class: 'run-lines', 'aria-label': 'Recorded gate decisions' },
                run.decisions.map(({ step, verdict, at, evidence }) => el('li', {},
                    el('div', {}, el('strong', {}, step),
                        el('p', { class: 'run-meta' }, el('time', { datetime: at }, new Date(at).toLocaleString())),
                        evidence ? el('div', {},
                            el('p', { class: 'run-meta' }, evidence.path, el('br'), 'SHA-256 ', el('code', {}, evidence.digest)),
                            roleButton('Compare current evidence…', () => inspectDecision(selected.id, key, run.id, step, evidence.path),
                                { id: `run-compare-${key}-${step}` })) : null),
                    tag(verdicts[verdict]))))) : null,
        native?.steps.length ? el('section', {}, el('h4', {}, 'Recorded step results'),
            native.steps.some(result => result.evidence) ? p('Recorded paths open the current files. Native run records do not preserve the reviewed bytes.') : null,
            native.steps.some(step => step.fanOut) ? p('Fan-out results show recorded item outcomes, not whether their execution overlapped.') : null,
            el('ul', { class: 'run-lines' }, native.steps.filter(step => !step.fanOutItem).map(recordedStep)),
            native.omittedSteps ? p(`${native.omittedSteps} additional results are available in the native run record.`) : null) : null,
        !native?.steps.length && !run?.startInputs?.length && !run?.decisions?.length ? p('No step results or gate decisions are recorded in this selection.') : null,
    ];
    const overview = () => [
        run?.step ? p(`Recorded checkpoint: ${run.step}`) : null,
        run?.error ? el('p', { role: 'alert' }, run.error) : null,
        native?.updatedAt ? el('p', { class: 'run-meta' }, 'Updated ', el('time', { datetime: native.updatedAt }, new Date(native.updatedAt).toLocaleString())) : null,
        native?.resumeHold === 'other-registry' ? p('This checkpoint names a separate workflow registry. Companion does not verify that registry or offer a resume command.')
            : historyOnly ? p('This workflow is not installed. You can inspect its saved records, but this view cannot start or resume it.')
            : native?.resumeHold === 'disabled' ? p('The installed workflow is disabled. To resume this checkpoint, first review and enable its workflow in Management.')
            : native?.status === 'paused' ? p('This checkpoint belongs to a native Spec Kit run. Inspect it here; resume it through the runtime that owns it.') : null,
        native?.gateWaiting ? el('section', { class: 'run-question' },
            el('h4', {}, 'Recorded decision'),
            question?.message ? el('p', { class: 'run-question-message', dir: 'auto' }, question.message) : p('Question text is not available in this view.'),
            question?.options ? el('ul', { 'aria-label': 'Recorded choices' }, question.options.map(option => el('li', { dir: 'auto' }, option))) : null,
            question?.onReject ? p(`Recorded behavior on rejection: ${question.onReject}.`) : null) : null,
        resumeCommand ? el('div', {},
            p('Run this from the repository root in an interactive terminal. Review any prompts there; the canvas does not supply a verdict or run the command.'),
            el('div', { class: 'workflow-actions' }, el('code', {}, resumeCommand),
                copyButton(resumeCommand, 'Copy resume command', { id: 'run-copy-resume' }))) : null,
        startCommand ? nativeStart() : null,
        recordedEvidence(native?.checkpoint, 'run-checkpoint-evidence'),
        !historyOnly ? el('div', { class: 'workflow-actions' },
            button('Inspect configuration', () => openWorkflow(selected.id)),
            requested && selection.feature ? button('Return to linked spec', () => openFeature(selection.feature)) : null) : null,
        !historyOnly && issue.length ? el('details', {}, el('summary', {}, `${issue.length} configuration ${issue.length === 1 ? 'blocker' : 'blockers'}`),
            el('ul', {}, issue.map(item => el('li', {}, item.message)))) : null,
    ];
    const definitionEvidence = selected && !historyOnly ? graph.nodes.filter(step => step.workflowOwner === selected.id && step.definitionEvidence) : [];
    const historicalEvidence = new Map([...(native?.steps ?? []), native?.checkpoint].filter(step => step?.evidence).map(step => [step.id, step]));
    const evidence = () => [
        historicalEvidence.size ? el('section', {}, el('h4', {}, 'Recorded evidence references'),
            p('Recorded paths open the current files. Native run records do not preserve the reviewed bytes.'),
            el('ul', { class: 'run-lines' }, [...historicalEvidence.values()].map(step => el('li', {},
                el('strong', {}, step.id), recordedEvidence(step, `run-reference-${step.id}`))))) : null,
        definitionEvidence.length ? el('section', {}, el('h4', {}, 'Current definition evidence'),
            el('ul', { class: 'run-lines' }, definitionEvidence.map(step => el('li', {},
                el('div', {}, el('strong', {}, step.name), el('p', { class: 'run-meta' }, step.definitionEvidence.path)),
                button('Read definition evidence…', () => inspectEvidence(step, step.definitionEvidence.path, step.definitionEvidence)))))) : null,
        run?.decisions?.some(decision => decision.evidence) ? el('section', {}, el('h4', {}, 'Reviewed evidence'),
            el('ul', { class: 'run-lines' }, run.decisions.filter(decision => decision.evidence).map(({ step, evidence }) => el('li', {},
                el('div', {}, el('strong', {}, step), el('p', { class: 'run-meta' }, evidence.path)),
                button('Compare current evidence…', () => inspectDecision(selected.id, key, run.id, step, evidence.path)))))) : null,
        featureIds.size ? el('section', {}, el('h4', {}, 'Linked specs'), el('div', { class: 'workflow-actions' },
            [...featureIds].map(id => button(`Spec evidence: ${byId.get(id).name}`, () => openFeature(byId.get(id).key))))) : null,
    ];
    const pendingDecision = inbox.find(item => item.node.id === selected?.id && item.runKey === key);
    const startActions = selected && !historyOnly ? [
        selected.canRunReview && !selected.isolatedRun?.error && selected.isolatedRun?.status !== 'paused'
            ? button('Start isolated review…', () => start(selected, 'isolated')) : null,
        selected.canRunGuided && !selected.guidedRun?.error && (!selected.guidedRun || ['aborted', 'completed'].includes(selected.guidedRun.status))
            ? button('Start guided run…', () => start(selected, 'guided')) : null,
    ].filter(Boolean) : [];
    const next = selected && el('section', { class: 'next run-next', 'aria-label': 'Next step' },
        el('div', { class: 'next-main' }, el('div', { class: 'next-copy' },
            el('p', { class: 'next-title' }, pendingDecision?.title ?? (issue.length && !run ? 'Configuration blocked' :
                historyOnly ? 'Saved history' : native ? 'Native Spec Kit run' : run ? 'Canvas run' : 'Current definition')),
            el('p', { class: 'next-why' }, pendingDecision?.detail ?? (run?.step ? `Checkpoint: ${run.step}` :
                historyOnly ? 'Read recorded activity without an installed definition.' :
                    run ? 'Inspect the outcome in Activity.' : 'Inspect the defined steps before starting a run.'))),
        pendingDecision?.action ? button(pendingDecision.action === 'guided-write' ? 'Review GitHub change…' : 'Review verdict…',
            () => handleDecision(selected, pendingDecision.action), { class: 'btn btn-primary', id: 'run-next-review' }) : null),
        startActions.length ? el('div', { class: 'next-more' }, startActions) : null);
    const rail = native ? native.steps.filter(step => !step.fanOutItem).map(step => [step.id, step.status])
        : topSteps.map(edge => {
            const step = byId.get(edge.target);
            return [step.name, step.name === run?.step ? run.status : null];
        });
    const tabs = [
        ...(selected ? [['overview', 'Overview', overview],
            ...(!historyOnly ? [['steps', 'Steps', () => [
                el('h4', {}, 'Step diagram'), p(native ? 'The diagram is the current definition, not a reconstruction of this historical run.' :
                    'Branches show what can run; only a saved checkpoint confirms where a run stopped.'),
                topSteps.length ? diagram(selected.id) : p('No steps are available in the repository definition.'),
            ]]] : []),
            ...(run ? [['activity', 'Activity', activity]] : []),
            ...(definitionEvidence.length || historicalEvidence.size || featureIds.size || run?.decisions?.some(decision => decision.evidence)
                ? [['evidence', 'Evidence', evidence]] : []),
        ] : []),
        ['inbox', 'Decision inbox', () => section, inbox.length],
    ];
    const [activeTab, , panel] = tabs.find(([id]) => id === selection.tab) ?? tabs[0];
    function selectTab(id) {
        selection.tab = id;
        render();
        document.getElementById(`run-tab-${id}`)?.focus();
    }
    const tabBar = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Workflow details' },
        tabs.map(([id, label, , count], index) => el('button', { type: 'button', class: 'tab', role: 'tab', id: `run-tab-${id}`,
            'aria-controls': 'run-panel', 'aria-selected': String(activeTab === id), tabindex: activeTab === id ? 0 : -1,
            onclick: () => selectTab(id),
            onkeydown: event => {
                const next = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length,
                    Home: 0, End: tabs.length - 1 }[event.key];
                if (typeof next !== 'number') return;
                event.preventDefault();
                selectTab(tabs[next][0]);
            } }, label, count ? el('span', { class: 'count' }, count) : null)));
    const detail = el('section', { class: 'detail', id: 'run-detail', 'aria-labelledby': 'run-details-heading' },
        el('div', { class: 'detail-inner' },
            button('← All workflows', back, { class: 'btn btn-quiet back', id: 'run-back' }),
            el('h2', { id: 'run-details-heading', tabindex: -1 }, selected?.name ?? 'Workflow & runs'),
            selected ? el('div', { class: 'head-pills' },
                pill(selected.key), selected.version ? pill(`v${selected.version}`) : null,
                run?.status ? pill(statuses[run.status] ?? run.status, tiers[run.status]) : null) : null,
            selected && activeTab !== 'inbox' ? el('div', { class: 'run-record-control' },
                el('label', { for: 'run-record-select' }, 'Run record'),
                el('select', { id: 'run-record-select', class: 'search', onchange: event => {
                    selection.run = event.target.value;
                    selection.tab = 'overview';
                    render();
                    document.getElementById('run-detail')?.scrollTo(0, 0);
                } }, options.map(([id, name]) => el('option', { value: id, selected: key === id }, name)))) : null,
            rail.length && activeTab !== 'inbox' ? el('ol', { class: 'rail run-rail', 'aria-label': native ? 'Recorded step progress' : 'Workflow pipeline' },
                rail.map(([name, status], index) => el('li', { dataset: { state: railState(status) } },
                    el('span', { class: 'rail-node', 'aria-hidden': 'true' }, status === 'completed' ? '✓' : String(index + 1)),
                    el('span', { class: 'sb-rail-label' }, name),
                    status ? el('span', { class: 'rail-state', 'aria-hidden': 'true' }, statuses[status] ?? status) : null,
                    status ? el('span', { class: 'sr-only' }, `: ${statuses[status] ?? status}`) : null))) : null,
            activeTab !== 'inbox' ? next : null,
            tabBar,
            el('div', { class: 'panel', role: 'tabpanel', id: 'run-panel', 'aria-labelledby': `run-tab-${activeTab}`, tabindex: 0 }, panel())));
    root.dataset.view = selection.pane;
    root.replaceChildren(board, detail);
    list.scrollTop = boardScroll;
    detail.scrollTop = detailScroll;
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}
