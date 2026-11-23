import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, entityDiagram, projectPath, readEvidence } from './vendor/work-evidence.mjs';
import { renderMarkdown } from './vendor/viewer-markdown.mjs';

const NATIVE_OUTPUT = 'data-model-diagram.svg';

export function evidenceRole(file) {
    const name = file.path.split('/').at(-1).toLowerCase();
    if (file.kind === 'diagram' || name === NATIVE_OUTPUT) return 'diagrams';
    if (file.kind === 'prototype' || file.kind === 'image') return 'design';
    if (file.kind === 'evidence' || /\/checklists\//i.test(file.path) ||
        /^(?:verification|test-results?|qa-report|acceptance-report)(?:[.-])/.test(name)) return 'verification';
    return 'documents';
}

export function evidenceProducers(spec, generators) {
    return generators.map(generator => {
        const producer = generator.id === 'preview' ? 'Spec Kit Preview' : 'Data Model Diagram';
        const path = generator.id === 'preview' ? 'preview/wireflow.html' : 'data-model-diagram.mmd';
        return { ...generator, role: generator.id === 'preview' ? 'design' : 'diagrams',
            output: `${spec}/${path}`, method: 'chat', producer };
    });
}

function mermaidFences(text) {
    const sources = [];
    let fence;
    for (const line of text.split(/\r\n?|\n/)) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (!fence) {
            if (marker) fence = { delimiter: marker[1], collect: marker[2].trim() === 'mermaid', lines: [], length: 0 };
        } else if (marker?.[1][0] === fence.delimiter[0] && marker[1].length >= fence.delimiter.length && !marker[2].trim()) {
            if (fence.collect) sources.push(fence.lines.join('\n').trim());
            if (sources.length === 12) break;
            fence = null;
        } else if (fence.collect) {
            fence.length += line.length + 1;
            if (fence.length > 32_000) fence.collect = false;
            else fence.lines.push(line);
        }
    }
    return sources;
}

function boundedDiagram(source) {
    if (source.length > 32_000) return null;
    const er = entityDiagram('diagram', source);
    if (er) return { type: 'er', ...er };
    const [header, ...lines] = source.split(/\r?\n/).map(line => line.trim())
        .filter(line => line && !line.startsWith('%%'));
    if (!lines.length || lines.length > 48) return null;
    const direction = /^(?:graph|flowchart)\s+(TB|TD|BT|LR|RL)$/.exec(header)?.[1];
    const sequence = header === 'sequenceDiagram';
    if (!direction && !sequence) return null;
    const nodes = new Map(), links = [];
    function add(id, label) {
        if (!nodes.has(id) || label) nodes.set(id, label ?? id);
    }
    for (const line of lines) {
        if (sequence) {
            const participant = /^(?:participant|actor)\s+([\w-]+)(?:\s+as\s+([^<>{}\x00-\x1f]{1,100}))?$/.exec(line);
            if (participant) { add(participant[1], participant[2]); continue; }
            const link = /^([\w-]+?)\s*(--?>>|--?>|--?x)\s*([\w-]+)\s*:\s*([^<>{}\x00-\x1f]{1,120})$/.exec(line);
            if (!link) return null;
            const [, from, arrow, to, label] = link;
            add(from); add(to); links.push({ from, to, label, arrow });
        } else {
            const endpoint = String.raw`([\w-]+?)(?:\["?([^"[\]<>{}\x00-\x1f]{1,100})"?\])?`;
            const node = new RegExp(`^${endpoint};?$`).exec(line);
            if (node) { add(node[1], node[2]); continue; }
            const link = new RegExp(`^${endpoint}\\s*(-->|-.->|==>)\\s*(?:\\|([^|<>{}]{1,120})\\|\\s*)?${endpoint};?$`).exec(line);
            if (!link) return null;
            const [, from, fromLabel, arrow, label, to, toLabel] = link;
            add(from, fromLabel); add(to, toLabel); links.push({ from, to, label, arrow });
        }
    }
    return nodes.size <= 24 && links.length ? {
        type: sequence ? 'sequence' : 'flow', direction, nodes: Object.fromEntries(nodes), links,
    } : null;
}

export function artifactProjection(kind, text) {
    if (kind === 'document') {
        const diagrams = mermaidFences(text).flatMap(source => {
            const model = boundedDiagram(source);
            return model ? [{ source, model }] : [];
        });
        return { markdownHtml: renderMarkdown(text), diagrams };
    }
    return kind === 'diagram' ? { visualDiagram: boundedDiagram(text.trim()) } : {};
}

function modelInput(root, spec) {
    const path = `${spec}/data-model.md`;
    if (!projectPath(root, path)) throw new Error('Add data-model.md to this spec first.');
    const input = readEvidence(root, spec, path);
    let diagram;
    for (const source of mermaidFences(input.content.toString('utf8'))) {
        if (/^erDiagram(?:\s|$)/.test(source)) diagram = boundedDiagram(source);
        if (diagram) break;
    }
    if (!diagram) throw new Error('Add a supported Mermaid ER diagram to data-model.md, or use a chat generator if one is installed.');
    return { input, diagram };
}

export function nativeEvidenceGenerator(root, spec) {
    const output = `${spec}/${NATIVE_OUTPUT}`;
    let reason = null;
    try {
        if (lstatSync(join(root, output), { throwIfNoEntry: false })) {
            reason = 'A file already occupies the output path. The local generator never overwrites it.';
        } else {
            modelInput(root, spec);
        }
    } catch (error) { reason = error.message; }
    return { id: 'local-er-svg', label: 'Data model SVG', producer: 'Companion', method: 'local', role: 'diagrams', output, reason };
}

export function nativeEvidenceRequest(root, spec) {
    const output = `${spec}/${NATIVE_OUTPUT}`;
    if (!projectPath(root, spec, 'directory') || lstatSync(join(root, output), { throwIfNoEntry: false })) {
        throw new Error('The local output folder or file changed. Refresh Evidence; existing files are never overwritten.');
    }
    const { input, diagram } = modelInput(root, spec);
    return { label: 'Data model SVG', inputs: [input.path], output, overwrite: false, target: 'This repository (no chat request)',
        revision: digest(JSON.stringify([root, output, input.revision])), diagram };
}

export function writeNativeEvidence(root, spec, request) {
    const current = nativeEvidenceRequest(root, spec);
    if (request.revision !== current.revision) throw new Error('The input changed. Review the generation request again.');
    writeFileSync(join(root, current.output), entitySvg(current.diagram), { flag: 'wx' });
    return { created: true, output: current.output };
}

const xml = value => String(value).replace(/[\x00-\x1f\ufffe\uffff]/g, ' ')
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const truncate = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

function entitySvg({ entities, relationships }) {
    const columns = Math.min(3, entities.length), width = columns * 270 + 24;
    const text = (x, y, value, weight = 'normal') =>
        `<text x="${x}" y="${y}" fill="#24292f" font-weight="${weight}">${xml(value)}</text>`;
    const rows = [];
    let y = 55;
    for (let i = 0; i < entities.length; i += columns) {
        const row = entities.slice(i, i + columns);
        const height = 37 + Math.max(...row.map(entity => entity.fields.length)) * 20;
        rows.push(...row.map(({ name, fields }, col) => {
            const x = 12 + col * 270;
            return `<g><title>${xml([name, ...fields].join(' · '))}</title>` +
                `<rect x="${x}" y="${y}" width="258" height="${height}" rx="6" fill="#ffffff" stroke="#8c959f"/>` +
                text(x + 12, y + 23, truncate(name, 32), 'bold') + fields.map((field, j) => text(x + 12, y + 44 + j * 20, truncate(field, 34))).join('') + '</g>';
        }));
        y += height + 12;
    }
    if (relationships.length) {
        rows.push(text(12, y + 20, 'Relationships', 'bold'));
        y += 28;
        for (const { from, to, cardinality, label } of relationships) {
            const value = `${from}  ${cardinality}  ${to}  ·  ${label}`;
            rows.push(`<g><title>${xml(value)}</title>${text(12, y + 18, truncate(value, Math.floor(width / 7.4) - 3))}</g>`);
            y += 22;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y + 16}" viewBox="0 0 ${width} ${y + 16}">` +
        `<title>Data model diagram</title><rect width="100%" height="100%" fill="#f6f8fa"/>` +
        `<g font-family="system-ui,sans-serif" font-size="13">${text(12, 31, 'Data model diagram', 'bold')}${rows.join('')}</g></svg>\n`;
}
