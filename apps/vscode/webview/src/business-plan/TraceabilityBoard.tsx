import { useMemo, useState } from 'preact/hooks';
import type {
    BusinessPlanGraph,
    BusinessPlanLink,
    BusinessPlanNode,
    BusinessPlanPhaseId,
    ClaimClassification,
    NodeKind,
    ValidationIssue,
} from '../../../src/protocol/businessPlan';
import {
    BUSINESS_PLAN_PHASES,
    STAGE_BY_KIND,
    STAGE_META,
} from '../../../src/protocol/businessPlan';

export interface TraceabilityBoardProps {
    graph: BusinessPlanGraph;
    mode: 'dossier' | 'pipeline';
    selectedPhaseFilter: BusinessPlanPhaseId | 'all';
    selectedNodeId: string | null;
    issuesByNodeId: Map<string, ValidationIssue[]>;
    onSelectNode: (nodeId: string) => void;
    onSelectPhase: (phase: BusinessPlanPhaseId | 'all') => void;
    onRunStep: (commandId: string, nodeId?: string) => void;
}

const CLAIM_FILTERS: readonly (ClaimClassification | 'all')[] = [
    'all',
    'fact',
    'evidence',
    'assumption',
    'estimate',
    'decision',
];

export function TraceabilityBoard({
    graph,
    mode,
    selectedPhaseFilter,
    selectedNodeId,
    issuesByNodeId,
    onSelectNode,
    onSelectPhase,
    onRunStep,
}: TraceabilityBoardProps) {
    const [selectedStage, setSelectedStage] = useState<NodeKind | 'all'>('all');
    const [claimFilter, setClaimFilter] = useState<ClaimClassification | 'all'>('all');
    const [searchQuery, setSearchQuery] = useState('');

    const nodesById = useMemo(() => {
        const map = new Map<string, BusinessPlanNode>();
        for (const node of graph.nodes) map.set(node.id, node);
        return map;
    }, [graph.nodes]);

    const upstreamById = useMemo(() => {
        const map = new Map<string, BusinessPlanLink[]>();
        for (const link of graph.links) {
            const list = map.get(link.to) ?? [];
            list.push(link);
            map.set(link.to, list);
        }
        return map;
    }, [graph.links]);

    const downstreamById = useMemo(() => {
        const map = new Map<string, BusinessPlanLink[]>();
        for (const link of graph.links) {
            const list = map.get(link.from) ?? [];
            list.push(link);
            map.set(link.from, list);
        }
        return map;
    }, [graph.links]);

    const countsByKind = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const node of graph.nodes) {
            counts[node.kind] = (counts[node.kind] ?? 0) + 1;
        }
        return counts;
    }, [graph.nodes]);

    const issueCountByKind = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const node of graph.nodes) {
            const issues = issuesByNodeId.get(node.id);
            if (issues && issues.length > 0) {
                counts[node.kind] = (counts[node.kind] ?? 0) + issues.length;
            }
        }
        return counts;
    }, [graph.nodes, issuesByNodeId]);

    const filteredNodes = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return graph.nodes.filter((node) => {
            const stage = STAGE_BY_KIND[node.kind];
            if (!stage) return false;
            if (selectedPhaseFilter !== 'all' && stage.phase !== selectedPhaseFilter) return false;
            if (selectedStage !== 'all' && node.kind !== selectedStage) return false;
            if (claimFilter !== 'all') {
                const hasClaim = node.claims?.some((c) => c.classification === claimFilter) ?? false;
                if (!hasClaim) return false;
            }
            if (q) {
                const haystack = [
                    node.id,
                    node.kind,
                    stage.label,
                    node.summary,
                    node.rationale ?? '',
                    node.approval?.owner ?? '',
                    ...(node.claims?.map((c) => `${c.classification} ${c.text} ${c.basis}`) ?? []),
                ]
                    .join(' ')
                    .toLowerCase();
                if (!haystack.includes(q)) return false;
            }
            return true;
        });
    }, [graph.nodes, selectedPhaseFilter, selectedStage, claimFilter, searchQuery]);

    const stagesToRender = useMemo(() => {
        return STAGE_META.filter((stage) => {
            if (selectedPhaseFilter !== 'all' && stage.phase !== selectedPhaseFilter) return false;
            if (selectedStage !== 'all' && stage.kind !== selectedStage) return false;
            return true;
        });
    }, [selectedPhaseFilter, selectedStage]);

    const hasActiveFilters =
        selectedPhaseFilter !== 'all' ||
        selectedStage !== 'all' ||
        claimFilter !== 'all' ||
        searchQuery.trim().length > 0;

    if (mode === 'pipeline') {
        return (
            <section class="bp-pipeline-board" aria-label="16-stage traceability chain">
                <div class="bp-pipeline-intro">
                    <span class="bp-section-kicker">END-TO-END TRACEABILITY CHAIN</span>
                    <span class="bp-muted bp-small">
                        Click any node to inspect its upstream lineage, claims, approvals, and downstream delivery links.
                    </span>
                </div>

                <div class="bp-phase-swimlanes">
                    {BUSINESS_PLAN_PHASES.map((phase) => {
                        const phaseStages = STAGE_META.filter((s) => s.phase === phase.id);
                        return (
                            <div class="bp-swimlane" key={phase.id}>
                                <div class="bp-swimlane-head">
                                    <div class="bp-swimlane-title">{phase.label}</div>
                                    {phase.gateLabel && (
                                        <span class="bp-pill bp-pill-review">{phase.gateLabel}</span>
                                    )}
                                </div>
                                <div class="bp-swimlane-stages">
                                    {phaseStages.map((stage) => {
                                        const stageNodes = graph.nodes.filter((n) => n.kind === stage.kind);
                                        return (
                                            <div
                                                class={`bp-stage-column ${stageNodes.length === 0 ? 'is-empty' : ''}`}
                                                key={stage.kind}
                                            >
                                                <div class="bp-stage-col-head">
                                                    <span class="bp-stage-col-num">
                                                        {String(stage.index + 1).padStart(2, '0')}
                                                    </span>
                                                    <span class="bp-stage-col-name">{stage.shortLabel}</span>
                                                    <span class="bp-stage-col-count">{stageNodes.length}</span>
                                                </div>
                                                <div class="bp-stage-col-body">
                                                    {stageNodes.length === 0 ? (
                                                        <div class="bp-stage-col-empty">
                                                            <span>Not added yet</span>
                                                            {stage.commandId && (
                                                                <button
                                                                    type="button"
                                                                    class="bp-btn bp-btn-ghost bp-btn-xs"
                                                                    onClick={() => onRunStep(stage.commandId!)}
                                                                >
                                                                    Draft
                                                                </button>
                                                            )}
                                                        </div>
                                                    ) : (
                                                        stageNodes.map((node) => {
                                                            const nodeIssues = issuesByNodeId.get(node.id) ?? [];
                                                            const isSelected = selectedNodeId === node.id;
                                                            const upCount = upstreamById.get(node.id)?.length ?? 0;
                                                            const downCount = downstreamById.get(node.id)?.length ?? 0;
                                                            return (
                                                                <button
                                                                    type="button"
                                                                    key={node.id}
                                                                    class={`bp-mini-node ${isSelected ? 'is-selected' : ''} ${nodeIssues.length > 0 ? 'has-issue' : ''}`}
                                                                    onClick={() => onSelectNode(node.id)}
                                                                >
                                                                    <div class="bp-mini-node-top">
                                                                        <span class="bp-node-id-mono">{node.id}</span>
                                                                        {node.approval && (
                                                                            <span class={`bp-dot bp-dot-${node.approval.status}`} title={`Approval: ${node.approval.status}`} />
                                                                        )}
                                                                    </div>
                                                                    <div class="bp-mini-node-summary">{node.summary}</div>
                                                                    <div class="bp-mini-node-foot">
                                                                        <span>↑{upCount} ↓{downCount}</span>
                                                                        {nodeIssues.length > 0 && (
                                                                            <span class="bp-mini-error">
                                                                                {nodeIssues.length} issue{nodeIssues.length === 1 ? '' : 's'}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </button>
                                                            );
                                                        })
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>
        );
    }

    return (
        <section class="bp-dossier" aria-label="Business plan dossier">
            <div class="bp-stage-strip" role="list" aria-label="16 traceability stages">
                {STAGE_META.map((stage) => {
                    const count = countsByKind[stage.kind] ?? 0;
                    const errCount = issueCountByKind[stage.kind] ?? 0;
                    const active = selectedStage === stage.kind;
                    const inPhase = selectedPhaseFilter === 'all' || stage.phase === selectedPhaseFilter;
                    return (
                        <button
                            type="button"
                            key={stage.kind}
                            class={`bp-stage-pill ${active ? 'is-selected' : ''} ${count > 0 ? 'is-filled' : 'is-empty'} ${errCount > 0 ? 'has-issue' : ''} ${!inPhase ? 'is-dimmed' : ''}`}
                            onClick={() => setSelectedStage(active ? 'all' : stage.kind)}
                            title={`Stage ${stage.index + 1}: ${stage.label} — ${stage.description}`}
                        >
                            <span class="bp-stage-pill-idx">{stage.index + 1}</span>
                            <span class="bp-stage-pill-label">{stage.shortLabel}</span>
                            <span class="bp-stage-pill-count">{count}</span>
                        </button>
                    );
                })}
            </div>

            <div class="bp-filter-bar">
                <input
                    type="search"
                    class="bp-search-input"
                    value={searchQuery}
                    placeholder="Filter by ID, summary, claim, rationale, or owner…"
                    aria-label="Filter business plan items"
                    onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                />

                <div class="bp-claim-filters" role="group" aria-label="Filter by claim classification">
                    {CLAIM_FILTERS.map((clf) => (
                        <button
                            type="button"
                            key={clf}
                            class={`bp-filter-chip ${claimFilter === clf ? 'is-active' : ''}`}
                            onClick={() => setClaimFilter(clf)}
                        >
                            {clf === 'all' ? 'All claims' : clf}
                        </button>
                    ))}
                </div>

                {hasActiveFilters && (
                    <button
                        type="button"
                        class="bp-btn bp-btn-ghost bp-btn-xs"
                        onClick={() => {
                            onSelectPhase('all');
                            setSelectedStage('all');
                            setClaimFilter('all');
                            setSearchQuery('');
                        }}
                    >
                        Reset filters
                    </button>
                )}
            </div>

            {filteredNodes.length === 0 ? (
                <div class="bp-empty-inline">
                    No business plan items match the current filters.
                </div>
            ) : (
                <div class="bp-dossier-groups">
                    {stagesToRender.map((stage) => {
                        const stageNodes = filteredNodes.filter((n) => n.kind === stage.kind);
                        if (stageNodes.length === 0) return null;

                        return (
                            <div class="bp-stage-group" key={stage.kind}>
                                <div class="bp-stage-group-head">
                                    <div class="bp-stage-group-title-row">
                                        <span class="bp-stage-num-badge">
                                            {String(stage.index + 1).padStart(2, '0')}
                                        </span>
                                        <h3 class="bp-stage-group-title">{stage.label}</h3>
                                        <span class="bp-stage-group-count">
                                            {stageNodes.length} {stageNodes.length === 1 ? 'item' : 'items'}
                                        </span>
                                    </div>
                                    <span class="bp-stage-group-desc">{stage.description}</span>
                                </div>

                                <div class="bp-card-grid">
                                    {stageNodes.map((node) => {
                                        const isSelected = selectedNodeId === node.id;
                                        const nodeIssues = issuesByNodeId.get(node.id) ?? [];
                                        const upLinks = upstreamById.get(node.id) ?? [];
                                        const downLinks = downstreamById.get(node.id) ?? [];

                                        return (
                                            <article
                                                key={node.id}
                                                class={`bp-node-card ${isSelected ? 'is-selected' : ''} ${nodeIssues.length > 0 ? 'has-issue' : ''}`}
                                                onClick={() => onSelectNode(node.id)}
                                            >
                                                <div class="bp-node-card-top">
                                                    <span class="bp-node-id-mono">{node.id}</span>
                                                    <div class="bp-node-card-badges">
                                                        {node['task-role'] && (
                                                            <span class="bp-mini-pill is-on">{node['task-role']}</span>
                                                        )}
                                                        {node.approval && (
                                                            <span class={`bp-approval-pill bp-approval-${node.approval.status}`}>
                                                                {node.approval.status}
                                                            </span>
                                                        )}
                                                        {node.waiver && (
                                                            <span class={`bp-approval-pill bp-approval-${node.waiver.status}`}>
                                                                waiver: {node.waiver.status}
                                                            </span>
                                                        )}
                                                        {nodeIssues.length > 0 && (
                                                            <span class="bp-status-badge is-error">
                                                                {nodeIssues.length} {nodeIssues.length === 1 ? 'error' : 'errors'}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>

                                                <p class="bp-node-summary">{node.summary}</p>

                                                {node.rationale && (
                                                    <div class="bp-node-rationale">
                                                        <strong>Rationale:</strong> {node.rationale}
                                                    </div>
                                                )}

                                                {node.claims && node.claims.length > 0 && (
                                                    <div class="bp-node-claims">
                                                        {node.claims.map((claim, idx) => (
                                                            <div class="bp-node-claim-row" key={`${claim.classification}-${idx}`}>
                                                                <span class={`bp-class-pill bp-class-${claim.classification}`}>
                                                                    {claim.classification}
                                                                </span>
                                                                <span class="bp-node-claim-text">{claim.text}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}

                                                <div class="bp-node-lineage-row">
                                                    {upLinks.map((link) => {
                                                        const parent = nodesById.get(link.from);
                                                        return (
                                                            <button
                                                                type="button"
                                                                key={`up-${link.from}`}
                                                                class="bp-trace-chip is-up"
                                                                title={parent ? `Upstream: ${parent.summary}` : link.from}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    onSelectNode(link.from);
                                                                }}
                                                            >
                                                                ↑ {link.from}
                                                            </button>
                                                        );
                                                    })}
                                                    {downLinks.map((link) => {
                                                        const child = nodesById.get(link.to);
                                                        return (
                                                            <button
                                                                type="button"
                                                                key={`down-${link.to}`}
                                                                class="bp-trace-chip is-down"
                                                                title={child ? `Downstream: ${child.summary}` : link.to}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    onSelectNode(link.to);
                                                                }}
                                                            >
                                                                ↓ {link.to}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </article>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
