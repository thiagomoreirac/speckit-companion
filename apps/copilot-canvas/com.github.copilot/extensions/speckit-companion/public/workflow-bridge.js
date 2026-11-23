const token = new URLSearchParams(location.search).get('token') ?? '';
const root = new URLSearchParams(location.search).get('root') ?? '';
const theme = new URLSearchParams(location.search).get('theme');
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
const applyTheme = () => {
    const light = theme === 'light' || (theme !== 'dark' && systemLight.matches);
    document.body.classList.toggle('vscode-light', light);
    document.body.classList.toggle('vscode-dark', !light);
};
document.addEventListener('DOMContentLoaded', applyTheme);
systemLight.addEventListener('change', applyTheme);
let queue = Promise.resolve();
let editor = null;
function openEditor({ path, content, readOnly, token }) {
    editor?.dialog.close();
    editor?.dialog.remove();
    const dialog = document.createElement('dialog');
    dialog.className = 'workflow-editor';
    const header = document.createElement('h2');
    header.textContent = path;
    const note = document.createElement('p');
    note.textContent = readOnly ? 'Shipped instructions are read-only here. Edit the node in its inspector to make a project copy.' : 'Changes are saved to this project file.';
    const text = document.createElement('textarea');
    text.readOnly = readOnly;
    text.setAttribute('aria-label', `Contents of ${path}`);
    const error = document.createElement('p');
    error.className = 'workflow-editor-error';
    error.setAttribute('role', 'alert');
    const key = JSON.stringify(['workflow-draft', root, path]);
    let restored = null;
    try {
        restored = JSON.parse(sessionStorage.getItem(key));
    } catch {
        error.textContent = 'Could not restore a saved draft. Copy your edits before switching repositories.';
    }
    const conflict = restored && typeof restored.original === 'string' && typeof restored.content === 'string' && restored.original !== content;
    text.value = !readOnly && restored && typeof restored.content === 'string' ? restored.content : content;
    if (conflict) error.textContent = 'The file changed since this draft was saved. Copy the draft or discard it before editing the current file.';
    const actions = document.createElement('div');
    actions.className = 'workflow-editor-actions';
    let saving = false;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    const requestClose = () => {
        if (saving) return;
        if (!readOnly && text.value !== content) {
            error.textContent = 'Save or discard your edits before closing.';
            return;
        }
        dialog.close();
    };
    close.addEventListener('click', requestClose);
    dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
    actions.append(close);
    if (!readOnly) {
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.textContent = 'Discard';
        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = 'Save';
        save.disabled = Boolean(conflict);
        const storeDraft = () => {
            try {
                if (text.value === content) sessionStorage.removeItem(key);
                else sessionStorage.setItem(key, JSON.stringify({ original: restored?.original ?? content, content: text.value }));
            } catch {
                error.textContent = 'Could not preserve this draft. Copy your edits before switching repositories.';
            }
        };
        text.addEventListener('input', storeDraft);
        discard.addEventListener('click', () => {
            text.value = content;
            restored = null;
            save.disabled = false;
            error.textContent = '';
            storeDraft();
        });
        save.addEventListener('click', async () => {
            error.textContent = '';
            saving = true;
            text.disabled = true;
            close.disabled = true;
            discard.disabled = true;
            save.disabled = true;
            await post({ type: 'saveWorkflowFile', token, content: text.value });
            if (editor?.dialog === dialog) {
                saving = false;
                text.disabled = false;
                close.disabled = false;
                discard.disabled = false;
                save.disabled = false;
            }
        });
        actions.append(discard, save);
    }
    dialog.append(header, note, text, error, actions);
    dialog.addEventListener('close', () => { dialog.remove(); if (editor?.dialog === dialog) editor = null; });
    document.body.append(dialog);
    editor = { dialog, error, key };
    dialog.showModal();
}

function post(message) {
    queue = queue.then(async () => {
        const response = await fetch('/api/workflow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-speckit-token': token },
            body: JSON.stringify({ ...message, expectedRoot: root || undefined }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
        for (const data of result.messages) {
            if (data.type === 'fileEditor') openEditor(data);
            else if (data.type === 'fileSaved' && editor) {
                try {
                    sessionStorage.removeItem(editor.key);
                } catch {
                    window.dispatchEvent(new MessageEvent('message', { data: { type: 'notice', text: 'File saved, but its local draft could not be cleared.' } }));
                }
                editor.dialog.close();
            }
            else window.dispatchEvent(new MessageEvent('message', { data }));
        }
    }).catch(error => {
        if (message.type === 'saveWorkflowFile' && editor) editor.error.textContent = error.message;
        else window.dispatchEvent(new MessageEvent('message', { data: { type: 'notice', text: error.message } }));
    });
    return queue;
}
window.acquireVsCodeApi = () => ({ postMessage: post });
