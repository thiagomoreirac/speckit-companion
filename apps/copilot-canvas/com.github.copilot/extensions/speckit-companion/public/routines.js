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
                const rhythm = el('select', { class: 'search' }, option('manual', 'Manual'), option('daily', 'Daily'), option('weekly', 'Weekly'));
                const time = el('input', { class: 'search', type: 'time', 'aria-label': 'Schedule time' });
                const day = el('select', { class: 'search' }, weekdays.map((value, i) => option(i, value)));
                const dayLabel = label('Day of week', day);
                const timeLabel = label('Time', time);
                const timezone = el('p', { class: 'board-muted' });
                const status = el('p', { role: 'status' });
                const submit = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save draft');
                const setInputs = () => {
                    const isActions = kinds.value === 'actions';
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
                    timeLabel.hidden = rhythm.value === 'manual';
                    dayLabel.hidden = rhythm.value !== 'weekly';
                    time.required = rhythm.value !== 'manual';
                    timezone.textContent = ['actions', 'copilot'].includes(kinds.value)
                        ? 'GitHub uses UTC for this draft. Companion does not schedule it.' : 'The Copilot app uses the computer’s local time.';
                };
                kinds.value = draft?.kind ?? model.types[0]?.id;
                name.value = draft?.name ?? '';
                target.value = draft?.action ?? '';
                workflows.value = draft?.kind === 'actions' ? draft.action : '';
                instructions.value = draft?.instructions ?? '';
                rhythm.value = draft?.rhythm ?? 'manual';
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
                        const saved = await api('/api/routines/save', { id: draft?.id, revision: draft?.revision, name: name.value,
                            kind: kinds.value, action: kinds.value === 'actions' ? workflows.value : target.value,
                            instructions: instructions.value, rhythm: rhythm.value, hour, minute,
                            day: Number(day.value), archived: draft?.archived ?? false });
                        notify('Draft saved. No automation was scheduled.');
                        open(pane, saved.id);
                    } catch (error) {
                        status.textContent = error.message;
                        submit.disabled = false;
                    }
                } },
                    label('Name', name), label('Runs using', kinds), targetLabel, suggestions, workflowLabel, targetHelp, label('Instructions', instructions),
                    el('div', { class: 'board-form-row' }, label('Repeat', rhythm), dayLabel, timeLabel), timezone,
                    el('div', { class: 'ecosystem-actions' }, submit, archive), status);
                editor.replaceChildren(editorHeading, draft ? el('p', { class: 'board-muted' }, draft.archived ? 'Archived draft' : 'Saved draft · not scheduled') : null, form,
                    draft && !draft.archived ? model.canHandoff ? el('div', { class: 'ecosystem-actions routine-handoff' }, handoff,
                        el('span', { class: 'board-muted' }, 'Review the saved version before creating or enabling anything.'))
                        : el('p', { class: 'board-muted' }, 'To hand off this draft, open Companion in the session that owns this repository.') : null);
                if (focus) editorHeading.focus();
            };
            const displayRhythm = draft => draft.rhythm === 'manual' ? 'Manual' : [
                draft.rhythm === 'weekly' ? weekdays[draft.day] : 'Daily',
                `${String(draft.hour).padStart(2, '0')}:${String(draft.minute).padStart(2, '0')}`,
            ].join(' · ');
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
            pane.replaceChildren(el('div', { class: 'ecosystem-panel' },
                el('header', { class: 'board-heading' }, el('div', {}, el('h2', {}, 'Routines'),
                    el('p', {}, 'Prepare recurring work here. Review, enable, pause, and inspect live runs in the scheduler that owns them.')),
                action('New routine', () => renderEditor(null, true), true)),
                el('aside', { class: 'board-subsection', 'aria-label': 'Live routine management' }, el('h3', {}, 'Live schedules and runs'),
                    el('p', {}, 'Open Automations in the Copilot app for local schedules. For GitHub Copilot Automations, review the repository setup in chat.'),
                    el('div', { class: 'ecosystem-actions' }, model.canHandoff ? liveReview : null, external('View GitHub Actions', model.destinations.actions)),
                    liveStatus),
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
