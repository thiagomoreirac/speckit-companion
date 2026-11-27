export function createRoutinesPage({ el, api, root, notify, sendResult }) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const option = (value, label) => el('option', { value }, label);
    const action = (label, run, primary = false) => el('button', {
        type: 'button', class: `btn ${primary ? 'btn-primary' : 'btn-quiet'}`, onclick: run,
    }, label);
    const label = (name, field) => el('label', {}, name, field);
    function external(label, href) {
        return href ? el('a', { class: 'btn btn-quiet', href, target: '_blank', rel: 'noopener noreferrer' }, label) : null;
    }

    async function open(pane, selectedId) {
        const expected = root();
        const progress = el('p', { role: 'status' }, 'Loading routine drafts…');
        pane.replaceChildren(progress);
        try {
            const model = await api('/api/routines');
            if (root() !== expected || model.root !== expected || !progress.isConnected) return;
            const editor = el('div', { class: 'routine-editor' });
            const editorHeading = el('h3', { tabindex: '-1' }, 'Routine details');
            const renderEditor = (draft, focus = false) => {
                editorHeading.textContent = draft ? draft.name : 'New routine';
                const byKind = new Map(model.types.map(type => [type.id, type]));
                const kinds = el('select', { class: 'search' }, model.types.map(type => option(type.id, type.label)));
                const name = el('input', { class: 'search', required: true, maxlength: '80' });
                const target = el('input', { class: 'search', required: true, maxlength: '100', list: 'routine-target-options' });
                const suggestions = el('datalist', { id: 'routine-target-options' });
                const workflows = el('select', { class: 'search' }, option('', 'Choose a workflow'), model.targets.actions.map(file => option(file, file)));
                const targetLabel = label('Exact command, agent, or workflow', target);
                const workflowLabel = label('Workflow file', workflows);
                const targetHelp = el('p', { class: 'board-muted', role: 'status' });
                const instructions = el('textarea', { rows: '3', maxlength: '3000' });
                const rhythm = el('select', { class: 'search' },
                    option('manual', 'Manual'),
                    option('daily', 'Daily'),
                    option('weekly', 'Weekly'),
                    option('event', 'GitHub event'),
                );
                const eventSelect = el('select', { class: 'search' },
                    ...(model.events ?? ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'check_suite', 'workflow_run']).map(ev => option(ev, ev)),
                );
                const eventLabel = label('GitHub event', eventSelect);
                const ownership = el('select', { class: 'search' },
                    option('shared', 'Shared (repository)'),
                    option('personal', 'Personal (user)'),
                );
                const ownershipLabel = label('Ownership', ownership);
                const allowedScopes = new Set(model.autonomyPolicy?.policy?.allowedWriteScopes ?? ['trigger']);
                const writeScope = el('select', { class: 'search' },
                    option('trigger', 'Trigger-scoped (least privilege)'),
                    option('repository', allowedScopes.has('repository') ? 'Repository-wide' : 'Repository-wide (restricted by policy)'),
                );
                const writeScopeLabel = label('Write scope', writeScope);
                const time = el('input', { class: 'search', type: 'time', 'aria-label': 'Schedule time' });
                const day = el('select', { class: 'search' }, weekdays.map((value, i) => option(i, value)));
                const dayLabel = label('Day of week', day);
                const timeLabel = label('Time', time);
                const timezone = el('p', { class: 'board-muted' });
                const status = el('p', { role: 'status' });
                const submit = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save draft');
                const setInputs = () => {
                    const isActions = kinds.value === 'actions';
                    const isCopilot = kinds.value === 'copilot';
                    const supportsEvent = isActions || isCopilot;
                    const eventOption = rhythm.querySelector('option[value="event"]');
                    if (eventOption) eventOption.disabled = !supportsEvent;
                    if (!supportsEvent && rhythm.value === 'event') rhythm.value = 'manual';
                    const available = !isActions || Boolean(model.targets.actions.length);
                    target.placeholder = byKind.get(kinds.value)?.placeholder ?? '';
                    targetLabel.hidden = isActions;
                    target.disabled = isActions;
                    workflowLabel.hidden = !isActions;
                    workflows.required = isActions;
                    workflows.disabled = !isActions;
                    submit.disabled = !available;
                    targetHelp.textContent = available ? '' : 'No GitHub Actions workflow files were found in this checkout.';
                    suggestions.replaceChildren(...(model.targets[kinds.value] ?? []).map(item => option(item, item)));
                    const isTimed = rhythm.value === 'daily' || rhythm.value === 'weekly';
                    timeLabel.hidden = !isTimed;
                    dayLabel.hidden = rhythm.value !== 'weekly';
                    time.required = isTimed;
                    eventLabel.hidden = rhythm.value !== 'event';
                    eventSelect.disabled = rhythm.value !== 'event';
                    ownershipLabel.hidden = !isCopilot;
                    ownership.disabled = !isCopilot;
                    writeScopeLabel.hidden = !isCopilot;
                    writeScope.disabled = !isCopilot;
                    timezone.textContent = rhythm.value === 'event'
                        ? 'Runs on GitHub events with allow_copilot_triggers disabled by default. Companion never enables it automatically.'
                        : ['actions', 'copilot'].includes(kinds.value)
                            ? 'GitHub uses UTC for this draft. Companion does not schedule it.'
                            : 'The Copilot app uses the computer’s local time.';
                };
                kinds.value = draft?.kind ?? model.types[0]?.id;
                name.value = draft?.name ?? '';
                target.value = draft?.action ?? '';
                workflows.value = draft?.kind === 'actions' ? draft.action : '';
                instructions.value = draft?.instructions ?? '';
                rhythm.value = draft?.rhythm ?? 'manual';
                eventSelect.value = draft?.event ?? 'issues';
                ownership.value = draft?.ownership ?? 'shared';
                writeScope.value = draft?.writeScope ?? 'trigger';
                time.value = `${String(draft?.hour ?? 9).padStart(2, '0')}:${String(draft?.minute ?? 0).padStart(2, '0')}`;
                day.value = String(draft?.day ?? 1);
                kinds.addEventListener('change', setInputs);
                rhythm.addEventListener('change', setInputs);
                setInputs();
                const guard = () => {
                    if (root() !== expected || pane.hidden || !status.isConnected) throw new Error('Reopen Routines for the selected repository.');
                };
                const handoff = action('Review setup in chat', async event => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        guard();
                        await sendResult(await api('/api/routines/review', { id: draft.id, revision: draft.revision }), 'the routine draft');
                    } catch (error) {
                        status.textContent = error.message;
                    } finally {
                        button.disabled = false;
                    }
                });
                const archive = draft ? action(draft.archived ? 'Restore draft' : 'Archive draft', async event => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        guard();
                        await api('/api/routines/archive', { id: draft.id, revision: draft.revision, archived: !draft.archived });
                        open(pane, draft.id);
                    } catch (error) {
                        status.textContent = error.message;
                        button.disabled = false;
                    }
                }) : null;
                const form = el('form', { class: 'board-form', onsubmit: async event => {
                    event.preventDefault();
                    if (submit.disabled) return;
                    submit.disabled = true;
                    try {
                        guard();
                        const [hour, minute] = time.value.split(':').map(Number);
                        const payload = {
                            id: draft?.id, revision: draft?.revision, name: name.value,
                            kind: kinds.value, action: kinds.value === 'actions' ? workflows.value : target.value,
                            instructions: instructions.value, rhythm: rhythm.value, hour, minute,
                            day: Number(day.value), archived: draft?.archived ?? false,
                        };
                        if (rhythm.value === 'event') payload.event = eventSelect.value;
                        if (kinds.value === 'copilot') {
                            payload.ownership = ownership.value;
                            payload.writeScope = writeScope.value;
                            if (draft?.blueprintId) payload.blueprintId = draft.blueprintId;
                        }
                        const saved = await api('/api/routines/save', payload);
                        notify('Draft saved. No automation was scheduled.');
                        open(pane, saved.id);
                    } catch (error) {
                        status.textContent = error.message;
                        submit.disabled = false;
                    }
                } },
                    label('Name', name), label('Runs using', kinds), targetLabel, suggestions, workflowLabel, targetHelp, label('Instructions', instructions),
                    el('div', { class: 'board-form-row' }, label('Repeat', rhythm), eventLabel, dayLabel, timeLabel),
                    el('div', { class: 'board-form-row' }, ownershipLabel, writeScopeLabel),
                    timezone,
                    el('div', { class: 'ecosystem-actions' }, submit, archive), status);
                editor.replaceChildren(editorHeading, draft ? el('p', { class: 'board-muted' }, draft.archived ? 'Archived draft' : 'Saved draft · not scheduled') : null, form,
                    draft && !draft.archived ? model.canHandoff ? el('div', { class: 'ecosystem-actions routine-handoff' }, handoff,
                        el('span', { class: 'board-muted' }, 'Review the saved version before creating or enabling anything.'))
                        : el('p', { class: 'board-muted' }, 'To hand off this draft, open Companion in the session that owns this repository.') : null);
                if (focus) editorHeading.focus();
            };
            const displayRhythm = draft => {
                if (draft.rhythm === 'manual') return 'Manual';
                if (draft.rhythm === 'event') return `Event · ${draft.event ?? 'github'}`;
                return [
                    draft.rhythm === 'weekly' ? weekdays[draft.day] : 'Daily',
                    `${String(draft.hour).padStart(2, '0')}:${String(draft.minute).padStart(2, '0')}`,
                ].join(' · ');
            };
            const list = (items, title) => el('section', { class: 'routine-list' }, el('h3', {}, title),
                items.length ? items.map(draft => el('button', { type: 'button', class: 'project-file', onclick: () => renderEditor(draft, true) },
                    draft.name, el('small', {}, ` · ${displayRhythm(draft)}`))) : el('p', { class: 'board-muted' }, 'No drafts in this section.'));
            const liveStatus = el('p', { role: 'status' });
            const liveReview = action('Find live routines in chat', async event => {
                if (root() !== expected || !liveStatus.isConnected || pane.hidden) return;
                const button = event.currentTarget;
                button.disabled = true;
                try {
                    await sendResult(await api('/api/routines/manage', {}), 'the live routine inventory');
                } catch (error) {
                    liveStatus.textContent = error.message;
                } finally {
                    button.disabled = false;
                }
            });
            const packStatus = el('p', { role: 'status' });
            const triggerLabel = bp => bp.trigger.type === 'schedule'
                ? `Daily · ${String(bp.trigger.hour).padStart(2, '0')}:${String(bp.trigger.minute).padStart(2, '0')} UTC`
                : `Event · ${bp.trigger.event}${bp.trigger.labelFilter ? ` (${bp.trigger.labelFilter})` : ''}`;
            const packReviewBtn = model.canHandoff && model.repository ? action('Review full pack in chat', async event => {
                if (root() !== expected || !packStatus.isConnected || pane.hidden) return;
                const button = event.currentTarget;
                button.disabled = true;
                try {
                    await sendResult(await api('/api/routines/blueprint-review', { pack: true }), 'the Cloud Autonomy automation pack');
                } catch (error) {
                    packStatus.textContent = error.message;
                } finally {
                    button.disabled = false;
                }
            }, true) : null;
            const blueprintsSection = Array.isArray(model.blueprints) && model.blueprints.length
                ? el('section', { class: 'board-subsection routine-blueprints', 'aria-label': 'Cloud Autonomy Pack' },
                    el('div', { class: 'board-heading' },
                        el('div', {},
                            el('h3', {}, 'Cloud Autonomy Pack'),
                            el('p', {}, 'Loop-safe, least-privilege GitHub Copilot Cloud Automation blueprints. Draft locally or review in chat before creating paused cloud automations.'),
                        ),
                        packReviewBtn,
                    ),
                    !model.repository ? el('p', { class: 'board-muted' }, 'Configure a direct github.com origin to draft or review Cloud Automation blueprints.') : null,
                    el('div', { class: 'blueprint-grid' },
                        model.blueprints.map(bp => {
                            const saveDraftBtn = model.repository ? action('Save as draft', async event => {
                                if (root() !== expected || !packStatus.isConnected || pane.hidden) return;
                                const button = event.currentTarget;
                                button.disabled = true;
                                try {
                                    const payload = { blueprintId: bp.id };
                                    if (!bp.policyCompliant && bp.writeScope === 'repository' && model.autonomyPolicy?.policy?.allowedWriteScopes?.includes('trigger')) {
                                        payload.writeScope = 'trigger';
                                    }
                                    const saved = await api('/api/routines/save-blueprint', payload);
                                    notify(`Saved "${bp.name}" as an unscheduled draft.`);
                                    open(pane, saved.id);
                                } catch (error) {
                                    packStatus.textContent = error.message;
                                    button.disabled = false;
                                }
                            }) : null;
                            const reviewBpBtn = model.canHandoff && model.repository ? action('Review in chat', async event => {
                                if (root() !== expected || !packStatus.isConnected || pane.hidden) return;
                                const button = event.currentTarget;
                                button.disabled = true;
                                try {
                                    await sendResult(await api('/api/routines/blueprint-review', { blueprintId: bp.id }), bp.name);
                                } catch (error) {
                                    packStatus.textContent = error.message;
                                } finally {
                                    button.disabled = false;
                                }
                            }) : null;
                            return el('article', { class: 'blueprint-card', 'data-blueprint': bp.id },
                                el('div', { class: 'blueprint-head' },
                                    el('strong', {}, bp.name),
                                    el('span', { class: `badge ${bp.policyCompliant ? 'badge-done' : 'badge-warn'}` },
                                        bp.policyCompliant ? 'Policy OK' : 'Scope restricted'),
                                ),
                                el('p', { class: 'blueprint-summary' }, bp.summary),
                                el('p', { class: 'board-muted' }, `${triggerLabel(bp)} · write_scope: ${bp.writeScope} · Loop-safe · human-triggered`),
                                bp.issues?.length ? el('p', { class: 'board-muted' }, bp.issues.map(i => i.message).join(' ')) : null,
                                el('div', { class: 'ecosystem-actions' }, saveDraftBtn, reviewBpBtn),
                            );
                        }),
                    ),
                    packStatus,
                )
                : null;
            pane.replaceChildren(el('div', { class: 'ecosystem-panel' },
                el('header', { class: 'board-heading' }, el('div', {}, el('h2', {}, 'Routines'),
                    el('p', {}, 'Prepare recurring and event-driven work here. Review, enable, pause, and inspect live runs in the scheduler that owns them.')),
                action('New routine', () => renderEditor(null, true), true)),
                el('aside', { class: 'board-subsection', 'aria-label': 'Live routine management' }, el('h3', {}, 'Live schedules and runs'),
                    el('p', {}, 'Open Automations in the Copilot app for local schedules. For GitHub Copilot Automations, review the repository setup in chat.'),
                    el('div', { class: 'ecosystem-actions' }, model.canHandoff ? liveReview : null, external('View GitHub Actions', model.destinations.actions)),
                    liveStatus),
                blueprintsSection,
                el('div', { class: 'routine-layout' }, el('aside', {},
                    list(model.drafts.filter(draft => !draft.archived), 'Saved drafts'),
                    model.drafts.some(draft => draft.archived) ? list(model.drafts.filter(draft => draft.archived), 'Archived drafts') : null), editor)));
            renderEditor(model.drafts.find(draft => draft.id === selectedId) ?? null);
        } catch (error) {
            if (!progress.isConnected) return;
            progress.textContent = error.message;
            progress.setAttribute('role', 'alert');
        }
    }
    return { open };
}
