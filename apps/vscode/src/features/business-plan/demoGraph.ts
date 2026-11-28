import type { BusinessPlanGraph } from '../../protocol/businessPlan';

/**
 * Synthetic consuming-project example from `thiagomoreirac/speckit-catalog`
 * (`examples/consuming-project/traceability.json`). Passes all 8 deterministic
 * `business-traceability` validation checks out of the box.
 */
export const CONSUMING_PROJECT_DEMO_GRAPH: BusinessPlanGraph = {
    version: 1,
    nodes: [
        {
            id: 'BP-EXAMPLE-1',
            kind: 'business-plan',
            summary: 'Synthetic example business plan showing end-to-end Spec Kit catalog consumption.',
            approval: {
                status: 'approved',
                owner: 'example-sponsor',
                reference: 'example-plan-approval-1',
            },
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'OBJ-EXAMPLE-1',
            kind: 'objective',
            summary: 'Reduce onboarding drop-off in a synthetic product flow.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'MET-EXAMPLE-1',
            kind: 'metric',
            summary: 'Onboarding completion rate measured across cohorts.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'INIT-EXAMPLE-1',
            kind: 'initiative',
            summary: 'Simplify account setup and instrument funnel completion.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'BC-EXAMPLE-1',
            kind: 'business-case',
            summary: 'Compare onboarding simplification against support automation.',
            claims: [
                {
                    classification: 'evidence',
                    text: 'Synthetic funnel drop-off is concentrated before workspace creation.',
                    basis: 'example-funnel-report',
                },
                {
                    classification: 'assumption',
                    text: 'Removing duplicate form fields improves completion.',
                    basis: 'synthetic-design-hypothesis',
                },
            ],
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'PRI-EXAMPLE-1',
            kind: 'prioritization-decision',
            summary: 'Prioritize onboarding simplification before support automation.',
            rationale: 'Synthetic funnel drop-off affects all new cohorts before support contact occurs.',
            approval: {
                status: 'approved',
                owner: 'example-product-owner',
                reference: 'example-prioritization-decision-1',
            },
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'RM-EXAMPLE-1',
            kind: 'roadmap-item',
            summary: 'Deliver streamlined onboarding flow in the next synthetic planning cycle.',
            approval: {
                status: 'approved',
                owner: 'example-product-owner',
                reference: 'example-roadmap-approval-1',
            },
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'EPIC-EXAMPLE-1',
            kind: 'epic',
            summary: 'Streamlined onboarding epic hypothesis.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'FEAT-EXAMPLE-1',
            kind: 'feature',
            summary: 'Single-step workspace creation with completion telemetry.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'PRD-EXAMPLE-1',
            kind: 'prd',
            summary: 'Feature requirements for single-step workspace creation.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'SPEC-EXAMPLE-1',
            kind: 'specification',
            summary: 'Spec Kit specification for single-step workspace creation.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'PLAN-EXAMPLE-1',
            kind: 'implementation-plan',
            summary: 'Implementation plan for onboarding UI and completion telemetry.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'TASK-EXAMPLE-1',
            kind: 'task',
            summary: 'Emit onboarding completion event with cohort identifier.',
            'task-role': 'measurement',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'ISSUE-EXAMPLE-1',
            kind: 'github-issue',
            summary: 'Synthetic issue tracking onboarding telemetry task.',
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'EVID-EXAMPLE-1',
            kind: 'delivery-evidence',
            summary: 'Synthetic verification that onboarding telemetry task shipped.',
            claims: [
                {
                    classification: 'evidence',
                    text: 'Telemetry event verified in synthetic staging run.',
                    basis: 'example-release-check',
                },
            ],
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
        {
            id: 'OUT-EXAMPLE-1',
            kind: 'outcome-measurement',
            summary: 'Synthetic post-release onboarding completion measurement.',
            claims: [
                {
                    classification: 'evidence',
                    text: 'Synthetic measurement compared pre- and post-release completion cohorts.',
                    basis: 'example-cohort-query',
                },
            ],
            provenance: {
                origin: 'synthetic',
                reference: 'examples/consuming-project/traceability.json',
            },
        },
    ],
    links: [
        { from: 'BP-EXAMPLE-1', to: 'OBJ-EXAMPLE-1' },
        { from: 'OBJ-EXAMPLE-1', to: 'MET-EXAMPLE-1' },
        { from: 'MET-EXAMPLE-1', to: 'INIT-EXAMPLE-1' },
        { from: 'INIT-EXAMPLE-1', to: 'BC-EXAMPLE-1' },
        { from: 'BC-EXAMPLE-1', to: 'PRI-EXAMPLE-1' },
        { from: 'PRI-EXAMPLE-1', to: 'RM-EXAMPLE-1' },
        { from: 'RM-EXAMPLE-1', to: 'EPIC-EXAMPLE-1' },
        { from: 'OBJ-EXAMPLE-1', to: 'EPIC-EXAMPLE-1' },
        { from: 'EPIC-EXAMPLE-1', to: 'FEAT-EXAMPLE-1' },
        { from: 'OBJ-EXAMPLE-1', to: 'FEAT-EXAMPLE-1' },
        { from: 'INIT-EXAMPLE-1', to: 'FEAT-EXAMPLE-1' },
        { from: 'FEAT-EXAMPLE-1', to: 'PRD-EXAMPLE-1' },
        { from: 'PRD-EXAMPLE-1', to: 'SPEC-EXAMPLE-1' },
        { from: 'SPEC-EXAMPLE-1', to: 'PLAN-EXAMPLE-1' },
        { from: 'PLAN-EXAMPLE-1', to: 'TASK-EXAMPLE-1' },
        { from: 'MET-EXAMPLE-1', to: 'TASK-EXAMPLE-1' },
        { from: 'TASK-EXAMPLE-1', to: 'ISSUE-EXAMPLE-1' },
        { from: 'ISSUE-EXAMPLE-1', to: 'EVID-EXAMPLE-1' },
        { from: 'EVID-EXAMPLE-1', to: 'OUT-EXAMPLE-1' },
        { from: 'MET-EXAMPLE-1', to: 'OUT-EXAMPLE-1' },
    ],
};

function slugToIdToken(raw: string): string {
    const cleaned = raw
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
    return cleaned && /^[A-Z]/.test(cleaned) ? cleaned : 'PLAN';
}

export function createStarterBusinessPlanGraph(
    title: string,
    summary: string,
    relativePath: string,
): BusinessPlanGraph {
    const token = slugToIdToken(title);
    return {
        version: 1,
        nodes: [
            {
                id: `BP-${token}-1`,
                kind: 'business-plan',
                summary: summary.trim() || `${title.trim()} — draft business plan awaiting discovery and human review.`,
                approval: {
                    status: 'pending',
                    owner: 'TBD',
                    reference: 'TBD',
                },
                provenance: {
                    origin: 'declared',
                    reference: relativePath,
                },
            },
        ],
        links: [],
    };
}
