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

export function renderWorkflowRuns({ root, graph, selection, el, button, copyButton, render, openFeature, openWorkflow,
    handleDecision, start, allowGuidedWrite, inspectEvidence, refresh }) {
    const workflows = graph.nodes.filter(node => node.kind === 'Workflows' && node.installed);
    const requested = workflows.find(node => node.id === selection.workflow);
    const selected = requested ?? workflows[0];
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    const focusId = root.contains(document.activeElement) ? document.activeElement.id : '';
    const changeWorkflow = id => { Object.assign(selection, { workflow: id, run: null, feature: null }); render(); };
    const tag = status => el('span', { class: 'run-status', 'data-run-status': status }, statuses[status] ?? status);
    const p = text => el('p', {}, text);
    const roleButton = (text, action, attrs = {}) => button(text, action, attrs);
    const findings = id => graph.findings.filter(item => item.severity === 'blocked' && item.nodeIds.includes(id));
    const inbox = [];
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
                    Object.assign(selection, { workflow: item.node.id, run: item.runKey, feature: selection.workflow === item.node.id ? selection.feature : null });
                    handleDecision(item.node, item.action);
                }, { id: `run-decision-${item.node.key}-${item.runKey}` })
                : roleButton('Inspect checkpoint', () => {
                    Object.assign(selection, { workflow: item.node.id, run: item.runKey, feature: null });
                    render();
                    document.getElementById('run-details-heading')?.focus();
                }, { id: `run-decision-${item.node.key}-${item.runKey}` })))) : p('No waiting decisions in the visible run records.'));
    const content = [el('div', { class: 'workflow-heading' },
        el('div', {}, el('h2', {}, 'Workflow & runs'), p('See what ran, what is waiting, and the evidence behind the next decision.')),
        button('Refresh runs', refresh, { id: 'run-refresh' })), section];
    if (!selected) {
        root.replaceChildren(...content, p('No installed workflows were found in this repository.'));
        return;
    }
    const nativeRuns = selected.nativeRuns ?? [];
    const options = [['definition', 'Current definition'], ...nativeRuns.map(run => [`native:${run.id}`, `${run.id} · ${statuses[run.status]}`]),
        ...(selected.guidedRun ? [['guided', 'Canvas guided run']] : []),
        ...(selected.isolatedRun ? [['isolated', 'Canvas isolated review']] : [])];
    const key = options.some(([id]) => id === selection.run) ? selection.run
        : selected.guidedRun ? 'guided' : selected.isolatedRun ? 'isolated' : options[1]?.[0] ?? 'definition';
    const native = nativeRuns.find(run => key === `native:${run.id}`);
    const issue = graph.findings.filter(item => item.severity === 'blocked' &&
        item.nodeIds.some(id => id === selected.id || byId.get(id)?.workflowOwner === selected.id));
    const resumeCommand = native?.status === 'paused' && cliId.test(native.id)
        ? `specify workflow resume ${native.id}` : null;
    const startCommand = key === 'definition' && selected.active && selected.state !== 'blocked' && !issue.length && cliId.test(selected.key)
        ? `specify workflow run ${selected.key}` : null;
    const run = native ?? (key === 'guided' ? selected.guidedRun : key === 'isolated' ? selected.isolatedRun : null);
    const children = new Map(), incoming = new Map(), readable = new Set(), featureIds = new Set();
    for (const edge of graph.edges) {
        if (edge.kind === 'contains' && byId.get(edge.target)?.workflowOwner === selected.id) {
            if (!children.has(edge.source)) children.set(edge.source, []);
            children.get(edge.source).push(edge);
        }
        if (edge.kind === 'step' && byId.get(edge.target)?.workflowOwner === selected.id) {
            if (!incoming.has(edge.target)) incoming.set(edge.target, []);
            incoming.get(edge.target).push(byId.get(edge.source)?.name ?? edge.source.split(':').at(-1));
        }
        if (edge.kind === 'input' && byId.get(edge.target)?.workflowOwner === selected.id && edge.source.startsWith('feature:')) {
            readable.add(edge.target);
            featureIds.add(edge.source);
        }
    }
    const topSteps = children.get(selected.id) ?? [];
    const gateRecords = new Map([...(selected.reviewGates ?? []), ...(selected.guidedReview ?? []).map(pair => pair.gate)].map(gate => [gate.id, gate]));
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
                    const stepLabel = step.runPurpose === 'acceptance' ? 'Acceptance gate' : step.runPurpose === 'validation' ? 'Validation check'
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
                        step.reviewArtifact && readable.has(step.id) ? roleButton('Read definition evidence…', () => inspectEvidence(step, step.reviewArtifact), { id: `run-evidence-${step.id}` }) : null,
                        gate?.artifact && gate.artifact !== step.reviewArtifact ? p(`Review evidence: ${gate.artifact}`) : null,
                        byId.get(step.subworkflow)?.installed ? button('Inspect subworkflow', () => {
                            changeWorkflow(step.subworkflow);
                            document.getElementById('run-details-heading')?.focus();
                        }) : null,
                        findings(step.id).map(item => el('p', { class: 'run-blocker' }, item.message)),
                        children.has(step.id) ? diagram(step.id) : null);
                })))));
    }

    const switcher = el('nav', { class: 'run-picker', 'aria-label': 'Installed workflows' },
        el('h3', {}, 'Workflows'), workflows.map(node => button(node.name, () => changeWorkflow(node.id),
            { id: `run-pick-${node.key}`, 'aria-pressed': String(node.id === selected.id), class: 'btn btn-quiet' })));
    const recordedEvidence = (result, id) => result?.evidence && el('div', {},
        el('p', { class: 'run-meta' }, result.evidence.path),
        roleButton('Read recorded evidence reference…',
            () => inspectEvidence(byId.get(result.evidence.feature), result.evidence.path, result.evidence), { id }));
    const detail = el('section', { class: 'run-detail', 'aria-labelledby': 'run-details-heading' },
        el('div', { class: 'run-step-title' }, el('h3', { id: 'run-details-heading', tabindex: -1 }, selected.name), run?.status ? tag(run.status) : null),
        el('label', { for: 'run-record-select' }, 'Run record'),
        el('select', { id: 'run-record-select', class: 'search', onchange: event => { selection.run = event.target.value; render(); } },
            options.map(([id, name]) => el('option', { value: id, selected: key === id }, name))),
        run?.step ? p(`Recorded checkpoint: ${run.step}`) : null,
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
                        evidence ? el('p', { class: 'run-meta' }, evidence.path, el('br'), 'SHA-256 ', el('code', {}, evidence.digest)) : null),
                    tag(verdicts[verdict]))))) : null,
        run?.error ? el('p', { role: 'alert' }, run.error) : null,
        native?.updatedAt ? el('p', { class: 'run-meta' }, 'Updated ', el('time', { datetime: native.updatedAt }, new Date(native.updatedAt).toLocaleString())) : null,
        native?.status === 'paused' ? p('This checkpoint belongs to a native Spec Kit run. Inspect it here; resume it through the runtime that owns it.') : null,
        resumeCommand ? el('div', {},
            p('Run this from the repository root in an interactive terminal. Review any prompts there; the canvas does not supply a verdict or run the command.'),
            el('div', { class: 'workflow-actions' }, el('code', {}, resumeCommand),
                copyButton(resumeCommand, 'Copy resume command', { id: 'run-copy-resume' }))) : null,
        startCommand ? el('div', {},
            p('To start a native run, review the workflow and run this command from the repository root in an interactive terminal.'),
            selected.inputs.length ? p(`Declared inputs: ${selected.inputs.join(', ')}. Add --input key=value for each value you need to supply.`) : null,
            el('div', { class: 'workflow-actions' }, el('code', {}, startCommand),
                copyButton(startCommand, 'Copy start command', { id: 'run-copy-start' }))) : null,
        native?.checkpoint?.evidence && !native.steps.some(result => result.id === native.checkpoint.id)
            ? recordedEvidence(native.checkpoint, 'run-checkpoint-evidence') : null,
        native?.steps.length ? el('section', {}, el('h4', {}, 'Recorded step results'),
            native.steps.some(result => result.evidence) ? p('Recorded paths open the current files. Native run records do not preserve the reviewed bytes.') : null,
            el('ul', { class: 'run-lines' },
            native.steps.map(step => el('li', {}, el('div', {}, el('code', {}, step.id),
                step.gate ? el('p', { class: 'run-meta' }, ['Human review gate', verdicts[step.verdict]].filter(Boolean).join(' · ')) : null,
                recordedEvidence(step, `run-recorded-evidence-${step.id}`)),
                tag(step.status)))),
            native.omittedSteps ? p(`${native.omittedSteps} additional results are available in the native run record.`) : null) : null,
        el('div', { class: 'workflow-actions' },
            button('Inspect configuration', () => openWorkflow(selected.id)),
            requested && selection.feature ? button('Return to linked spec', () => openFeature(selection.feature)) : null,
            [...featureIds].filter(id => id !== `feature:${selection.feature}`).map(id => button(`Spec evidence: ${byId.get(id).name}`, () => openFeature(byId.get(id).key))),
            selected.canRunReview && !selected.isolatedRun?.error && selected.isolatedRun?.status !== 'paused'
                ? button('Start isolated review…', () => start(selected, 'isolated')) : null,
            selected.canRunGuided && !selected.guidedRun?.error && (!selected.guidedRun || ['aborted', 'completed'].includes(selected.guidedRun.status))
                ? button('Start guided run…', () => start(selected, 'guided')) : null),
        issue.length ? el('details', {}, el('summary', {}, `${issue.length} configuration ${issue.length === 1 ? 'blocker' : 'blockers'}`),
            el('ul', {}, issue.map(item => el('li', {}, item.message)))) : null,
        el('h4', {}, 'Step diagram'), p(native ? 'The diagram is the current definition, not a reconstruction of this historical run.' :
            'Branches show what can run; only a saved checkpoint confirms where a run stopped.'),
        topSteps.length ? diagram(selected.id) : p('No steps are available in the repository definition.'));
    root.replaceChildren(...content, el('div', { class: 'run-grid' }, switcher, detail));
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}
