export function createSettingsPage({ api, el, root, saved }) {
    const $ = id => document.getElementById(`settings-${id}`);
    const form = $('form');
    const fields = $('fields');
    const status = $('status');
    const terminal = $('terminal');
    const save = $('save');
    const reload = $('reload');
    let current;
    let request = 0;
    let busy = false;
    const edits = new Map();

    function controls() {
        const detached = current?.root !== root();
        fields.disabled = busy || detached;
        save.disabled = busy || detached || !edits.size;
        reload.disabled = busy;
        terminal.disabled = busy || detached || !current?.terminalAvailable;
        $('terminal-hint').textContent = terminal.disabled && !busy
            ? 'Open Terminal directly in the Copilot session that owns this repository.' : '';
    }

    function render() {
        fields.replaceChildren();
        const groups = new Map();
        for (const [index, field] of current.fields.entries()) {
            if (!groups.has(field.group)) {
                const group = el('section', { class: 'settings-section', 'aria-labelledby': `setting-group-${index}` },
                    el('h3', { id: `setting-group-${index}` }, field.group));
                fields.append(group);
                groups.set(field.group, group);
            }
            const id = `setting-${index}`;
            const description = el('div', {},
                field.readOnly ? el('span', { class: 'setting-label' }, field.label) : el('label', { for: id }, field.label),
                el('small', { id: `${id}-description` }, field.description),
                field.error ? el('small', { class: 'setting-error' }, field.error) : null);
            const source = el('p', { class: 'setting-source' }, field.source);
            const cell = el('div', { class: 'setting-control' }, source);
            if (!field.readOnly) {
                const attributes = { id, class: 'search', 'aria-describedby': `${id}-description` };
                const input = field.type === 'array' ? el('textarea', { ...attributes, rows: 3, spellcheck: 'false' })
                    : field.type === 'boolean' || field.choices ? el('select', attributes,
                        (field.choices ?? ['true', 'false']).map(value => el('option', { value }, value === 'true' ? 'On' : value === 'false' ? 'Off' : value)))
                        : el('input', { ...attributes, type: 'text', spellcheck: 'false' });
                const reset = el('button', { class: 'btn btn-quiet', type: 'button', 'aria-label': `Reset ${field.label}` }, 'Use default');
                const format = value => field.type === 'array' ? JSON.stringify(value, null, 2) : String(value);
                input.value = format(field.value);
                reset.hidden = field.source === 'Default';
                input.addEventListener('input', () => {
                    if (field.source === 'Repository' && input.value === format(field.value)) edits.delete(field.key);
                    else edits.set(field.key, { field, input });
                    source.textContent = edits.has(field.key) ? 'Unsaved repository override' : field.source;
                    reset.hidden = field.source === 'Default' && !edits.has(field.key);
                    controls();
                });
                reset.addEventListener('click', () => {
                    input.value = format(field.fallback);
                    if (field.source === 'Repository') edits.set(field.key, null);
                    else edits.delete(field.key);
                    source.textContent = field.source === 'Repository' ? 'Default after save' : 'Default';
                    reset.hidden = true;
                    controls();
                });
                cell.prepend(input);
                cell.append(reset);
            }
            groups.get(field.group).append(el('div', { class: 'setting-row' }, description, cell));
        }
        controls();
    }

    async function load({ force = false } = {}) {
        if (busy || (edits.size && !force)) return;
        const id = ++request;
        busy = true;
        status.textContent = 'Loading repository settings…';
        controls();
        try {
            const next = await api('/api/settings');
            if (id !== request || next.root !== root()) return;
            current = next;
            edits.clear();
            render();
            status.textContent = next.error ?? next.root;
        } catch (error) {
            if (id === request) status.textContent = `Could not load settings: ${error.message}`;
        } finally {
            if (id === request) { busy = false; controls(); }
        }
    }

    reload.addEventListener('click', () => {
        if (!edits.size || window.confirm('Discard unsaved settings changes and reload?')) void load({ force: true });
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (save.disabled) return;
        const changes = {};
        for (const [key, edit] of edits) {
            try {
                changes[key] = edit === null ? null : edit.field.type === 'array' ? JSON.parse(edit.input.value)
                    : edit.field.type === 'boolean' ? edit.input.value === 'true' : edit.input.value;
                if (edit && edit.field.type === 'array' && !Array.isArray(changes[key])) throw new Error('Expected an array.');
            } catch {
                status.textContent = `${edit.field.label} needs a valid JSON array.`;
                edit.input.focus();
                return;
            }
        }
        const id = ++request;
        busy = true;
        controls();
        try {
            const next = await api('/api/settings', { version: current.version, changes });
            if (id !== request || next.root !== root()) return;
            current = { ...next, terminalAvailable: current.terminalAvailable };
            edits.clear();
            render();
            status.textContent = 'Changes saved to .vscode/settings.json.';
            saved();
            reload.focus();
        } catch (error) {
            if (id === request) status.textContent = `Could not save: ${error.message}`;
        } finally {
            if (id === request) { busy = false; controls(); }
        }
    });
    terminal.addEventListener('click', async () => {
        terminal.disabled = true;
        try {
            await api('/api/terminal', {});
            $('terminal-hint').textContent = 'Terminal opened in this session.';
        } catch (error) {
            $('terminal-hint').textContent = error.message;
        } finally {
            terminal.disabled = busy || current?.root !== root() || !current?.terminalAvailable;
        }
    });
    return {
        open() {
            $('title').focus();
            if (!current || !edits.size) void load();
        },
        rootChanged() {
            request++;
            busy = false;
            controls();
            if (edits.size) status.textContent = 'Repository changed. Return to the original repository to keep editing, or reload to discard your changes.';
            else if (!$('panel').hidden) void load();
        },
        diskChanged(event) {
            if ($('panel').hidden || busy || event.root !== root() || event.version === current?.version) return;
            if (edits.size) status.textContent = 'Settings changed on disk. Reload before saving.';
            else void load();
        },
    };
}
