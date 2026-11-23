import type { Artifact } from './workEvidence';

type Relationship = { from: string; to: string; cardinality: string; label: string };

/** A bounded, text-only projection of Mermaid ER. No Mermaid runtime or HTML. */
export function entityDiagram(kind: Artifact['kind'], content: string) {
    if (kind !== 'diagram' && kind !== 'document') return null;
    const lines = content.split(/\r?\n/);
    let first = 0;
    let end = lines.length;
    if (kind === 'document') {
        first = lines.findIndex(line => /^ {0,3}```mermaid[ \t]*$/.test(line)) + 1;
        if (!first) return null;
        end = lines.findIndex((line, index) => index >= first && /^ {0,3}```[ \t]*$/.test(line));
        if (end < 0) return null;
    }
    while (first < end && !lines[first].trim()) first++;
    if (first >= end || lines[first].trim() !== 'erDiagram' || end - first > 251) return null;
    const entities = new Map<string, string[]>();
    const relationships: Relationship[] = [];
    let current: string[] | undefined;
    for (let index = first + 1; index < end; index++) {
        const line = lines[index].trim();
        if (!line || line.startsWith('%%')) continue;
        if (current) {
            if (line === '}') current = undefined;
            else if (/^[\w[\]()-]+ +[\w-]+(?: +(?:PK|FK|UK)(?: *, *(?:PK|FK|UK))*)?$/.test(line)) current.push(line);
            else return null;
            continue;
        }
        const entity = /^([\w-]+)\s*\{$/.exec(line);
        if (entity) {
            current = entities.get(entity[1]) ?? [];
            entities.set(entity[1], current);
            continue;
        }
        const relation = /^([\w-]+)\s+([|o}{]{2}(?:--|\.\.)[|o}{]{2})\s+([\w-]+)\s*:\s*(.{1,160})$/.exec(line);
        if (!relation) return null;
        const [, from, cardinality, to, label] = relation;
        for (const id of [from, to]) if (!entities.has(id)) entities.set(id, []);
        relationships.push({ from, to, cardinality, label: label.replace(/^"|"$/g, '') });
    }
    if (current || !entities.size || entities.size > 40) return null;
    return { entities: [...entities].map(([name, fields]) => ({ name, fields })), relationships };
}
