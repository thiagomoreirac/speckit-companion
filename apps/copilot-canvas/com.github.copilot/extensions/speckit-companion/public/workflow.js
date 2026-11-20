import { renderWorkflowRuns } from '/workflow-runs.js';

const statusNames = { valid: 'Valid', advisory: 'Advisory', confirm: 'Needs confirmation', blocked: 'Blocked' };
const badge = status => statusNames[status] ?? status;
const human = value => String(value ?? 'Not recorded').replaceAll('-', ' ');
const codeList = values => (values ?? []).join(', ') || 'None declared';
const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attributes = {}, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text) node.textContent = text;
    return node;
}

async function drawWireframe(text, canvas) {
    // Decode in SVG image mode off-DOM; the dialog receives pixels, never SVG elements.
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    await image.decode();
    const ratio = Math.min(1, 1800 / image.naturalWidth, 1800 / image.naturalHeight);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('The image has no drawable area.');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.hidden = false;
}

function dependencyPath(graph, id) {
    if (!id) return null;
    const edge = graph.edges.find(item => item.id === id);
    const seeds = edge ? [edge.source, edge.target] : [id];
    const seen = new Set(seeds);
    for (const [from, to] of [['source', 'target'], ['target', 'source']]) {
        const walked = new Set(seeds), queue = [...seeds];
        for (let index = 0; index < queue.length; index++) {
            for (const relation of graph.edges) {
                if (relation.kind === 'reference' || relation.kind === 'contains' || relation[from] !== queue[index] || walked.has(relation[to])) continue;
                walked.add(relation[to]);
                seen.add(relation[to]);
                queue.push(relation[to]);
            }
        }
    }
    return seen;
}

export function setupWorkflow({ el, api, reportSend, copyButton, renderEvidence, openFeature }) {
    const $ = id => document.getElementById(id);
    const canvas = $('workflow-view'), layout = $('layout'), graphSvg = $('workflow-svg'), viewport = $('workflow-viewport');
    const inspector = $('workflow-inspector'), inventory = $('workflow-inventory'), filter = $('workflow-filter');
    const dialog = $('workflow-dialog'), dialogBody = $('workflow-dialog-body'), errorBox = $('workflow-dialog-error');
    const repository = $('repository-form'), repositoryToggle = $('workflow-repository');
    const runs = $('workflow-runs');
    const tabs = { workflow: $('workflow-tab'), management: $('management-tab'), specs: $('specs-tab'), runs: $('runs-tab') };
    const runSelection = { workflow: null, run: null, feature: null };
    const state = { graph: null, snapshot: null, selected: null, view: 'specs', changedView: false, text: false,
        management: 'Extensions', filter: '', world: { width: 1240, height: 610 }, camera: null, request: 0, workflowDirty: false };

    const button = (text, action, attrs = {}) => el('button', { type: 'button', class: 'btn', text, onclick: action, ...attrs });
    const actions = (...buttons) => el('div', { class: 'workflow-actions' }, buttons);
    const heading = label => el('h3', { text: label });
    const paragraph = text => el('p', { text });
    const notice = text => {
        const runSurface = state.view === 'runs' || state.view === 'specs';
        $(runSurface ? 'run-surface-notice' : 'workflow-notice').textContent = text;
    };
    const nodeById = id => state.graph?.nodes.find(item => item.id === id);
    const nodeName = id => nodeById(id)?.name ?? id;
    const edgeName = edge => `${nodeName(edge.source)} → ${nodeName(edge.target)}`;
    const selectOptions = entries => entries.map(([value, name]) => el('option', { value, text: name }));
    const scalarField = (label, input) => {
        const id = `workflow-field-${input.name}`;
        input.id = id;
        return el('div', { class: 'workflow-field' }, el('label', { for: id, text: label }), input);
    };
    const input = (name, props = {}) => el('input', { class: 'search', name, ...props });
    const select = (name, entries) => el('select', { name, class: 'search' }, selectOptions(entries));
    const textarea = (name, props = {}) => el('textarea', { name, rows: 4, ...props });
    const health = value => el('span', { class: 'workflow-health', 'data-health': value, text: badge(value) });

    function drawingEvidence(item) {
        const drawing = el('canvas', { class: 'workflow-drawing', role: 'img', 'aria-label': `Wireframe: ${item.path}`, hidden: true });
        const status = el('p', { role: 'status', text: 'Preparing image preview…' });
        void drawWireframe(item.text, drawing).then(() => { status.hidden = true; }, () => {
            status.textContent = 'This drawing could not be rendered here. Review the referenced file before approving.';
        });
        return [drawing, status];
    }

    function show(view, manual = true) {
        state.changedView ||= manual;
        if (state.view !== view) {
            if (dialog.open) dialog.close();
            $('run-surface-notice').textContent = '';
        }
        state.view = view;
        layout.hidden = view !== 'specs';
        canvas.hidden = view === 'specs' || view === 'runs';
        runs.hidden = view !== 'runs';
        $('new-spec-toggle').hidden = view !== 'specs';
        if (view !== 'specs') {
            $('new-spec').hidden = true;
            $('new-spec-toggle').setAttribute('aria-expanded', 'false');
        }
        repositoryToggle.hidden = view === 'specs';
        repository.hidden = view !== 'specs' && repositoryToggle.getAttribute('aria-expanded') !== 'true';
        for (const [key, tab] of Object.entries(tabs)) tab.setAttribute('aria-pressed', String(view === key));
        if (view === 'specs') return;
        if (view === 'runs' && !state.graph) runs.replaceChildren(el('p', { role: 'status' }, 'Reading workflow runs…'));
        $('workflow-title').textContent = view === 'management' ? 'Spec Kit Management' : 'Spec Kit lifecycle';
        if (state.graph) render();
        if (!state.graph || state.workflowDirty) void reload({ quiet: Boolean(state.graph) });
    }

    async function reload({ quiet = false } = {}) {
        const request = ++state.request;
        state.workflowDirty = false;
        if (!quiet) notice('Reading the repository workflow…');
        try {
            const graph = await api('/api/workflow');
            if (request !== state.request) return;
            state.graph = graph;
            render();
            if (!quiet) notice('');
        } catch (error) {
            if (request === state.request) {
                state.workflowDirty = true;
                notice(`Could not read the workflow: ${error.message}`);
                if (state.view === 'runs') runs.replaceChildren(el('p', { role: 'alert' }, error.message), button('Retry', () => void reload()));
            }
        }
    }

    function update(snapshot) {
        const previous = state.snapshot;
        state.snapshot = snapshot;
        const rootChanged = previous && previous.root !== snapshot.root;
        if (previous && previous.workflowRevision !== snapshot.workflowRevision) state.workflowDirty = true;
        if (rootChanged) {
            ++state.request;
            state.selected = null;
            state.graph = null;
            Object.assign(runSelection, { workflow: null, run: null, feature: null });
            state.camera = null;
            if (dialog.open) dialog.close();
        }
        if (!state.changedView && snapshot.workflowAvailable && state.view !== 'workflow') show('workflow', false);
        else if (state.view !== 'specs' && (rootChanged || !dialog.open &&
            (state.workflowDirty || previous?.generatedAt !== snapshot.generatedAt && state.graph))) {
            void reload({ quiet: !rootChanged });
        }
    }
    dialog.addEventListener('close', () => {
        if (state.workflowDirty && state.view !== 'specs' && !dialog.open) void reload({ quiet: true });
    });

    function visible() {
        const graph = state.graph;
        const term = $('workflow-search').value.toLowerCase().trim();
        const category = state.view === 'management' ? state.management : state.filter;
        const path = $('workflow-path').checked ? dependencyPath(graph, state.selected) : null;
        const match = node => !term || [node.name, node.category, node.state, node.source, node.authority, node.version].some(value => String(value ?? '').toLowerCase().includes(term));
        const nodes = graph.nodes.filter(node => {
            if (path && !path.has(node.id) || !match(node)) return false;
            if (category === 'Versions and sources') return Boolean(node.version) || node.kind === category;
            if (category === 'Hooks') return node.kind === 'Hooks' || node.hooks?.length > 0;
            if (category) return node.kind === category || (category === 'Workflows' && node.kind === 'Workflow overlays');
            return ['Lifecycle', 'Extensions', 'Hooks', 'Workflows', 'Workflow overlays', 'Workflow steps', 'Workflow inputs'].includes(node.kind) || (path?.has(node.id) ?? false);
        });
        const ids = new Set(nodes.map(item => item.id));
        const edges = graph.edges.filter(edge => category === 'Hooks' ? ['hook', 'native-hook', 'embedded-hook'].includes(edge.kind) && ids.has(edge.owner)
            : ids.has(edge.source) && ids.has(edge.target));
        return { nodes, edges };
    }

    function render() {
        const { graph, view } = state;
        if (!graph || view === 'specs') return;
        if (view === 'runs') {
            renderWorkflowRuns({
                root: runs, graph, selection: runSelection, el, button, copyButton, render, openFeature,
                refresh: () => void reload(),
                openWorkflow: id => {
                    state.management = 'Workflows';
                    state.selected = id;
                    show('management');
                },
                handleDecision: (node, kind) => {
                    if (kind === 'guided-write') guidedLabelForm(node, availableGitHubWriters());
                    else reviewGateForm(node, kind === 'guided-review');
                },
                allowGuidedWrite: availableGitHubWriters().length > 0,
                start: startReview,
                inspectEvidence: artifact,
                inspectDecision: decisionEvidence,
            });
            return;
        }
        const all = [['', 'Lifecycle & participants'], ['Lifecycle', 'Lifecycle'], ['Workflow inputs', 'Workflow inputs'], ...graph.management.map(name => [name, name])];
        const options = view === 'management' ? graph.management.map(name => [name, name]) : all;
        filter.replaceChildren(...selectOptions(options));
        filter.value = view === 'management' ? state.management : state.filter;
        const runtime = graph.runtime.version ? `Spec Kit ${graph.runtime.version} recorded in this repository` : 'Spec Kit version not recorded';
        const issues = graph.findings.filter(item => item.severity === 'blocked').length;
        $('workflow-runtime').textContent = `${runtime}${graph.runtime.integration ? ` · ${graph.runtime.integration} integration` : ''}.`;
        const validation = $('workflow-validation');
        const message = `${issues ? `${issues} blocking ${issues === 1 ? 'finding' : 'findings'}` : 'No structural blockers found'}. ` +
            (graph.commandDispatchHold ?? 'Validity does not approve an agent proposal.');
        if (validation.textContent !== message) validation.textContent = message;
        $('workflow-new-spec').hidden = view !== 'workflow';
        $('workflow-new-spec').disabled = Boolean(graph.commandDispatchHold) || !nodeById('stage:specify')?.commands.length;
        const textual = view === 'management' || state.text;
        $('workflow-text-toggle').hidden = view === 'management';
        $('workflow-text-toggle').setAttribute('aria-pressed', String(state.text));
        $('workflow-text-toggle').textContent = state.text ? 'Graph view' : 'Text view';
        $('workflow-graph-tools').hidden = textual;
        viewport.hidden = textual;
        inventory.hidden = !textual;
        const selection = visible();
        if (textual) renderText(selection);
        else renderGraph(selection);
        renderInspector();
    }

    function choose(id) {
        state.selected = id;
        for (const element of canvas.querySelectorAll('[data-workflow-item]')) {
            if (element.dataset.workflowItem === id) element.setAttribute('data-selected', '');
            else element.removeAttribute('data-selected');
        }
        if ($('workflow-path').checked) render();
        else renderInspector();
        if (state.view === 'runs') $('run-details-heading')?.focus({ preventScroll: true });
        else if (state.view !== 'specs') inspector.focus({ preventScroll: true });
        if (window.matchMedia('(max-width: 760px)').matches) inspector.scrollIntoView({ block: 'nearest' });
    }

    function inspectButton(id, label) {
        return button(label, () => choose(id), { class: 'btn btn-quiet', 'data-workflow-item': id, 'aria-label': `Inspect ${label}`, 'data-selected': state.selected === id });
    }

    function table(title, cols, rows) {
        if (!rows.length) return null;
        return el('section', {}, heading(title), el('table', { class: 'workflow-table', 'aria-label': title },
            el('thead', {}, el('tr', {}, cols.map(text => el('th', { scope: 'col', text })))),
            el('tbody', {}, rows.map(row => el('tr', {}, row.map(cell => el('td', {}, cell)))))));
    }

    function renderText({ nodes, edges }) {
        const management = state.view === 'management';
        const main = table('Participants', ['Name', 'Category', 'State', 'Validation'], nodes.map(node =>
            [inspectButton(node.id, node.name), node.category, human(node.state), health(node.healthStatus)]));
        const links = table('Connections and hooks', ['Connection', 'Hook', 'Effect', 'Approval', 'Validation'], edges.map(edge =>
            [inspectButton(edge.id, edgeName(edge)), edge.hook ?? human(edge.kind), human(edge.effect), human(edge.approval), health(edge.status)]));
        const shown = new Set([...nodes.map(item => item.id), ...edges.map(item => item.id)]);
        const findings = state.graph.findings.filter(item => (!item.nodeIds.length && !item.edgeIds.length) || [...item.nodeIds, ...item.edgeIds].some(id => shown.has(id)));
        const content = [
            management && ['Presets', 'Workflows', 'Workflow steps', 'Extensions'].includes(state.management)
               ? actions(button('Register local package…', () => packageForm(null, 'install', state.management)),
                   state.management === 'Workflows' ? button('Register pinned GitHub workflow…', () => remoteWorkflowForm()) : null) : null,
            management && state.management === 'Catalogs' ? actions(button('Register discovery catalog…', () => catalogForm())) : null,
            management && state.management === 'Bundles' ? actions(button('Register local bundle…', () => bundleForm()),
                button('Register pinned GitHub bundle…', () => bundleForm(null, true)),
                /^1\.4\.1(?:\.dev0)?$/.test(state.graph.runtime.version ?? '') ?
                    button('Install core workflow bundle…', () => coreBundleForm()) : null) : null,
            management && state.management === 'Hooks' && !state.graph.runtime.nativeEventOverrideSupported
                ? paragraph('Suppressing all native events from the canvas requires a recorded Spec Kit 1.4.1 Copilot or Claude integration. Lifecycle hook controls are separate.') : null,
            management && state.management === 'Versions and sources' ? actions(button('Record ownership decision…', () => ownershipForm())) : null,
            main, links, findingGroup(findings),
        ];
        if (!main && !links) content.push(paragraph('No matching entries in the selected repository. Try another category or clear the filter.'));
        inventory.replaceChildren(...content.filter(Boolean));
    }

    function updateCamera() {
        const { x, y, width, height } = state.camera;
        graphSvg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    }

    function fit() {
        state.camera = { x: 0, y: 0, width: state.world.width, height: state.world.height };
        updateCamera();
    }

    function zoom(factor) {
        if (!state.camera) return;
        const camera = state.camera;
        const width = Math.max(260, Math.min(state.world.width * 3, camera.width * factor));
        const height = width * camera.height / camera.width;
        state.camera = { x: camera.x + (camera.width - width) / 2, y: camera.y + (camera.height - height) / 2, width, height };
        updateCamera();
    }

    function interactiveSvg(group, item, label) {
        group.setAttribute('role', 'button');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-label', label);
        group.setAttribute('data-workflow-item', item.id);
        if (state.selected === item.id) group.setAttribute('data-selected', '');
        group.addEventListener('click', () => choose(item.id));
        group.addEventListener('keydown', event => {
            if (['Enter', ' '].includes(event.key)) {
                event.preventDefault();
                choose(item.id);
            }
        });
        return group;
    }

    function renderGraph({ nodes, edges }) {
        const lanes = state.graph.phases.map(([id, title]) => ({ id, title, nodes: nodes.filter(node => node.phase === id) })).filter(lane => lane.nodes.length);
        const width = 216, stepX = 230, stepY = 58, height = 46, offsetY = 52;
        const world = { width: Math.max(300, lanes.length * stepX + 16), height: Math.max(300, Math.max(0, ...lanes.map(lane => lane.nodes.length)) * stepY + offsetY + 10) };
        const reframe = !state.camera || world.width !== state.world.width || world.height !== state.world.height;
        state.world = world;
        const positions = new Map(), layers = svg('g');
        const title = svg('title', { id: 'workflow-svg-title' }, 'Spec Kit lifecycle and integration map');
        const definitions = svg('defs');
        for (const level of Object.keys(statusNames)) {
            const arrow = svg('marker', { id: `wf-arrow-${level}`, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
            arrow.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'wf-arrow', 'data-health': level }));
            definitions.append(arrow);
        }
        for (const [column, lane] of lanes.entries()) {
            const x = 8 + column * stepX;
            layers.append(svg('rect', { x, y: 8, width: width + 6, height: world.height - 16, rx: 5, class: 'wf-lane' }),
                svg('text', { x: x + 12, y: 32, class: 'wf-lane-label' }, lane.title));
            const ordered = [...lane.nodes].sort((a, b) => Number(b.kind === 'Lifecycle') - Number(a.kind === 'Lifecycle'));
            ordered.forEach((node, index) => positions.set(node.id, { x: x + 3, y: offsetY + index * stepY, column, index }));
        }
        const edgeLayer = svg('g'), nodeLayer = svg('g');
        const offsets = new Map();
        for (const edge of edges) {
            const a = positions.get(edge.source), b = positions.get(edge.target);
            if (!a || !b) continue;
            const pair = [edge.source, edge.target].sort().join('|');
            const offset = (offsets.get(pair) ?? 0) * 5;
            offsets.set(pair, (offsets.get(pair) ?? 0) + 1);
            const sideways = a.column === b.column;
            const ax = sideways ? a.x + width - 18 - offset : a.x + (a.x < b.x ? width : 0);
            const bx = sideways ? b.x + width - 18 - offset : b.x + (a.x < b.x ? 0 : width);
            const ay = a.y + (sideways ? (a.y < b.y ? height : 0) : height / 2 + offset);
            const by = b.y + (sideways ? (a.y < b.y ? 0 : height) : height / 2 + offset);
            const mid = sideways ? ax + 22 : (ax + bx) / 2;
            const d = `M${ax},${ay} C${mid},${ay} ${mid},${by} ${bx},${by}`;
            const group = interactiveSvg(svg('g', { class: 'wf-edge-group', 'data-health': edge.status }), edge, `${edgeName(edge)}, ${edge.hook ?? edge.kind}, ${badge(edge.status)}`);
            group.append(svg('title', {}, `${edgeName(edge)} · ${edge.hook ?? edge.kind} · ${badge(edge.status)}`),
                svg('path', { class: 'wf-edge', d, 'data-kind': edge.kind, 'marker-end': `url(#wf-arrow-${edge.status})` }),
                svg('path', { class: 'wf-edge-hit', d }));
            edgeLayer.append(group);
        }
        const trim = (text, size) => text.length > size ? `${text.slice(0, size - 1)}…` : text;
        for (const node of nodes) {
            const point = positions.get(node.id);
            if (!point) continue;
            const { x, y } = point;
            const summary = `${human(node.state)} · ${badge(node.healthStatus)}`;
            const group = interactiveSvg(svg('g', { class: 'wf-node', 'data-health': node.healthStatus, 'data-state': node.state }), node, `${node.name}, ${node.category}, ${summary}`);
            group.append(svg('title', {}, `${node.name} · ${node.category} · ${summary}`),
                svg('rect', { x, y, width, height, rx: 5 }),
                svg('text', { x: x + 10, y: y + 18, class: 'wf-node-name' }, trim(node.name, 28)),
                svg('text', { x: x + 10, y: y + 35, class: 'wf-node-state' }, trim(summary, 37)));
            nodeLayer.append(group);
        }
        if (!nodes.length) layers.append(svg('text', { x: 16, y: 34, class: 'wf-lane-label' }, 'No matching participants'));
        graphSvg.replaceChildren(title, definitions, layers, edgeLayer, nodeLayer);
        if (reframe && viewport.clientWidth < 640 && world.width > 650) {
            state.camera = { x: 0, y: 0, width: 650, height: world.height };
            updateCamera();
        } else if (reframe) fit();
        else updateCamera();
    }

    function findingGroup(findings) {
        if (!findings.length) return null;
        return el('section', {}, heading('Validation findings'),
            el('ul', {}, findings.map(finding => el('li', { class: 'workflow-finding', 'data-health': finding.severity },
                `${badge(finding.severity)}: ${finding.message}`,
                ...finding.nodeIds.filter(id => nodeById(id) && id !== state.selected).map(id => inspectButton(id, nodeName(id))),
                ...finding.edgeIds.filter(id => id !== state.selected).map(id => {
                    const edge = state.graph.edges.find(item => item.id === id);
                    return edge ? inspectButton(id, edge.hook ?? edge.label) : null;
                })))));
    }

    function facts(entries) {
        return el('dl', {}, entries.flatMap(([label, value]) => value == null ? [] : [el('dt', { text: label }), el('dd', {}, value)]));
    }

    function renderInspector() {
        const node = nodeById(state.selected);
        const edge = state.graph.edges.find(item => item.id === state.selected);
        const selected = node ?? edge;
        const findings = state.graph.findings.filter(item => !selected || [...item.nodeIds, ...item.edgeIds].includes(selected.id));
        const global = selected ? null : findingGroup([...findings.filter(item => item.severity === 'blocked'), ...findings.filter(item => item.severity !== 'blocked')].slice(0, 40));
        if (!selected) {
            inspector.replaceChildren(el('h2', { text: 'Workflow inspector' }), paragraph('Select a participant or connection to inspect its sources, effects, and available actions.'), ...(global ? [global] : []),
                actions(button('Record ownership decision…', () => ownershipForm())));
            return;
        }
        if (edge) {
            inspector.replaceChildren(el('h2', { text: edge.hook ?? edge.label }), paragraph(edgeName(edge)), health(edge.status),
                facts([['Connection', human(edge.kind)], ['Source', inspectButton(edge.source, nodeName(edge.source))], ['Target', inspectButton(edge.target, nodeName(edge.target))],
                    ['Command', edge.command], ['Status', edge.active ? 'Enabled' : 'Inactive or proposed'], ['Effect', human(edge.effect)], ['Approval', human(edge.approval)],
                    ['Order', edge.order == null ? null : `${edge.runOrder == null ? 'Not scheduled' : `Runs #${edge.runOrder}`}${edge.priority == null ? '' : ` · Priority ${edge.priority}`}`],
                    ['Condition', edge.condition], ['Timeout', edge.timeout == null ? null : `${edge.timeout} s`],
                    ['Native configuration', edge.nativeConfiguration === 'replaced' ? 'Replaced on next integration refresh' :
                        edge.nativeConfiguration === 'inherited' ? 'Inherited declaration' : null],
                    ['Execution', edge.background ? 'Background' : null], ['Reads', codeList(edge.reads)],
                    ['Writes', codeList(edge.writes)], ['External systems', codeList(edge.external)], ['Configuration', edge.path]]),
                ...(edge.description ? [paragraph(edge.description)] : []),
                ...(edge.kind === 'hook' ? [actions(
                    button(edge.active ? 'Disable hook…' : 'Enable hook…', () => direct('hook-toggle', edge.id)),
                    button('Remove hook…', () => direct('hook-remove', edge.id)),
                    button('Move earlier…', () => direct('hook-up', edge.id), { disabled: edge.order === 0 }),
                    button('Move later…', () => direct('hook-down', edge.id), { disabled: !state.graph.edges.some(item => item.kind === 'hook' && item.hook === edge.hook && item.order === edge.order + 1) }),
                    button('Change behavior…', () => form('Hook behavior', [
                        scalarField('Behavior', select('behavior', [['optional', 'Optional'], ['required', 'Required']])),
                    ], values => ({ operation: 'hook-behavior', id: edge.id, ...values }))),
                    button('Test hook wiring', () => testHook(edge)),
                    edge.fixtures?.length ? button('Run local fixture…', () => hookFixtureForm(edge)) : null,
                )] : []),
                ...(edge.kind === 'embedded-hook' && edge.editable ? [actions(
                    button('Remove embedded hook…', () => direct('embedded-remove', edge.id)),
                    button('Move earlier…', () => direct('embedded-up', edge.id), { disabled: edge.order === 0 }),
                    button('Move later…', () => direct('embedded-down', edge.id), { disabled: !edge.canMoveLater }),
                )] : []),
                ...(edge.kind === 'native-hook' && edge.nativeLayer === 'extension' && nodeById(edge.owner)?.active ?
                    [actions(button('Disable owning extension…', () => direct('disable', edge.owner)),
                        edge.effect === 'read-only' && nodeById(edge.owner)?.healthStatus !== 'blocked' &&
                        nodeById(`native-events:${state.graph.runtime.integration}`)?.installed &&
                        !state.graph.edges.some(item => item.nativeLayer === 'override' && item.hook === edge.hook && item.command === edge.command) ?
                            button('Add to native override…', () => direct('native-override-add', edge.id)) : null)] : []),
                ...(edge.nativeLayer === 'override' && edge.editable ? [actions(
                    edge.effect === 'read-only' && nodeById(edge.owner)?.healthStatus !== 'blocked' ?
                        button('Configure handler…', () => nativeHookForm(edge)) : null,
                    button('Remove configured handler…', () => direct('native-override-remove', edge.id)),
                    button('Move earlier…', () => direct('native-override-up', edge.id), { disabled: edge.order === 0 }),
                    button('Move later…', () => direct('native-override-down', edge.id), { disabled: !edge.canMoveLater }),
                )] : []),
                ...(findings.length ? [findingGroup(findings)] : []));
            return;
        }
        const stepPackage = node.id.startsWith('step-package:');
        const packageKind = ['Extensions', 'Presets', 'Workflows'].includes(node.kind) || stepPackage;
        const version = node.version ? String(node.version) : null;
        const hasHooks = node.hooks?.length;
        const installed = node.installed;
        const origin = typeof node.origin === 'object' && node.origin ? [node.origin.kind, node.origin.catalog, node.origin.url].filter(Boolean).join(' · ') : node.origin;
        const githubWriters = availableGitHubWriters();
        const workflowOwner = node.workflowOwner && nodeById(node.workflowOwner);
        const canReviewLabel = node.active && node.issueLabelChange && workflowOwner?.active && !workflowOwner.guidedReview && !workflowOwner.hasProjectOverlay &&
            !state.graph.findings.some(item => item.severity === 'blocked' && item.code !== 'unapproved-external-step' &&
                (item.nodeIds.includes(workflowOwner.id) || item.nodeIds.includes(node.id)));
        const commands = node.commands.map(command => el('li', {},
            ['Lifecycle', 'Extensions'].includes(node.kind) && !node.dispatchHandoff ? button(`Preview ${command.name}…`, () => runForm(node, command),
                { disabled: Boolean(state.graph.commandDispatchHold) || !node.active || node.healthStatus === 'blocked' || ['unknown', 'external-write'].includes(node.effect) }) : command.name,
            el('div', {}, el('code', { text: command.invocation ?? command.id })), command.aliases?.length ? `Aliases: ${command.aliases.join(', ')}` : null));
        const selectedPhase = state.graph.phases.find(([key]) => key === node.phase)?.[1];
        const decisions = state.graph.decisions.filter(decision => [decision.primary, decision.secondary].includes(node.key));
        inspector.replaceChildren(el('h2', { text: node.name }), paragraph(`${node.category} · ${human(node.state)}`), health(node.healthStatus),
            ...(node.dispatchHandoff ? [paragraph(node.dispatchHandoff)] : []),
            facts([['Phase', selectedPhase], ['Source', node.source], ['Origin', origin], ['Version', version], ['Requires Spec Kit', node.requirement], ['Priority', node.priority],
                ['Prerequisites', codeList([...(node.prerequisites ?? []), ...(node.requires ?? []).map(nodeName)])],
                ['Authority', node.authority], ['Automation', node.mode], ['Effect', human(node.effect)], ['Approval', human(node.approval)], ['Inputs', codeList(node.inputs)],
                ['Outputs', codeList(node.outputs)], ['Last recorded activity', node.lastRun],
                ['Latest workflow run', node.lastRunId ? `${human(node.lastRunStatus)} · ${node.lastRunId}` : null], ['Current run step', node.lastRunStep],
                ['Isolated canvas run', node.isolatedRun?.id ? `${human(node.isolatedRun.status)} · ${node.isolatedRun.id}` : null],
                ['Isolated run step', node.isolatedRun?.step],
                ['Guided run', node.guidedRun?.status ? guidedStatus(node.guidedRun.status) : null],
                ['Guided run step', node.guidedRun?.step],
                ['Catalog trust', node.installAllowed == null ? null : node.installAllowed ? 'Installation permitted by Spec Kit' : 'Discovery only']]),
            ...(node.note ? [paragraph(node.note)] : []),
            ...(!node.active && node.state === 'proposed' ? [paragraph('Proposed role only. Install a reviewed compatible package to discover its real commands and hooks.')] : []),
            ...(node.kind === 'Workflows' && node.active && !node.canRunReview && !node.canRunGuided && node.healthStatus !== 'blocked' ?
                [paragraph('This workflow cannot run from this canvas. Inspect the composed steps, or use individual canvas actions to review and run supported changes.')] : []),
            ...(node.effect === 'external-write' ? [paragraph('Automatic external writes are blocked. Supported GitHub changes require a separate confirmation for the exact target and field.')] : []),
            ...(findings.length ? [findingGroup(findings)] : []),
            ...(node.artifacts.length ? [heading('Artifacts & provenance'),
                el('ul', {}, node.artifacts.map(path => el('li', {}, button(path, () => artifact(node, path)))))] : []),
            ...(commands.length ? [heading('Commands'), el('ul', {}, commands)] : []),
            ...(hasHooks ? [heading('Attached hooks'), el('ul', {}, node.hooks.map(id => {
                const hook = state.graph.edges.find(item => item.id === id);
                return el('li', {}, inspectButton(id, `${hook.hook} · ${hook.active ? 'Enabled' : 'Disabled'}`));
            }))] : []),
            ...(decisions.length ? [heading('Ownership decisions'), el('ul', {}, decisions.map(item => el('li', {},
                `${item.primary} / ${item.secondary} (${human(item.strategy)}): ${item.rationale} · ${item.owner} · ${item.approval.at}`,
                item.strategy === 'scoped' ? el('div', {}, codeList([item.primaryScope, item.secondaryScope])) : null)))] : []),
            actions(
                node.canMuteNativeEvents ? button('Suppress all native events…', () => direct('native-override-empty', node.id)) : null,
                node.canRestoreNativeInheritance ? button('Restore inherited native events…', () => direct('native-override-restore', node.id)) : null,
                node.kind === 'Workflow inputs' ? button(`Open ${node.category.toLowerCase()}`, () => { state.management = node.category; show('management'); }) : null,
                node.kind === 'Features and specs' && node.id.startsWith('feature:') ? button('Open spec & run history', () => openFeature(node.key)) : null,
                node.kind === 'Workflows' && installed ? button('Inspect composed steps…', () => inspectComposition(node)) : null,
                node.canDisableOverlay ? button('Disable overlay…', () => direct('overlay-disable', node.id)) : null,
                node.canEnableOverlay ? button('Enable review overlay…', () => direct('overlay-enable', node.id)) : null,
                node.kind === 'Workflow overlays' ? button('Remove overlay…', () => direct('overlay-remove', node.id)) : null,
                node.canRunReview && !node.isolatedRun?.error && node.isolatedRun?.status !== 'paused' ? button('Start isolated review…', () => startReview(node)) : null,
                node.canRunReview && node.isolatedRun?.resumable ? button('Decide current gate…', () => reviewGateForm(node)) : null,
                node.canRunGuided && !node.guidedRun?.error && (!node.guidedRun || ['aborted', 'completed'].includes(node.guidedRun.status)) ?
                    button('Start guided run…', () => startReview(node, 'guided')) : null,
                node.canRunGuided && node.guidedRun?.matched && node.guidedRun.status === 'review' ?
                    button('Decide guided gate…', () => reviewGateForm(node, true)) : null,
                node.canRunGuided && node.guidedRun?.matched && node.guidedRun.status === 'write' && githubWriters.length ?
                    button('Review guided issue label…', () => guidedLabelForm(node, githubWriters)) : null,
                ['review', 'write'].includes(node.guidedRun?.status) ? button('End guided run…', () => {
                    openDialog('Preparing preview');
                    void preview({ operation: 'guided-stop', id: node.id, runId: node.guidedRun.id });
                }) : null,
                ...(node.reviewBranching ? [] : node.reviewGates ?? []).map(gate => button(`Configure ${gate.id} gate…`, () => reviewGateConfigForm(node, gate), {
                    disabled: Boolean(node.hasProjectOverlay && !node.reviewOverlay || node.isolatedRun?.error ||
                        node.isolatedRun?.status === 'paused' || ['paused', 'running'].includes(node.lastRunStatus)),
                })),
                githubWriters.includes(node) ? button('Review GitHub change…', () => githubForm(node)) : null,
                canReviewLabel && githubWriters.length ? button('Review issue label…', () => form('Review a manual issue label', [
                    facts([['Issue', node.issueLabelChange.url], ['Label', node.issueLabelChange.label]]),
                    paragraph('This changes the issue only. It does not run this workflow or advance its state.'),
                    scalarField('GitHub integration', select('writer', githubWriters.map(item => [item.id, item.name]))),
                ], values => ({ operation: 'workflow-issue-label', id: node.id, ...values }))) : null,
                packageKind ? (installed ? [
                    !stepPackage ? button(node.active ? 'Disable…' : 'Enable…', () => direct(node.active ? 'disable' : 'enable', node.id)) : null,
                    button('Update or repair from local source…', () => packageForm(node, 'update')),
                    node.kind === 'Workflows' ? button('Replace with pinned GitHub workflow…', () => remoteWorkflowForm(node)) : null,
                    button('Remove…', () => direct('remove', node.id)),
                ] : button('Install from local source…', () => packageForm(node, 'install'))) : null,
                node.kind === 'Presets' && installed && node.healthStatus !== 'blocked' ? button('Change priority…', () => form('Preset priority', [
                    paragraph('Lower priority numbers take precedence in template resolution.'),
                    scalarField('Priority', input('priority', { type: 'number', min: 1, max: 99999, step: 1, required: true, value: node.priority })),
                ], values => ({ operation: 'preset-priority', id: node.id, priority: Number(values.priority) }))) : null,
                node.kind === 'Catalogs' && node.healthStatus !== 'blocked' ? button('Remove catalog…', () => direct('catalog-remove', node.id)) : null,
                node.canBrowsePinnedReleases && node.healthStatus !== 'blocked' ?
                    button(node.category === 'bundle' ? 'Browse pinned bundles…' : 'Browse pinned workflows…', () => browsePinnedReleases(node)) : null,
                node.kind === 'Catalogs' && node.installAllowed ? button('Restrict to discovery…', () => direct('catalog-discovery', node.id)) : null,
                node.kind === 'Catalogs' && node.installAllowed === false && node.healthStatus !== 'blocked' ? button('Allow installations…', () => {
                    openDialog('Preparing catalog trust preview');
                    void preview({ operation: 'catalog-allow-install', id: node.id, url: node.origin });
                }) : null,
                node.kind === 'Bundles' && node.canRemoveRecord ? button('Remove bundle record…', () => direct('bundle-remove-record', node.id)) : null,
                node.kind === 'Bundles' && node.canRemoveBundleWorkflow ? button('Remove bundle and workflow…', () => direct('bundle-remove-workflow', node.id)) : null,
                node.kind === 'Bundles' && node.canRefreshRecord ? button('Refresh from local bundle…', () => bundleForm(node)) : null,
                node.kind === 'Bundles' && node.canRefreshRecord ? button('Refresh from pinned GitHub bundle…', () => bundleForm(node, true)) : null,
                ...(node.configs ?? []).map(config => button(`Configure ${config.name}…`, () => configure(node, config))),
                node.templateOverride ? button('Edit project template override…', () => templateForm(node)) : null,
                node.editableConstitution ? button('Edit constitution…', () => constitutionForm(node)) : null,
                node.editableCharterSource && nodeById('extension:charter')?.healthStatus !== 'blocked' ?
                    button('Review Charter source edit…', () => constitutionForm(node, true)) : null,
                node.roadmapStatus?.entries && node.healthStatus !== 'blocked' ?
                    button('Review roadmap status change…', () => roadmapStatusForm(node)) : null,
                node.wireframeSignoff?.features.length && node.healthStatus !== 'blocked' ?
                    button('Review initial wireframe sign-off…', () => wireframeSignoffForm(node)) : null,
                node.adrRecords?.length && node.healthStatus !== 'blocked' ?
                    button('Review ADR acceptance…', () => adrAcceptanceForm(node)) : null,
                node.approvedProductChanges?.length && node.healthStatus !== 'blocked' ?
                    button('Review approved Product Change…', () => productChangeForm(node, false)) : null,
                node.appliedProductChanges?.length && node.healthStatus !== 'blocked' ?
                    button('Review Product Change archival…', () => productChangeForm(node, true)) : null,
                node.templateOverride === node.source ? button('Remove project template override…', () => direct('template-remove', node.id)) : null,
                hasHooks && installed ? button('Disable all lifecycle hooks…', () => direct('hook-mute-all', node.id)) : null,
                state.graph.edges.some(edge => edge.owner === node.id && edge.nativeLayer === 'override' && edge.editable) && node.kind === 'Extensions' ?
                    button('Remove this extension’s native override handlers…', () => direct('native-override-mute', node.id)) : null,
                node.declaredHooks?.length && node.active ? button('Add declared hook…', () => hookForm(node)) : null,
                node.kind === 'Extensions' ? button('Record ownership decision…', () => ownershipForm(node)) : null,
            ));
        if (node.roadmapStatus?.note) inspector.append(paragraph(node.roadmapStatus.note));
        if (node.wireframeSignoff?.note) inspector.append(paragraph(node.wireframeSignoff.note));
        if (node.adrNote) inspector.append(paragraph(node.adrNote));
        if (node.productNote) inspector.append(paragraph(node.productNote));
        if (node.kind === 'Workflows' && node.active) {
            if (node.hasProjectOverlay && !node.reviewOverlay) inspector.append(paragraph('An enabled project overlay changes this workflow. Only the supported literal review override can be included in an isolated run.'));
            else if (node.canRunGuided) {
                inspector.append(paragraph('Decide each gate in order. When a label follows, confirm that GitHub change separately. The canvas does not start a Spec Kit CLI run.'));
                if (node.guidedRun?.matched && node.guidedRun.status === 'write' && !githubWriters.length) {
                    inspector.append(paragraph('Enable one eligible GitHub integration to preview the issue label.'));
                }
            }
            else if (!node.canRunReview) inspector.append(paragraph('Isolated review supports literal gates and simple branches. For workflows that mix effects, use the lifecycle or integration actions to preview and approve each supported change.'));
            else if (node.isolatedRun?.error) inspector.append(paragraph(node.isolatedRun.error));
            else if (node.isolatedRun?.status === 'paused' && !node.isolatedRun.resumable) inspector.append(paragraph('The definition changed after this run paused. Restore the reviewed definition before recording a verdict.'));
        }
        if (node.guidedRun?.error) inspector.append(paragraph(node.guidedRun.error));
        if (node.guidedRun?.status === 'uncertain') inspector.append(paragraph('Inspect the issue on GitHub before making another change. This guided run will not retry the write.'));
        if (['review', 'write'].includes(node.guidedRun?.status) && !node.guidedRun.matched) {
            inspector.append(paragraph('The installed definition changed. End this guided run before starting a new one.'));
        }
        if (!packageKind && !node.templateOverride && !node.editableCharterSource && !node.canRemoveRecord && !node.canRemoveBundleWorkflow && ['Bundles', 'Workflow steps', 'Templates and schemas', 'Constitution and Charter', 'Commands and skills'].includes(node.kind)) {
            inspector.append(paragraph('Inspect this source here. This item has no verified mutation adapter in the canvas.'));
        }
        if (node.state === 'blocked' || node.state === 'missing' || node.state === 'incompatible') {
            inspector.append(paragraph('Inspect the finding and its source. Repair the registration or select a compatible version before running this participant.'));
        }
    }

    function openDialog(title) {
        $('workflow-dialog-title').textContent = title;
        errorBox.textContent = '';
        dialogBody.replaceChildren();
        if (!dialog.open) dialog.showModal();
    }

    function direct(operation, id) {
        openDialog('Preparing preview');
        void preview({ operation, id });
    }

    function form(title, fields, request) {
        openDialog(title);
        const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Preview' });
        const element = el('form', { onsubmit: async event => {
            event.preventDefault();
            submit.disabled = true;
            try { await preview(request(Object.fromEntries(new FormData(element)), element)); }
            catch (error) { errorBox.textContent = error.message; }
            finally { submit.disabled = false; }
        } }, fields, actions(submit, button('Cancel', () => dialog.close())));
        dialogBody.append(element);
        element.querySelector('input, select, textarea')?.focus();
    }

    function startReview(node, kind = 'isolated') {
        const guided = kind === 'guided';
        const operation = guided ? 'guided-start' : 'workflow-review-start';
        const fields = guided ? node.guidedStartInputs : node.reviewStartInputs;
        if (!fields?.length) return direct(operation, node.id);
        form(`Choose workflow inputs: ${node.name}`, [
            paragraph('Choose the route for this run. The preview shows the first checkpoint before you confirm.'),
            ...fields.map(field => {
                const control = select(field.name, [
                    ...(field.default === null ? [['', 'Choose a value']] : []),
                    ...field.options.map(value => [value, value]),
                ]);
                control.required = true;
                control.value = field.default ?? '';
                if (field.description) {
                    const description = `review-input-${field.name}-help`;
                    control.setAttribute('aria-describedby', description);
                    return el('div', {}, scalarField(field.name, control), el('p', { id: description }, field.description));
                }
                return scalarField(field.name, control);
            }),
        ], inputs => ({ operation, id: node.id, inputs }));
    }

    function packageForm(node, operation, kind = node?.kind) {
        form(`${operation === 'update' ? 'Update' : 'Register'} ${node?.name ?? kind.toLowerCase()}`, [
            paragraph('Use a reviewed package directory inside this repository. Unverified remote packages are not installed from this canvas.'),
            node ? null : scalarField('Package identifier', input('key', { required: true, maxlength: 128 })),
            scalarField('Source directory relative to this repository', input('source', { required: true, maxlength: 300, placeholder: 'packages/my-extension' })),
        ], values => ({ operation, id: node?.id, kind, ...values }));
    }

    function remoteWorkflowForm(node) {
        form(node ? `Replace ${node.name} from GitHub` : 'Register a pinned GitHub workflow', [
            paragraph('Use a standalone public YAML file at a full Git commit. The preview checks the SHA-256 and shows the file before registration. It does not execute the workflow.'),
            node ? null : scalarField('Workflow identifier', input('key', { required: true, maxlength: 64 })),
            scalarField('Pinned raw GitHub URL', input('remoteUrl', { type: 'url', required: true, maxlength: 500 })),
            scalarField('Expected SHA-256', input('sha256', { required: true, pattern: '[a-fA-F0-9]{64}', maxlength: 64 })),
        ], values => ({ operation: node ? 'update' : 'install', id: node?.id, kind: 'Workflows', ...values }));
    }

    function roadmapStatusForm(node) {
        const { entries, statuses } = node.roadmapStatus;
        form('Change an existing roadmap status', [
            paragraph('Review the exact ledger change before saving. Feature status and GitHub are not updated.'),
            scalarField('Roadmap entry', select('entry', [['', 'Choose an entry'], ...entries.map(item => [item.id, `${item.id} — ${item.title} (${item.status})`])])),
            scalarField('New roadmap status', select('status', [['', 'Choose a status'], ...statuses.map(status => [status, status])])),
        ], values => ({ operation: 'roadmap-status', id: node.id, ...values }));
    }

    function wireframeSignoffForm(node) {
        form('Sign off reviewed wireframes', [
            paragraph('Existing SVGs and passing reports are checked without running Wireframe. You make the visual approval decision.'),
            scalarField('Feature', select('feature', node.wireframeSignoff.features.map(item => [item.id, item.name]))),
        ], values => ({ operation: 'wireframe-signoff', id: node.id, ...values }));
    }

    function adrAcceptanceForm(node) {
        form('Accept a proposed ADR', [
            paragraph('Confirm only as the human ratifier of this decision. adrkit must accept the proposal and its review evidence.'),
            scalarField('Decision record', select('record', [['', 'Choose a decision'], ...node.adrRecords.map(item => [item.path, item.path])])),
            scalarField('Human ratifier', input('ratifier', { required: true, maxlength: 120, placeholder: '@handle' })),
        ], values => ({ operation: 'adr-accept', id: node.id, ...values }));
    }

    function productChangeForm(node, archive) {
        const changes = archive ? node.appliedProductChanges : node.approvedProductChanges;
        form(archive ? 'Archive an applied Product Change' : 'Apply an approved Product Change', [
            paragraph(archive ? 'Only an applied change can be archived. Review the destination and the files that will move.' :
                'The Product Change must already record human approval. Preview shows the exact files and which citations need review.'),
            scalarField('Product Change', select('change', [['', 'Choose a change'], ...changes.map(name => [name, name])])),
        ], values => ({ operation: archive ? 'product-archive' : 'product-apply', id: node.id, ...values }));
    }

    function catalogForm() {
        form('Register discovery catalog', [
            paragraph('A new catalog is registered for discovery only. Allowing installation is a separate confirmation for that URL.'),
            scalarField('Catalog kind', select('kind', [['extension', 'Extensions'], ['preset', 'Presets'], ['workflow', 'Workflows'], ['step', 'Workflow steps'], ['bundle', 'Bundles']])),
            scalarField('Name', input('name', { required: true, maxlength: 128 })),
            scalarField('HTTPS catalog URL', input('url', { type: 'url', required: true, maxlength: 1000 })),
        ], values => ({ operation: 'catalog-add', ...values }));
    }

    function browsePinnedReleases(node) {
        const title = `Browse ${node.name}`;
        const bundle = node.category === 'bundle';
        void readDialog(title, () => api('/api/workflow/catalog', { id: node.id }), result => {
            const label = release => `${release.key} · ${release.version}${release.installed ? ` (installed: ${release.installed.version ?? 'unknown'})` : ''}`;
            const releases = result.releases;
            if (!result.installAllowed || !releases.length) {
                dialogBody.replaceChildren(
                    facts([['Catalog source', result.url]]),
                    result.installAllowed ? null : paragraph('This source is discovery-only. To register a release, first review and allow installations in its inspector.'),
                    releases.length ? el('ul', {}, releases.map(release => el('li', { text: label(release) }))) :
                        paragraph(bundle ? 'No pinned bundle.yml or GitHub ZIP releases with a SHA-256 are available. You can also register a reviewed local bundle.yml.' :
                            'No pinned standalone YAML or GitHub ZIP releases with a SHA-256 are available. For other workflows, use a reviewed local directory.'),
                    actions(button('Close', () => dialog.close())));
                return;
            }
            const releaseField = select('selection', [['', 'Choose a release'], ...releases.map(release => [release.selection, label(release)])]);
            releaseField.required = true;
            form(title, [
                facts([['Catalog source', result.url]]),
                paragraph(bundle ? 'Choose an exact release to preview its manifest and record. All components must already be installed independently at the listed versions.' :
                    'Choose an exact release. Preview shows the definition and files before registering or replacing the workflow. No workflow steps run.'),
                scalarField(bundle ? 'Bundle release' : 'Workflow release', releaseField),
            ], ({ selection }) => {
                const release = releases.find(item => item.selection === selection);
                if (!release) throw new Error('Choose a pinned release.');
                if (bundle) return { operation: release.installed ? 'bundle-update-record' : 'bundle-install-record', id: release.installed?.id,
                    key: release.key, catalogId: node.id, selection };
                return { operation: release.installed ? 'update' : 'install', id: release.installed?.id,
                    kind: 'Workflows', key: release.key, catalogId: node.id, selection };
            });
        });
    }

    function guidedStatus(status) {
        return ({ review: 'Waiting for gate verdict', write: 'Waiting for GitHub approval', uncertain: 'GitHub result unknown' })[status] ?? human(status);
    }

    function availableGitHubWriters() {
        return state.graph.nodes.filter(item => ['extension:ghp', 'extension:project'].includes(item.id) &&
            item.active && item.healthStatus !== 'blocked' &&
            !state.graph.decisions.some(decision => decision.secondary === item.key && decision.strategy === 'primary'));
    }

    function guidedLabelForm(node, writers) {
        form('Review the guided issue label', [
            scalarField('GitHub integration', select('writer', writers.map(item => [item.id, item.name]))),
        ], values => ({ operation: 'guided-label', id: node.id, runId: node.guidedRun.id, gate: node.guidedRun.step, ...values }));
    }

    function reviewGateForm(node, guided = false) {
        const run = guided ? node.guidedRun : node.isolatedRun;
        const gates = guided ? node.guidedReview.map(pair => pair.gate) : node.reviewGates;
        const gate = gates.find(item => item.id === run.step);
        form(`Decide ${gate.id}`, [
            paragraph(gate.message),
            gate.artifact ? paragraph(`The preview will show ${gate.artifact} before you confirm the verdict.`) : null,
            scalarField('Verdict', select('verdict', [['', 'Choose a verdict'], ['approve', 'Approve'], ['reject', 'Reject']])),
        ], ({ verdict }) => {
            if (!verdict) throw new Error('Choose a verdict.');
            return { operation: guided ? 'guided-verdict' : 'workflow-review-resume', id: node.id, runId: run.id, gate: gate.id, verdict };
        });
    }

    function nativeHookForm(edge) {
        form(`Configure ${edge.hook} handler`, [
            paragraph('This changes the project override. It does not update the agent’s generated settings.'),
            scalarField('Tool matcher (optional)', input('matcher', { value: edge.condition ?? '', maxlength: 160 })),
            scalarField('Timeout in seconds (optional)', input('timeout', { type: 'number', min: 1, max: 600, step: 1, value: edge.timeout ?? '' })),
        ], ({ matcher, timeout }) => ({ operation: 'native-override-configure', id: edge.id, matcher: matcher.trim(), timeout: timeout ? Number(timeout) : null }));
    }

    function inspectComposition(node) {
        void readDialog(`Composed steps: ${node.name}`, () => api('/api/workflow/composition', { id: node.id }), result => {
            dialogBody.replaceChildren(
                paragraph('Spec Kit resolved these sources in a temporary project. This shows step order and attribution, not workflow validation or approval. No steps or repository plugins ran.'),
                facts([['Sources', codeList(result.sources)]]),
                el('pre', { text: result.text, tabindex: 0 }),
                actions(button('Close', () => dialog.close())));
        });
    }

    function reviewGateConfigForm(node, gate) {
        const message = textarea('message', { required: true, maxlength: 2400 });
        message.value = gate.message;
        const rejection = select('rejection', [['abort', 'Abort the workflow'], ['skip', 'Skip this gate']]);
        rejection.value = gate.rejection;
        const paths = new Set(state.graph.nodes.filter(item => item.id.startsWith('feature:'))
            .flatMap(item => item.artifacts.filter(path => /\.md$/i.test(path))));
        if (gate.artifact) paths.add(gate.artifact);
        const artifact = select('artifact', [['', 'No evidence file'], ...[...paths].sort().map(path => [path, path])]);
        artifact.value = gate.artifact ?? '';
        form(`Configure ${gate.id} gate`, [scalarField('Review message', message), scalarField('On rejection', rejection),
            scalarField('Review evidence', artifact)],
            values => ({ operation: 'workflow-review-configure', id: node.id, gate: gate.id, ...values }));
    }

    function editAssignment(feature, task, agents, previous) {
        assignmentForm(feature, task, agents, previous);
    }

    function addAssignment(feature, tasks, agents) {
        assignmentForm(feature, null, agents, null, tasks);
    }

    function assignmentForm(feature, task, agents, previous, tasks = []) {
        const agent = select('agent', agents.map(item => [item.name, `${item.name} · Claude Code`]));
        if (agents.some(item => item.name === previous?.agent)) agent.value = previous.agent;
        const reason = input('reason', { required: true, maxlength: 240 });
        reason.value = previous?.reason ?? '';
        form(task ? `Edit assignment for ${task}` : 'Assign a task', [
            paragraph('Choose an APM-verified HVE Core profile already deployed in this project. This updates metadata without running the agent.'),
            task ? null : scalarField('Task', select('task', tasks.map(id => [id, id]))),
            scalarField('Agent', agent), scalarField('Reason', reason),
        ], values => ({ operation: task ? 'agent-assignment-edit' : 'agent-assignment-add', id: `feature:${feature}`, feature, task, ...values }));
    }

    function bundleForm(node, remote = false) {
        form(node ? `Refresh ${node.name}` : remote ? 'Register a pinned GitHub bundle' : 'Register a local bundle', [
            paragraph('Use a flat bundle.yml pinned to components already installed independently. No packages are installed or replaced.'),
            ...(remote ? [
                scalarField('Pinned raw GitHub URL', input('remoteUrl', { type: 'url', required: true, maxlength: 500 })),
                scalarField('Expected SHA-256', input('sha256', { required: true, minlength: 64, maxlength: 64, pattern: '[a-fA-F0-9]{64}' })),
            ] : [scalarField('Path to bundle.yml', input('source', { required: true, maxlength: 300, placeholder: 'packages/my-bundle/bundle.yml' }))]),
        ], values => ({ operation: node ? 'bundle-update-record' : 'bundle-install-record', id: node?.id, ...values }));
    }

    function coreBundleForm() {
        form('Install a core workflow bundle', [
            paragraph('Choose a local bundle pinned to one workflow shipped with Spec Kit 1.4.1. The workflow is installed disabled. No other components are installed or replaced.'),
            scalarField('Path to bundle.yml', input('source', { required: true, maxlength: 300, placeholder: 'packages/my-bundle/bundle.yml' })),
        ], values => ({ operation: 'bundle-install-core-workflow', ...values }));
    }

    function githubForm(node) {
        form('Choose a GitHub change', [
            paragraph('Use an existing github.com issue. The canvas reads it using the GitHub CLI account on this host.'),
            scalarField('Issue URL', input('url', { type: 'url', required: true, maxlength: 350 })),
            scalarField('Change', select('action', [['close', 'Close the issue'], ['reopen', 'Reopen the issue'], ['project-status', 'Set its project status']])),
        ], values => ({ operation: 'github-change', id: node.id, ...values }));
    }

    function githubProjectForm(request) {
        void readDialog('Read linked GitHub projects', () => api('/api/workflow/github-target', request), target => {
            if (!target.projects.length) {
                dialogBody.replaceChildren(paragraph('No accessible project linked to this issue exposes a single-select Status field.'),
                    actions(button('Close', () => dialog.close())));
                return;
            }
            const item = select('item', target.projects.map(project => [project.id, `${project.title} — ${project.url}`]));
            const option = select('option', []);
            const update = () => {
                const project = target.projects.find(candidate => candidate.id === item.value);
                option.replaceChildren(...selectOptions(project.options.filter(candidate => candidate.id !== project.current?.option).map(candidate => [candidate.id, candidate.name])));
            };
            item.addEventListener('change', update);
            update();
            option.required = true;
            form('Choose the project status', [
                paragraph(`${target.title} · ${target.url}`),
                scalarField('Linked project', item), scalarField('New status', option),
            ], values => ({ ...request, ...values }));
        });
    }

    function ownershipForm(node) {
        const candidates = state.graph.nodes.filter(item => item.kind === 'Extensions').map(item => [item.key, item.name]);
        const primary = select('primary', candidates);
        if (node) primary.value = node.key;
        const strategy = select('strategy', [['primary', 'Keep only the primary enabled'], ['manual', 'Keep secondary manual or read-only'],
            ['disabled-hook', 'Disable the conflicting hook'], ['scoped', 'Record disjoint local output scopes']]);
        const primaryScope = input('primaryScope', { maxlength: 240 });
        const secondaryScope = input('secondaryScope', { maxlength: 240 });
        const scopeFields = el('div', { hidden: true, class: 'workflow-field' }, [
            scalarField('Primary output directory', primaryScope), scalarField('Secondary output directory', secondaryScope),
        ]);
        strategy.addEventListener('change', () => {
            const scoped = strategy.value === 'scoped';
            scopeFields.hidden = !scoped;
            primaryScope.required = secondaryScope.required = scoped;
        });
        form('Record ownership decision', [
            paragraph('Disable the competing extension or hook first. For disjoint scopes, use existing manifest output declarations for local integrations with no automatic hooks.'),
            scalarField('Primary owner', primary),
            scalarField('Secondary integration', select('secondary', candidates)),
            scalarField('Resolution', strategy), scopeFields,
            scalarField('Accountable owner', input('owner', { required: true, maxlength: 140 })),
            scalarField('Rationale', textarea('rationale', { required: true, maxlength: 800 })),
        ], values => ({ operation: 'record-owner', ...values }));
    }

    function hookForm(node) {
        form('Add a declared hook', [
            paragraph('New hooks start disabled. Enabling a hook runs workflow validation again.'),
            scalarField('Lifecycle point and command', select('hook', node.declaredHooks.map((hook, index) => [index, `${hook.event} · ${hook.command}`]))),
        ], values => {
            const { event, command } = node.declaredHooks[Number(values.hook)];
            return { operation: 'hook-add', id: node.id, event, command };
        });
    }

    function runForm(node, command) {
        const isSpec = node.kind === 'Lifecycle' && command.id === 'specify';
        const previewFidelity = node.previewFidelity && command.id === 'speckit.preview';
        const features = state.graph.nodes.filter(item => item.id.startsWith('feature:')).map(item => [item.key, `${item.name} (${item.key})`]);
        const needsFeature = previewFidelity || node.kind === 'Lifecycle' && !['constitution', 'specify'].includes(command.id);
        const field = select('feature', [['', needsFeature ? 'Select a feature' : 'No feature'], ...features]);
        field.required = needsFeature;
        const artifact = select('artifact', []);
        const updateArtifacts = () => {
            const paths = [...new Set([...(nodeById(`feature:${field.value}`)?.artifacts ?? []), ...node.artifacts])];
            artifact.replaceChildren(...selectOptions([['', 'No specific artifact'], ...paths.map(path => [path, path])]));
        };
        field.addEventListener('change', updateArtifacts);
        updateArtifacts();
        const choices = (state.snapshot?.specify?.choices ?? []).filter(item => item.available && item.id !== 'auto').map(item => [item.id, item.label]);
        const needsIntent = isSpec || (node.kind === 'Lifecycle' && command.id === 'constitution');
        form(command.name, [
            isSpec ? scalarField('Workflow', select('workflow', choices.length ? choices : [['speckit', 'Spec Kit']])) : null,
            !isSpec && command.id !== 'constitution' ? scalarField('Feature', field) : null,
            previewFidelity ? scalarField('Fidelity', select('fidelity', [['low', 'Low'], ['mid', 'Mid'], ['high', 'High']])) : null,
            !previewFidelity && !isSpec && command.id !== 'constitution' ? scalarField('Input artifact', artifact) : null,
            scalarField(isSpec ? 'What should this feature accomplish?' : command.id === 'constitution' ? 'What principles should the constitution express?' :
                previewFidelity ? 'Design focus (optional)' : 'Additional intent (optional)',
                textarea('intent', { required: needsIntent, maxlength: 4000 })),
        ], values => ({ operation: 'run', id: node.id, command: command.id, ...values }));
    }

    async function readDialog(title, request, view) {
        openDialog(title);
        const loading = el('p', { role: 'status', text: 'Loading…' });
        dialogBody.append(loading, actions(button('Close', () => dialog.close())));
        const current = () => dialog.open && dialogBody.contains(loading);
        try {
            const result = await request();
            if (current()) view(result);
        } catch (error) {
            if (current()) {
                errorBox.textContent = error.message;
                dialogBody.replaceChildren(actions(button('Close', () => dialog.close())));
            }
        }
    }

    const params = (id, path) => new URLSearchParams({ id, path });
    const artifact = (node, path, recorded) => readDialog(path, () => recorded?.featureArtifact
        ? api(`/api/spec/evidence?${params(node.key, path)}`)
        : api(`/api/workflow/artifact?${params(node.id, path)}`),
        result => dialogBody.replaceChildren(
            ...(recorded ? [paragraph('Current repository copy of the file referenced in the run record. It may have changed since that checkpoint.')] : []),
            ...(recorded?.featureArtifact ? renderEvidence(result) : [el('pre', { text: result.text, tabindex: 0 })]),
            actions(button('Close', () => dialog.close()))));

    const decisionEvidence = (id, mode, runId, step, path) => readDialog(path,
        () => api(`/api/workflow/decision-evidence?${new URLSearchParams({ id, mode, runId, step })}`),
        result => dialogBody.replaceChildren(
            paragraph(result.matches ? 'The current file matches the version reviewed at this gate.' :
                'The current file differs from the version reviewed at this gate. The run did not save the original contents.'),
            el('pre', { text: result.text, tabindex: 0 }),
            actions(button('Close', () => dialog.close()))));

    function templateForm(node) {
        void readDialog('Read template override', () => api(`/api/workflow/config?${params(node.id, node.templateOverride)}`), result => {
            const text = textarea('text', { rows: 12, maxlength: 24 * 1024, required: true });
            text.value = result.text;
            form(`${result.newFile ? 'Create' : 'Edit'} project template override`, [
                paragraph(result.path), scalarField('Markdown template', text),
            ], values => ({ operation: 'template-save', id: node.id, ...values }));
        });
    }

    function constitutionForm(node, charter = false) {
        const path = charter ? node.editableCharterSource : node.editableConstitution;
        void readDialog(charter ? 'Read Charter source' : 'Read constitution', () => api(`/api/workflow/config?${params(node.id, path)}`), result => {
            const text = textarea('text', { rows: 12, maxlength: 24 * 1024, required: true });
            text.value = result.text;
            form(charter ? 'Edit package Charter rules' : `${result.newFile ? 'Create' : 'Edit'} constitution`, [
                paragraph(result.path), charter ? paragraph('Only this source changes. The composed project constitution stays as it is.') : null,
                scalarField('Constitution Markdown', text),
            ], values => ({ operation: charter ? 'charter-source-save' : 'constitution-save', id: node.id, ...values }));
        });
    }

    function configure(node, config) {
        void readDialog(`Configure ${config.name}`, () => api(`/api/workflow/config?${params(node.id, config.path)}`), result => {
            if (!result.fields.length) {
                dialogBody.replaceChildren(paragraph('This file has no scalar settings supported by the canvas.'), actions(button('Close', () => dialog.close())));
                return;
            }
            const fields = result.fields.map(({ key, value }, index) => {
                const kind = typeof value;
                const control = input(`field-${index}`, { type: kind === 'boolean' ? 'checkbox' : kind === 'number' ? 'number' : 'text', step: 'any', maxlength: 2000, value: kind === 'boolean' ? 'true' : value, required: kind === 'number' });
                if (kind === 'boolean') control.checked = value;
                return scalarField(key, control);
            });
            form(`${result.newFile ? 'Create' : 'Edit'} ${config.name}`, fields, values => ({
                operation: 'configure', id: node.id, path: config.path,
                values: Object.fromEntries(result.fields.map(({ key, value }, index) => [key, typeof value === 'boolean' ? Boolean(values[`field-${index}`]) :
                    typeof value === 'number' ? Number(values[`field-${index}`]) : values[`field-${index}`]])),
            }));
        });
    }

    function hookFixtureForm(edge) {
        openDialog('Run local hook fixture');
        const fixture = select('fixture', edge.fixtures);
        dialogBody.append(paragraph('Git validates a disposable repository created for this test. The workspace, agent and network are not used.'),
            scalarField('Fixture', fixture), actions(button('Run fixture', () => testHook(edge, fixture.value)), button('Cancel', () => dialog.close())));
        fixture.focus();
    }

    function testHook(edge, fixture) {
        void readDialog(`Test ${edge.hook}`, () => api('/api/workflow/test-hook', { id: edge.id, fixture }), result => {
            dialogBody.replaceChildren(result.executed ?
                paragraph(result.fixture.feature === result.fixture.expected ? 'The fixture matched its expected result.' : 'The fixture did not match its expected result.') :
                paragraph('The canvas validated an enabled copy in memory. It did not execute the command, write files, or contact an external service.'),
                ...(result.fixture ? [facts([['Adapter', result.fixture.adapter], ['Branch', result.fixture.branch],
                    ['Feature branch', result.fixture.feature ? 'Yes' : 'No'], ['Spec directory', result.fixture.artifact ?? 'None']])] : []),
                ...(result.findings.length ? [el('ul', {}, result.findings.map(item => el('li', { text: item.message })))] : [paragraph('The fixture passed structural checks.')]),
                actions(button('Close', () => dialog.close())));
        });
    }

    async function preview(request) {
        if (request.operation === 'github-change' && request.action === 'project-status' && !request.item) {
            githubProjectForm(request);
            return;
        }
        const original = $('workflow-dialog-title').textContent;
        errorBox.textContent = '';
        try {
            const result = await api('/api/workflow/preview', request);
            if (!dialog.open || $('workflow-dialog-title').textContent !== original) return;
            openDialog(result.title);
            const changes = ['nodes', 'edges'].flatMap(kind => {
                const diff = result.diff[kind];
                const name = item => item.name ?? item.hook ?? item.label;
                return [
                    ...diff.added.map(item => `Add ${name(item)}`), ...diff.removed.map(item => `Remove ${name(item)}`),
                    ...diff.changed.map(({ before, after }) => {
                        const stateChange = before.state !== after.state ? `${human(before.state)} → ${human(after.state)}` :
                            before.active !== after.active ? (after.active ? 'Enabled' : 'Disabled') :
                            before.nativeConfiguration !== after.nativeConfiguration && after.nativeConfiguration === 'replaced' ?
                                'Replaced on next integration refresh' :
                            before.nativeConfiguration !== after.nativeConfiguration && after.nativeConfiguration === 'inherited' ?
                                'Inherited on next integration refresh' :
                            before.priority !== after.priority ? `Priority ${before.priority} → ${after.priority}` :
                            before.version !== after.version ? `Version ${before.version ?? 'none'} → ${after.version ?? 'none'}` :
                            before.approval !== after.approval ? `${human(before.approval)} → ${human(after.approval)}` : 'Metadata changed';
                        return `${name(after)}: ${stateChange}`;
                    }),
                ];
            });
            dialogBody.replaceChildren(
                ...(result.notes ?? []).map(paragraph),
                ...(result.invocation ? [heading('Generated invocation'), el('pre', { text: result.invocation, tabindex: 0 })] : []),
                facts([['Files or paths', codeList(result.paths)], ['Inputs and instructions', codeList(result.readPaths)], ['Predicted artifacts', codeList(result.artifacts)], ['Affected commands', codeList(result.commands)],
                    ['Affected hooks', codeList(result.hooks)], ['External systems', codeList(result.external)]]),
                ...(result.config ? [heading('Proposed settings'), el('pre', { text: JSON.stringify(result.config, null, 2), tabindex: 0 })] : []),
                ...(result.documentChange ? [
                    heading('Current content'), result.documentChange.before == null ? paragraph('This file does not exist yet.') :
                        el('pre', { text: result.documentChange.before, tabindex: 0 }),
                    heading('Proposed content'), result.documentChange.after == null ? paragraph('Remove this file.') :
                        el('pre', { text: result.documentChange.after, tabindex: 0 }),
                ] : []),
                ...(result.documentChanges ?? []).flatMap(doc => [
                    heading(doc.path), paragraph('Current content'),
                    doc.before == null ? paragraph('This file does not exist yet.') : el('pre', { text: doc.before, tabindex: 0 }),
                    paragraph('Proposed content'),
                    doc.after == null ? paragraph('Remove this file.') : el('pre', { text: doc.after, tabindex: 0 }),
                ]),
                ...(result.productChange ? [
                    heading('Affected citations'),
                    result.productChange.citations.length ? el('ul', {}, result.productChange.citations.map(item =>
                        el('li', { text: `${item.path}: ${item.id} (${item.status})` }))) : paragraph('None reported by ProductShape.'),
                    ...result.productChange.documents.flatMap(doc => [
                        heading(doc.path), paragraph('Current content'),
                        doc.before == null ? paragraph('This file does not exist yet.') : el('pre', { text: doc.before, tabindex: 0 }),
                        paragraph('Proposed content'),
                        doc.after == null ? paragraph('Remove this file.') : el('pre', { text: doc.after, tabindex: 0 }),
                    ]),
                ] : []),
                ...(result.productArchive ? [heading('Archive move'),
                    facts([['From', result.productArchive.from], ['To', result.productArchive.to]]),
                    el('ul', {}, result.productArchive.entries.map(entry => el('li', {
                        text: `${entry.relative}${entry.sha256 ? ` (SHA-256: ${entry.sha256})` : '/'}`,
                    }))),
                ] : []),
                ...(result.localEvidence ? [heading('Wireframe review evidence'), ...result.localEvidence.flatMap(item => [
                    facts([['Source', item.path], ['SHA-256', item.digest]]),
                    ...(item.kind === 'drawing' ? drawingEvidence(item) : [el('pre', { text: item.text, tabindex: 0 })]),
                ])] : []),
                ...(result.packageDefinition ? [
                    facts([['Catalog source', result.packageDefinition.catalog], ['Catalog version', result.packageDefinition.version],
                        ['Remote source', result.packageDefinition.url], ['SHA-256', result.packageDefinition.sha256],
                        ['ZIP entry', result.packageDefinition.archiveEntry], ['Manifest SHA-256', result.packageDefinition.manifestSha256]]),
                    heading('Installed definition'), result.packageDefinition.before == null ? paragraph('No definition is installed at this path.') :
                        el('pre', { text: result.packageDefinition.before, tabindex: 0 }),
                    heading('Reviewed source definition'), el('pre', { text: result.packageDefinition.after, tabindex: 0 }),
                ] : []),
                ...(result.guidedChange ? [heading('Guided run'), facts([
                    ['Run', result.guidedChange.runId],
                    ['Step order', result.guidedChange.steps.length ? codeList(result.guidedChange.steps) : null],
                    ['After confirmation', guidedStatus(result.guidedChange.status)],
                    ['Next checkpoint', result.guidedChange.nextStep],
                ])] : []),
                ...(result.externalChange ? [heading('GitHub change'), facts([
                    ['GitHub CLI account', result.externalChange.account],
                    ['Issue', `${result.externalChange.title} · ${result.externalChange.target}`],
                    ['Project', result.externalChange.project ? `${result.externalChange.projectTitle} · ${result.externalChange.project}` : null],
                    ['Field', result.externalChange.field], ['Current value', result.externalChange.before], ['New value', result.externalChange.after],
                ])] : []),
                ...(result.reviewChange?.startInputs?.length ? [heading('Run inputs'),
                    facts(result.reviewChange.startInputs.map(({ name, value }) => [name, value]))] : []),
                ...(result.reviewChange ? [heading(result.reviewChange.gate ? 'Review gate' : 'Run outcome'),
                    result.reviewChange.message ? paragraph(result.reviewChange.message) : null, facts([
                    ['Run', result.reviewChange.runId], ['Step', result.reviewChange.gate],
                    ['Verdict', result.reviewChange.verdict], ['On rejection', result.reviewChange.rejection],
                    ['Expected after confirmation', result.reviewChange.nextGate ? `Pause at ${result.reviewChange.nextGate}` :
                        result.reviewChange.expected === 'aborted' ? 'Abort the run' : result.reviewChange.expected === 'completed' ? 'Complete the run' : null],
                ]),
                ...(result.reviewChange.artifact ? [heading('Review evidence'),
                    facts([['Source', result.reviewChange.artifact.path], ['SHA-256', result.reviewChange.artifact.digest]]),
                    el('pre', { text: result.reviewChange.artifact.text, tabindex: 0 })] : []),
                ] : []),
                heading('Workflow changes'), changes.length ? el('ul', {}, changes.map(text => el('li', { text }))) : paragraph('No structural changes.'),
                ...(result.advisories?.length ? [heading('New advisories'), el('ul', {}, result.advisories.map(item => el('li', { text: item.message })))] : []),
                ...(result.findings.length ? [heading('Blocking findings'), el('ul', {}, result.findings.map(item => el('li', { text: item.message })))] : []),
                actions(result.ready ? button(request.operation === 'run' ? 'Approve & dispatch' : result.externalChange ? 'Apply GitHub change' : 'Confirm change',
                    event => apply(result.id, event.currentTarget), { class: 'btn btn-primary' }) : null,
                    button(result.ready ? 'Cancel' : 'Close', () => dialog.close())),
            );
            dialogBody.querySelector('button:last-child')?.focus();
        } catch (error) {
            if (!dialog.open) return;
            errorBox.textContent = error.message;
            if (!dialogBody.childElementCount) dialogBody.append(actions(button('Close', () => dialog.close())));
        }
    }

    async function apply(id, control) {
        control.disabled = true;
        errorBox.textContent = '';
        try {
            const result = await api('/api/workflow/apply', { id });
            if (result.prompt && !result.sent) {
                errorBox.textContent = 'The agent transport is unavailable. No command was dispatched.';
                return;
            }
            state.graph = result.graph;
            ++state.request;
            dialog.close();
            render();
            if (result.prompt) await reportSend(result, 'workflow command');
            else notice(result.workflowOutcome ? `Isolated review run: ${human(result.workflowOutcome.status)}.` :
                result.guidedOutcome ? result.externalApplied && result.guidedOutcome === 'review' ?
                    'GitHub confirmed the change. The next gate is ready for review.' : `Guided run: ${guidedStatus(result.guidedOutcome)}.` :
                result.externalApplied ? 'GitHub confirmed the change.' : 'Confirmed change applied. The workflow reflects the latest repository state.');
            inspector.focus({ preventScroll: true });
        } catch (error) {
            errorBox.textContent = error.message;
            void reload({ quiet: true });
        }
    }

    let pointer;
    graphSvg.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('[data-workflow-item]') || !state.camera) return;
        const matrix = graphSvg.getScreenCTM();
        if (!matrix?.a) return;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, scale: matrix.a, camera: state.camera };
        graphSvg.setPointerCapture(event.pointerId);
        graphSvg.setAttribute('data-panning', '');
    });
    graphSvg.addEventListener('pointermove', event => {
        if (pointer?.id !== event.pointerId) return;
        state.camera = { ...pointer.camera, x: pointer.camera.x + (pointer.x - event.clientX) / pointer.scale, y: pointer.camera.y + (pointer.y - event.clientY) / pointer.scale };
        updateCamera();
    });
    graphSvg.addEventListener('lostpointercapture', () => {
        pointer = null;
        graphSvg.removeAttribute('data-panning');
    });
    viewport.addEventListener('keydown', event => {
        if (event.target !== viewport || !state.camera) return;
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!direction) return;
        event.preventDefault();
        state.camera.x += direction[0] * state.camera.width * 0.1;
        state.camera.y += direction[1] * state.camera.height * 0.1;
        updateCamera();
    });

    for (const [view, tab] of Object.entries(tabs)) tab.addEventListener('click', () => show(view));
    repositoryToggle.addEventListener('click', () => {
        repository.hidden = !repository.hidden;
        repositoryToggle.setAttribute('aria-expanded', String(!repository.hidden));
    });
    $('workflow-refresh').addEventListener('click', () => void reload());
    $('workflow-new-spec').addEventListener('click', () => {
        const node = nodeById('stage:specify');
        if (node?.commands[0]) runForm(node, node.commands[0]);
    });
    $('workflow-search').addEventListener('input', () => render());
    $('workflow-path').addEventListener('change', () => render());
    $('workflow-text-toggle').addEventListener('click', () => { state.text = !state.text; render(); });
    $('workflow-fit').addEventListener('click', fit);
    $('workflow-zoom-in').addEventListener('click', () => zoom(0.8));
    $('workflow-zoom-out').addEventListener('click', () => zoom(1.25));
    filter.addEventListener('change', () => {
        state[state.view === 'management' ? 'management' : 'filter'] = filter.value;
        state.camera = null;
        render();
    });
    return {
        show, update, editAssignment, addAssignment,
        importHve(feature) {
            openDialog('Preparing HVE Core import');
            void preview({ operation: 'agent-apm-import', id: `feature:${feature}`, feature });
        },
        hasWorkflow(key) {
            return Boolean(state.graph?.nodes.some(node => node.kind === 'Workflows' && node.key === key && node.installed));
        },
        openRun(key, feature) {
            Object.assign(runSelection, { workflow: `workflow:${key}`, run: null, feature });
            show('runs');
        },
    };
}
