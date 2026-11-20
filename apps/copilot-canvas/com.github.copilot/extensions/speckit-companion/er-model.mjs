const entityName = /^([a-zA-Z_][\w-]{0,79})(?:\s*(\{))?$/;
const fieldLine = /^([a-zA-Z][\w()[\]-]{0,79})\s+([a-zA-Z_][\w*-]{0,79})(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]{0,240})")?$/;
const relationshipLine = /^([a-zA-Z_][\w-]{0,79})\s+(\|\||\|o|\}o|\}\|)(--|\.\.)(\|\||o\||o\{|\|\{)\s+([a-zA-Z_][\w-]{0,79})\s*:\s*("[^"]{1,160}"|[^\s"][^"]{0,159})$/;
const cardinality = new Map([
    ['||', '1'], ['|o', '0..1'], ['o|', '0..1'], ['}o', '0..*'], ['o{', '0..*'], ['}|', '1..*'], ['|{', '1..*'],
]);

// Accept the raw, line-oriented export from Data Model Diagram, not general Mermaid syntax.
export function parseErModel(source) {
    const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
    if (lines.shift() !== 'erDiagram' || lines.length > 1024) return null;
    const entities = new Map();
    const relationships = [];
    let fields = null;
    const entity = name => {
        if (!entities.has(name)) entities.set(name, []);
        return entities.get(name);
    };
    for (const line of lines) {
        if (fields) {
            if (line === '}') { fields = null; continue; }
            const field = fieldLine.exec(line);
            if (!field || fields.length >= 96) return null;
            fields.push({ type: field[1], name: field[2], keys: field[3] ?? '', note: field[4] ?? '' });
        } else {
            const relation = relationshipLine.exec(line);
            if (relation) {
                const [, from, left, connector, right, to, label] = relation;
                entity(from);
                entity(to);
                relationships.push({ from, to, left: cardinality.get(left), right: cardinality.get(right),
                    identifying: connector === '--', label: label.startsWith('"') ? label.slice(1, -1) : label });
            } else {
                const declaration = entityName.exec(line);
                if (!declaration) return null;
                const attributes = entity(declaration[1]);
                if (declaration[2]) fields = attributes;
            }
        }
        if (entities.size > 64 || relationships.length > 128) return null;
    }
    if (fields || !entities.size) return null;
    return { entities: [...entities].map(([name, attributes]) => ({ name, attributes })), relationships };
}
