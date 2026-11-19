export const WIREFRAME_CONFIG = '.specify/extensions/wireframe/wireframe-config.yml';
export const standardWireframeFeature = path => /^specs\/\d{3}-[a-z0-9][a-z0-9-]*$/.test(path);
export const standardWireframeName = name => /^\d{2}-[a-z0-9][a-z0-9-]{0,80}\.svg$/.test(name);
const unsupported = message => Object.assign(new Error(message), { status: 400 });

export function requirePassingWireframeReport(text, path) {
    const lines = text.split(/\r?\n/);
    if (!/^# .+ Review$/.test(lines[0]) || !lines.includes('## Issues')) {
        throw unsupported(`${path} is not a standard Wireframe review report.`);
    }
    for (const [label, expected] of [['Status', 'PASS'], ['Structural issues', '0'], ['Visual issues', '0'], ['Coverage issues', '0']]) {
        const values = lines.filter(line => line.startsWith(`**${label}:**`));
        if (values.length !== 1 || values[0].trimEnd() !== `**${label}:** ${expected}`) {
            throw unsupported(`${path} must record PASS and zero issues in every category before sign-off.`);
        }
    }
    if (lines.some(line => /^\s*\|\s*\d+\s*\|.*\|\s*(?:PATCH|REGENERATE)\s*\|\s*$/.test(line))) {
        throw unsupported(`${path} still lists repair or regeneration issues. Inspect the report before signing off.`);
    }
}

export function addWireframeSignoff(text, names, date) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(eol);
    if (/\r|\n/.test(lines.join(''))) throw unsupported('Repair mixed line endings before signing off wireframes.');
    let fence = '', comment = false;
    const anchors = [];
    for (const [index, line] of lines.entries()) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
            continue;
        }
        if (comment || /^ {0,3}<!--/.test(line)) {
            if (/-->.*\S/.test(line)) throw unsupported('The spec has an ambiguous Markdown comment.');
            comment = !line.includes('-->');
            continue;
        }
        if (marker) { fence = marker[1]; continue; }
        if (/^ {0,3}<[A-Za-z/!?]/.test(line) || line.includes('<!--')) {
            throw unsupported('The spec uses raw HTML or inline comments that the sign-off editor cannot interpret.');
        }
        if (/^ {0,3}#{1,6}\s+UI Mockup(?:\s+#+)?\s*$/i.test(line) ||
            /^ {0,3}UI Mockup\s*$/i.test(line) && /^ {0,3}[-=]+\s*$/.test(lines[index + 1] ?? '')) {
            throw unsupported('This spec already has a UI Mockup section. The canvas only supports initial sign-off.');
        }
        if (/^## (?:User Stories|User Scenarios & Testing)(?:\s+#+)?\s*$/.test(line)) anchors.push(index);
    }
    if (comment || fence || anchors.length !== 1) {
        throw unsupported('The spec must have one standard user-stories heading and no unclosed Markdown blocks.');
    }
    const section = ['## UI Mockup', '', `Signed off: ${date}`, '',
        ...names.map(name => `- [\`wireframes/${name}\`](./wireframes/${name})`), '',
        'These wireframes are spec constraints. Deviations require revising the spec.', ''];
    if (anchors[0] > 0 && lines[anchors[0] - 1].trim()) section.unshift('');
    lines.splice(anchors[0], 0, ...section);
    return lines.join(eol);
}
