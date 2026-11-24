export function createEcosystemView({ el, api, root, notify, sendResult, openSpec, startSpec, startWork, openWork, openReport }) {
    function button(label, run) {
        return el('button', { class: 'btn btn-quiet', type: 'button', onclick: async event => {
            const control = event.currentTarget;
            control.disabled = true;
            try { await run(); } catch (error) { notify(error.message); }
            finally { control.disabled = false; }
        } }, label);
    }
    function confirm(title, copy, action) {
        return new Promise(resolve => {
            const dialog = el('dialog', { class: 'ecosystem-dialog', 'aria-label': title }, el('h3', {}, title),
                typeof copy === 'string' ? el('p', {}, copy) : copy,
                el('div', { class: 'ecosystem-actions' }, button('Cancel', () => dialog.close()), button(action, () => dialog.close('yes'))));
            dialog.addEventListener('close', () => {
                resolve(dialog.returnValue === 'yes');
                dialog.remove();
            }, { once: true });
            document.body.append(dialog);
            dialog.showModal();
        });
    }
    const q = encodeURIComponent;
    const title = kind => ({ 'business-plan': 'Business plan', epic: 'Epic', idea: 'Idea', bug: 'Bug' })[kind];
    const list = (...rows) => el('ul', { class: 'ecosystem-list' }, rows);
    function render(pane, load) {
        const expectedRoot = root();
        const status = el('p', { role: 'status' }, 'Loading…');
        pane.replaceChildren(status);
        return load().then(nodes => {
            if (root() === expectedRoot && status.parentNode === pane) pane.replaceChildren(...nodes.filter(Boolean));
        }).catch(error => {
            status.setAttribute('role', 'alert');
            status.textContent = error.message;
        });
    }
    async function extensionSetup(item, info, opener) {
        const title = `${item.setup.name} setup`;
        const body = el('div', {}, el('p', { role: 'status' }, 'Reading the installed extension…'));
        const dialog = el('dialog', { class: 'ecosystem-dialog extension-setup', 'aria-label': title },
            el('h3', {}, title), body, el('div', { class: 'ecosystem-actions' }, button('Close setup', () => dialog.close())));
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        document.body.append(dialog);
        dialog.showModal();
        const guard = () => {
            if (!dialog.open || !opener.isConnected || root() !== info.root) throw new Error('The repository or Integrations view changed. Reopen setup.');
        };
        const load = async () => {
            guard();
            const data = await api('/api/integrations/config', { id: item.id });
            guard();
            if (data.root !== info.root) throw new Error('The repository changed. Reopen setup.');
            return data;
        };
        const statusText = { set: 'Set in project file', unset: 'Not set in project file', invalid: 'Invalid in project file',
            unchecked: 'Project value not checked', 'host-only': 'Configure outside Companion; not checked' };
        const needsSetup = files => files.some(file => (file.required && file.present === false) ||
            (file.present && file.fields?.some(field => field.required && ['unset', 'invalid'].includes(field.status))));
        const hookNotes = el('p', { role: 'status' });
        function fileSection(file) {
            const controls = new Map();
            const summary = el('div', {},
                el('p', {}, el('code', {}, file.path), ` · ${file.required ? 'Required file' : 'Optional file'}`,
                    file.present == null ? '' : file.present ? ' · Exists' : ' · Not present'),
                file.description ? el('p', {}, file.description) : null,
                file.template ? el('p', {}, 'Template: ', el('code', {}, file.template), ' in the extension folder.') : null,
                file.templateUnavailable ? el('p', {}, 'The declared template could not be located safely.') : null,
                file.problem || file.reason ? el('p', {}, file.problem || file.reason) : null);
            const section = el('section', { class: 'extension-config-file', 'aria-label': file.name }, summary);
            const form = el('form', { class: 'extension-config-form' });
            const fields = (required, heading) => {
                const entries = file.fields?.filter(field => field.required === required) ?? [];
                if (!entries.length) return null;
                return el('fieldset', {}, el('legend', {}, heading), entries.map(field => {
                    const text = el('small', {}, statusText[field.status], field.description ? ` · ${field.description}` : '');
                    if (!file.canEdit || field.hostOnly) return el('p', {}, el('strong', {}, field.title), ' · ', text);
                    const select = field.choices || field.type === 'boolean';
                    const choices = field.choices ?? ['true', 'false'];
                    const control = select ? el('select', { class: 'search' },
                        el('option', { value: '' }, 'Leave unchanged'),
                        choices.map(value => el('option', { value }, !field.choices ? value === 'true' ? 'Yes' : 'No' : value)))
                        : el('input', { class: 'search', type: field.type === 'string' ? 'text' : 'number',
                            placeholder: 'Leave unchanged', autocomplete: 'off',
                            minlength: field.minLength, maxlength: field.type === 'string' ? field.maxLength ?? 512 : null,
                            min: field.minimum, max: field.maximum, step: field.type === 'integer' ? '1' : field.type === 'number' ? 'any' : null });
                    controls.set(field.key, { control, type: field.type });
                    return el('div', { class: 'extension-config-field' }, el('label', {}, el('strong', {}, field.title), control, text));
                }));
            };
            form.append(...[fields(true, 'Required setup'), fields(false, 'Optional settings')].filter(Boolean));
            if (file.canEdit) {
                const status = el('p', { role: 'alert' });
                const review = el('button', { class: 'btn btn-quiet', type: 'submit' }, 'Review changes');
                form.addEventListener('submit', async event => {
                    event.preventDefault();
                    status.textContent = '';
                    review.disabled = true;
                    try {
                        guard();
                        const changes = Object.fromEntries([...controls].filter(([, { control }]) => control.value !== '')
                            .map(([key, { control, type }]) => [key, type === 'boolean' ? control.value === 'true' :
                                ['number', 'integer'].includes(type) ? control.valueAsNumber : control.value]));
                        const preview = await api('/api/integrations/config/preview', { id: item.id, file: file.name, revision: file.revision, changes });
                        guard();
                        if (preview.root !== info.root) throw new Error('The repository changed. Review setup again.');
                        if (!await confirm('Review extension settings', el('div', {},
                            el('p', {}, `${preview.creates ? 'Create' : 'Update'} `, el('code', {}, preview.path), ' in the selected checkout.'),
                            list(...preview.changes.map(change => el('li', {}, el('strong', {}, change.title), change.replaces ? ' · Replace with ' : ' · Set to ',
                                el('code', {}, JSON.stringify(change.value))))),
                            el('p', {}, 'Saving does not run the extension or change its hooks.')), 'Save settings')) return;
                        guard();
                        await api('/api/integrations/config/save', { token: preview.token });
                        notify(`Saved ${file.name}.`);
                        const current = await load();
                        const refreshed = current.files.find(entry => entry.name === file.name);
                        if (!refreshed) throw new Error('The file is no longer declared. Reopen setup.');
                        const next = fileSection(refreshed);
                        section.replaceWith(next);
                        next.querySelector('button')?.focus();
                        hookNotes.textContent = current.hooks.some(hook => hook.enabled) && needsSetup(current.files) ?
                            'Required project settings are missing or invalid. Check setup before running an enabled hook.' : '';
                    } catch (error) {
                        status.textContent = error.message;
                    } finally {
                        review.disabled = false;
                    }
                });
                form.append(el('p', {}, 'Leave a field blank to keep its current project value. Existing values are not displayed.'), status, review);
            }
            section.append(form);
            return section;
        }
        try {
            const data = await load();
            hookNotes.textContent = data.hooks.some(hook => hook.enabled) && needsSetup(data.files) ?
                'Required project settings are missing or invalid. Check setup before running an enabled hook.' : '';
            body.replaceChildren(
                el('p', {}, data.enabled ? 'Enabled in Spec Kit' : 'Not enabled in Spec Kit', ' · Execution host not checked'),
                !info.localSetup ? el('p', {}, 'Read-only here. Open the owning Copilot session to edit project settings.') : '',
                ...(data.files.length ? data.files.map(fileSection) : [el('p', {},
                    data.problem ?? 'This extension does not declare a project config file. Follow the extension’s setup instructions.')]),
                ...(data.docs ? [el('p', {}, el('a', { href: data.docs, target: '_blank', rel: 'noopener noreferrer' }, 'Extension documentation'))] : []),
                el('h4', {}, 'Hooks'),
                data.hooks.length ? list(...data.hooks.map(hook => el('li', {}, el('code', {}, hook.phase),
                    ` · ${hook.enabled} enabled, ${hook.disabled} disabled in project`))) :
                    el('p', {}, data.known ? 'No configured hook bindings found for this extension.' : 'Project hook bindings could not be checked.'),
                hookNotes);
        } catch (error) {
            body.replaceChildren(el('p', { role: 'alert' }, error.message));
        }
    }
    function integrations(pane) {
        render(pane, async () => {
            const [info, engine] = await Promise.all([api('/api/integrations'), api('/api/workflow-runs')]);
            if (info.root !== root() || engine.root !== info.root) throw new Error('The repository changed. Reopen Integrations.');
            const setup = async id => {
                if (root() !== info.root) throw new Error('The repository changed. Reopen Integrations.');
                const request = await api('/api/integrations/preview', { id });
                if (!await confirm('Review setup', `${info.root}\n\n${request.changes}`, 'Apply setup')) return;
                if (root() !== info.root) throw new Error('The repository changed. Review setup again.');
                const result = await api('/api/integrations/setup', { token: request.token });
                integrations(pane);
                notify(result.outcome);
            };
            const actions = [button('Ask Copilot about setup', async () => sendResult(await api('/api/integrations/assist', {}), 'the setup request'))];
            if (info.localSetup && !info.cli) actions.unshift(button('Set up CLI in this repository', () => setup('cli')));
            if (info.localSetup && info.cli && info.canInitialize) {
                if (info.offersBashInit) actions.unshift(button('Initialize with Bash scripts', () => setup('init:bash')));
                actions.unshift(button('Initialize Spec Kit for Copilot', () => setup('init')));
            }
            if (info.localSetup && info.cli && info.provider === 'copilot') {
                for (const [id, label] of [['companion', 'Install Companion'], ['bug', 'Install Bugs'], ['assess', 'Install Ideas'],
                    ['github', 'Install GitHub delivery']]) {
                    if (!info.packages[0].installed.some(item => item.id === id)) actions.push(button(label, () => setup(id)));
                }
                for (const item of info.firstParty) {
                    if (!info.packages.find(group => group.kind === item.kind).installed.some(pkg => item.id === `${item.kind}:${pkg.id}`)) {
                        actions.push(button(`Install ${item.name}`, () => setup(item.id)));
                    }
                }
            }
            const resolved = el('div', { class: 'ecosystem-resolved' });
            const catalogSources = el('div', { class: 'ecosystem-resolved', role: 'region', 'aria-label': 'Catalog sources' });
            const showCatalogs = () => render(catalogSources, async () => {
                if (root() !== info.root) throw new Error('The repository changed. Reopen Integrations.');
                const result = await api('/api/integrations/catalogs', {});
                if (result.root !== info.root) throw new Error('The repository changed. Reopen Integrations.');
                const labels = { extension: 'Extensions', preset: 'Presets', workflow: 'Workflows', bundle: 'Bundles' };
                return result.catalogs.map(group => el('details', { open: group.kind === 'extension' || group.unavailable === true },
                    el('summary', {}, labels[group.kind]),
                    group.unavailable ? el('p', { role: 'alert' }, 'Spec Kit could not read these sources. Check the catalog configuration in the owning session.') :
                        group.sources.length ? list(...group.sources.map(source => el('li', {},
                            el('strong', {}, source.name), ` · ${source.installAllowed ? 'Install allowed by Spec Kit' : 'Discovery only'}`,
                            el('p', {}, `Priority ${source.priority} · ${source.location}`)))) : el('p', {}, 'No sources configured.')));
            });
            const inspect = async () => {
                if (root() !== info.root) throw new Error('The repository changed. Reopen Integrations.');
                resolved.replaceChildren(el('p', { role: 'status' }, 'Resolving artifacts with Spec Kit…'));
                try {
                    const result = await api('/api/integrations/artifacts', {});
                    if (root() !== info.root || result.root !== info.root) return;
                    resolved.replaceChildren(...[
                        ['command', 'Commands and overlays'], ['template', 'Templates'], ['hook', 'Configured hooks'],
                    ].map(([kind, label]) => {
                        const rows = result.artifacts.filter(row => row.kind === kind);
                        return el('details', { open: kind === 'hook' },
                            el('summary', {}, `${label} (${rows.length})`),
                            list(...rows.map(row => el('li', {}, el('strong', {}, row.name),
                                kind === 'hook' ? ` · ${row.registered ? 'Enabled in Spec Kit' : 'Not enabled in Spec Kit'}` : null,
                                list(...row.layers.map(layer => el('li', {},
                                    `${layer.source} · ${kind === 'hook' ? (layer.active ? 'Enabled' : 'Not enabled') : (layer.active ? 'Applied' : 'Not applied')} · ${kind === 'hook' ? (layer.optional ? 'Optional' : 'Required') : layer.strategy}`,
                                    layer.path ? el('p', {}, el('code', {}, layer.path)) : null)))))));
                    }));
                } catch (error) {
                    resolved.replaceChildren(el('p', { role: 'alert' }, error.message));
                }
            };
            const installed = info.packages.find(group => group.kind === 'extension').installed;
            const packageLabel = item => `${item.id}${item.version ? ` ${item.version}` : ''}`;
            const extensionRow = item => {
                const name = item.setup.name === item.id ? packageLabel(item) : `${item.setup.name} · ${packageLabel(item)}`;
                const action = !info.localSetup && item.setup.mode === 'configure' ? 'View setup' :
                    { configure: 'Configure', view: 'View setup', manual: 'Manual setup' }[item.setup.mode];
                const control = button(action, () => extensionSetup(item, info, control));
                control.setAttribute('aria-label', `${action}: ${item.setup.name}`);
                return el('li', { class: 'extension-setup-row' }, el('div', {},
                    el('strong', {}, name), el('small', {}, item.enabled ? 'Enabled in Spec Kit' : 'Not enabled in Spec Kit',
                        item.priority == null ? '' : ` · Priority ${item.priority}`)), control);
            };
            return [
                el('h3', {}, 'Spec Kit integrations'),
                el('p', {}, `Compatibility baseline: ${info.baseline}. ${info.cli ? `Local CLI found; active integration: ${info.provider ?? 'not configured'}.` : 'No CLI found in .venv.'}`),
                el('div', { class: 'ecosystem-actions' }, actions),
                info.localSetup && info.cli && info.provider === 'copilot' && !info.hasBashPrerequisites ?
                    el('p', {}, 'Data Model Diagram requires a Spec Kit project initialized with Bash scripts.') : null,
                el('h4', {}, 'Installed packages'),
                installed.length ? list(...installed.map(extensionRow)) : el('p', {}, 'No extensions registered.'),
                list(...info.packages.filter(group => group.kind !== 'extension').map(group => el('li', {}, `${group.kind}: ${group.installed.map(item =>
                    `${packageLabel(item)}${item.enabled ? '' : ' (disabled)'}${item.priority === null || item.priority === undefined ? '' : ` · priority ${item.priority}`}`).join(', ') || 'None'}`))),
                el('h4', {}, 'Resolved Spec Kit artifacts'),
                el('p', {}, 'Inspect the command layers, template sources and hook bindings Spec Kit resolves for this checkout. This does not run a hook or predict what a chat session will execute.'),
                info.localSetup && info.cli ? button('Inspect resolved artifacts', inspect) : el('p', {}, 'Requires a repository-local Spec Kit CLI in the owning session.'),
                resolved,
                el('h4', {}, 'Catalog sources'),
                el('p', {}, 'See where Spec Kit looks for packages, in precedence order. This does not fetch catalog entries or authorize an install.'),
                info.localSetup && info.cli ? button('Inspect catalog sources', showCatalogs) : el('p', {}, 'Requires the repository-local Spec Kit installation in the owning session.'),
                catalogSources,
                el('h4', {}, 'Spec Kit engine runs'),
                button('Refresh integrations and runs', () => integrations(pane)),
                engine.runs.length ? runList(engine.runs, { terminalAvailable: engine.terminalAvailable }) : el('p', {}, 'No persisted workflow runs.'),
                el('h4', {}, 'Curated candidates'),
                el('p', {}, 'Registration does not verify runtime behavior. Only reviewed packages can be installed here, from the repository’s owning Copilot session.'),
                list(...info.catalog.map(item => el('li', {},
                    el('a', { href: item.source, target: '_blank', rel: 'noopener noreferrer' }, item.name),
                    ` ${item.version} · ${item.area}${item.installed ? ' · Installed' : ''}`, el('p', {}, item.effect),
                    el('small', {}, item.certification),
                    item.declaredHooks?.length ? el('p', {}, `Declared hooks: ${item.declaredHooks.join(', ')}. Inspect resolved artifacts for configured bindings.`) : null,
                    item.setupBlocked ? el('p', {}, item.setupBlocked) : null,
                    item.setupAvailable && info.localSetup && info.cli && info.provider === 'copilot' ?
                        el('div', { class: 'ecosystem-actions' }, button(`Install ${item.name}`, () => setup(item.id))) : null,
                    item.presetSetup && info.localSetup && info.cli && info.provider === 'copilot' ?
                        el('div', { class: 'ecosystem-actions' }, button(`Install ${item.presetSetup.name}`, () => setup(item.presetSetup.id))) : null))),
            ];
        });
    }
    function linkedWork(detail = null, selectedId) {
        const pane = el('section', { class: 'ecosystem-panel' });
        const expected = root();
        render(pane, async () => {
            const data = await api('/api/work');
            const guard = run => {
                if (data.root !== root() || data.root !== expected || !pane.isConnected) throw new Error('The repository changed. Reopen Product work.');
                return run();
            };
            const { records, links, specs, updates } = data;
            const current = detail ? links.filter(link => link.spec === detail.spec.id) : [];
            const alreadyLinked = new Set(current.map(link => link.source.id));
            const picker = el('select', { class: 'search', 'aria-label': 'Choose work to link' }, el('option', { value: '' }, 'Choose a work record'),
                records.filter(record => !alreadyLinked.has(record.id)).map(record => el('option', { value: record.id }, record.title)));
            const sourceButton = source => button(`${title(source.kind)}: ${source.title}`, () => guard(() =>
                ['bug', 'idea'].includes(source.kind) ? openReport(`${source.kind}s`, source.id) : openWork(source.id)));
            if (detail) return [
                el('h3', {}, 'Linked work'),
                ...(current.length ? current.map(link => sourceButton(link.source)) : [el('p', {}, 'No work is linked to this spec.')]),
                records.some(record => !alreadyLinked.has(record.id)) ? el('div', { class: 'ecosystem-actions' }, picker, button('Link to this spec', async () => guard(async () => {
                    const record = records.find(item => item.id === picker.value);
                    if (!record) throw new Error('Choose a work record first.');
                    await api('/api/work/link', { spec: detail.spec.id, source: { id: record.id, kind: record.kind } });
                    pane.replaceWith(linkedWork(detail));
                }))) : null,
            ];
            const byId = new Map(records.map(record => [record.id, record]));
            const specById = new Map(specs.map(spec => [spec.id, spec]));
            const details = new Map();
            const reveal = id => {
                const entry = details.get(id);
                if (entry) {
                    if (byId.get(id)?.parent && details.has(byId.get(id).parent)) details.get(byId.get(id).parent).open = true;
                    entry.open = true;
                    entry.querySelector('summary').focus();
                }
            };
            const card = (record, children = []) => {
                const destinations = links.filter(link => link.source.id === record.id && link.source.kind === record.kind);
                const changes = updates.filter(update => update.target.id === record.id && update.target.kind === record.kind);
                const parent = byId.get(record.parent);
                const entry = el('details', { class: 'product-record', open: selectedId === record.id || children.some(child => child.id === selectedId) },
                    el('summary', {}, `${title(record.kind)}: ${record.title}`,
                        el('small', { class: 'board-muted' }, children.length ? ` · ${children.length} ${children.length === 1 ? 'epic' : 'epics'}` : ` · ${destinations.length} linked`)),
                    el('div', { class: 'product-record-body' },
                        el('p', { class: 'board-prose' }, record.description),
                        record.outcome ? el('p', { class: 'board-prose' }, `Expected outcome: ${record.outcome}`) : null,
                        record.parent ? el('p', {}, `Business plan: ${parent?.title ?? 'Unavailable'}`) : null,
                        record.dependencies?.length ? el('div', { class: 'ecosystem-actions' }, 'Depends on', record.dependencies.map(id =>
                            byId.has(id) ? button(byId.get(id).title, () => guard(() => reveal(id))) : el('span', {}, 'Unavailable epic'))) : null,
                        el('div', { class: 'ecosystem-actions' },
                            record.kind === 'business-plan' ? button('Draft epic from this plan', () => guard(() => startWork('epic', record.id))) : null,
                            button('Draft linked spec', () => guard(() => startSpec(record)))),
                        destinations.length ? el('section', { class: 'board-subsection' }, el('h4', {}, 'Delivery specs'), el('div', { class: 'ecosystem-actions' },
                            destinations.map(link => specById.has(link.spec) ? button(specById.get(link.spec).title, () => guard(() => openSpec(link.spec)))
                                : el('span', {}, `${link.spec} · not in this checkout`)))) : null,
                        changes.length ? el('section', { class: 'board-subsection' }, el('h4', {}, 'Updates from ideas'), changes.map(update =>
                            el('div', { class: 'product-update' }, sourceButton({ kind: 'idea', ...update.idea }), el('p', { class: 'board-prose' }, update.summary)))) : null,
                        children.length ? el('section', { class: 'board-subsection' }, el('h4', {}, 'Epics'), children.map(child => card(child))) : null));
                details.set(record.id, entry);
                return entry;
            };
            const plans = records.filter(record => record.kind === 'business-plan');
            const epics = records.filter(record => record.kind === 'epic');
            const standalone = epics.filter(epic => !byId.has(epic.parent));
            return [
                el('header', { class: 'board-heading' }, el('div', {}, el('h2', {}, 'Product work'),
                    el('p', {}, 'Follow a business plan through epics to delivery specs. Linked specs keep their own workflow state.')),
                    el('div', { class: 'ecosystem-actions' }, button('New business plan', () => guard(() => startWork('business-plan'))),
                        button('New epic', () => guard(() => startWork('epic'))))),
                el('section', {}, el('h3', {}, 'Business plans'), plans.length
                    ? plans.map(plan => card(plan, epics.filter(epic => epic.parent === plan.id))) : el('p', {}, 'No plans yet. Start with a business plan, then derive an epic.')),
                standalone.length ? el('section', {}, el('h3', {}, 'Standalone epics'), standalone.map(epic => card(epic))) : null,
            ];
        });
        return pane;
    }
    const gateReference = run => ({ run: run.id, step: run.gate, version: run.reviewVersion });
    const evidenceRoles = [
        { id: 'documents', label: 'Documents', icon: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
            empty: 'Add a Markdown document, such as a spec, plan or research note, to this spec folder.' },
        { id: 'diagrams', label: 'Diagrams', icon: 'M9 3h6v5H9z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-4h12v4',
            empty: 'Add a Mermaid diagram to this spec folder or review the available data model generators.' },
        { id: 'design', label: 'Design', icon: 'M3 5h18v14H3z M3 9h18 M7 12h4v4H7z M14 12h3 M14 16h3',
            empty: 'Add a wireflow, SVG or image to this spec folder. Spec Kit Preview can generate a static wireflow.' },
        { id: 'verification', label: 'Verification', icon: 'M5 4h14v16H5z M8 10l2 2 4-4 M8 16h8',
            empty: 'Add a checklist, test report, YAML result or SARIF file to this spec folder.' },
    ];
    const statusLabels = { ready: 'Ready to review', pending: 'Pending review', approved: 'Approved',
        changes: 'Changes requested', stale: 'Review stale', missing: 'Missing', queued: 'Queued' };
    const artifactStatus = (revision, decisions, gate) => {
        const latest = decisions.find(item => gate ?
            item.gate?.run === gate.run && item.gate.step === gate.step : !item.gate);
        if (!latest) return gate ? 'pending' : 'ready';
        if (latest.version !== revision || (gate && latest.gate.version !== gate.version)) return 'stale';
        return latest.decision === 'approve' ? 'approved' : 'changes';
    };
    const evidenceBadge = state => el('span', { class: 'evidence-badge', 'data-state': state }, statusLabels[state]);
    let evidenceId = 0;
    function evidence(detail, run) {
        const pane = el('section', { class: 'ecosystem-panel evidence-workbench' });
        const spec = detail.spec.id;
        const gate = run ? gateReference(run) : undefined;
        const expectedRoot = root();
        const prefix = `evidence-${++evidenceId}`;
        const selection = new Map();
        const queued = new Map();
        let roleId, focusAfter;
        const reload = async () => {
            await render(pane, async () => {
                const [inventory, catalog] = await Promise.all([api(`/api/evidence?id=${q(spec)}`),
                    run ? null : api(`/api/evidence/generators?id=${q(spec)}`).catch(error => ({ error: error.message }))]);
                if (root() !== expectedRoot || inventory.root !== expectedRoot || (catalog?.root && catalog.root !== expectedRoot)) {
                    throw new Error('The repository changed. Reopen Evidence.');
                }
                const groups = new Map(evidenceRoles.map(role => [role.id, inventory.files.filter(file => file.role === role.id)]));
                const preferred = ['spec.md', 'plan.md', 'tasks.md'];
                const safeName = path => path.slice(spec.length + 1);
                groups.get('documents').sort((a, b) => {
                    const order = file => preferred.includes(safeName(file.path)) ? preferred.indexOf(safeName(file.path)) : preferred.length;
                    return order(a) - order(b);
                });
                roleId ??= evidenceRoles.find(role => groups.get(role.id).length)?.id ?? 'documents';
                const surface = el('div', { class: 'evidence-tabpanel', id: `${prefix}-panel`, role: 'tabpanel', tabindex: 0 });
                const generate = run ? null : generationControls(spec, expectedRoot, catalog, queued, async (generator, created) => {
                    roleId = generator.role;
                    selection.set(roleId, generator.output);
                    focusAfter = 'tab';
                    await reload();
                    if (created) notify('Data model SVG created. Review the new artifact in Diagrams.');
                });
                const tabs = evidenceRoles.map(role => {
                    const files = groups.get(role.id);
                    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    icon.setAttribute('viewBox', '0 0 24 24');
                    icon.setAttribute('aria-hidden', 'true');
                    const shape = document.createElementNS(icon.namespaceURI, 'path');
                    shape.setAttribute('d', role.icon);
                    icon.append(shape);
                    return el('button', { type: 'button', role: 'tab', id: `${prefix}-${role.id}`,
                        'aria-controls': surface.id, 'data-role': role.id, onclick: () => selectRole(role.id) },
                    icon, el('span', { class: 'evidence-tab-label' }, role.label),
                    el('span', { class: 'evidence-tab-count' }, files.length ?
                        `${files.length} ${files.length === 1 ? 'file' : 'files'}` : [...queued.values()].some(entry => entry.role === role.id) ? 'Queued' : 'Missing'));
                });
                function selectRole(id) {
                    roleId = id;
                    for (const tab of tabs) {
                        const selected = tab.dataset.role === id;
                        tab.setAttribute('aria-selected', String(selected));
                        tab.tabIndex = selected ? 0 : -1;
                        if (selected) surface.setAttribute('aria-labelledby', tab.id);
                    }
                    const files = groups.get(id);
                    const pending = [...queued].find(([, entry]) => entry.role === id);
                    const role = evidenceRoles.find(role => role.id === id);
                    if (!files.length) {
                        surface.replaceChildren(el('div', { class: 'evidence-empty' },
                            evidenceBadge(pending ? 'queued' : 'missing'),
                            el('h4', {}, pending ? 'Waiting for Copilot output' : `No ${role.label.toLowerCase()} yet`),
                            el('p', {}, pending ? 'Copilot accepted the request. Refresh artifacts after Copilot reports a result.' : role.empty),
                            generate && (id === 'diagrams' || id === 'design') ?
                                button('Find a generator', () => generate.reveal(id)) : null));
                        return;
                    }
                    const pick = files.find(item => item.path === selection.get(id)) ?? files[0];
                    selection.set(id, pick.path);
                    const preview = el('article', { class: 'artifact-preview evidence-sheet' });
                    const picker = files.length > 1 ? el('select', { class: 'search', 'aria-label': 'Choose an artifact' },
                        files.map(item => el('option', { value: item.path },
                            `${safeName(item.path)} · ${statusLabels[artifactStatus(item.revision, item.decisions, gate)]}`))) : null;
                    const show = path => {
                        selection.set(id, path);
                        return render(preview, async () => {
                            const artifact = await api(`/api/artifact?id=${q(spec)}&path=${q(path)}`);
                            if (root() !== expectedRoot || artifact.root !== expectedRoot) {
                                throw new Error('The repository changed. Reopen Evidence.');
                            }
                            const entry = queued.get(path);
                            if (entry && artifact.revision !== entry.previous) {
                                queued.delete(path);
                                generate?.updateStatus();
                            }
                            const status = artifactStatus(artifact.revision, artifact.reviews, gate);
                            const file = files.find(item => item.path === path);
                            Object.assign(file, { revision: artifact.revision, decisions: artifact.reviews });
                            const option = picker && [...picker.options].find(item => item.value === path);
                            if (option) option.textContent = `${safeName(path)} · ${statusLabels[status]}`;
                            const producer = catalog?.contributions?.find(item => item.output === path && !item.reason);
                            return [
                                el('header', { class: 'evidence-doc-header' },
                                    el('div', {}, el('h4', {}, safeName(path)),
                                        el('p', { class: 'evidence-file-meta' }, 'Revision ',
                                            el('code', { title: artifact.revision }, artifact.revision.slice(0, 12)),
                                            producer ? ` · Installed producer available: ${producer.producer}` : null)),
                                    el('div', { class: 'evidence-badges' }, evidenceBadge(status), queued.has(path) ? evidenceBadge('queued') : null)),
                                status === 'stale' ? el('p', { class: 'evidence-notice' }, 'A previous decision does not cover this file or gate revision. Review the current evidence.') : null,
                                artifactVisual(artifact, safeName(path)),
                                artifactReview({ spec, artifact, gate, expectedRoot, preview, refresh: () => show(path) }),
                            ];
                        });
                    };
                    if (picker) {
                        picker.value = pick.path;
                        picker.addEventListener('change', () => show(picker.value));
                    }
                    surface.replaceChildren(picker ? el('label', { class: 'evidence-file-picker' }, 'Artifact', picker) : '',
                        preview, generate && pending && !files.some(file => file.path === pending[0]) ?
                            el('p', { class: 'evidence-notice' }, evidenceBadge('queued'), ` ${safeName(pending[0])} has not appeared yet.`) : '');
                    show(pick.path);
                }
                const tablist = el('div', { class: 'evidence-tabs', role: 'tablist', 'aria-label': 'Evidence categories',
                    onkeydown: event => {
                        const current = tabs.indexOf(event.target);
                        if (current < 0) return;
                        const next = { ArrowRight: (current + 1) % tabs.length, ArrowLeft: (current + tabs.length - 1) % tabs.length,
                            Home: 0, End: tabs.length - 1 }[event.key];
                        if (next === undefined) return;
                        event.preventDefault();
                        tabs[next].focus();
                        selectRole(tabs[next].dataset.role);
                    } }, tabs);
                selectRole(roleId);
                const producers = catalog?.contributions?.filter(item => !item.reason).map(item => item.producer) ?? [];
                return [el('header', { class: 'evidence-heading' }, el('div', {},
                    el('h3', {}, run ? `Evidence for ${run.gate}` : 'Evidence'),
                    el('p', {}, run ? 'Record a decision on the current artifact and gate revisions. This does not resume the engine.' :
                        'Browse spec artifacts and review the exact revision in front of you.'),
                    producers.length ? el('p', { class: 'evidence-file-meta' }, `Installed generators: ${producers.join(', ')}`) : null),
                button('Refresh artifacts', () => { focusAfter = 'refresh'; return reload(); })),
                tablist, surface, generate?.controls];
            });
            if (focusAfter === 'tab') pane.querySelector('[role="tab"][aria-selected="true"]')?.focus();
            if (focusAfter === 'refresh') pane.querySelector('.evidence-heading button')?.focus();
            focusAfter = null;
        };
        reload();
        return pane;
    }

    function generationControls(spec, expectedRoot, catalog, queued, refresh) {
        const summary = el('summary', {}, 'Generate evidence');
        const controls = el('details', { class: 'evidence-generate', open: queued.size > 0 }, summary);
        const entries = catalog?.contributions ?? [];
        const available = [...(catalog?.localGenerator ? [catalog.localGenerator] : []), ...entries];
        const status = el('p', { role: 'status', class: 'evidence-generation-status' });
        const updateStatus = () => {
            status.textContent = queued.size ? 'Request sent to Copilot. Queued, not completed. Refresh artifacts after Copilot reports the result.' : '';
        };
        updateStatus();
        controls.append(el('p', {}, 'Choose a generator, then review its inputs and output. Nothing runs before you confirm.'));
        if (catalog?.error) controls.append(el('p', { role: 'alert' }, `Evidence generators unavailable: ${catalog.error}`));
        for (const generator of available) {
            const local = generator.method === 'local';
            const fidelity = generator.fidelity ? el('select', { class: 'search', 'aria-label': 'Wireflow fidelity' },
                el('option', { value: '' }, 'Choose fidelity'), generator.fidelity.map(value =>
                    el('option', { value }, `${{ low: 'Low', mid: 'Medium', high: 'High' }[value]} fidelity`))) : null;
            const submit = button(`Review ${generator.label} request`, async () => {
                const choice = fidelity?.value;
                if (fidelity && !choice) { fidelity.focus(); throw new Error('Choose a wireflow fidelity first.'); }
                function checkSelection() {
                    if (root() !== expectedRoot || !controls.isConnected || fidelity?.value !== choice) {
                        throw new Error('The selection changed. Review the generation request again.');
                    }
                }
                checkSelection();
                const input = { spec, generator: generator.id, fidelity: choice };
                const request = await api('/api/evidence/generation-preview', input);
                checkSelection();
                const copy = [`Required inputs: ${request.inputs.join(', ')}`, `${request.overwrite ? 'Update' : 'Create'}: ${request.output}`,
                    request.fidelity ? `Fidelity: ${request.fidelity}` : null, `${local ? 'Write to' : 'Send to'}: ${request.target}`, '',
                    local ? 'Companion creates only this SVG. It does not send anything to chat or approve evidence.' :
                        'Copilot receives a request. This does not complete generation, approve evidence or advance the workflow.'].filter(line => line !== null).join('\n');
                if (!await confirm(request.label, copy, local ? 'Create SVG' : 'Send to Copilot')) return;
                checkSelection();
                const result = await api('/api/evidence/generate', { ...input, revision: request.revision });
                if (!local) {
                    queued.set(request.output, { role: generator.role, previous: request.outputRevision });
                    updateStatus();
                }
                await refresh(generator, result.created);
            });
            controls.append(el('section', { class: 'evidence-generator', 'data-role': generator.role, tabindex: -1 },
                el('div', {}, el('h4', {}, generator.label),
                    el('p', {}, local ? 'Companion · Run locally' : `${generator.producer} · ${generator.reason ? 'Chat action unavailable' : 'Installed · Send to Copilot'}`),
                    el('code', {}, generator.output.slice(spec.length + 1))),
                generator.reason ? el('p', {}, generator.reason) : el('div', { class: 'ecosystem-actions' }, fidelity, submit)));
        }
        if (!entries.length) controls.append(el('p', {}, 'To add a chat generator, install a supported evidence extension in Workflow Builder → Integrations.'));
        controls.append(status);
        return { controls, updateStatus, reveal: role => {
            controls.open = true;
            const matches = [...controls.querySelectorAll('.evidence-generator')].filter(row => row.dataset.role === role);
            (matches.find(row => row.querySelector('button')) ?? matches[0] ?? summary).focus();
        } };
    }
    function sourceDisclosure(content, label = 'View source') {
        return el('details', { class: 'evidence-source' }, el('summary', {}, label), el('pre', { tabindex: 0 }, content));
    }

    function artifactVisual(artifact, name) {
        if (artifact.mime) return el('figure', { class: 'evidence-image' },
            el('img', { src: `data:${artifact.mime};base64,${artifact.content}`, alt: `Preview of ${name}` }));
        if (artifact.wireflow) return staticWireflow(artifact);
        if (artifact.kind === 'document') return el('div', { class: 'evidence-document' }, markdownPreview(artifact),
            sourceDisclosure(artifact.content, 'View Markdown source'));
        if (artifact.visualDiagram) return diagramPreview(artifact.visualDiagram, artifact.content);
        if (artifact.kind === 'prototype' || artifact.kind === 'diagram') return el('div', { class: 'evidence-no-preview' },
            el('p', {}, artifact.kind === 'prototype' ? 'Prototype source only. Repository HTML is not executed here.' :
                'This diagram uses syntax outside the static preview. View the original source below.'),
            sourceDisclosure(artifact.content, artifact.kind === 'prototype' ? 'View HTML source' : 'View diagram source'));
        return el('pre', { tabindex: 0, 'aria-label': 'Verification evidence' }, artifact.content);
    }
    const markdownTags = new Set(('a article aside blockquote br button caption code dd details div dl dt em h1 h2 h3 h4 h5 h6 ' +
        'hr kbd li mark ol p pre s section small span strong sub summary sup table tbody td th thead tfoot tr ul').split(' '));
    function markdownPreview(artifact) {
        const template = document.createElement('template');
        template.innerHTML = artifact.markdownHtml;
        const diagrams = new Map(artifact.diagrams.map(item => [item.source, item.model]));
        function project(node) {
            if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
            if (node.nodeType !== Node.ELEMENT_NODE || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
            const tag = node.localName;
            if (tag === 'img') return el('span', { class: 'evidence-inline-image' }, node.getAttribute('alt') || 'Embedded image',
                ' (open image files from Design)');
            if (tag === 'input' && node.getAttribute('type') === 'checkbox') {
                return el('span', { role: 'img', 'aria-label': node.hasAttribute('checked') ? 'Checked' : 'Unchecked' },
                    node.hasAttribute('checked') ? '☑ ' : '☐ ');
            }
            if (!markdownTags.has(tag)) return null;
            if (node.classList.contains('mermaid-container')) {
                const source = node.querySelector('pre.mermaid')?.textContent.trim();
                if (diagrams.has(source)) return diagramPreview(diagrams.get(source), source);
            }
            const props = {};
            for (const attr of ['class', 'scope', 'colspan', 'rowspan', 'start', 'aria-label']) {
                if (node.hasAttribute(attr)) props[attr] = node.getAttribute(attr);
            }
            if (tag === 'details') props.open = node.hasAttribute('open');
            // Rebuild an inert reading view: no navigation, loaded assets, event handlers or source styles.
            return el(tag === 'a' || tag === 'button' ? 'span' : tag, props, [...node.childNodes].map(project));
        }
        return el('div', { class: 'evidence-markdown' }, [...template.content.childNodes].map(project));
    }
    function diagramPreview(model, content) {
        const source = sourceDisclosure(content, 'View diagram source');
        if (model.type !== 'er') {
            const sequence = model.type === 'sequence';
            const label = sequence ? 'Sequence preview' : 'Flowchart preview';
            const connected = new Set(model.links.flatMap(link => [link.from, link.to]));
            const standalone = Object.keys(model.nodes).filter(id => !connected.has(id));
            return el('section', { class: 'evidence-flow', 'aria-label': label },
                el('h5', {}, label),
                sequence ? el('p', {}, 'Participants: ', Object.values(model.nodes).join(', ')) : null,
                el(sequence ? 'ol' : 'ul', { class: 'evidence-flow-links' }, model.links.map(link =>
                    el('li', {}, el('strong', { class: 'evidence-node' }, model.nodes[link.from]),
                        el('span', { class: 'evidence-connector', 'data-line': (sequence && link.arrow.startsWith('--')) || link.arrow === '-.->' ? 'dashed' : 'solid' },
                            el('span', {}, link.label || (sequence ? 'Message' : 'Connects to')), el('span', { 'aria-hidden': 'true' }, link.arrow.endsWith('x') ? '×' : '→')),
                        el('strong', { class: 'evidence-node' }, model.nodes[link.to])))),
                !sequence && standalone.length ? el('p', {}, 'Unconnected nodes: ', standalone.map(id => model.nodes[id]).join(', ')) : null,
                source);
        }
        const { entities, relationships } = model;
        return el('section', { class: 'entity-diagram', 'aria-label': 'Entity relationship preview' },
            el('div', { class: 'entity-grid' }, entities.map(({ name, fields }) => el('section', { class: 'entity-card' },
                el('h5', {}, name), fields.length ? list(...fields.map(field => el('li', {}, field))) : null))),
            relationships.length ? el('ol', { class: 'entity-relations' }, relationships.map(item => el('li', {},
                el('strong', {}, item.from), el('code', {}, ` ${item.cardinality} `), el('strong', {}, item.to), `: ${item.label}`))) : null,
            source);
    }
    const wireflowTags = new Map(Object.entries({
        group: 'div', heading: 'h5', paragraph: 'p', sequence: 'ol', list: 'ul', item: 'li', label: 'span',
        table: 'table', caption: 'caption', 'table-head': 'thead', 'table-body': 'tbody', 'table-foot': 'tfoot',
        row: 'tr', header: 'th', cell: 'td', pre: 'pre', code: 'code', inline: 'span',
    }));
    function staticWireflow({ wireflow, content }) {
        const renderNode = node => {
            if (typeof node === 'string') return node;
            const tag = wireflowTags.get(node.type);
            return tag ? el(tag, node.type === 'label' ? { class: 'wireflow-label' } : {}, node.children.map(renderNode)) : null;
        };
        const fidelity = { low: 'Low', mid: 'Medium', high: 'High' }[wireflow.fidelity];
        return el('section', { class: 'wireflow-preview', 'aria-label': 'Static prototype preview' },
            el('h4', {}, 'Static prototype preview'),
            el('p', {}, `${fidelity} fidelity. Layout and flow only; controls are not interactive.`),
            wireflow.sections.map(section => el('section', {},
                el('h5', { class: 'wireflow-section-title' }, section.id === 'design-surface' ? 'Design layout' : 'Wireflow'),
                el('div', { class: 'wireflow-surface' }, section.children.map(renderNode)))),
            wireflow.truncated ? el('p', {}, 'This preview is shortened. View source for the complete artifact.') : null,
            sourceDisclosure(content, 'View HTML source'));
    }
    function artifactReview({ spec, artifact, gate, expectedRoot, preview, refresh }) {
        const { path, revision, reviews } = artifact;
        const question = el('input', { class: 'search', maxlength: 1200, 'aria-label': 'Optional impact question', placeholder: 'Focus the explanation (optional)' });
        const note = el('textarea', { maxlength: 2000, rows: 3, 'aria-label': 'Review note', placeholder: 'Review note (optional)' });
        const snapshot = el('input', { type: 'checkbox' });
        const comparison = el('div', { class: 'artifact-comparison' });
        const summary = el('summary', {}, 'Review this artifact');
        const checkSelection = () => {
            if (root() !== expectedRoot || !preview.isConnected || !summary.isConnected) {
                throw new Error('The selected artifact changed. Reopen it before reviewing.');
            }
        };
        const decide = async decision => {
            const keepSnapshot = snapshot.checked;
            const savedCopy = keepSnapshot ? '\nA copy of this revision will be retained in this repository.' : '';
            const action = decision === 'approve' ? 'Approve artifact' : 'Request changes';
            if (!await confirm('Record an artifact decision', `${action}\n${path}\nRevision ${revision.slice(0, 12)}${savedCopy}\n\nThis does not satisfy a workflow gate or start work.`, 'Record decision')) return;
            checkSelection();
            await api('/api/artifact/review', { spec, path, version: revision, note: note.value, decision, gate, keepSnapshot, confirmed: true });
            notify('Artifact review recorded.');
            if (preview.isConnected && summary.isConnected) {
                await refresh();
                preview.querySelector('.evidence-decision summary')?.focus();
            }
        };
        return el('footer', { class: 'evidence-review-tools' },
            el('details', { class: 'evidence-decision' }, summary,
                el('p', {}, 'Record a decision on this revision only. This does not advance the Spec Kit workflow.'), note,
                el('label', { class: 'evidence-snapshot' }, snapshot, ' Keep a copy for comparison'),
                el('div', { class: 'ecosystem-actions' }, button('Approve artifact', () => decide('approve')),
                    button('Request changes', () => decide('request-changes')))),
            reviews.length ? el('details', { class: 'evidence-history' },
                el('summary', {}, `Decision history (${reviews.length})`),
                reviewList(reviews, new Map([[path, revision]]), null, item => showComparison(comparison, expectedRoot, spec, item)), comparison) : null,
            el('details', { class: 'evidence-impact' }, el('summary', {}, gate ? 'Explain gate impact in chat' : 'Explain impact in chat'),
                el('p', {}, 'Ask a read-only question about this artifact and the available code revision.'),
                el('div', { class: 'ecosystem-actions' }, question, button('Send impact question', async () => {
                    checkSelection();
                    sendResult(await api('/api/impact', { spec, path, version: revision, question: question.value, gate }), 'the impact question');
                }))));
    }
    function review(detail) {
        const pane = el('section', { class: 'ecosystem-panel evidence-workbench evidence-review' });
        const load = () => render(pane, async () => {
            const spec = detail.spec.id;
            const { root: expectedRoot, runs, reviews, revisions, terminalAvailable } = await api(`/api/workflow-reviews?id=${q(spec)}`);
            if (root() !== expectedRoot) throw new Error('The repository changed. Reopen Review.');
            const comparison = el('div', { class: 'artifact-comparison' });
            const paused = runs.filter(run => run.status === 'paused').length;
            return [el('header', { class: 'evidence-heading' }, el('div', {}, el('h3', {}, 'Review'),
                el('p', {}, 'Artifact decisions do not approve or resume Spec Kit runs.')),
                button('Refresh reviews and runs', async () => { await load(); pane.querySelector('.evidence-heading button')?.focus(); })),
                el('section', { class: 'evidence-review-section' }, el('h4', {}, 'Artifact decisions'),
                    reviews.length ? reviewList(reviews, new Map(revisions), new Map(runs.map(run => [run.id, run.reviewVersion])),
                        item => showComparison(comparison, expectedRoot, spec, item)) : el('p', {}, 'Open Evidence to record a decision on a specific revision.'),
                    comparison),
                el('section', { class: 'evidence-review-section' }, el('h4', {}, 'Spec Kit engine'),
                    el('p', {}, paused ? `${paused} ${paused === 1 ? 'run is' : 'runs are'} paused. Use the owning session’s Spec Kit workflow to continue.` :
                        'Engine state is read from the recorded Spec Kit runs.'),
                    runs.length ? runList(runs, { terminalAvailable, spec, gateEvidence: run => evidence(detail, run) }) :
                        el('p', {}, 'No engine run declares this spec as its target. Other runs appear in Workflow Builder → Integrations.'))];
        });
        load();
        return pane;
    }
    function showComparison(pane, expectedRoot, spec, item) {
        return render(pane, async () => {
            if (root() !== expectedRoot) throw new Error('The repository changed. Reopen the artifact review.');
            const { root: actualRoot, mime, reviewed, current } = await api(`/api/artifact/compare?id=${q(spec)}&path=${q(item.path)}&reviewed=${q(item.version)}`);
            if (actualRoot !== expectedRoot) throw new Error('The repository changed. Reopen the artifact review.');
            const column = (label, copy) => el('section', {},
                el('h5', {}, label, ' ', el('code', { title: copy.revision }, copy.revision.slice(0, 12))),
                mime ? el('img', { src: `data:${mime};base64,${copy.content}`, alt: `${label}: ${item.path.split('/').at(-1)}` }) :
                    el('pre', { tabindex: 0, 'aria-label': `${label} source` }, copy.content));
            return [el('section', { 'aria-label': 'Artifact revision comparison', tabindex: -1 }, el('h4', {}, 'Artifact revision comparison'),
                el('p', {}, item.path), el('div', { class: 'artifact-comparison-columns' }, column('Reviewed revision', reviewed), column('Current revision', current)))];
        }).then(() => pane.querySelector('section')?.focus());
    }
    function reviewList(reviews, versions, gates, compare) {
        return el('ol', { class: 'evidence-ledger' }, reviews.map(item => el('li', {},
            el('div', { class: 'evidence-badges' }, evidenceBadge(item.decision === 'approve' ? 'approved' : 'changes'),
                el('span', {}, item.version === versions.get(item.path) ? 'Current revision' : 'Older or missing revision')),
            el('p', {}, item.path, ' · ', el('code', { title: item.version }, item.version.slice(0, 12)), ' · ',
                el('time', { datetime: item.recordedAt }, new Date(item.recordedAt).toLocaleString())),
            item.gate ? el('p', {}, `Gate: ${item.gate.run} / ${item.gate.step}${gates && gates.get(item.gate.run) !== item.gate.version ? ' · Gate changed or no longer paused' : ''}`) : null,
            item.note ? el('p', {}, item.note) : null,
            compare && item.snapshot && versions.has(item.path) && item.version !== versions.get(item.path) ?
                button(`Compare with current · ${item.version.slice(0, 12)}`, () => compare(item)) : null)));
    }
    function runList(runs, { spec, gateEvidence, terminalAvailable }) {
        const expectedRoot = root();
        return list(...runs.map(run => {
            const paused = run.status === 'paused';
            const review = el('div', { 'aria-label': 'Gate evidence', role: 'region', tabindex: -1 });
            return el('li', {}, el('details', { open: paused },
                el('summary', {}, `${run.workflow} · ${run.status}`),
                el('p', {}, 'Run ', el('code', {}, run.id)),
                run.steps.length ? el('ol', { class: 'ecosystem-steps', 'aria-label': 'Recorded workflow steps' }, run.steps.map(step => {
                    const current = paused && step.id === run.gate && step.status === 'paused';
                    return el('li', { 'aria-current': current ? 'step' : null, 'data-status': step.status },
                        el('span', { class: 'ecosystem-step-marker', 'aria-hidden': 'true' }),
                        el('strong', {}, step.id),
                        el('span', {}, `${current ? 'Paused here' : step.status}${step.choice ? ` · ${step.choice}` : ''}`));
                })) : null,
                paused ? el('section', { class: 'engine-pause', 'aria-label': 'Engine pause' },
                    el('h5', {}, run.gate ? `Paused at ${run.gate}` : 'Run paused'),
                    run.message ? el('p', {}, run.message) : null,
                    run.choices.length ? el('p', {}, 'Engine choices: ', run.choices.map(choice =>
                        el('span', { class: 'engine-choice' }, choice))) : null,
                    el('div', { class: 'ecosystem-actions' },
                        spec && run.reviewVersion ? button('Explain this pause in chat', async () => {
                            if (root() !== expectedRoot) throw new Error('The repository changed. Refresh the workflow runs.');
                            sendResult(await api('/api/impact', { spec, gate: gateReference(run), expectedRoot }), 'the pause explanation');
                        }) : null,
                        gateEvidence && run.reviewVersion ? button('Review gate evidence', () => {
                            if (!review.firstElementChild) review.append(gateEvidence(run));
                            review.focus();
                        }) : null,
                        terminalAvailable ? button('Open terminal to review run', async () => {
                            if (root() !== expectedRoot) throw new Error('The repository changed. Refresh the workflow runs.');
                            await api('/api/terminal', {});
                            notify('Terminal opened. No workflow command was sent.');
                        }) : el('span', {}, 'Review this run in the session that owns its repository.')),
                    gateEvidence && run.reviewVersion ? review : null) : null));
        }));
    }
    return { integrations, linkedWork, evidence, review };
}
