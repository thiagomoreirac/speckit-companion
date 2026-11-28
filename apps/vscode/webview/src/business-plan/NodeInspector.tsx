import { useState } from 'preact/hooks';
import type {
    ApprovalStatus,
    BusinessPlanLink,
    BusinessPlanNode,
    ValidationIssue,
} from '../../../src/protocol/businessPlan';
import {
    BUSINESS_PLAN_COMMANDS,
    STAGE_BY_KIND,
} from '../../../src/protocol/businessPlan';

export interface NodeInspectorProps {
    node: BusinessPlanNode;
    nodesById: Map<string, BusinessPlanNode>;
    upstreamLinks: BusinessPlanLink[];
    downstreamLinks: BusinessPlanLink[];
    issues: ValidationIssue[];
    commandSpellings: Record<string, string>;
    canEdit: boolean;
    onSelectNode: (nodeId: string) => void;
    onUpdateApproval: (nodeId: string, status: ApprovalStatus, owner: string, reference: string) => void;
    onRunStep: (commandId: string, nodeId?: string) => void;
    onClose: () => void;
}

const APPROVAL_OPTIONS: { value: ApprovalStatus; label: string }[] = [
    { value: 'approved', label: 'Approved' },
    { value: 'pending', label: 'Pending Review' },
    { value: 'rejected', label: 'Rejected' },
];

export function NodeInspector({
    node,
    nodesById,
    upstreamLinks,
    downstreamLinks,
    issues,
    commandSpellings,
    canEdit,
    onSelectNode,
    onUpdateApproval,
    onRunStep,
    onClose,
}: NodeInspectorProps) {
    const [status, setStatus] = useState<ApprovalStatus>(node.approval?.status ?? 'pending');
    const [owner, setOwner] = useState<string>(node.approval?.owner ?? '');
    const [reference, setReference] = useState<string>(node.approval?.reference ?? '');

    const approvalKey = `${node.id}|${node.approval?.status ?? ''}|${node.approval?.owner ?? ''}|${node.approval?.reference ?? ''}`;
    const [syncedKey, setSyncedKey] = useState<string>(approvalKey);
    if (syncedKey !== approvalKey) {
        setSyncedKey(approvalKey);
        setStatus(node.approval?.status ?? 'pending');
        setOwner(node.approval?.owner ?? '');
        setReference(node.approval?.reference ?? '');
    }

    const stage = STAGE_BY_KIND[node.kind];
    const suggestedCommand =
        (stage.commandId ? BUSINESS_PLAN_COMMANDS.find((c) => c.id === stage.commandId) : undefined) ??
        BUSINESS_PLAN_COMMANDS.find((c) => c.phase === stage.phase);
    const suggestedSpelling = suggestedCommand
        ? (commandSpellings[suggestedCommand.id] ?? `/${suggestedCommand.id}`)
        : undefined;

    const handleSubmit = (e: Event) => {
        e.preventDefault();
        if (!canEdit) return;
        onUpdateApproval(
            node.id,
            status,
            owner.trim() || 'product-owner',
            reference.trim() || 'Reviewed in SpecKit Companion',
        );
    };

    return (
        <aside class="bp-inspector" aria-label={`Details for ${node.id}`}>
            <div class="bp-inspector-header">
                <div class="bp-inspector-badges">
                    <span class="bp-stage-badge">
                        Stage {stage.index + 1} · {stage.label}
                    </span>
                    {node.provenance && (
                        <span class={`bp-origin-pill bp-origin-${node.provenance.origin}`}>
                            {node.provenance.origin}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    class="bp-btn bp-btn-ghost bp-btn-xs"
                    onClick={onClose}
                    aria-label="Close inspector"
                >
                    ✕
                </button>
            </div>

            <div class="bp-inspector-title-block">
                <div class="bp-node-id-mono">{node.id}</div>
                <h2 class="bp-inspector-title">{stage.label}</h2>
            </div>

            <div class="bp-inspector-section">
                <h3 class="bp-inspector-heading">Summary</h3>
                <p class="bp-inspector-prose">{node.summary}</p>
            </div>

            {node.rationale && (
                <div class="bp-inspector-section">
                    <h3 class="bp-inspector-heading">Rationale</h3>
                    <p class="bp-inspector-callout">{node.rationale}</p>
                </div>
            )}

            {node.claims && node.claims.length > 0 && (
                <div class="bp-inspector-section">
                    <h3 class="bp-inspector-heading">Classified Claims ({node.claims.length})</h3>
                    <div class="bp-claims-list">
                        {node.claims.map((claim, idx) => (
                            <div class="bp-claim-card" key={`${claim.classification}-${idx}`}>
                                <div class="bp-claim-top">
                                    <span class={`bp-class-pill bp-class-${claim.classification}`}>
                                        {claim.classification}
                                    </span>
                                </div>
                                <div class="bp-claim-text">{claim.text}</div>
                                <div class="bp-claim-basis">Basis: {claim.basis}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div class="bp-inspector-section">
                <h3 class="bp-inspector-heading">Metadata</h3>
                <dl class="bp-kv-list">
                    <div class="bp-kv-row">
                        <dt>Stage</dt>
                        <dd>{stage.index + 1} of 16 ({stage.kind})</dd>
                    </div>
                    <div class="bp-kv-row">
                        <dt>Phase</dt>
                        <dd>{stage.phase}</dd>
                    </div>
                    {node['task-role'] && (
                        <div class="bp-kv-row">
                            <dt>Task role</dt>
                            <dd>
                                <span class="bp-mini-pill is-on">{node['task-role']}</span>
                            </dd>
                        </div>
                    )}
                    {node.approval && (
                        <div class="bp-kv-row">
                            <dt>Approval</dt>
                            <dd>
                                <span class={`bp-approval-pill bp-approval-${node.approval.status}`}>
                                    {node.approval.status}
                                </span>
                                {node.approval.owner && (
                                    <span class="bp-kv-sub"> · {node.approval.owner}</span>
                                )}
                            </dd>
                        </div>
                    )}
                    {node.approval?.reference && (
                        <div class="bp-kv-row">
                            <dt>Approval ref</dt>
                            <dd>{node.approval.reference}</dd>
                        </div>
                    )}
                    {node.waiver && (
                        <div class="bp-kv-row">
                            <dt>Waiver</dt>
                            <dd>
                                <span class={`bp-approval-pill bp-approval-${node.waiver.status}`}>
                                    {node.waiver.status}
                                </span>
                                <span class="bp-kv-sub"> · {node.waiver.owner} ({node.waiver.reference})</span>
                            </dd>
                        </div>
                    )}
                    {node.provenance && (
                        <div class="bp-kv-row">
                            <dt>Provenance</dt>
                            <dd>{node.provenance.origin} — {node.provenance.reference}</dd>
                        </div>
                    )}
                </dl>
            </div>

            <div class="bp-inspector-section">
                <h3 class="bp-inspector-heading">
                    Traceability Lineage ({upstreamLinks.length} upstream · {downstreamLinks.length} downstream)
                </h3>

                <div class="bp-lineage-group">
                    <div class="bp-lineage-subhead">Upstream (traces from)</div>
                    {upstreamLinks.length === 0 ? (
                        <div class="bp-muted bp-small">
                            {node.kind === 'business-plan'
                                ? 'Root business plan node (top of graph).'
                                : 'No upstream links.'}
                        </div>
                    ) : (
                        <div class="bp-lineage-list">
                            {upstreamLinks.map((link) => {
                                const parent = nodesById.get(link.from);
                                const parentStage = parent ? STAGE_BY_KIND[parent.kind] : undefined;
                                return (
                                    <button
                                        type="button"
                                        key={`up-${link.from}-${link.to}`}
                                        class="bp-lineage-item"
                                        onClick={() => onSelectNode(link.from)}
                                    >
                                        <span class="bp-lineage-rel">{parentStage?.shortLabel ?? 'Parent'}</span>
                                        <span class="bp-lineage-target">
                                            <strong>{link.from}</strong>
                                            {parent ? ` — ${parent.summary}` : ''}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div class="bp-lineage-group">
                    <div class="bp-lineage-subhead">Downstream (drives)</div>
                    {downstreamLinks.length === 0 ? (
                        <div class="bp-muted bp-small">
                            {node.kind === 'outcome-measurement'
                                ? 'Terminal outcome measurement node.'
                                : 'No downstream links yet.'}
                        </div>
                    ) : (
                        <div class="bp-lineage-list">
                            {downstreamLinks.map((link) => {
                                const child = nodesById.get(link.to);
                                const childStage = child ? STAGE_BY_KIND[child.kind] : undefined;
                                return (
                                    <button
                                        type="button"
                                        key={`down-${link.from}-${link.to}`}
                                        class="bp-lineage-item"
                                        onClick={() => onSelectNode(link.to)}
                                    >
                                        <span class="bp-lineage-rel">{childStage?.shortLabel ?? 'Child'}</span>
                                        <span class="bp-lineage-target">
                                            <strong>{link.to}</strong>
                                            {child ? ` — ${child.summary}` : ''}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {issues.length > 0 && (
                <div class="bp-inspector-section">
                    <h3 class="bp-inspector-heading">Validation Issues ({issues.length})</h3>
                    <ul class="bp-issue-mini-list">
                        {issues.map((issue, idx) => (
                            <li
                                key={`${issue.check}-${idx}`}
                                class="bp-issue-mini bp-severity-error"
                            >
                                <span class="bp-issue-mini-check">{issue.check}</span>
                                <span>{issue.message}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div class="bp-inspector-section">
                <h3 class="bp-inspector-heading">
                    Human Approval{stage.requiresApproval ? ' (Required)' : ''}
                </h3>
                {!canEdit ? (
                    <p class="bp-muted bp-small">
                        Select a workspace <code>traceability.json</code> to update approval decisions.
                    </p>
                ) : (
                    <form class="bp-approval-form" onSubmit={handleSubmit}>
                        <label class="bp-field">
                            <span>Status</span>
                            <select
                                value={status}
                                onChange={(e) =>
                                    setStatus((e.target as HTMLSelectElement).value as ApprovalStatus)
                                }
                            >
                                {APPROVAL_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label class="bp-field">
                            <span>Owner / Approver</span>
                            <input
                                type="text"
                                value={owner}
                                placeholder="e.g. Executive Sponsor"
                                onInput={(e) => setOwner((e.target as HTMLInputElement).value)}
                            />
                        </label>
                        <label class="bp-field">
                            <span>Decision Reference</span>
                            <input
                                type="text"
                                value={reference}
                                placeholder="e.g. ADR-012 / Board review 2026-04-20"
                                onInput={(e) => setReference((e.target as HTMLInputElement).value)}
                            />
                        </label>
                        <button type="submit" class="bp-btn bp-btn-primary bp-btn-sm">
                            Save Approval to Graph
                        </button>
                    </form>
                )}
            </div>

            {suggestedCommand && (
                <div class="bp-inspector-footer">
                    <button
                        type="button"
                        class="bp-btn bp-btn-secondary bp-btn-sm bp-btn-block"
                        onClick={() => onRunStep(suggestedCommand.id, node.id)}
                    >
                        Run {suggestedCommand.label} ({suggestedSpelling})
                    </button>
                </div>
            )}
        </aside>
    );
}
