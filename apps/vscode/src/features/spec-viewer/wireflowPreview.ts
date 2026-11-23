import { defaultTreeAdapter as tree, parse, type DefaultTreeAdapterTypes } from 'parse5';
import type { WireflowNode, WireflowPreview } from '../../protocol/wireflowPreview';

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
const HTML = 'http://www.w3.org/1999/xhtml';
const TYPES = new Map<string, Exclude<WireflowNode, string>['type']>([
    ['div', 'group'], ['section', 'group'], ['article', 'group'], ['aside', 'group'], ['fieldset', 'group'],
    ['h1', 'heading'], ['h2', 'heading'], ['h3', 'heading'], ['h4', 'heading'], ['h5', 'heading'], ['h6', 'heading'],
    ['legend', 'heading'], ['summary', 'heading'], ['p', 'paragraph'], ['blockquote', 'paragraph'],
    ['ul', 'list'], ['ol', 'sequence'], ['li', 'item'], ['details', 'group'], ['label', 'label'],
    ['a', 'label'], ['button', 'label'], ['option', 'label'], ['select', 'group'], ['form', 'group'],
    ['table', 'table'], ['caption', 'caption'], ['thead', 'table-head'], ['tbody', 'table-body'], ['tfoot', 'table-foot'],
    ['tr', 'row'], ['th', 'header'], ['td', 'cell'], ['pre', 'pre'], ['code', 'code'],
    ['span', 'inline'], ['em', 'inline'], ['strong', 'inline'], ['small', 'inline'],
]);
const attribute = (node: Element | undefined, name: string) => node?.attrs.find(item => item.name === name)?.value;
const shown = (node: Element) => attribute(node, 'hidden') === undefined && attribute(node, 'aria-hidden') !== 'true';
const child = (node: ParentNode | undefined, tag: string, matches: (element: Element) => boolean = () => true) =>
    node?.childNodes.find((item): item is Element =>
        tree.isElementNode(item) && item.namespaceURI === HTML && item.tagName === tag && shown(item) && matches(item));

export function wireflowPreview(path: string, content: string): WireflowPreview | null {
    if (!path.endsWith('/preview/wireflow.html')) return null;
    const html = child(parse(content), 'html');
    const fidelity = attribute(html, 'data-fidelity');
    if (fidelity !== 'low' && fidelity !== 'mid' && fidelity !== 'high') return null;
    const main = child(child(html, 'body'), 'main');
    let remaining = 700;
    let truncated = false;
    function project(nodes: ChildNode[], depth: number): WireflowNode[] {
        const result: WireflowNode[] = [];
        for (const node of nodes) {
            if (remaining < 1 || depth > 20) { truncated = true; break; }
            remaining--;
            if (tree.isTextNode(node)) {
                if (node.value.length > 4000) truncated = true;
                result.push(node.value.slice(0, 4000));
            } else if (tree.isElementNode(node) && node.namespaceURI === HTML && shown(node)) {
                if (node.tagName === 'br') result.push(' ');
                const type = TYPES.get(node.tagName);
                if (!type) continue;
                const children = project(node.childNodes, depth + 1);
                if (children.some(item => typeof item === 'string' ? item.trim() : true)) result.push({ type, children });
            }
        }
        return result;
    }
    const sections = (['design-surface', 'wireflow'] as const).flatMap(id => {
        const section = child(main, 'section', node => attribute(node, 'aria-labelledby') === id);
        if (!section) return [];
        const children = project(section.childNodes.filter(node => !tree.isElementNode(node) || attribute(node, 'id') !== id), 0);
        return children.some(item => typeof item === 'string' ? item.trim() : true) ? [{ id, children }] : [];
    });
    return sections.length ? { fidelity, sections, truncated } : null;
}
