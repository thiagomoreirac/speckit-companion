const id = String.raw`[a-zA-Z_]\w{0,31}`;
const endpoint = new RegExp(String.raw`^(${id})(?:\s*(?:\["([^"\r\n]{1,72})"\]|\[([^\[\]"\r\n;]{1,72})\]|\{"([^"\r\n]{1,72})"\}|\{([^{}"\r\n;]{1,72})\}))?`);
const connector = /^(-->|-\.->)(?:[ \t]*\|([^|;\r\n]{1,80})\|)?[ \t]*/;
const reserved = /^(?:subgraph|end|click|style|class|classDef|linkStyle|direction|accTitle|accDescr)$/i;

export function parseFlowchartModel(source) {
    const lines = source.split(/\r?\n/).map(line => line.trim());
    if (lines.length > 128 || lines.some(line => line.startsWith('%%{'))) return null;
    const content = lines.filter(line => line && !line.startsWith('%%'));
    const header = /^(?:flowchart|graph)[ \t]+(TD|TB|LR)$/.exec(content.shift() ?? '');
    if (!header) return null;
    const nodes = new Map(), edges = [];
    function readNode(text) {
        const match = endpoint.exec(text);
        if (!match || reserved.test(match[1])) return null;
        const [, key, quoted, plain, decisionQuoted, decisionPlain] = match;
        const label = (quoted ?? plain ?? decisionQuoted ?? decisionPlain)?.trim();
        const kind = decisionQuoted != null || decisionPlain != null ? 'decision' : 'step';
        const existing = nodes.get(key);
        if (label === '' || (label && existing?.label && (existing.label !== label || existing.kind !== kind))) return null;
        if (!existing || label) nodes.set(key, { id: key, label, kind });
        return { key, rest: text.slice(match[0].length).trimStart() };
    }
    for (const line of content) {
        let current = readNode(line);
        if (!current) return null;
        while (current.rest) {
            const link = connector.exec(current.rest);
            if (!link || edges.length >= 36) return null;
            const target = readNode(current.rest.slice(link[0].length));
            const label = link[2]?.trim();
            if (!target || label === '' || edges.some(edge => edge.from === current.key && edge.to === target.key)) return null;
            edges.push({ from: current.key, to: target.key, dashed: link[1] === '-.->', ...(label ? { label } : {}) });
            current = target;
        }
        if (nodes.size > 24) return null;
    }
    if (!edges.length) return null;

    const ranks = new Map();
    const incoming = new Map([...nodes.keys()].map(key => [key, edges.filter(edge => edge.to === key).map(edge => edge.from)]));
    while (ranks.size < nodes.size) {
        const prior = ranks.size;
        for (const [key, parents] of incoming) {
            if (!ranks.has(key) && parents.every(parent => ranks.has(parent))) {
                ranks.set(key, parents.length ? 1 + Math.max(...parents.map(parent => ranks.get(parent))) : 0);
            }
        }
        if (ranks.size === prior) return null;
    }
    return { direction: header[1] === 'LR' ? 'horizontal' : 'vertical',
        nodes: [...nodes.values()].map(node => ({ ...node, label: node.label ?? node.id, rank: ranks.get(node.id) })), edges };
}
