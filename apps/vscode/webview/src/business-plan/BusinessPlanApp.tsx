import { useEffect, useMemo, useState } from 'preact/hooks';
import type {
    ApprovalStatus,
    BusinessPlanGateId,
    BusinessPlanNode,
    BusinessPlanPayload,
    BusinessPlanPhaseId,
    BusinessPlanTabId,
    BusinessPlanToExtensionMessage,
    ValidationIssue,
} from '../../../src/protocol/businessPlan';
import {
    DEFAULT_CATALOG_URL,
    STAGE_META,
} from '../../../src/protocol/businessPlan';
import { PipelineStepper } from './PipelineStepper';
import { TraceabilityBoard } from './TraceabilityBoard';
import { NodeInspector } from './NodeInspector';
import { ValidationPanel } from './ValidationPanel';
import { CatalogIntegrationPanel } from './CatalogIntegrationPanel';

export interface BusinessPlanNotice {
    tone: 'info' | 'done' | 'error';
    text: string;
}

export interface BusinessPlanAppProps {
    payload: BusinessPlanPayload | null;
    notice: BusinessPlanNotice | null;
    onDismissNotice: () => void;
    send: (message: BusinessPlanToExtensionMessage) => void;
}

export function BusinessPlanApp({
    payload,
    notice,
    onDismissNotice,
    send,
}: BusinessPlanAppProps) {
    const [activeTab, setActiveTab] = useState<BusinessPlanTabId>(payload?.initialTab ?? 'overview');
    const [selectedPhaseFilter, setSelectedPhaseFilter] = useState<BusinessPlanPhaseId | 'all'>('all');
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

    useEffect(() => {
        if (payload?.initialTab) {
            setActiveTab(payload.initialTab);
        }
    }, [payload?.initialTab]);

    const graph = payload?.graph ?? null;
    const validation = payload?.validation ?? null;
    const activeSummary = useMemo(
        () => payload?.plans.find((p) => p.filePath === payload.activePlanPath) ?? null,
        [payload?.plans, payload?.activePlanPath],
    );

    const nodesById = useMemo(() => {
        const map = new Map<string, BusinessPlanNode>();
        for (const node of graph?.nodes ?? []) {
            map.set(node.id, node);
        }
        return map;
    }, [graph?.nodes]);

    useEffect(() => {
        if (selectedNodeId && !nodesById.has(selectedNodeId)) {
            setSelectedNodeId(null);
        }
    }, [selectedNodeId, nodesById]);

    const countsByKind = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const node of graph?.nodes ?? []) {
            counts[node.kind] = (counts[node.kind] ?? 0) + 1;
        }
        return counts;
    }, [graph?.nodes]);

    const issuesByNodeId = useMemo(() => {
        const map = new Map<string, ValidationIssue[]>();
        for (const issue of validation?.issues ?? []) {
            if (!issue.nodeId) continue;
            const list = map.get(issue.nodeId) ?? [];
            list.push(issue);
            map.set(issue.nodeId, list);
        }
        return map;
    }, [validation?.issues]);

    const kpis = useMemo(() => {
        const nodes = graph?.nodes ?? [];
        const links = graph?.links ?? [];
        const coveredStages = new Set(nodes.map((n) => n.kind)).size;
        const governedNodes = nodes.filter((n) => n.approval !== undefined);
        const approvedNodes = governedNodes.filter((n) => n.approval?.status === 'approved');
        const allClaims = nodes.flatMap((n) => n.claims ?? []);
        const speculativeClaims = allClaims.filter(
            (c) => c.classification === 'assumption' || c.classification === 'estimate',
        );
        const checksPassed = validation ? validation.checks.filter((c) => c.passed).length : 0;
        const checksTotal = validation ? validation.checks.length : 8;

        return {
            nodeCount: nodes.length,
            linkCount: links.length,
            coveredStages,
            totalStages: STAGE_META.length,
            approvedCount: approvedNodes.length,
            governedCount: governedNodes.length,
            claimCount: allClaims.length,
            speculativeCount: speculativeClaims.length,
            checksPassed,
            checksTotal,
        };
    }, [graph, validation]);

    if (!payload) {
        return (
            <div class="bp-shell bp-loading">
                <div class="bp-loading-card">Loading Business Plan workspace…</div>
            </div>
        );
    }

    const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) ?? null : null;
    const upstreamLinks = selectedNode
        ? (graph?.links ?? []).filter((l) => l.to === selectedNode.id)
        : [];
    const downstreamLinks = selectedNode
        ? (graph?.links ?? []).filter((l) => l.from === selectedNode.id)
        : [];

    const handleRunStep = (commandId: string, nodeId?: string) => {
        send({
            type: 'runStep',
            commandId,
            graphPath: payload.activePlanPath,
            nodeId,
        });
    };

    const handleRunWorkflow = (draft: boolean) => {
        if (!payload.activePlanPath) return;
        send({ type: 'runWorkflow', graphPath: payload.activePlanPath, draft });
    };

    const handleAnswerGate = (
        runId: string,
        gateId: BusinessPlanGateId,
        verdict: 'approve' | 'reject',
    ) => {
        send({ type: 'answerGate', runId, gateId, verdict });
    };

    const handleUpdateApproval = (
        nodeId: string,
        status: ApprovalStatus,
        owner: string,
        reference: string,
    ) => {
        if (!payload.activePlanPath) return;
        send({
            type: 'updateNodeApproval',
            filePath: payload.activePlanPath,
            nodeId,
            status,
            owner,
            reference,
        });
    };

    const handleJumpToNode = (nodeId: string) => {
        setSelectedNodeId(nodeId);
        if (activeTab === 'validation' || activeTab === 'catalog') {
            setActiveTab('overview');
        }
    };

    const catalogUrl = `${DEFAULT_CATALOG_URL}/tree/main/examples/consuming-project`;

    return (
        <div class="bp-shell">
            <header class="bp-header">
                <div class="bp-header-left">
                    <div class="bp-title-row">
                        <span class="bp-brand-kicker">SPECKIT BUSINESS PLAN</span>
                        {payload.plans.length > 1 ? (
                            <select
                                class="bp-plan-select"
                                aria-label="Select business plan"
                                value={payload.activePlanPath ?? ''}
                                onChange={(e) =>
                                    send({
                                        type: 'selectPlan',
                                        filePath: (e.target as HTMLSelectElement).value,
                                    })
                                }
                            >
                                {payload.plans.map((plan) => (
                                    <option key={plan.filePath} value={plan.filePath}>
                                        {plan.title} ({plan.filePath})
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <h1 class="bp-page-title">
                                {activeSummary?.title ?? payload.workspaceName}
                            </h1>
                        )}
                    </div>

                    <div class="bp-header-meta">
                        {payload.activePlanPath && (
                            <span class="bp-path-label" title={payload.activePlanPath}>
                                {payload.activePlanPath}
                            </span>
                        )}
                        {activeSummary && activeSummary.origin !== 'unknown' && (
                            <span class={`bp-origin-pill bp-origin-${activeSummary.origin}`}>
                                {activeSummary.origin === 'synthetic' ? 'Example / Synthetic' : 'Declared Plan'}
                            </span>
                        )}
                        {validation && (
                            <span class={`bp-status-badge ${validation.passed ? 'is-pass' : 'is-error'}`}>
                                {validation.passed
                                    ? `${kpis.checksPassed}/${kpis.checksTotal} checks passing`
                                    : `${validation.errorCount} validation ${validation.errorCount === 1 ? 'error' : 'errors'}`}
                            </span>
                        )}
                        <span class={`bp-status-badge ${payload.catalog.bundleReady ? 'is-pass' : 'is-warning'}`}>
                            {payload.catalog.bundleReady
                                ? `Bundle ${payload.catalog.bundleId} ready`
                                : `Catalog bundle ${payload.catalog.installedCount}/${payload.catalog.totalComponents}`}
                        </span>
                    </div>
                </div>

                <div class="bp-header-actions">
                    {payload.activePlanPath && (
                        <>
                            <button
                                type="button"
                                class="bp-btn bp-btn-primary bp-btn-sm"
                                onClick={() => handleRunWorkflow(false)}
                            >
                                Run Workflow
                            </button>
                            <button
                                type="button"
                                class="bp-btn bp-btn-secondary bp-btn-sm"
                                onClick={() => send({ type: 'openSource', filePath: payload.activePlanPath! })}
                            >
                                Open JSON
                            </button>
                        </>
                    )}
                    <button
                        type="button"
                        class="bp-btn bp-btn-ghost bp-btn-sm"
                        onClick={() => send({ type: 'createNewPlan' })}
                    >
                        + New Plan
                    </button>
                    <button
                        type="button"
                        class="bp-btn bp-btn-ghost bp-btn-sm"
                        onClick={() => send({ type: 'refresh' })}
                        title="Refresh business plan and catalog status"
                    >
                        Refresh
                    </button>
                </div>
            </header>

            {notice && (
                <div class={`bp-notice bp-notice-${notice.tone}`} role="status">
                    <span>{notice.text}</span>
                    <button
                        type="button"
                        class="bp-btn bp-btn-ghost bp-btn-xs"
                        onClick={onDismissNotice}
                        aria-label="Dismiss message"
                    >
                        ✕
                    </button>
                </div>
            )}

            {payload.parseError && (
                <div class="bp-notice bp-notice-error" role="alert">
                    <span>Unable to parse business plan graph: {payload.parseError}</span>
                    {payload.activePlanPath && (
                        <button
                            type="button"
                            class="bp-btn bp-btn-secondary bp-btn-xs"
                            onClick={() => send({ type: 'openSource', filePath: payload.activePlanPath! })}
                        >
                            Fix in Editor
                        </button>
                    )}
                </div>
            )}

            {!graph && !payload.parseError ? (
                <main class="bp-onboarding">
                    <div class="bp-onboarding-card">
                        <span class="bp-section-kicker">GET STARTED WITH BUSINESS PLANS</span>
                        <h2 class="bp-onboarding-title">
                            Trace strategy to delivery before writing code
                        </h2>
                        <p class="bp-onboarding-copy">
                            No <code>traceability.json</code> business plan graph was found in{' '}
                            <strong>{payload.workspaceName}</strong> yet. Start with a clean starter plan,
                            import the 16-stage <code>consuming-project</code> demo from{' '}
                            <code>{payload.catalog.catalogRepo}</code>, or install the{' '}
                            <code>{payload.catalog.bundleId}</code> bundle directly.
                        </p>

                        <div class="bp-onboarding-actions">
                            <button
                                type="button"
                                class="bp-btn bp-btn-primary"
                                onClick={() => send({ type: 'createDemoPlan' })}
                            >
                                Load Consuming-Project Demo (16 stages)
                            </button>
                            <button
                                type="button"
                                class="bp-btn bp-btn-secondary"
                                onClick={() => send({ type: 'createNewPlan' })}
                            >
                                Create Starter Business Plan
                            </button>
                            <button
                                type="button"
                                class="bp-btn bp-btn-ghost"
                                onClick={() => setActiveTab('catalog')}
                            >
                                Configure speckit-catalog Integration
                            </button>
                        </div>
                    </div>

                    <CatalogIntegrationPanel
                        catalog={payload.catalog}
                        workflowRun={payload.workflowRun}
                        commandSpellings={payload.commandSpellings}
                        onConfigureAuth={() => send({ type: 'configureAuth' })}
                        onRegisterCatalog={(source) => send({ type: 'registerCatalog', source })}
                        onInstallBundle={() => send({ type: 'installBundle' })}
                        onRunWorkflow={handleRunWorkflow}
                        onRunStep={(id) => handleRunStep(id)}
                        onOpenCatalogRepo={() => send({ type: 'openExternal', url: catalogUrl })}
                        onCreateDemoPlan={() => send({ type: 'createDemoPlan' })}
                    />
                </main>
            ) : (
                <>
                    <section class="bp-kpi-strip" aria-label="Business plan summary metrics">
                        <div class="bp-kpi-card">
                            <div class="bp-kpi-label">STAGE COVERAGE</div>
                            <div class="bp-kpi-value">
                                {kpis.coveredStages}
                                <span class="bp-kpi-unit">/{kpis.totalStages}</span>
                            </div>
                            <div class="bp-kpi-sub">
                                {kpis.nodeCount} nodes · {kpis.linkCount} traced links
                            </div>
                        </div>
                        <div class="bp-kpi-card">
                            <div class="bp-kpi-label">VALIDATION HEALTH</div>
                            <div class={`bp-kpi-value ${validation?.passed ? 'is-pass' : 'is-error'}`}>
                                {kpis.checksPassed}
                                <span class="bp-kpi-unit">/{kpis.checksTotal}</span>
                            </div>
                            <div class="bp-kpi-sub">
                                {validation?.passed
                                    ? 'All deterministic checks pass'
                                    : `${validation?.errorCount ?? 0} issues to resolve`}
                            </div>
                        </div>
                        <div class="bp-kpi-card">
                            <div class="bp-kpi-label">GOVERNANCE APPROVALS</div>
                            <div class="bp-kpi-value">
                                {kpis.approvedCount}
                                <span class="bp-kpi-unit">/{kpis.governedCount}</span>
                            </div>
                            <div class="bp-kpi-sub">
                                {kpis.governedCount === 0
                                    ? 'No approval records yet'
                                    : `${kpis.approvedCount} approved · ${kpis.governedCount - kpis.approvedCount} pending/other`}
                            </div>
                        </div>
                        <div class="bp-kpi-card">
                            <div class="bp-kpi-label">CLAIMS DISCIPLINE</div>
                            <div class="bp-kpi-value">{kpis.claimCount}</div>
                            <div class="bp-kpi-sub">
                                {kpis.speculativeCount} assumption{kpis.speculativeCount === 1 ? '' : 's'} / estimate{kpis.speculativeCount === 1 ? '' : 's'}
                            </div>
                        </div>
                    </section>

                    <PipelineStepper
                        activePhase={activeSummary?.currentPhase ?? 'plan'}
                        selectedPhaseFilter={selectedPhaseFilter}
                        countsByKind={countsByKind}
                        workflowRun={payload.workflowRun}
                        commandSpellings={payload.commandSpellings}
                        onSelectPhase={setSelectedPhaseFilter}
                        onRunStep={(id) => handleRunStep(id)}
                        onAnswerGate={handleAnswerGate}
                    />

                    <nav class="bp-tabs" role="tablist" aria-label="Business plan sections">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'overview'}
                            class={`bp-tab ${activeTab === 'overview' ? 'is-active' : ''}`}
                            onClick={() => setActiveTab('overview')}
                        >
                            Plan Dossier
                            <span class="bp-tab-badge">{kpis.nodeCount}</span>
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'pipeline'}
                            class={`bp-tab ${activeTab === 'pipeline' ? 'is-active' : ''}`}
                            onClick={() => setActiveTab('pipeline')}
                        >
                            Traceability Chain
                            <span class="bp-tab-badge">{kpis.coveredStages}/16</span>
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'validation'}
                            class={`bp-tab ${activeTab === 'validation' ? 'is-active' : ''}`}
                            onClick={() => setActiveTab('validation')}
                        >
                            Validation
                            <span
                                class={`bp-tab-badge ${validation?.passed ? 'is-pass' : 'is-error'}`}
                            >
                                {validation ? `${kpis.checksPassed}/${kpis.checksTotal}` : '—'}
                            </span>
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'catalog'}
                            class={`bp-tab ${activeTab === 'catalog' ? 'is-active' : ''}`}
                            onClick={() => setActiveTab('catalog')}
                        >
                            Catalog &amp; Commands
                            <span
                                class={`bp-tab-badge ${payload.catalog.bundleReady ? 'is-pass' : 'is-warning'}`}
                            >
                                {payload.catalog.installedCount}/{payload.catalog.totalComponents}
                            </span>
                        </button>
                    </nav>

                    <main class={`bp-workspace ${selectedNode ? 'has-inspector' : ''}`}>
                        <div class="bp-main-col">
                            {activeTab === 'overview' && graph && (
                                <TraceabilityBoard
                                    graph={graph}
                                    mode="dossier"
                                    selectedPhaseFilter={selectedPhaseFilter}
                                    selectedNodeId={selectedNodeId}
                                    issuesByNodeId={issuesByNodeId}
                                    onSelectNode={setSelectedNodeId}
                                    onSelectPhase={setSelectedPhaseFilter}
                                    onRunStep={handleRunStep}
                                />
                            )}

                            {activeTab === 'pipeline' && graph && (
                                <TraceabilityBoard
                                    graph={graph}
                                    mode="pipeline"
                                    selectedPhaseFilter={selectedPhaseFilter}
                                    selectedNodeId={selectedNodeId}
                                    issuesByNodeId={issuesByNodeId}
                                    onSelectNode={setSelectedNodeId}
                                    onSelectPhase={setSelectedPhaseFilter}
                                    onRunStep={handleRunStep}
                                />
                            )}

                            {activeTab === 'validation' && validation && (
                                <ValidationPanel
                                    validation={validation}
                                    onSelectNode={handleJumpToNode}
                                    onRunStep={(id) => handleRunStep(id)}
                                />
                            )}

                            {activeTab === 'catalog' && (
                                <CatalogIntegrationPanel
                                    catalog={payload.catalog}
                                    workflowRun={payload.workflowRun}
                                    commandSpellings={payload.commandSpellings}
                                    onConfigureAuth={() => send({ type: 'configureAuth' })}
                                    onRegisterCatalog={(source) => send({ type: 'registerCatalog', source })}
                                    onInstallBundle={() => send({ type: 'installBundle' })}
                                    onRunWorkflow={handleRunWorkflow}
                                    onRunStep={(id) => handleRunStep(id)}
                                    onOpenCatalogRepo={() => send({ type: 'openExternal', url: catalogUrl })}
                                    onCreateDemoPlan={() => send({ type: 'createDemoPlan' })}
                                />
                            )}
                        </div>

                        {selectedNode && (
                            <NodeInspector
                                key={selectedNode.id}
                                node={selectedNode}
                                nodesById={nodesById}
                                upstreamLinks={upstreamLinks}
                                downstreamLinks={downstreamLinks}
                                issues={issuesByNodeId.get(selectedNode.id) ?? []}
                                commandSpellings={payload.commandSpellings}
                                canEdit={Boolean(payload.activePlanPath)}
                                onSelectNode={setSelectedNodeId}
                                onUpdateApproval={handleUpdateApproval}
                                onRunStep={handleRunStep}
                                onClose={() => setSelectedNodeId(null)}
                            />
                        )}
                    </main>
                </>
            )}
        </div>
    );
}
