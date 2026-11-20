const identifier = String.raw`[a-zA-Z_]\w{0,47}`;
const declaration = new RegExp(String.raw`^(participant|actor)\s+(${identifier})(?:\s+as\s+([^;]{1,100}))?$`);
const message = new RegExp(String.raw`^(${identifier})\s*(-->>|->>)\s*(${identifier})\s*:\s*([^;]{1,240})$`);

export function parseSequenceModel(source) {
    const lines = source.split(/\r?\n/).map(line => line.trim());
    if (lines.length > 256 || lines.some(line => line.startsWith('%%{'))) return null;
    const content = lines.filter(line => line && !line.startsWith('%%'));
    if (content.shift() !== 'sequenceDiagram') return null;
    const participants = new Map(), messages = [];
    let numbered = false;
    for (const line of content) {
        const declared = declaration.exec(line);
        const sent = message.exec(line);
        if (declared) {
            const [, role, id, label] = declared;
            if (participants.get(id)?.role) return null;
            participants.set(id, { id, role, label: label?.trim() || id });
        } else if (sent) {
            const [, from, arrow, to, label] = sent;
            if (!label.trim() || messages.length >= 96) return null;
            for (const id of [from, to]) if (!participants.has(id)) participants.set(id, { id, label: id });
            messages.push({ from, to, dashed: arrow === '-->>', label: label.trim() });
        } else if (line === 'autonumber' && !numbered && !messages.length) {
            numbered = true;
        } else {
            return null;
        }
        if (participants.size > 16) return null;
    }
    return messages.length ? { participants: [...participants.values()], messages } : null;
}
