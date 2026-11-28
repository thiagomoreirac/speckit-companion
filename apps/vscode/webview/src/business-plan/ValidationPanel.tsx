import type { ValidationReport } from '../../../src/protocol/businessPlan';

export interface ValidationPanelProps {
    validation: ValidationReport;
    onSelectNode: (nodeId: string) => void;
    onRunStep: (commandId: string) => void;
}

export function ValidationPanel({
    validation,
    onSelectNode,
    onRunStep,
}: ValidationPanelProps) {
    const passingChecks = validation.checks.filter((c) => c.passed).length;

    return (
        <section class="bp-validation-view" aria-label="Validation health checks">
            <div class={`bp-validation-banner ${validation.passed ? 'is-pass' : 'is-fail'}`}>
                <div class="bp-validation-banner-copy">
                    <div class="bp-validation-banner-title">
                        {validation.passed
                            ? `All ${passingChecks}/${validation.checks.length} deterministic checks passing`
                            : `${validation.errorCount} validation ${validation.errorCount === 1 ? 'error' : 'errors'} found (${passingChecks}/${validation.checks.length} checks passing)`}
                    </div>
                    <div class="bp-validation-banner-sub">
                        Mirrors the 8 deterministic checks from <code>business-plan/scripts/validate_business.py</code>.
                    </div>
                </div>
                <div class="bp-validation-banner-actions">
                    <button
                        type="button"
                        class="bp-btn bp-btn-secondary bp-btn-sm"
                        onClick={() => onRunStep('speckit.business-plan.review')}
                    >
                        Run Traceability Review
                    </button>
                    <button
                        type="button"
                        class="bp-btn bp-btn-ghost bp-btn-sm"
                        onClick={() => onRunStep('speckit.business-plan.outcomes')}
                    >
                        Check Outcome Evidence
                    </button>
                </div>
            </div>

            <div class="bp-checks-grid">
                {validation.checks.map((check) => {
                    const statusLabel = check.passed
                        ? 'Pass'
                        : `${check.issues.length} ${check.issues.length === 1 ? 'error' : 'errors'}`;
                    const statusClass = check.passed ? 'is-pass' : 'is-error';

                    return (
                        <article class={`bp-check-card ${statusClass}`} key={check.id}>
                            <div class="bp-check-card-head">
                                <div>
                                    <div class="bp-check-title">{check.label}</div>
                                    <div class="bp-check-id">{check.id}</div>
                                </div>
                                <span class={`bp-status-badge ${statusClass}`}>{statusLabel}</span>
                            </div>
                            <p class="bp-check-summary">{check.description}</p>
                        </article>
                    );
                })}
            </div>

            <div class="bp-issues-section">
                <h3 class="bp-subheading">
                    Findings ({validation.issues.length})
                </h3>
                {validation.issues.length === 0 ? (
                    <div class="bp-empty-inline">
                        No validation errors. Every node traces cleanly from Business Plan through Outcome Measurement.
                    </div>
                ) : (
                    <ul class="bp-issues-list">
                        {validation.issues.map((issue, index) => (
                            <li
                                key={`${issue.check}-${issue.nodeId ?? 'graph'}-${index}`}
                                class="bp-issue-row bp-severity-error"
                            >
                                <span class="bp-severity-pill bp-severity-error">error</span>
                                <span class="bp-issue-check-tag">{issue.check}</span>
                                <span class="bp-issue-message">{issue.message}</span>
                                {issue.nodeId && (
                                    <button
                                        type="button"
                                        class="bp-btn bp-btn-ghost bp-btn-xs"
                                        onClick={() => onSelectNode(issue.nodeId!)}
                                    >
                                        Inspect {issue.nodeId}
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}
