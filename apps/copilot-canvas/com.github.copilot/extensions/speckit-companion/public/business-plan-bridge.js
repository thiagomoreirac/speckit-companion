const searchParams = new URLSearchParams(location.search);
const token = searchParams.get('token') ?? '';
const root = searchParams.get('root') ?? '';
const forcedTheme = searchParams.get('theme');
const systemLight = window.matchMedia('(prefers-color-scheme: light)');

const applyTheme = () => {
    const light = forcedTheme === 'light' || (forcedTheme !== 'dark' && systemLight.matches);
    document.body.classList.toggle('vscode-light', light);
    document.body.classList.toggle('vscode-dark', !light);
};
document.addEventListener('DOMContentLoaded', applyTheme);
systemLight.addEventListener('change', applyTheme);

let queue = Promise.resolve();
let activeDialog = null;

function closeDialog() {
    if (!activeDialog) return;
    activeDialog.close();
    activeDialog.remove();
    activeDialog = null;
}

function openFileViewer({ path, content }) {
    closeDialog();
    const dialog = document.createElement('dialog');
    dialog.className = 'bp-canvas-dialog';
    const header = document.createElement('h2');
    header.textContent = path;
    const note = document.createElement('p');
    note.className = 'bp-canvas-dialog-note';
    note.textContent = 'Read-only preview from the repository.';
    const pre = document.createElement('pre');
    pre.className = 'bp-canvas-dialog-code';
    pre.tabIndex = 0;
    pre.textContent = content;
    const actions = document.createElement('div');
    actions.className = 'bp-canvas-dialog-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(content);
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
        } catch {
            copy.textContent = 'Copy failed';
        }
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => dialog.close());
    actions.append(copy, close);
    dialog.append(header, note, pre, actions);
    dialog.addEventListener('close', () => {
        dialog.remove();
        if (activeDialog === dialog) activeDialog = null;
    });
    document.body.append(dialog);
    activeDialog = dialog;
    dialog.showModal();
}

function openCreatePlanDialog() {
    closeDialog();
    const dialog = document.createElement('dialog');
    dialog.className = 'bp-canvas-dialog bp-canvas-dialog--compact';
    const form = document.createElement('form');
    form.className = 'bp-canvas-form';

    const header = document.createElement('h2');
    header.textContent = 'New Business Plan';

    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'Plan name';
    titleLabel.htmlFor = 'bp-new-title';
    const titleInput = document.createElement('input');
    titleInput.id = 'bp-new-title';
    titleInput.type = 'text';
    titleInput.required = true;
    titleInput.placeholder = 'Q3 Onboarding Growth';

    const summaryLabel = document.createElement('label');
    summaryLabel.textContent = 'Business problem or objective (optional)';
    summaryLabel.htmlFor = 'bp-new-summary';
    const summaryInput = document.createElement('textarea');
    summaryInput.id = 'bp-new-summary';
    summaryInput.rows = 3;
    summaryInput.placeholder = 'Reduce new-user onboarding drop-off across self-serve signups.';

    const actions = document.createElement('div');
    actions.className = 'bp-canvas-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => dialog.close());
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'bp-canvas-btn-primary';
    submit.textContent = 'Create starter plan';

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const title = titleInput.value.trim();
        if (!title) return;
        const summary = summaryInput.value.trim();
        dialog.close();
        void post({ type: 'createNewPlan', title, summary });
    });

    actions.append(cancel, submit);
    form.append(header, titleLabel, titleInput, summaryLabel, summaryInput, actions);
    dialog.append(form);
    dialog.addEventListener('close', () => {
        dialog.remove();
        if (activeDialog === dialog) activeDialog = null;
    });
    document.body.append(dialog);
    activeDialog = dialog;
    dialog.showModal();
    titleInput.focus();
}

function post(message) {
    queue = queue.then(async () => {
        const response = await fetch('/api/business-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-speckit-token': token },
            body: JSON.stringify({ ...message, expectedRoot: root || undefined }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
        for (const data of result.messages) {
            if (data.type === 'fileViewer') openFileViewer(data);
            else if (data.type === 'createPlanPrompt') openCreatePlanDialog();
            else if (data.type === 'openExternal' && typeof data.url === 'string' && /^https:\/\//i.test(data.url)) {
                window.open(data.url, '_blank', 'noopener,noreferrer');
            } else if (data.type === 'openSettings') {
                window.parent?.postMessage({ type: 'speckit-canvas:open-settings', setting: data.setting }, location.origin);
            } else {
                window.dispatchEvent(new MessageEvent('message', { data }));
            }
        }
    }).catch(error => {
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'notice', tone: 'error', text: error.message },
        }));
    });
    return queue;
}

window.acquireVsCodeApi = () => ({ postMessage: post });

window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.type === 'speckit-canvas:refresh-business-plan') {
        void post({ type: 'ready' });
    }
});
