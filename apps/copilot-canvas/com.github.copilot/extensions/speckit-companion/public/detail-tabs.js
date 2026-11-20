export function detailTabId(panelId, id) {
    return `${panelId}-tab-${id}`;
}

export function renderDetailTabs({ el, tabs, active, panelId, label, select }) {
    return el('div', { class: 'tabs', role: 'tablist', 'aria-label': label },
        tabs.map(({ id, label, count, title }, index) => el('button', {
            class: 'tab', type: 'button', role: 'tab', id: detailTabId(panelId, id), title,
            'aria-controls': panelId, 'aria-selected': String(active === id), tabindex: active === id ? 0 : -1,
            onclick: () => select(id),
            onkeydown: event => {
                const next = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length,
                    Home: 0, End: tabs.length - 1 }[event.key];
                if (typeof next !== 'number') return;
                event.preventDefault();
                select(tabs[next].id);
            },
        }, label, count ? el('span', { class: 'count' }, count) : null)));
}
