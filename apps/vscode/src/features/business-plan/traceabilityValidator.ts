import {
    ALLOWED_SHORTCUTS,
    NODE_KINDS,
    STAGE_BY_KIND,
    VALIDATION_CHECK_IDS,
    type ApprovalStatus,
    type BusinessPlanApproval,
    type BusinessPlanClaim,
    type BusinessPlanGraph,
    type BusinessPlanLink,
    type BusinessPlanNode,
    type BusinessPlanPhaseId,
    type ClaimClassification,
    type NodeKind,
    type ProvenanceOrigin,
    type TaskRole,
    type ValidationCheckId,
    type ValidationCheckResult,
    type ValidationIssue,
    type ValidationReport,
} from '../../protocol/businessPlan';

export const MAX_GRAPH_BYTES = 2 * 1024 * 1024;

const ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const NODE_KIND_SET = new Set<string>(NODE_KINDS);
const CLAIM_CLASSIFICATIONS = new Set<ClaimClassification>([
    'fact',
    'evidence',
    'assumption',
    'estimate',
    'decision',
]);
const APPROVAL_STATUSES = new Set<ApprovalStatus>(['approved', 'pending', 'rejected']);
const PROVENANCE_ORIGINS = new Set<ProvenanceOrigin>(['synthetic', 'declared']);
const TASK_ROLES = new Set<TaskRole>(['measurement', 'delivery']);
const APPROVAL_REQUIRED_KINDS = new Set<NodeKind>([
    'business-plan',
    'prioritization-decision',
    'roadmap-item',
]);
const CLAIMS_REQUIRED_KINDS = new Set<NodeKind>([
    'business-case',
    'delivery-evidence',
    'outcome-measurement',
]);
const SHORTCUT_KEY_SET = new Set<string>(ALLOWED_SHORTCUTS.map(([from, to]) => `${from}->${to}`));

const CHECK_DESCRIPTIONS: Record<ValidationCheckId, { label: string; description: string }> = {
    schema: {
        label: 'Schema & Structure',
        description: 'Validates version, unique node IDs, required fields, sizes, and allowed properties.',
    },
    classification: {
        label: 'Claim Classification',
        description: 'Verifies facts, evidence, and decisions cite non-TBD sources and required nodes carry claims.',
    },
    duplicates: {
        label: 'Duplicate Objectives',
        description: 'Ensures objective summaries are distinct after normalization.',
    },
    orphans: {
        label: 'Orphans & Reachability',
        description: 'Ensures exactly one root business plan and that every node is reachable from it.',
    },
    traceability: {
        label: 'Traceability Chain',
        description: 'Checks forward backbone links, valid shortcuts, epic/roadmap links, and feature waivers.',
    },
    metrics: {
        label: 'Measurable Outcomes',
        description: 'Ensures every metric links to a measurement task and an outcome measurement on the same branch.',
    },
    approvals: {
        label: 'Human Approvals',
        description: 'Verifies business plans, prioritization decisions, and roadmap items have non-TBD human approvals.',
    },
    provenance: {
        label: 'Source Provenance',
        description: 'Ensures every node records its provenance origin (declared or synthetic) and non-TBD reference.',
    },
};

const NODE_ALLOWED_KEYS = new Set([
    'id',
    'kind',
    'summary',
    'claims',
    'approval',
    'waiver',
    'provenance',
    'rationale',
    'task-role',
]);
const TOP_ALLOWED_KEYS = new Set(['version', 'nodes', 'links']);
const CLAIM_ALLOWED_KEYS = new Set(['classification', 'text', 'basis']);
const APPROVAL_ALLOWED_KEYS = new Set(['status', 'owner', 'reference']);
const PROVENANCE_ALLOWED_KEYS = new Set(['origin', 'reference']);
const LINK_ALLOWED_KEYS = new Set(['from', 'to']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown, maxLen?: number): value is string {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    if (maxLen !== undefined && value.length > maxLen) return false;
    return true;
}

function isPlaceholder(value: unknown): boolean {
    if (typeof value !== 'string') return true;
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed.toUpperCase() === 'TBD';
}

function normalizeSummary(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseJsonStrict(raw: string): { value?: unknown; error?: string } {
    if (Buffer.byteLength(raw, 'utf8') > MAX_GRAPH_BYTES) {
        return { error: `Traceability graph exceeds ${MAX_GRAPH_BYTES} bytes.` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const dupKey = findDuplicateJsonKey(raw);
    if (dupKey) {
        return { error: `Duplicate JSON key "${dupKey}" is not allowed.` };
    }
    return { value: parsed };
}

/**
 * Lightweight recursive-descent scanner over already-valid JSON to catch duplicate
 * object keys (matching Python's `object_pairs_hook` check in `validate_business.py`).
 */
function findDuplicateJsonKey(raw: string): string | null {
    let i = 0;
    const len = raw.length;

    const skipWs = () => {
        while (i < len && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) {
            i++;
        }
    };

    const readString = (): string => {
        const start = i;
        i++;
        while (i < len) {
            const ch = raw[i];
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === '"') {
                i++;
                return JSON.parse(raw.slice(start, i)) as string;
            }
            i++;
        }
        return '';
    };

    const parseValue = (): string | null => {
        skipWs();
        if (i >= len) return null;
        const ch = raw[i];
        if (ch === '{') {
            i++;
            skipWs();
            const keys = new Set<string>();
            if (raw[i] === '}') {
                i++;
                return null;
            }
            while (i < len) {
                skipWs();
                const key = readString();
                if (keys.has(key)) return key;
                keys.add(key);
                skipWs();
                if (raw[i] === ':') i++;
                const dup = parseValue();
                if (dup) return dup;
                skipWs();
                if (raw[i] === ',') {
                    i++;
                    continue;
                }
                if (raw[i] === '}') {
                    i++;
                    return null;
                }
                break;
            }
            return null;
        }
        if (ch === '[') {
            i++;
            skipWs();
            if (raw[i] === ']') {
                i++;
                return null;
            }
            while (i < len) {
                const dup = parseValue();
                if (dup) return dup;
                skipWs();
                if (raw[i] === ',') {
                    i++;
                    continue;
                }
                if (raw[i] === ']') {
                    i++;
                    return null;
                }
                break;
            }
            return null;
        }
        if (ch === '"') {
            readString();
            return null;
        }
        while (i < len && !' \t\n\r,}]'.includes(raw[i])) {
            i++;
        }
        return null;
    };

    return parseValue();
}

export interface ParsedBusinessPlan {
    graph: BusinessPlanGraph | null;
    parseError?: string;
    report: ValidationReport;
}

export function parseAndValidateBusinessPlan(raw: string): ParsedBusinessPlan {
    const { value, error } = parseJsonStrict(raw);
    if (error) {
        const schemaIssue: ValidationIssue = { check: 'schema', message: error };
        return {
            graph: null,
            parseError: error,
            report: buildReport([schemaIssue]),
        };
    }
    const report = validateBusinessPlanObject(value);
    const graph = extractTypedGraph(value);
    return { graph, report };
}

function extractTypedGraph(value: unknown): BusinessPlanGraph | null {
    if (!isPlainObject(value)) return null;
    if (!Array.isArray(value.nodes) || !Array.isArray(value.links)) return null;
    const nodes: BusinessPlanNode[] = [];
    for (const rawNode of value.nodes) {
        if (!isPlainObject(rawNode)) continue;
        if (typeof rawNode.id !== 'string' || typeof rawNode.kind !== 'string' || !NODE_KIND_SET.has(rawNode.kind)) {
            continue;
        }
        const node: BusinessPlanNode = {
            id: rawNode.id,
            kind: rawNode.kind as NodeKind,
            summary: typeof rawNode.summary === 'string' ? rawNode.summary : '',
        };
        if (Array.isArray(rawNode.claims)) {
            node.claims = rawNode.claims
                .filter(isPlainObject)
                .map((c) => ({
                    classification: (typeof c.classification === 'string'
                        ? c.classification
                        : 'assumption') as ClaimClassification,
                    text: typeof c.text === 'string' ? c.text : '',
                    basis: typeof c.basis === 'string' ? c.basis : '',
                }));
        }
        if (isPlainObject(rawNode.approval)) {
            node.approval = {
                status: (typeof rawNode.approval.status === 'string'
                    ? rawNode.approval.status
                    : 'pending') as ApprovalStatus,
                owner: typeof rawNode.approval.owner === 'string' ? rawNode.approval.owner : '',
                reference: typeof rawNode.approval.reference === 'string' ? rawNode.approval.reference : '',
            };
        }
        if (isPlainObject(rawNode.waiver)) {
            node.waiver = {
                status: (typeof rawNode.waiver.status === 'string'
                    ? rawNode.waiver.status
                    : 'pending') as ApprovalStatus,
                owner: typeof rawNode.waiver.owner === 'string' ? rawNode.waiver.owner : '',
                reference: typeof rawNode.waiver.reference === 'string' ? rawNode.waiver.reference : '',
            };
        }
        if (isPlainObject(rawNode.provenance)) {
            node.provenance = {
                origin: (typeof rawNode.provenance.origin === 'string'
                    ? rawNode.provenance.origin
                    : 'declared') as ProvenanceOrigin,
                reference: typeof rawNode.provenance.reference === 'string' ? rawNode.provenance.reference : '',
            };
        }
        if (typeof rawNode.rationale === 'string') {
            node.rationale = rawNode.rationale;
        }
        if (rawNode['task-role'] === 'measurement' || rawNode['task-role'] === 'delivery') {
            node['task-role'] = rawNode['task-role'];
        }
        nodes.push(node);
    }

    const links: BusinessPlanLink[] = [];
    for (const rawLink of value.links) {
        if (!isPlainObject(rawLink)) continue;
        if (typeof rawLink.from === 'string' && typeof rawLink.to === 'string') {
            links.push({ from: rawLink.from, to: rawLink.to });
        }
    }

    return {
        version: typeof value.version === 'number' ? value.version : 1,
        nodes,
        links,
    };
}

export function validateBusinessPlanObject(data: unknown): ValidationReport {
    const issues: ValidationIssue[] = [];
    const add = (check: ValidationCheckId, message: string, nodeId?: string) => {
        issues.push({ check, message, nodeId });
    };

    if (!isPlainObject(data)) {
        add('schema', 'Root document must be a JSON object.');
        return buildReport(issues);
    }

    for (const key of Object.keys(data)) {
        if (!TOP_ALLOWED_KEYS.has(key)) {
            add('schema', `Unexpected top-level property "${key}".`);
        }
    }
    if (data.version !== 1) {
        add('schema', 'Top-level "version" must be integer 1.');
    }
    if (!Array.isArray(data.nodes)) {
        add('schema', 'Top-level "nodes" must be an array.');
    }
    if (!Array.isArray(data.links)) {
        add('schema', 'Top-level "links" must be an array.');
    }

    const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
    const rawLinks = Array.isArray(data.links) ? data.links : [];

    const nodesById = new Map<string, BusinessPlanNode>();

    rawNodes.forEach((raw, idx) => {
        if (!isPlainObject(raw)) {
            add('schema', `nodes[${idx}] must be an object.`);
            return;
        }
        for (const key of Object.keys(raw)) {
            if (!NODE_ALLOWED_KEYS.has(key)) {
                add('schema', `Node at index ${idx} has unexpected property "${key}".`, typeof raw.id === 'string' ? raw.id : undefined);
            }
        }
        const id = raw.id;
        const nodeIdLabel = typeof id === 'string' ? id : `nodes[${idx}]`;
        if (typeof id !== 'string' || id.length === 0 || id.length > 64 || !ID_PATTERN.test(id)) {
            add('schema', `Node "${nodeIdLabel}" has invalid id (expected UPPER-KEBAB, max 64 chars).`, typeof id === 'string' ? id : undefined);
        } else if (nodesById.has(id)) {
            add('schema', `Duplicate node id "${id}".`, id);
        }

        const kind = raw.kind;
        if (typeof kind !== 'string' || !NODE_KIND_SET.has(kind)) {
            add('schema', `Node "${nodeIdLabel}" has unknown kind "${String(kind)}".`, typeof id === 'string' ? id : undefined);
        }

        if (!isNonBlankString(raw.summary, 1000)) {
            add('schema', `Node "${nodeIdLabel}" must have a non-blank summary (1..1000 chars).`, typeof id === 'string' ? id : undefined);
        }

        if (raw.waiver !== undefined && kind !== 'feature') {
            add('schema', `Node "${nodeIdLabel}" has a waiver, which is only allowed on feature nodes.`, typeof id === 'string' ? id : undefined);
        }

        if (raw['task-role'] !== undefined) {
            if (kind !== 'task') {
                add('schema', `Node "${nodeIdLabel}" has task-role, which is only allowed on task nodes.`, typeof id === 'string' ? id : undefined);
            } else if (typeof raw['task-role'] !== 'string' || !TASK_ROLES.has(raw['task-role'] as TaskRole)) {
                add('schema', `Task "${nodeIdLabel}" has invalid task-role "${String(raw['task-role'])}".`, typeof id === 'string' ? id : undefined);
            }
        }

        if (raw.rationale !== undefined && !isNonBlankString(raw.rationale, 1000)) {
            add('schema', `Node "${nodeIdLabel}" rationale must be a non-blank string (max 1000 chars).`, typeof id === 'string' ? id : undefined);
        }

        if (raw.claims !== undefined) {
            if (!Array.isArray(raw.claims)) {
                add('schema', `Node "${nodeIdLabel}" claims must be an array.`, typeof id === 'string' ? id : undefined);
            } else {
                raw.claims.forEach((claim, cIdx) => {
                    if (!isPlainObject(claim)) {
                        add('schema', `Node "${nodeIdLabel}" claims[${cIdx}] must be an object.`, typeof id === 'string' ? id : undefined);
                        return;
                    }
                    for (const key of Object.keys(claim)) {
                        if (!CLAIM_ALLOWED_KEYS.has(key)) {
                            add('schema', `Node "${nodeIdLabel}" claims[${cIdx}] has unexpected property "${key}".`, typeof id === 'string' ? id : undefined);
                        }
                    }
                    if (typeof claim.classification !== 'string' || !CLAIM_CLASSIFICATIONS.has(claim.classification as ClaimClassification)) {
                        add('schema', `Node "${nodeIdLabel}" claims[${cIdx}] has invalid classification.`, typeof id === 'string' ? id : undefined);
                    }
                    if (!isNonBlankString(claim.text, 1000)) {
                        add('schema', `Node "${nodeIdLabel}" claims[${cIdx}] requires non-blank text.`, typeof id === 'string' ? id : undefined);
                    }
                    if (!isNonBlankString(claim.basis, 500)) {
                        add('schema', `Node "${nodeIdLabel}" claims[${cIdx}] requires non-blank basis.`, typeof id === 'string' ? id : undefined);
                    }
                });
            }
        }

        const validateApprovalShape = (field: 'approval' | 'waiver', obj: unknown) => {
            if (!isPlainObject(obj)) {
                add('schema', `Node "${nodeIdLabel}" ${field} must be an object.`, typeof id === 'string' ? id : undefined);
                return;
            }
            for (const key of Object.keys(obj)) {
                if (!APPROVAL_ALLOWED_KEYS.has(key)) {
                    add('schema', `Node "${nodeIdLabel}" ${field} has unexpected property "${key}".`, typeof id === 'string' ? id : undefined);
                }
            }
            if (typeof obj.status !== 'string' || !APPROVAL_STATUSES.has(obj.status as ApprovalStatus)) {
                add('schema', `Node "${nodeIdLabel}" ${field}.status must be approved, pending, or rejected.`, typeof id === 'string' ? id : undefined);
            }
            if (!isNonBlankString(obj.owner, 200)) {
                add('schema', `Node "${nodeIdLabel}" ${field}.owner must be a non-blank string.`, typeof id === 'string' ? id : undefined);
            }
            if (!isNonBlankString(obj.reference, 500)) {
                add('schema', `Node "${nodeIdLabel}" ${field}.reference must be a non-blank string.`, typeof id === 'string' ? id : undefined);
            }
        };

        if (raw.approval !== undefined) validateApprovalShape('approval', raw.approval);
        if (raw.waiver !== undefined) validateApprovalShape('waiver', raw.waiver);

        if (raw.provenance !== undefined) {
            if (!isPlainObject(raw.provenance)) {
                add('schema', `Node "${nodeIdLabel}" provenance must be an object.`, typeof id === 'string' ? id : undefined);
            } else {
                for (const key of Object.keys(raw.provenance)) {
                    if (!PROVENANCE_ALLOWED_KEYS.has(key)) {
                        add('schema', `Node "${nodeIdLabel}" provenance has unexpected property "${key}".`, typeof id === 'string' ? id : undefined);
                    }
                }
                if (typeof raw.provenance.origin !== 'string' || !PROVENANCE_ORIGINS.has(raw.provenance.origin as ProvenanceOrigin)) {
                    add('schema', `Node "${nodeIdLabel}" provenance.origin must be synthetic or declared.`, typeof id === 'string' ? id : undefined);
                }
                if (!isNonBlankString(raw.provenance.reference, 500)) {
                    add('schema', `Node "${nodeIdLabel}" provenance.reference must be a non-blank string.`, typeof id === 'string' ? id : undefined);
                }
            }
        }

        if (typeof id === 'string' && typeof kind === 'string' && NODE_KIND_SET.has(kind) && !nodesById.has(id)) {
            nodesById.set(id, {
                id,
                kind: kind as NodeKind,
                summary: typeof raw.summary === 'string' ? raw.summary : '',
                claims: Array.isArray(raw.claims) ? (raw.claims as BusinessPlanClaim[]) : undefined,
                approval: isPlainObject(raw.approval) ? (raw.approval as unknown as BusinessPlanApproval) : undefined,
                waiver: isPlainObject(raw.waiver) ? (raw.waiver as unknown as BusinessPlanApproval) : undefined,
                provenance: isPlainObject(raw.provenance)
                    ? {
                        origin: raw.provenance.origin as ProvenanceOrigin,
                        reference: typeof raw.provenance.reference === 'string' ? raw.provenance.reference : '',
                    }
                    : undefined,
                rationale: typeof raw.rationale === 'string' ? raw.rationale : undefined,
                'task-role': raw['task-role'] as TaskRole | undefined,
            });
        }
    });

    const validLinks: BusinessPlanLink[] = [];
    const seenLinks = new Set<string>();
    rawLinks.forEach((rawLink, idx) => {
        if (!isPlainObject(rawLink)) {
            add('schema', `links[${idx}] must be an object.`);
            return;
        }
        for (const key of Object.keys(rawLink)) {
            if (!LINK_ALLOWED_KEYS.has(key)) {
                add('schema', `links[${idx}] has unexpected property "${key}".`);
            }
        }
        if (typeof rawLink.from !== 'string' || typeof rawLink.to !== 'string') {
            add('schema', `links[${idx}] requires string "from" and "to" IDs.`);
            return;
        }
        const pairKey = `${rawLink.from}->${rawLink.to}`;
        if (seenLinks.has(pairKey)) {
            add('schema', `Duplicate link "${rawLink.from}" -> "${rawLink.to}".`, rawLink.to);
            return;
        }
        seenLinks.add(pairKey);
        validLinks.push({ from: rawLink.from, to: rawLink.to });
    });

    // Check 2: classification
    for (const node of nodesById.values()) {
        const claims = Array.isArray(node.claims) ? node.claims : [];
        if (CLAIMS_REQUIRED_KINDS.has(node.kind) && claims.length === 0) {
            add('classification', `${STAGE_BY_KIND[node.kind].label} "${node.id}" must include at least one classified claim.`, node.id);
        }
        for (const claim of claims) {
            if (
                (claim.classification === 'fact' || claim.classification === 'evidence' || claim.classification === 'decision') &&
                isPlaceholder(claim.basis)
            ) {
                add(
                    'classification',
                    `Node "${node.id}" has a ${claim.classification} claim without a concrete non-TBD basis.`,
                    node.id,
                );
            }
        }
    }

    // Check 3: duplicates (normalized objective summaries)
    const objectiveSummaries = new Map<string, string>();
    for (const node of nodesById.values()) {
        if (node.kind !== 'objective') continue;
        const norm = normalizeSummary(node.summary);
        if (!norm) continue;
        const prior = objectiveSummaries.get(norm);
        if (prior) {
            add('duplicates', `Objective "${node.id}" duplicates objective "${prior}" summary.`, node.id);
        } else {
            objectiveSummaries.set(norm, node.id);
        }
    }

    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    const backboneOutgoing = new Map<string, string[]>();
    for (const id of nodesById.keys()) {
        outgoing.set(id, []);
        incoming.set(id, []);
        backboneOutgoing.set(id, []);
    }

    for (const link of validLinks) {
        const fromNode = nodesById.get(link.from);
        const toNode = nodesById.get(link.to);
        if (!fromNode) {
            add('orphans', `Link source "${link.from}" does not exist in nodes.`, link.to);
            continue;
        }
        if (!toNode) {
            add('orphans', `Link target "${link.to}" does not exist in nodes.`, link.from);
            continue;
        }
        outgoing.get(link.from)!.push(link.to);
        incoming.get(link.to)!.push(link.from);
    }

    // Check 4: orphans
    const roots = Array.from(nodesById.values()).filter((n) => n.kind === 'business-plan');
    if (roots.length === 0) {
        add('orphans', 'Graph must contain a root "business-plan" node.');
    } else if (roots.length > 1) {
        for (const extra of roots.slice(1)) {
            add('orphans', `Graph contains multiple business-plan roots (extra: "${extra.id}").`, extra.id);
        }
    }

    if (roots.length >= 1) {
        const visited = new Set<string>();
        const queue: string[] = [roots[0].id];
        visited.add(roots[0].id);
        while (queue.length > 0) {
            const current = queue.shift()!;
            for (const next of outgoing.get(current) ?? []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
        for (const node of nodesById.values()) {
            if (!visited.has(node.id)) {
                add('orphans', `Node "${node.id}" (${node.kind}) is unreachable from root "${roots[0].id}".`, node.id);
            }
        }
    }

    // Check 5: traceability
    const shortcutLinks: BusinessPlanLink[] = [];
    for (const link of validLinks) {
        const fromNode = nodesById.get(link.from);
        const toNode = nodesById.get(link.to);
        if (!fromNode || !toNode) continue;

        const fromIdx = STAGE_BY_KIND[fromNode.kind].index;
        const toIdx = STAGE_BY_KIND[toNode.kind].index;
        if (toIdx <= fromIdx) {
            add(
                'traceability',
                `Link "${link.from}" (${fromNode.kind}) -> "${link.to}" (${toNode.kind}) must move forward in the traceability chain.`,
                link.to,
            );
            continue;
        }

        if (toIdx === fromIdx + 1) {
            backboneOutgoing.get(link.from)!.push(link.to);
        } else if (SHORTCUT_KEY_SET.has(`${fromNode.kind}->${toNode.kind}`)) {
            shortcutLinks.push(link);
        } else {
            add(
                'traceability',
                `Link "${link.from}" (${fromNode.kind}) -> "${link.to}" (${toNode.kind}) skips backbone stages and is not an allowed shortcut.`,
                link.to,
            );
        }
    }

    const backboneReachable = (startId: string, targetId: string): boolean => {
        if (startId === targetId) return true;
        const seen = new Set<string>([startId]);
        const stack = [startId];
        while (stack.length > 0) {
            const cur = stack.pop()!;
            for (const nxt of backboneOutgoing.get(cur) ?? []) {
                if (nxt === targetId) return true;
                if (!seen.has(nxt)) {
                    seen.add(nxt);
                    stack.push(nxt);
                }
            }
        }
        return false;
    };

    for (const shortcut of shortcutLinks) {
        if (!backboneReachable(shortcut.from, shortcut.to)) {
            add(
                'traceability',
                `Shortcut link "${shortcut.from}" -> "${shortcut.to}" must connect nodes on the same backbone branch.`,
                shortcut.to,
            );
        }
    }

    for (const node of nodesById.values()) {
        const parents = (incoming.get(node.id) ?? [])
            .map((id) => nodesById.get(id))
            .filter((n): n is BusinessPlanNode => Boolean(n));

        if (node.kind === 'epic') {
            if (!parents.some((p) => p.kind === 'objective')) {
                add('traceability', `Epic "${node.id}" must link directly from an objective.`, node.id);
            }
        }

        if (node.kind === 'roadmap-item') {
            const decisions = parents.filter((p) => p.kind === 'prioritization-decision');
            if (decisions.length === 0) {
                add('traceability', `Roadmap item "${node.id}" must trace from a prioritization-decision.`, node.id);
            } else if (!decisions.some((d) => !isPlaceholder(d.rationale))) {
                add(
                    'traceability',
                    `Roadmap item "${node.id}" requires a parent prioritization-decision with a non-TBD rationale.`,
                    node.id,
                );
            }
        }

        if (node.kind === 'feature') {
            const hasEpic = parents.some((p) => p.kind === 'epic');
            const hasObjective = parents.some((p) => p.kind === 'objective');
            const hasInitiative = parents.some((p) => p.kind === 'initiative');
            const hasApprovedWaiver =
                node.waiver !== undefined &&
                node.waiver.status === 'approved' &&
                !isPlaceholder(node.waiver.owner) &&
                !isPlaceholder(node.waiver.reference);

            if (!hasEpic) {
                add('traceability', `Feature "${node.id}" must link from an epic.`, node.id);
            }
            if (!(hasObjective && hasInitiative) && !hasApprovedWaiver) {
                add(
                    'traceability',
                    `Feature "${node.id}" must link from both an objective and an initiative, or carry an approved waiver.`,
                    node.id,
                );
            }
        }
    }

    // Check 6: metrics
    for (const node of nodesById.values()) {
        if (node.kind === 'metric') {
            const children = (outgoing.get(node.id) ?? [])
                .map((id) => nodesById.get(id))
                .filter((n): n is BusinessPlanNode => Boolean(n));

            const measurementTasks = children.filter(
                (c) => c.kind === 'task' && c['task-role'] === 'measurement',
            );
            if (measurementTasks.length === 0) {
                add(
                    'metrics',
                    `Metric "${node.id}" must link to a task with task-role "measurement".`,
                    node.id,
                );
            }

            const outcomes = children.filter((c) => c.kind === 'outcome-measurement');
            if (outcomes.length === 0) {
                add(
                    'metrics',
                    `Metric "${node.id}" must link to an outcome-measurement node.`,
                    node.id,
                );
            }
        }

        if (node.kind === 'outcome-measurement') {
            const linkedMetrics = (incoming.get(node.id) ?? [])
                .map((id) => nodesById.get(id))
                .filter((n): n is BusinessPlanNode => Boolean(n && n.kind === 'metric'));

            for (const metric of linkedMetrics) {
                const metricMeasurementTasks = (outgoing.get(metric.id) ?? [])
                    .map((id) => nodesById.get(id))
                    .filter(
                        (n): n is BusinessPlanNode =>
                            Boolean(n && n.kind === 'task' && n['task-role'] === 'measurement'),
                    );

                const onSameBranch = metricMeasurementTasks.some(
                    (task) => backboneReachable(metric.id, task.id) && backboneReachable(task.id, node.id),
                );
                if (!onSameBranch) {
                    add(
                        'metrics',
                        `Outcome "${node.id}" for metric "${metric.id}" requires a measurement task on the same backbone branch.`,
                        node.id,
                    );
                }
            }
        }
    }

    // Check 7: approvals
    for (const node of nodesById.values()) {
        if (APPROVAL_REQUIRED_KINDS.has(node.kind)) {
            if (!node.approval) {
                add('approvals', `${STAGE_BY_KIND[node.kind].label} "${node.id}" requires an approval record.`, node.id);
            } else if (node.approval.status !== 'approved') {
                add(
                    'approvals',
                    `${STAGE_BY_KIND[node.kind].label} "${node.id}" approval status is "${node.approval.status}" (requires "approved").`,
                    node.id,
                );
            } else if (isPlaceholder(node.approval.owner) || isPlaceholder(node.approval.reference)) {
                add(
                    'approvals',
                    `${STAGE_BY_KIND[node.kind].label} "${node.id}" approval must specify a non-TBD owner and reference.`,
                    node.id,
                );
            }
        }

        if (node.waiver && node.waiver.status === 'approved') {
            if (isPlaceholder(node.waiver.owner) || isPlaceholder(node.waiver.reference)) {
                add('approvals', `Feature "${node.id}" waiver must specify a non-TBD owner and reference.`, node.id);
            }
        }
    }

    // Check 8: provenance
    for (const node of nodesById.values()) {
        if (!node.provenance) {
            add('provenance', `Node "${node.id}" is missing a provenance record.`, node.id);
        } else if (isPlaceholder(node.provenance.reference)) {
            add('provenance', `Node "${node.id}" provenance.reference must not be blank or TBD.`, node.id);
        }
    }

    return buildReport(issues);
}

function buildReport(issues: ValidationIssue[]): ValidationReport {
    const byCheck = new Map<ValidationCheckId, ValidationIssue[]>();
    for (const id of VALIDATION_CHECK_IDS) {
        byCheck.set(id, []);
    }
    for (const issue of issues) {
        byCheck.get(issue.check)!.push(issue);
    }

    const checks: ValidationCheckResult[] = VALIDATION_CHECK_IDS.map((id) => {
        const checkIssues = byCheck.get(id)!;
        return {
            id,
            label: CHECK_DESCRIPTIONS[id].label,
            description: CHECK_DESCRIPTIONS[id].description,
            passed: checkIssues.length === 0,
            issues: checkIssues,
        };
    });

    return {
        passed: issues.length === 0,
        errorCount: issues.length,
        checks,
        issues,
    };
}

export function inferCurrentPhase(graph: BusinessPlanGraph | null): BusinessPlanPhaseId {
    if (!graph || graph.nodes.length === 0) return 'plan';
    const kinds = new Set<NodeKind>(graph.nodes.map((n) => n.kind));
    if (kinds.has('delivery-evidence') || kinds.has('outcome-measurement')) {
        return 'outcomes';
    }
    if (
        kinds.has('epic') ||
        kinds.has('feature') ||
        kinds.has('prd') ||
        kinds.has('specification') ||
        kinds.has('implementation-plan') ||
        kinds.has('task') ||
        kinds.has('github-issue')
    ) {
        return 'delivery';
    }
    if (
        kinds.has('objective') ||
        kinds.has('metric') ||
        kinds.has('initiative') ||
        kinds.has('business-case') ||
        kinds.has('prioritization-decision') ||
        kinds.has('roadmap-item')
    ) {
        return 'strategy';
    }
    return 'plan';
}
