export const ROADMAP_PATH = '.specify/memory/roadmap.md';
export const ROADMAP_CONFIG = '.specify/extensions/roadmap/roadmap-config.yml';
export const ROADMAP_STATUSES = [
    'undecided', 'needs-info', 'planned', 'specced', 'in-progress', 'implemented', 'verified', 'deferred', 'abandoned',
];

const SECTIONS = ['Vision & End States', 'Constraints & Decisions', 'Planned Specs', 'Open Questions', 'Cross-Cutting Notes'];
const ENTRY = /^(### (\d{3}) — (.+?) +\[status: )([a-z-]+)(\][ \t]*)$/;
const FOOTER = /^(\*\*Version\*\*: )((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.)(0|[1-9]\d*)( \| \*\*Ratified\*\*: \d{4}-\d{2}-\d{2} \| \*\*Last Amended\*\*: )\d{4}-\d{2}-\d{2}$/;
const REQUIRED = [/^- \*\*Description:\*\* +\S/, /^- \*\*Outcome:\*\* +\S/, /^- \*\*Scope \(in\):\*\* +\S/];
const unsupported = message => Object.assign(new Error(message), { status: 400 });

export function parseRoadmap(text) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    if (/\r/.test(text.replaceAll(eol, '')) || eol === '\r\n' && /(?<!\r)\n/.test(text)) {
        throw unsupported('The roadmap uses mixed line endings. Repair it before changing status.');
    }
    const lines = text.split(eol);
    if (lines[0] !== '<!--' || lines[1] !== 'SYNC IMPACT REPORT') {
        throw unsupported('The roadmap must begin with the standard Sync Impact Report.');
    }
    const sections = [];
    const entries = [];
    let reportEnd = -1, comment = false, entry, section;
    for (const [index, line] of lines.entries()) {
        const opening = /^ {0,3}<!--/.test(line);
        if (opening || comment) {
            const body = opening ? line.slice(line.indexOf('<!--') + 4) : line;
            if (opening && comment || body.includes('<!--') || /-->.*\S/.test(body)) {
                throw unsupported('The roadmap contains an ambiguous Markdown comment.');
            }
            comment = !body.includes('-->');
            if (!comment && reportEnd < 0) reportEnd = index;
            continue;
        }
        if (/^ {0,3}(?:`{3,}|~{3,}|<[A-Za-z/!?])/.test(line) || line.includes('<!--')) {
            throw unsupported('Roadmaps with fenced or raw HTML blocks are read-only in the canvas.');
        }
        const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
        if (heading && heading[1].length <= 3) entry = null;
        if (heading?.[1] === '##') {
            section = heading[2].trim();
            sections.push(section);
        }
        if (section !== 'Planned Specs') continue;
        const match = ENTRY.exec(line);
        if (match) {
            const [, , id, title, status] = match;
            if (entries.some(item => item.id === id) || !ROADMAP_STATUSES.includes(status) || title.includes('[status:')) {
                throw unsupported('The roadmap ledger contains a duplicate ID or an unsupported status heading.');
            }
            entries.push(entry = { id, title, status, line: index, fields: new Set() });
        } else if (heading?.[1] === '###' && /^(?:\d|\[status:)/.test(heading[2])) {
            throw unsupported('The roadmap has an entry outside the standard ID and status format.');
        } else {
            REQUIRED.forEach((pattern, field) => { if (entry && pattern.test(line)) entry.fields.add(field); });
        }
    }
    const footer = lines.findLastIndex(line => line.trim());
    if (comment || reportEnd < 2 || !/^# .+ — Spec Roadmap$/.test(lines.slice(reportEnd + 1).find(line => line.trim()) ?? '') ||
        sections.join('\n') !== SECTIONS.join('\n') || !FOOTER.test(lines[footer] ?? '') ||
        entries.some(item => item.fields.size !== REQUIRED.length) || !entries.length) {
        throw unsupported('The roadmap lacks the standard sections, entry fields, or version footer. Inspect or repair it before changing status.');
    }
    return { lines, eol, reportEnd, footer, entries };
}

export function changeRoadmapStatus(text, id, status, date) {
    const { lines, eol, reportEnd, footer, entries } = parseRoadmap(text);
    const selected = entries.find(item => item.id === id);
    if (!selected || !ROADMAP_STATUSES.includes(status)) throw unsupported('Select an existing roadmap entry and a supported status.');
    if (status === selected.status) throw unsupported('Choose a status different from the current status.');
    const [, label, base, patch, dates] = FOOTER.exec(lines[footer]);
    const next = Number(patch) + 1;
    if (!Number.isSafeInteger(next)) throw unsupported('The roadmap patch version is out of range.');
    const [, prefix, , , , suffix] = ENTRY.exec(lines[selected.line]);
    lines[selected.line] = `${prefix}${status}${suffix}`;
    lines[footer] = `${label}${base}${next}${dates}${date}`;
    lines.splice(0, reportEnd + 1, '<!--', 'SYNC IMPACT REPORT', '==================',
        `Version change: ${base}${patch} → ${base}${next}`, 'Bump rationale: PATCH — Approved roadmap status change',
        '', 'Changes this revision:', `  - Status: ${id} ${selected.status} → ${status}`,
        '', `Specs affected: ${id}`, 'Open questions added/resolved: none', '-->');
    return lines.join(eol);
}
