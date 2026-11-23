import type { WireflowNode, WireflowPreview } from '../../../../src/protocol/wireflowPreview';

const tags = {
    group: 'div', heading: 'h5', paragraph: 'p', sequence: 'ol', list: 'ul', item: 'li', label: 'span',
    table: 'table', caption: 'caption', 'table-head': 'thead', 'table-body': 'tbody', 'table-foot': 'tfoot',
    row: 'tr', header: 'th', cell: 'td', pre: 'pre', code: 'code', inline: 'span',
} as const satisfies Record<Exclude<WireflowNode, string>['type'], string>;

function renderNode(node: WireflowNode, index: number) {
    if (typeof node === 'string') return node;
    const Tag = tags[node.type];
    return <Tag key={index} class={node.type === 'label' ? 'work-evidence__wireflow-label' : undefined}>
        {node.children.map(renderNode)}
    </Tag>;
}

export function StaticWireflow({ preview, source }: { preview: WireflowPreview; source: string }) {
    const fidelity = { low: 'Low', mid: 'Medium', high: 'High' }[preview.fidelity];
    return <section aria-label="Static prototype preview">
        <h4>Static prototype preview</h4>
        <p>{fidelity} fidelity. Layout and flow only; controls are not interactive.</p>
        {preview.sections.map(section => <section key={section.id} class="work-evidence__wireflow">
            <h5>{section.id === 'design-surface' ? 'Design layout' : 'Wireflow'}</h5>
            <div>{section.children.map(renderNode)}</div>
        </section>)}
        {preview.truncated && <p>This preview is shortened. View source for the complete artifact.</p>}
        <details><summary>View HTML source</summary><pre tabIndex={0} aria-label="Artifact source">{source}</pre></details>
    </section>;
}
