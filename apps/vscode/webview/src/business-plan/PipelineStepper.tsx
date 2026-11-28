import type {
    BusinessPlanCommandSpec,
    BusinessPlanGateId,
    BusinessPlanPhaseId,
    BusinessPlanPhaseMeta,
    BusinessPlanWorkflowRun,
} from '../../../src/protocol/businessPlan';
import {
    BUSINESS_PLAN_COMMANDS,
    BUSINESS_PLAN_PHASES,
    STAGE_BY_KIND,
} from '../../../src/protocol/businessPlan';

export interface PipelineStepperProps {
    activePhase: BusinessPlanPhaseId;
    selectedPhaseFilter: BusinessPlanPhaseId | 'all';
    countsByKind: Record<string, number>;
    workflowRun: BusinessPlanWorkflowRun | null;
    commandSpellings: Record<string, string>;
    onSelectPhase: (phase: BusinessPlanPhaseId | 'all') => void;
    onRunStep: (commandId: string) => void;
    onAnswerGate: (runId: string, gateId: BusinessPlanGateId, verdict: 'approve' | 'reject') => void;
}

function countPhaseNodes(phase: BusinessPlanPhaseMeta, countsByKind: Record<string, number>): number {
    return phase.kinds.reduce((sum, kind) => sum + (countsByKind[kind] ?? 0), 0);
}

function phaseStageCoverage(phase: BusinessPlanPhaseMeta, countsByKind: Record<string, number>): {
    filled: number;
    total: number;
} {
    const filled = phase.kinds.filter((kind) => (countsByKind[kind] ?? 0) > 0).length;
    return { filled, total: phase.kinds.length };
}

function commandsForPhase(phase: BusinessPlanPhaseId): BusinessPlanCommandSpec[] {
    return BUSINESS_PLAN_COMMANDS.filter((c) => c.phase === phase);
}

export function PipelineStepper({
    activePhase,
    selectedPhaseFilter,
    countsByKind,
    workflowRun,
    commandSpellings,
    onSelectPhase,
    onRunStep,
    onAnswerGate,
}: PipelineStepperProps) {
    const displayPhase: BusinessPlanPhaseId =
        selectedPhaseFilter === 'all' ? activePhase : selectedPhaseFilter;
    const displayPhaseMeta = BUSINESS_PLAN_PHASES.find((p) => p.id === displayPhase) ?? BUSINESS_PLAN_PHASES[0];
    const phaseCommands = commandsForPhase(displayPhase);

    const pausedGateMeta = workflowRun?.pausedAt
        ? BUSINESS_PLAN_PHASES.find((p) => p.gateId === workflowRun.pausedAt)
        : undefined;

    return (
        <section class="bp-stepper-section" aria-label="Business plan workflow phases">
            <div class="bp-stepper-header">
                <div class="bp-stepper-title-row">
                    <span class="bp-section-kicker">WORKFLOW PIPELINE</span>
                    <span class="bp-stepper-subtitle">
                        4 phases · 3 human review gates · 16 traceability stages
                    </span>
                </div>
                {selectedPhaseFilter !== 'all' && (
                    <button
                        type="button"
                        class="bp-btn bp-btn-ghost bp-btn-xs"
                        onClick={() => onSelectPhase('all')}
                    >
                        Show all phases
                    </button>
                )}
            </div>

            <div class="bp-phases-rail" role="tablist" aria-label="Business plan phases">
                {BUSINESS_PLAN_PHASES.map((phase, idx) => {
                    const nodeCount = countPhaseNodes(phase, countsByKind);
                    const coverage = phaseStageCoverage(phase, countsByKind);
                    const isSelected = selectedPhaseFilter === phase.id;
                    const isActive = activePhase === phase.id;
                    const isComplete = coverage.filled === coverage.total && nodeCount > 0;
                    const gatePaused =
                        workflowRun?.pausedAt !== undefined &&
                        phase.gateId !== undefined &&
                        workflowRun.pausedAt === phase.gateId;

                    const stateClass = gatePaused
                        ? 'is-gate-paused'
                        : isSelected
                            ? 'is-selected'
                            : isActive
                                ? 'is-active'
                                : isComplete
                                    ? 'is-complete'
                                    : 'is-pending';

                    return (
                        <div class="bp-phase-unit" key={phase.id}>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={isSelected}
                                class={`bp-phase-card ${stateClass}`}
                                onClick={() => onSelectPhase(isSelected ? 'all' : phase.id)}
                                title={`Filter to ${phase.label}`}
                            >
                                <div class="bp-phase-card-top">
                                    <span class="bp-phase-num">PHASE {idx + 1}</span>
                                    <span class="bp-phase-count">
                                        {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
                                    </span>
                                </div>
                                <div class="bp-phase-name">{phase.shortLabel}</div>
                                <div class="bp-phase-desc">{phase.description}</div>
                                <div class="bp-phase-meta">
                                    <span class="bp-phase-coverage">
                                        {coverage.filled}/{coverage.total} stages
                                    </span>
                                    {phase.kinds.length > 0 && (
                                        <span class="bp-phase-stage-range">
                                            {STAGE_BY_KIND[phase.kinds[0]].shortLabel}
                                            {phase.kinds.length > 1
                                                ? ` → ${STAGE_BY_KIND[phase.kinds[phase.kinds.length - 1]].shortLabel}`
                                                : ''}
                                        </span>
                                    )}
                                </div>
                            </button>

                            {phase.gateId && (
                                <div
                                    class={`bp-gate-connector ${gatePaused ? 'is-paused' : ''}`}
                                    title={phase.gateLabel}
                                >
                                    <span class="bp-gate-dot" aria-hidden="true" />
                                    <span class="bp-gate-label">
                                        {gatePaused ? 'GATE' : `G${idx + 1}`}
                                    </span>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {workflowRun?.pausedAt && pausedGateMeta?.gateId && (
                <div class="bp-gate-banner" role="region" aria-label="Pending approval gate">
                    <div class="bp-gate-banner-text">
                        <span class="bp-pill bp-pill-review">HUMAN GATE PAUSED</span>
                        <strong>{pausedGateMeta.gateLabel ?? workflowRun.pausedAt}</strong>
                        <span class="bp-muted">
                            Run <code>{workflowRun.runId}</code> is paused at <code>{workflowRun.pausedAt}</code> waiting for review.
                        </span>
                    </div>
                    <div class="bp-gate-banner-actions">
                        <button
                            type="button"
                            class="bp-btn bp-btn-primary bp-btn-sm"
                            onClick={() => onAnswerGate(workflowRun.runId, pausedGateMeta.gateId!, 'approve')}
                        >
                            Approve Gate
                        </button>
                        <button
                            type="button"
                            class="bp-btn bp-btn-danger bp-btn-sm"
                            onClick={() => onAnswerGate(workflowRun.runId, pausedGateMeta.gateId!, 'reject')}
                        >
                            Reject Gate
                        </button>
                    </div>
                </div>
            )}

            <div class="bp-phase-actions-bar">
                <span class="bp-phase-actions-label">
                    {displayPhaseMeta.label} actions:
                </span>
                <div class="bp-command-chips">
                    {phaseCommands.map((cmd) => {
                        const spelling = commandSpellings[cmd.id] ?? `/${cmd.id}`;
                        return (
                            <button
                                type="button"
                                key={cmd.id}
                                class={`bp-cmd-chip ${cmd.source === 'speckit' ? 'is-speckit' : ''}`}
                                title={`${spelling} — ${cmd.description}`}
                                onClick={() => onRunStep(cmd.id)}
                            >
                                <span class="bp-cmd-chip-name">{cmd.label}</span>
                                <span class="bp-cmd-chip-slash">{spelling}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
