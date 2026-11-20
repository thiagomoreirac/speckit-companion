export const PHASES = [
    ['intent', 'Intent & discovery', ['intent', 'ideas', 'intake']],
    ['governance', 'Product & governance', ['constitution', 'product', 'decisions']],
    ['specification', 'Specification', ['specify', 'clarify', 'design']],
    ['planning', 'Roadmap & planning', ['roadmap', 'plan', 'tasks']],
    ['delivery', 'Implementation', ['implement', 'sync']],
    ['evidence', 'Verification & release', ['verify', 'release', 'archive']],
];

const stages = {
    intent: ['User & product intent', [], ['Intent statement']],
    ideas: ['Ideas & discovery', ['Intent statement'], ['Discovery notes']],
    intake: ['Intake & OKR framing', ['Discovery notes'], ['Source evidence']],
    constitution: ['Constitution & fragments', ['Principles'], ['.specify/memory/constitution.md'], 'confirm'],
    product: ['Product definition & changes', ['Accepted product baseline'], ['Product change proposal'], 'confirm'],
    decisions: ['Decisions & epics', ['Product change proposal'], ['Decision and dependency references']],
    specify: ['Specify', ['Intent statement', 'Source evidence'], ['spec.md']],
    clarify: ['Clarify', ['spec.md'], ['spec.md']],
    design: ['Design sources', ['spec.md'], ['Design references']],
    roadmap: ['Roadmap & reconciliation', ['Epic references', 'Run evidence'], ['Roadmap references'], 'confirm'],
    plan: ['Plan', ['spec.md'], ['plan.md', 'research.md', 'data-model.md']],
    tasks: ['Tasks', ['plan.md'], ['tasks.md']],
    implement: ['Implement', ['tasks.md'], ['Implementation', 'tasks.md']],
    sync: ['GitHub Projects & Issues', ['Feature and task references'], ['External project state'], 'confirm'],
    verify: ['Verification & quality gates', ['Implementation'], ['Checklists', 'Verification evidence']],
    release: ['Release evidence', ['Verification evidence'], ['Release evidence'], 'confirm'],
    archive: ['Archive', ['Release evidence'], ['Archive record'], 'confirm'],
};

const extension = (id, name, category, stage, source, authority, inputs, outputs, options = {}) => ({
    id: `extension:${id}`, key: id, name, category, stage: `stage:${stage}`, source, authority, inputs, outputs,
    kind: 'Extensions', effect: 'local-write', approval: 'manual', mode: 'primary', ...options,
});

export const INTEGRATIONS = [
    extension('companion', 'SpecKit Companion', 'Run control', 'implement', 'SpecKit Companion project', 'Run record and dispatch', ['Spec and task state'], ['**/.spec-context.json']),
    extension('pdac', 'Product Definition as Code (PDaC)', 'Product grounding', 'product', 'github.com/juangcarmona/productshape', 'Delivery grounding', ['Accepted product definition'], ['Product citations']),
    extension('pdac-product', 'PDaC Product', 'Product changes', 'product', 'github.com/juangcarmona/productshape', 'Canonical product definition', ['Product change request', 'Product citations'], ['Accepted product definition'], { approval: 'confirm', requires: ['extension:pdac'] }),
    extension('charter', 'Charter', 'Governance', 'constitution', 'github.com/Fyloss/spec-kit-charter', 'Constitution composition', ['Charter fragments'], ['.specify/memory/constitution.md'], { approval: 'confirm' }),
    extension('adrkit', 'adrkit', 'Decision memory', 'decisions', 'github.com/mbeacom/adrkit', 'Accepted ADRs', ['Plan and decisions'], ['ADR ledger'], { approval: 'confirm' }),
    extension('epic', 'Epic', 'Cross-feature coordination', 'decisions', 'github.com/pmckeown/spec-kit-epic', 'Epic facts and feature slicing', ['Shared decisions and dependencies'], ['Epic ledger']),
    extension('roadmap', 'Roadmap', 'Cross-feature planning', 'roadmap', 'github.com/srobroek/speckit-roadmap', 'Durable roadmap', ['Epic ledger', 'Status reconciliation'], ['Roadmap ledger'], { approval: 'confirm' }),
    extension('spec-status', 'Spec Status', 'Status reconciliation', 'roadmap', 'github.com/tosin2013/spec-status', 'Status reconciliation', ['**/.spec-context.json'], ['Reconciliation evidence'], { approval: 'confirm' }),
    extension('prespec', 'Pre-Spec Cards', 'Exploratory framing', 'ideas', 'github.com/bendlikeabamboo/pre-spec', 'Exploratory problem framing', ['Intent statement'], ['Problem framing cards']),
    extension('okr', 'OKR Bets', 'Outcome measurement', 'intake', 'github.com/juanl/spec-kit-okr', 'Hypotheses and bet verdicts', ['Problem framing cards', 'Key results'], ['Bet hypothesis and verdict']),
    extension('intake', 'Intake', 'Source capture', 'intake', 'github.com/bigsmartben/spec-kit-intake', 'Source provenance', ['Raw stakeholder sources'], ['Normalized sources and clarification evidence']),
    extension('figma-starter', 'Figma Starter', 'Screen import', 'design', 'github.com/OmneWave/spec-kit-figma-starter', 'Screen-to-spec import', ['Figma screens'], ['Screen-derived specification']),
    extension('figma', 'Spec Kit Figma', 'Design context', 'design', 'github.com/Fyloss/spec-kit-figma', 'Design context and tokens', ['Figma sources'], ['Design context and tokens'], { mode: 'manual' }),
    extension('preview', 'Preview', 'Exploratory design', 'design', 'github.com/bigsmartben/spec-kit-preview', 'Exploratory previews', ['spec.md'], ['Exploratory HTML previews']),
    extension('wireframe', 'Wireframe', 'Visual review', 'design', 'github.com/TortoiseWolfe/spec-kit-extension-wireframe', 'Reviewed visual artifacts', ['spec.md'], ['Reviewed SVG wireframes'], { approval: 'confirm' }),
    extension('illustrate', 'Illustrate', 'Technical diagrams', 'design', 'github.com/samykabu/sanduq', 'General diagrams', ['Technical and product descriptions'], ['General diagrams']),
    extension('data-model-diagram', 'Data Model Diagram', 'Schema visualization', 'plan', 'github.com/benizzio/spec-kit-data-model-diagram', 'Model diagrams', ['data-model.md'], ['Model diagrams']),
    extension('agent-assign', 'Agent Assign', 'Task routing', 'tasks', 'github.com/xymelon/spec-kit-agent-assign', 'Task-to-agent assignments', ['tasks.md', 'Claude Code agent profiles'], ['**/agent-assignments.yml'], { mode: 'manual', dispatchHandoff: 'Review assignments in the feature’s Tasks tab. Agent Assign commands run in Claude Code, not through the Copilot canvas.' }),
    extension('ghp', 'GHP', 'Human-gated story lifecycle', 'sync', 'github.com/praveenlavu/spec-kit-ghp', 'GitHub Project/Issue writer', ['Approved stories'], ['GitHub Projects / Issues'], { effect: 'external-write', approval: 'confirm' }),
    extension('project', 'GitHub Project Lifecycle Sync', 'Project synchronization', 'sync', 'github.com/samykabu/sanduq', 'GitHub Project/Issue writer', ['Feature and task state'], ['GitHub Projects / Issues'], { effect: 'external-write', approval: 'confirm', mode: 'manual' }),
    extension('docguard', 'DocGuard', 'Documentation assurance', 'verify', 'github.com/raccioly/docguard', 'Documentation drift enforcement', ['Specs, docs and advisory findings'], ['Consistency enforcement report']),
];

export const INTEGRATION_LINKS = [
    ['pdac', 'pdac-product', 'Delivery grounding'], ['prespec', 'okr', 'Problem framing'], ['intake', 'okr', 'Source evidence'],
    ['epic', 'roadmap', 'Epic references'], ['spec-status', 'roadmap', 'Status reconciliation'],
    ['roadmap', 'companion', 'Roadmap data'], ['spec-status', 'companion', 'Status evidence'],
    ['figma', 'figma-starter', 'Design context'], ['preview', 'wireframe', 'Exploratory reference'],
    ...['pdac', 'adrkit', 'spec-status', 'companion'].map(id => [id, 'docguard', 'Advisory evidence']),
];

export const CORE_COMMANDS = {
    constitution: [['constitution', 'Draft constitution proposal', 'confirm']],
    specify: [['specify', 'Create specification', 'manual']],
    clarify: [['clarify', 'Clarify specification', 'manual']],
    plan: [['plan', 'Create plan', 'manual']],
    tasks: [['tasks', 'Generate tasks', 'manual']],
    implement: [['implement', 'Implement tasks', 'manual']],
    verify: [['checklist', 'Generate checklist', 'manual'], ['analyze', 'Analyze consistency', 'manual']],
    archive: [['mark-complete', 'Mark feature complete', 'confirm']],
};

export const MANAGEMENT = ['Presets', 'Workflows', 'Workflow steps', 'Extensions', 'Bundles', 'Catalogs', 'Hooks', 'Commands and skills', 'Constitution and Charter', 'Templates and schemas', 'Features and specs', 'Versions and sources'];
export const AUTOMATIC_HOOKS = ['hook', 'native-hook', 'embedded-hook'];

export function validScope(scope) {
    return typeof scope === 'string' && scope.length <= 240 &&
        scope.split('/').every(part => /^[a-z0-9_-][a-z0-9_.-]*$/i.test(part) && !part.endsWith('.'));
}

export function scopeProblem(primary, secondary, decision, edges) {
    if (!primary || !secondary || primary.health || secondary.health ||
        [primary, secondary].some(node => !node.installed || node.fixedAuthority || node.effect !== 'local-write' || !node.authority) ||
        primary.authority.toLowerCase() !== secondary.authority.toLowerCase()) {
        return 'Scoped ownership requires two installed, healthy local integrations declaring the same non-canonical concern.';
    }
    const scopes = [decision.primaryScope, decision.secondaryScope];
    if (!scopes.every(validScope)) return 'Enter two repository-relative directory scopes without wildcards.';
    const [left, right] = scopes.map(scope => `${scope.toLowerCase()}/`);
    if (left.startsWith(right) || right.startsWith(left)) return 'The directory scopes overlap.';
    if ([primary, secondary].some((node, index) => !node.declaredWrites?.length || node.declaredWrites.some(path =>
        !path.toLowerCase().startsWith(`${scopes[index].toLowerCase()}/`) ||
        !path.split('/').every(part => /^[a-z0-9_*.-]+$/i.test(part) && !['.', '..'].includes(part) && !part.endsWith('.'))))) {
        return 'Every declared output pattern must be inside its assigned directory, with no parent paths or alternate glob syntax.';
    }
    if (edges.some(edge => edge.active && AUTOMATIC_HOOKS.includes(edge.kind) && [primary.id, secondary.id].includes(edge.owner))) {
        return 'Disable automatic hooks before using a scoped ownership decision. A declaration is not an execution sandbox.';
    }
    return null;
}

export function lifecycleNodes() {
    return PHASES.flatMap(([phase, , keys]) => keys.map(key => {
        const [name, inputs, outputs, approval = 'none'] = stages[key];
        return {
            id: `stage:${key}`, key, name, kind: 'Lifecycle', category: 'Lifecycle stage', phase,
            state: 'available', active: true, source: 'Companion lifecycle map', authority: 'Lifecycle checkpoint',
            inputs, outputs, approval, effect: CORE_COMMANDS[key] ? 'local-write' : 'read-only',
            artifacts: [], commands: (CORE_COMMANDS[key] ?? []).map(([id, name, approval]) => ({ id, name, approval })),
        };
    }));
}

export function hookStage(event) {
    const key = event.replace(/^(before|after)[_.-]/, '').split(/[.:]/)[0];
    return ({ checklist: 'verify', analyze: 'verify', converge: 'verify', bug: 'implement', taskstoissues: 'sync', on_prompt: 'intent', on_stop: 'archive' })[key]
        ?? (Object.hasOwn(stages, key) ? key : 'implement');
}

const normalize = command => command.toLowerCase().replace(/^\/|[.]/g, match => match === '.' ? '-' : '');
const pair = (groups, key, member) => {
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(member.id, member);
};

function artifactOverlap(left, right) {
    if (left === right) return true;
    if (!left.includes('*') && !right.includes('*')) return false;
    if (left.length > 420 || right.length > 420) return true;
    const intersects = (a, b, wildcard, compatible) => {
        const pending = [[0, 0]], visited = new Set();
        while (pending.length) {
            const [i, j] = pending.pop();
            if (i === a.length && j === b.length) return true;
            const state = `${i}:${j}`;
            if (visited.has(state)) continue;
            visited.add(state);
            if (a[i] === wildcard) pending.push([i + 1, j]);
            if (b[j] === wildcard) pending.push([i, j + 1]);
            if (i === a.length || j === b.length) continue;
            if (a[i] === wildcard) pending.push([i, j + 1]);
            else if (b[j] === wildcard) pending.push([i + 1, j]);
            else if (compatible(a[i], b[j])) pending.push([i + 1, j + 1]);
        }
        return false;
    };
    // A globstar can consume directories; a star in a filename can't cross a slash.
    return intersects(left.split('/'), right.split('/'), '**', (a, b) =>
        a === b || intersects(a, b, '*', (x, y) => x === y));
}

function cycles(edges) {
    const outgoing = new Map();
    for (const edge of edges) {
        if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
        outgoing.get(edge.source).push(edge);
    }
    const visited = new Set(), active = new Map(), path = [], found = new Map();
    function visit(id) {
        if (visited.has(id)) return;
        visited.add(id);
        active.set(id, path.length);
        for (const edge of outgoing.get(id) ?? []) {
            path.push(edge);
            if (active.has(edge.target)) {
                const loop = path.slice(active.get(edge.target));
                found.set(loop.map(item => item.id).sort().join('|'), loop);
            } else visit(edge.target);
            path.pop();
        }
        active.delete(id);
    }
    for (const id of outgoing.keys()) visit(id);
    return [...found.values()];
}

export function validateGraph(nodes, edges, initial = [], decisions = []) {
    const findings = [...initial];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const issue = (code, severity, message, nodeIds = [], edgeIds = []) => findings.push({ code, severity, message, nodeIds, edgeIds });
    const owners = new Map(), writers = new Map(), commands = new Map(), hooks = new Map(), core = new Map();
    for (const node of nodes.filter(item => item.kind === 'Lifecycle')) {
        for (const command of node.commands) core.set(normalize(`speckit.${command.id}`), node);
    }
    for (const node of nodes) {
        if (node.health) issue(node.health.code, 'blocked', node.health.message, [node.id]);
        for (const dependency of node.requires ?? []) {
            const prerequisite = byId.get(dependency);
            const installedWorkflow = node.kind === 'Bundles' && prerequisite?.kind === 'Workflows' && prerequisite.installed;
            if ((!prerequisite?.active && !installedWorkflow) || prerequisite?.health) issue('missing-dependency', node.active ? 'blocked' : 'advisory', `${node.name} needs ${prerequisite?.name ?? dependency}.`, [node.id, dependency],
                edges.filter(edge => edge.kind === 'dependency' && edge.target === node.id && edge.source === dependency).map(edge => edge.id));
        }
        if (!node.active || node.kind !== 'Extensions') continue;
        for (const cmd of node.commands) {
            for (const name of new Set([cmd.id, ...(cmd.aliases ?? [])].map(normalize))) {
                pair(commands, name, { id: `${node.id}:${cmd.id}`, node });
            }
        }
        if (node.mode !== 'primary') continue;
        if (node.authority) pair(owners, node.authority.toLowerCase(), node);
        for (const output of node.writes ?? node.outputs) pair(writers, output.toLowerCase(), node);
    }
    for (const [key, members] of owners) {
        const participants = [...members.values()];
        for (const [index, left] of participants.entries()) {
            for (const right of participants.slice(index + 1)) {
                const scoped = decisions.some(decision => decision.strategy === 'scoped' &&
                    ((decision.primary === left.key && decision.secondary === right.key && !scopeProblem(left, right, decision, edges)) ||
                     (decision.primary === right.key && decision.secondary === left.key && !scopeProblem(right, left, decision, edges))));
                if (!scoped) issue('authority-conflict', 'blocked', `Competing owners: ${key}. Choose one owner or disable the competing integration or hook.`, [left.id, right.id]);
            }
        }
    }
    for (const [key, members] of writers) if (members.size > 1) issue('artifact-writers', 'blocked', `Multiple artifact writers: ${key}.`, [...members.keys()]);
    const patterns = [...writers.keys()];
    for (const [index, left] of patterns.entries()) {
        for (const right of patterns.slice(index + 1)) {
            if (!artifactOverlap(left, right)) continue;
            const ids = [...new Set([...writers.get(left).keys(), ...writers.get(right).keys()])];
            if (ids.length > 1) issue('artifact-writers', 'blocked', `Artifact patterns may overlap: ${left} and ${right}.`, ids);
        }
    }
    for (const [name, members] of commands) {
        if (members.size > 1 || core.has(name)) issue('duplicate-command', 'blocked', `Duplicate command or alias: ${name}.`,
            [...new Set([...members.values()].map(item => item.node.id).concat(core.get(name)?.id ?? []))]);
    }
    for (const edge of edges) {
        if (!byId.has(edge.source) || !byId.has(edge.target)) issue('broken-reference', edge.active ? 'blocked' : 'advisory', `Unresolved reference: ${edge.label}.`, [edge.source, edge.target], [edge.id]);
        if (!['hook', 'native-hook'].includes(edge.kind) || !edge.active) continue;
        pair(hooks, `${edge.kind}:${edge.nativeLayer ?? ''}:${edge.hook}`, edge);
        const owner = byId.get(edge.owner);
        if (!owner?.active || owner.health || (edge.command && !owner.commands?.some(command => command.id === edge.command))) {
            issue('hook-prerequisite', 'blocked', `Hook ${edge.hook} has no ready provider for ${edge.command ?? owner?.name ?? edge.owner}.`, [edge.owner], [edge.id]);
        } else if (['external-write', 'unknown'].includes(edge.effect) || edge.approval === 'confirm') {
            issue('unguarded-hook', 'blocked', `${edge.hook} can run ${owner.name} outside the canvas approval boundary. Disable the hook and use an explicitly reviewed action.`, [owner.id], [edge.id]);
        }
    }
    for (const members of hooks.values()) {
        const edgesAtEvent = [...members.values()];
        const event = edgesAtEvent[0].hook;
        const duplicates = new Set(edgesAtEvent.map(edge => `${edge.owner}:${edge.command ?? edge.label}`)).size < edgesAtEvent.length;
        if (edgesAtEvent.length > 1) issue('parallel-hooks', duplicates ? 'blocked' : 'advisory', `${edgesAtEvent.length} enabled hooks at ${event}; ${duplicates ? 'a command is duplicated' : 'review their order and effects'}.`,
            [...new Set(edgesAtEvent.map(edge => edge.owner))], edgesAtEvent.map(edge => edge.id));
    }
    for (const loop of cycles(edges.filter(edge => edge.active && ['dependency', 'step', 'call'].includes(edge.kind)))) {
        issue('cycle', 'blocked', 'Circular workflow or hook dependency.', [...new Set(loop.flatMap(edge => [edge.source, edge.target]))], loop.map(edge => edge.id));
    }
    const dependents = new Map();
    for (const edge of edges) {
        if (!edge.active || !['dependency', 'step', 'command', 'contains', 'call'].includes(edge.kind)) continue;
        const [from, to] = ['contains', 'call'].includes(edge.kind) ? [edge.target, edge.source] : [edge.source, edge.target];
        if (!dependents.has(from)) dependents.set(from, []);
        dependents.get(from).push({ to, edge });
    }
    const blocked = new Set(findings.filter(item => item.severity === 'blocked').flatMap(item => item.nodeIds));
    for (const from of blocked) {
        for (const { to, edge } of dependents.get(from) ?? []) {
            if (blocked.has(to) || !byId.get(to)?.active) continue;
            issue('blocked-prerequisite', 'blocked', `${byId.get(to).name} depends on blocked ${byId.get(from)?.name ?? from}.`, [to], [edge.id]);
            blocked.add(to);
        }
    }
    return findings;
}

export function graphDiff(before, after) {
    const compare = (oldItems, newItems) => {
        const old = new Map(oldItems.map(item => [item.id, item]));
        const next = new Map(newItems.map(item => [item.id, item]));
        return {
            added: newItems.filter(item => !old.has(item.id)),
            removed: oldItems.filter(item => !next.has(item.id)),
            changed: newItems.flatMap(item => old.has(item.id) && JSON.stringify(old.get(item.id)) !== JSON.stringify(item) ? [{ before: old.get(item.id), after: item }] : []),
        };
    };
    return { nodes: compare(before.nodes, after.nodes), edges: compare(before.edges, after.edges) };
}
