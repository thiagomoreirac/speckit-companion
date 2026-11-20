const svgNS = 'http://www.w3.org/2000/svg';
const elements = new Set(('g defs marker clipPath linearGradient radialGradient stop path rect circle ellipse line polyline polygon ' +
    'text tspan title desc').split(' '));
const textElements = new Set(['text', 'tspan', 'title', 'desc']);
const attributes = new Set(('viewBox width height x y x1 y1 x2 y2 cx cy r rx ry fx fy fr dx dy points d transform ' +
    'refX refY markerWidth markerHeight markerUnits orient preserveAspectRatio gradientUnits gradientTransform clipPathUnits ' +
    'offset stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset ' +
    'fill-rule clip-rule fill-opacity stroke-opacity stop-opacity opacity font-size font-weight font-style ' +
    'font-family text-anchor dominant-baseline alignment-baseline letter-spacing vector-effect').split(' '));
const id = /^[a-zA-Z_][\w.-]{0,79}$/;
const fragment = /^url\(\s*#[a-zA-Z_][\w.-]{0,79}\s*\)$/;
const color = /^(?:[a-zA-Z]+|#[\da-fA-F]{3,8}|(?:rgb|hsl)a?\([\d.,%+\s/-]+\))$/;
const paint = new Set(['fill', 'stroke', 'stop-color', 'color']);
const references = new Set(['marker-start', 'marker-mid', 'marker-end', 'clip-path']);

export function staticDrawings(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const results = [];
    for (const source of template.content.querySelectorAll('svg')) {
        if (results.length >= 8) break;
        if (source.namespaceURI !== svgNS || source.parentElement?.closest('svg, math')) continue;
        const viewBox = source.getAttribute('viewBox')?.trim().split(/[\s,]+/);
        const size = viewBox?.every(value => value && Number.isFinite(Number(value))) && viewBox.length === 4
            ? viewBox.slice(2).map(Number) : ['width', 'height'].map(name => Number(source.getAttribute(name)));
        if (!size.every(value => value > 0 && value <= 8192) || Math.max(...size) / Math.min(...size) > 40) continue;
        let remaining = 1200, hasShape = false, limited = false;
        function rebuild(node, depth) {
            if (--remaining < 0 || depth > 24) { limited = true; return null; }
            const name = node.localName;
            const element = document.createElementNS(svgNS, name);
            for (const { name: key, value, namespaceURI } of node.attributes) {
                if (namespaceURI) continue;
                const safe = key === 'id' ? id.test(value)
                    : paint.has(key) ? color.test(value) || fragment.test(value)
                    : references.has(key) ? fragment.test(value)
                    : attributes.has(key) && value.length <= (key === 'd' || key === 'points' ? 16_384 : 160);
                if (safe) element.setAttribute(key, value);
            }
            if (!['svg', 'g', 'defs', 'marker', 'clipPath', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc'].includes(name)) hasShape = true;
            for (const child of node.childNodes) {
                if (limited) break;
                if (child.nodeType === Node.TEXT_NODE && textElements.has(name)) element.append(document.createTextNode(child.nodeValue));
                else if (child.namespaceURI === svgNS && elements.has(child.localName)) {
                    const copy = rebuild(child, depth + 1);
                    if (copy) element.append(copy);
                }
            }
            return element;
        }
        const drawing = rebuild(source, 0);
        if (!hasShape || limited) continue;
        if (viewBox?.length !== 4 || !viewBox.every(value => value && Number.isFinite(Number(value)))) drawing.removeAttribute('viewBox');
        drawing.setAttribute('width', String(size[0]));
        drawing.setAttribute('height', String(size[1]));
        const accessibleText = name => [...drawing.children].find(node => node.localName === name)?.textContent.trim().slice(0, 1000);
        results.push({
            title: accessibleText('title'), description: accessibleText('desc'),
            url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(drawing))}`,
        });
    }
    return results;
}

export function flowchartDrawing({ nodes, edges, direction }) {
    function svg(tag, attrs, ...children) {
        const element = document.createElementNS(svgNS, tag);
        for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
        element.append(...children);
        return element;
    }

    const horizontal = direction === 'horizontal';
    const layers = [];
    for (const node of nodes) (layers[node.rank] ??= []).push(node);
    const primarySize = horizontal ? 184 : 76;
    const crossSize = horizontal ? 76 : 184;
    const gap = 58, crossGap = 22, inset = 16;
    const crossSpan = count => count * (crossSize + crossGap) - crossGap;
    const breadth = Math.max(...layers.map(layer => crossSpan(layer.length)));
    const primary = inset * 2 + layers.length * (primarySize + gap) - gap;
    const points = new Map();
    const pair = (along, across) => horizontal ? [along, across] : [across, along];
    layers.forEach((layer, rank) => layer.forEach((node, slot) => points.set(node.id, {
        along: inset + rank * (primarySize + gap),
        across: inset + (breadth - crossSpan(layer.length)) / 2 + slot * (crossSize + crossGap),
        node,
    })));

    let detours = 0;
    const paths = edges.map(({ from, to, label, dashed }) => {
        const a = points.get(from), b = points.get(to);
        const start = a.along + primarySize, end = b.along;
        const ac = a.across + crossSize / 2, bc = b.across + crossSize / 2;
        const mid = start + gap / 2;
        // Keep connectors that skip a layer outside the node area.
        const route = b.node.rank === a.node.rank + 1
            ? `C ${pair(mid, ac)} ${pair(mid, bc)} ${pair(end, bc)}`
            : (() => {
                const lane = inset + breadth + 14 + detours++ * 10;
                return `L ${pair(mid, ac)} ${pair(mid, lane)} ${pair(end - gap / 2, lane)} ${pair(end - gap / 2, bc)} ${pair(end, bc)}`;
            })();
        return svg('g', {},
            svg('path', { d: `M ${pair(start, ac)} ${route}`, class: 'sb-flowchart-line', ...(dashed ? { 'stroke-dasharray': '5 4' } : {}) },
                ...(label ? [svg('title', {}, label)] : [])),
            svg('polygon', { points: [pair(end, bc), pair(end - 8, bc - 4), pair(end - 8, bc + 4)].join(' '),
                class: 'sb-flowchart-tip' }));
    });
    const length = breadth + inset * 2 + (detours ? 8 + detours * 10 : 0);
    const [width, height] = pair(primary, length);
    return svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', class: 'sb-flowchart-diagram' },
        ...paths, ...[...points.values()].map(({ along, across, node }) => {
            const [x, y] = pair(along, across);
            const w = 184, h = 76;
            const cut = node.kind === 'decision' ? 16 : 0;
            const shape = cut ? svg('polygon', { points: `${x + cut},${y} ${x + w - cut},${y} ${x + w},${y + h / 2} ${x + w - cut},${y + h} ${x + cut},${y + h} ${x},${y + h / 2}`,
                class: 'sb-flowchart-node sb-flowchart-decision' })
                : svg('rect', { x, y, width: w, height: h, rx: 5, class: 'sb-flowchart-node' });
            const label = document.createElement('div');
            label.className = 'sb-flowchart-label';
            label.dir = 'auto';
            label.textContent = node.label;
            return svg('g', {}, svg('title', {}, node.label), shape,
                svg('foreignObject', { x: x + 10 + cut, y: y + 6, width: w - 20 - 2 * cut, height: h - 12 }, label));
        }));
}
