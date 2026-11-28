/**
 * Shared protocol and domain model for the Business Plan interface and
 * `thiagomoreirac/speckit-catalog` (`business-plan` bundle) integration.
 *
 * Pure TypeScript — compiled by both the VS Code extension host and the
 * Preact webview bundle. Must never import `vscode` or Node built-ins.
 */

export const DEFAULT_CATALOG_REPO = 'thiagomoreirac/speckit-catalog';
export const DEFAULT_CATALOG_URL = 'https://github.com/thiagomoreirac/speckit-catalog';
export const DEFAULT_BUNDLE_ID = 'business-plan';
export const DEFAULT_BUNDLE_VERSION = '0.1.0';
export const DEFAULT_DEMO_GRAPH_PATH = 'examples/consuming-project/traceability.json';

export const DEFAULT_GRAPH_PATTERNS: readonly string[] = [
    'examples/consuming-project/traceability.json',
    '.specify/business-plan/**/traceability.json',
    'business-plans/**/traceability.json',
    'traceability.json',
];

export const CATALOG_INDEX_FILES = [
    { kind: 'extension', file: 'extensions.json', label: 'Extensions catalog' },
    { kind: 'preset', file: 'presets.json', label: 'Presets catalog' },
    { kind: 'workflow', file: 'workflows.json', label: 'Workflows catalog' },
    { kind: 'step', file: 'steps.json', label: 'Steps catalog' },
    { kind: 'bundle', file: 'bundles.json', label: 'Bundles catalog' },
] as const;

export type CatalogIndexKind = (typeof CATALOG_INDEX_FILES)[number]['kind'];

export const CATALOG_AUTH_HOSTS = [
    'github.com',
    'api.github.com',
    'raw.githubusercontent.com',
] as const;

export type BusinessPlanPhaseId = 'plan' | 'strategy' | 'delivery' | 'outcomes';

export interface BusinessPlanPhaseMeta {
    id: BusinessPlanPhaseId;
    label: string;
    shortLabel: string;
    description: string;
    gateId?: BusinessPlanGateId;
    gateLabel?: string;
    kinds: readonly NodeKind[];
}

export type BusinessPlanGateId = 'review-plan' | 'review-roadmap' | 'review-outcomes';

export const NODE_KINDS = [
    'business-plan',
    'objective',
    'metric',
    'initiative',
    'business-case',
    'prioritization-decision',
    'roadmap-item',
    'epic',
    'feature',
    'prd',
    'specification',
    'implementation-plan',
    'task',
    'github-issue',
    'delivery-evidence',
    'outcome-measurement',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export interface StageMeta {
    kind: NodeKind;
    index: number;
    label: string;
    shortLabel: string;
    phase: BusinessPlanPhaseId;
    description: string;
    requiresApproval?: boolean;
    requiresClaims?: boolean;
    commandId?: string;
}

export const STAGE_META: readonly StageMeta[] = [
    {
        kind: 'business-plan',
        index: 0,
        label: 'Business Plan',
        shortLabel: 'Plan',
        phase: 'plan',
        description: 'Top-level business plan framing problem, scope, constraints, and decision authority.',
        requiresApproval: true,
        commandId: 'speckit.business-plan.plan',
    },
    {
        kind: 'objective',
        index: 1,
        label: 'Objective',
        shortLabel: 'Objective',
        phase: 'strategy',
        description: 'Measurable business objective tied directly to the business plan.',
        commandId: 'speckit.business-plan.objectives',
    },
    {
        kind: 'metric',
        index: 2,
        label: 'Outcome Metric',
        shortLabel: 'Metric',
        phase: 'strategy',
        description: 'Quantifiable metric with baseline, target, horizon, and instrumentation requirement.',
        commandId: 'speckit.business-plan.objectives',
    },
    {
        kind: 'initiative',
        index: 3,
        label: 'Initiative',
        shortLabel: 'Initiative',
        phase: 'strategy',
        description: 'Coherent body of work decomposing an objective into actionable investments.',
        commandId: 'speckit.business-plan.initiatives',
    },
    {
        kind: 'business-case',
        index: 4,
        label: 'Business Case',
        shortLabel: 'Case',
        phase: 'strategy',
        description: 'Evidence-backed comparison of value, cost, risks, and explicit assumptions.',
        requiresClaims: true,
        commandId: 'speckit.business-plan.case',
    },
    {
        kind: 'prioritization-decision',
        index: 5,
        label: 'Prioritization Decision',
        shortLabel: 'Priority',
        phase: 'strategy',
        description: 'Explicit tradeoff decision with rationale and rejected alternatives.',
        requiresApproval: true,
        commandId: 'speckit.business-plan.prioritize',
    },
    {
        kind: 'roadmap-item',
        index: 6,
        label: 'Roadmap Item',
        shortLabel: 'Roadmap',
        phase: 'strategy',
        description: 'Sequenced, approved commitment derived from a prioritization decision.',
        requiresApproval: true,
        commandId: 'speckit.business-plan.roadmap',
    },
    {
        kind: 'epic',
        index: 7,
        label: 'Epic Hypothesis',
        shortLabel: 'Epic',
        phase: 'delivery',
        description: 'Falsifiable epic hypothesis linked back to an objective and roadmap commitment.',
        commandId: 'speckit.business-plan.epic',
    },
    {
        kind: 'feature',
        index: 8,
        label: 'Feature',
        shortLabel: 'Feature',
        phase: 'delivery',
        description: 'Scoped user capability linked to its epic, objective, and initiative (or approved waiver).',
        commandId: 'speckit.business-plan.prd',
    },
    {
        kind: 'prd',
        index: 9,
        label: 'Feature PRD',
        shortLabel: 'PRD',
        phase: 'delivery',
        description: 'Product requirements defining user flows, edge cases, and measurable acceptance.',
        commandId: 'speckit.business-plan.prd',
    },
    {
        kind: 'specification',
        index: 10,
        label: 'Specification',
        shortLabel: 'Spec',
        phase: 'delivery',
        description: 'Spec Kit technical specification generated from the feature PRD.',
        commandId: 'speckit.specify',
    },
    {
        kind: 'implementation-plan',
        index: 11,
        label: 'Implementation Plan',
        shortLabel: 'Impl Plan',
        phase: 'delivery',
        description: 'Spec Kit architecture and implementation plan traced to the specification.',
        commandId: 'speckit.plan',
    },
    {
        kind: 'task',
        index: 12,
        label: 'Task',
        shortLabel: 'Task',
        phase: 'delivery',
        description: 'Actionable delivery or measurement-instrumentation task.',
        commandId: 'speckit.tasks',
    },
    {
        kind: 'github-issue',
        index: 13,
        label: 'GitHub Issue',
        shortLabel: 'Issue',
        phase: 'delivery',
        description: 'Tracked issue linking delivery execution back to planned tasks.',
        commandId: 'speckit.taskstoissues',
    },
    {
        kind: 'delivery-evidence',
        index: 14,
        label: 'Delivery Evidence',
        shortLabel: 'Evidence',
        phase: 'outcomes',
        description: 'Verified deployment, test, or instrumentation evidence from completed delivery.',
        requiresClaims: true,
        commandId: 'speckit.business-plan.outcomes',
    },
    {
        kind: 'outcome-measurement',
        index: 15,
        label: 'Outcome Measurement',
        shortLabel: 'Outcome',
        phase: 'outcomes',
        description: 'Measured business impact compared against target metrics and measurement tasks.',
        requiresClaims: true,
        commandId: 'speckit.business-plan.outcomes',
    },
];

export const STAGE_BY_KIND: Record<NodeKind, StageMeta> = STAGE_META.reduce(
    (acc, stage) => {
        acc[stage.kind] = stage;
        return acc;
    },
    {} as Record<NodeKind, StageMeta>,
);

export const ALLOWED_SHORTCUTS: readonly [NodeKind, NodeKind][] = [
    ['objective', 'epic'],
    ['objective', 'feature'],
    ['initiative', 'feature'],
    ['metric', 'task'],
    ['metric', 'outcome-measurement'],
];

export const BUSINESS_PLAN_PHASES: readonly BusinessPlanPhaseMeta[] = [
    {
        id: 'plan',
        label: '1. Plan & Discovery',
        shortLabel: 'Plan',
        description: 'Frame the business problem, classify source evidence, and draft the business plan for review.',
        gateId: 'review-plan',
        gateLabel: 'Plan Review Gate',
        kinds: ['business-plan'],
    },
    {
        id: 'strategy',
        label: '2. Strategy & Roadmap',
        shortLabel: 'Strategy',
        description: 'Define measurable objectives and metrics, evaluate initiatives and business cases, prioritize, and sequence the roadmap.',
        gateId: 'review-roadmap',
        gateLabel: 'Roadmap Approval Gate',
        kinds: ['objective', 'metric', 'initiative', 'business-case', 'prioritization-decision', 'roadmap-item'],
    },
    {
        id: 'delivery',
        label: '3. Delivery Planning',
        shortLabel: 'Delivery',
        description: 'Translate approved roadmap items into epic hypotheses, feature PRDs, Spec Kit specs, implementation plans, tasks, and issues.',
        kinds: ['epic', 'feature', 'prd', 'specification', 'implementation-plan', 'task', 'github-issue'],
    },
    {
        id: 'outcomes',
        label: '4. Validation & Outcomes',
        shortLabel: 'Outcomes',
        description: 'Verify delivery evidence, measure real outcomes against metrics, validate full traceability, and review results.',
        gateId: 'review-outcomes',
        gateLabel: 'Outcomes Review Gate',
        kinds: ['delivery-evidence', 'outcome-measurement'],
    },
];

export interface BusinessPlanCommandSpec {
    id: string;
    workflowStepId: string;
    label: string;
    phase: BusinessPlanPhaseId;
    description: string;
    source: 'bundle' | 'speckit';
    targetKinds: readonly NodeKind[];
}

export const BUSINESS_PLAN_COMMANDS: readonly BusinessPlanCommandSpec[] = [
    {
        id: 'speckit.business-plan.discovery',
        workflowStepId: 'discovery',
        label: 'Discovery',
        phase: 'plan',
        description: 'Frame the business problem, sponsor, affected groups, constraints, and evidence gaps.',
        source: 'bundle',
        targetKinds: ['business-plan'],
    },
    {
        id: 'speckit.business-plan.plan',
        workflowStepId: 'draft-plan',
        label: 'Draft Business Plan',
        phase: 'plan',
        description: 'Draft a traceable business plan with classified claims and explicit decision boundaries.',
        source: 'bundle',
        targetKinds: ['business-plan'],
    },
    {
        id: 'speckit.business-plan.objectives',
        workflowStepId: 'objectives-and-metrics',
        label: 'Objectives & Metrics',
        phase: 'strategy',
        description: 'Define measurable objectives and outcome metrics with baselines, targets, and measurement plans.',
        source: 'bundle',
        targetKinds: ['objective', 'metric'],
    },
    {
        id: 'speckit.business-plan.initiatives',
        workflowStepId: 'initiatives',
        label: 'Initiatives',
        phase: 'strategy',
        description: 'Decompose reviewed objectives into candidate initiatives.',
        source: 'bundle',
        targetKinds: ['initiative'],
    },
    {
        id: 'speckit.business-plan.case',
        workflowStepId: 'business-case',
        label: 'Business Case',
        phase: 'strategy',
        description: 'Compare initiative business cases with classified facts, evidence, assumptions, and estimates.',
        source: 'bundle',
        targetKinds: ['business-case'],
    },
    {
        id: 'speckit.business-plan.prioritize',
        workflowStepId: 'prioritize',
        label: 'Prioritize',
        phase: 'strategy',
        description: 'Draft a prioritization decision with rationale and rejected alternatives.',
        source: 'bundle',
        targetKinds: ['prioritization-decision'],
    },
    {
        id: 'speckit.business-plan.roadmap',
        workflowStepId: 'roadmap',
        label: 'Roadmap',
        phase: 'strategy',
        description: 'Sequence prioritized initiatives into a proposed roadmap for human approval.',
        source: 'bundle',
        targetKinds: ['roadmap-item'],
    },
    {
        id: 'speckit.business-plan.epic',
        workflowStepId: 'epic',
        label: 'Epic Hypothesis',
        phase: 'delivery',
        description: 'Draft a falsifiable epic hypothesis anchored to its objective and roadmap commitment.',
        source: 'bundle',
        targetKinds: ['epic'],
    },
    {
        id: 'speckit.business-plan.prd',
        workflowStepId: 'feature-prd',
        label: 'Feature PRD',
        phase: 'delivery',
        description: 'Draft feature requirements traced to the epic, objective, and initiative.',
        source: 'bundle',
        targetKinds: ['feature', 'prd'],
    },
    {
        id: 'speckit.specify',
        workflowStepId: 'specification',
        label: 'Specify',
        phase: 'delivery',
        description: 'Generate the Spec Kit feature specification with business traceability metadata.',
        source: 'speckit',
        targetKinds: ['specification'],
    },
    {
        id: 'speckit.plan',
        workflowStepId: 'implementation-plan',
        label: 'Implementation Plan',
        phase: 'delivery',
        description: 'Generate the Spec Kit technical plan traced back to the specification.',
        source: 'speckit',
        targetKinds: ['implementation-plan'],
    },
    {
        id: 'speckit.tasks',
        workflowStepId: 'tasks',
        label: 'Tasks',
        phase: 'delivery',
        description: 'Break the plan into delivery and measurement-instrumentation tasks.',
        source: 'speckit',
        targetKinds: ['task', 'github-issue'],
    },
    {
        id: 'speckit.business-plan.review',
        workflowStepId: 'traceability-review',
        label: 'Traceability Review',
        phase: 'outcomes',
        description: 'Audit evidence quality, measurability, and end-to-end delivery links without editing.',
        source: 'bundle',
        targetKinds: ['delivery-evidence', 'outcome-measurement'],
    },
    {
        id: 'speckit.business-plan.outcomes',
        workflowStepId: 'outcome-evidence',
        label: 'Outcome Evidence',
        phase: 'outcomes',
        description: 'Compare verified delivery evidence with measured outcomes against metric targets.',
        source: 'bundle',
        targetKinds: ['delivery-evidence', 'outcome-measurement'],
    },
];

export type ClaimClassification = 'fact' | 'evidence' | 'assumption' | 'estimate' | 'decision';
export type ApprovalStatus = 'approved' | 'pending' | 'rejected';
export type ProvenanceOrigin = 'synthetic' | 'declared';
export type TaskRole = 'measurement' | 'delivery';

export interface BusinessPlanClaim {
    classification: ClaimClassification;
    text: string;
    basis: string;
}

export interface BusinessPlanApproval {
    status: ApprovalStatus;
    owner: string;
    reference: string;
}

export interface BusinessPlanProvenance {
    origin: ProvenanceOrigin;
    reference: string;
}

export interface BusinessPlanNode {
    id: string;
    kind: NodeKind;
    summary: string;
    claims?: BusinessPlanClaim[];
    approval?: BusinessPlanApproval;
    waiver?: BusinessPlanApproval;
    provenance?: BusinessPlanProvenance;
    rationale?: string;
    'task-role'?: TaskRole;
}

export interface BusinessPlanLink {
    from: string;
    to: string;
}

export interface BusinessPlanGraph {
    version: number;
    nodes: BusinessPlanNode[];
    links: BusinessPlanLink[];
}

export const VALIDATION_CHECK_IDS = [
    'schema',
    'classification',
    'duplicates',
    'orphans',
    'traceability',
    'metrics',
    'approvals',
    'provenance',
] as const;

export type ValidationCheckId = (typeof VALIDATION_CHECK_IDS)[number];

export interface ValidationIssue {
    check: ValidationCheckId;
    message: string;
    nodeId?: string;
}

export interface ValidationCheckResult {
    id: ValidationCheckId;
    label: string;
    description: string;
    passed: boolean;
    issues: ValidationIssue[];
}

export interface ValidationReport {
    passed: boolean;
    errorCount: number;
    checks: ValidationCheckResult[];
    issues: ValidationIssue[];
}

export type ComponentInstallState = 'installed' | 'missing';

export interface CatalogComponentStatus {
    id: 'extension' | 'preset' | 'workflow' | 'step' | 'bundle';
    name: string;
    label: string;
    state: ComponentInstallState;
    version?: string;
    path?: string;
}

export interface BusinessPlanWorkflowStepRun {
    id: string;
    state: 'done' | 'paused' | 'failed' | 'running';
    gate: boolean;
    seconds?: number;
}

export interface BusinessPlanWorkflowRun {
    runId: string;
    workflowId: string;
    graphPath?: string;
    status: string;
    pausedAt?: string;
    workSeconds: number;
    steps: BusinessPlanWorkflowStepRun[];
}

export interface CatalogIntegrationState {
    catalogRepo: string;
    catalogSource: string;
    bundleId: string;
    bundleVersion: string;
    specifyInitialized: boolean;
    authConfigured: boolean;
    authPath: string;
    bundleReady: boolean;
    installedCount: number;
    totalComponents: number;
    components: CatalogComponentStatus[];
    bootstrapInstalled: boolean;
    configuredCatalogs: CatalogIndexKind[];
    latestRun?: BusinessPlanWorkflowRun;
}

export interface BusinessPlanSummary {
    id: string;
    filePath: string;
    title: string;
    summary: string;
    origin: ProvenanceOrigin | 'unknown';
    approvalStatus: ApprovalStatus | 'unreviewed';
    nodeCount: number;
    linkCount: number;
    coveredStages: number;
    totalStages: number;
    validationPassed: boolean;
    errorCount: number;
    currentPhase: BusinessPlanPhaseId;
    parseError?: string;
}

export interface BusinessPlanPayload {
    workspaceName: string;
    plans: BusinessPlanSummary[];
    activePlanPath: string | null;
    graph: BusinessPlanGraph | null;
    parseError?: string;
    validation: ValidationReport | null;
    catalog: CatalogIntegrationState;
    commandSpellings: Record<string, string>;
    workflowRun: BusinessPlanWorkflowRun | null;
    initialTab?: BusinessPlanTabId;
}

export type BusinessPlanTabId = 'overview' | 'pipeline' | 'validation' | 'catalog';

export type ExtensionToBusinessPlanMessage =
    | { type: 'state'; payload: BusinessPlanPayload }
    | { type: 'notice'; tone: 'info' | 'done' | 'error'; text: string };

export type BusinessPlanToExtensionMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'selectPlan'; filePath: string }
    | { type: 'openSource'; filePath: string }
    | { type: 'runStep'; commandId: string; graphPath: string | null; nodeId?: string }
    | { type: 'runWorkflow'; graphPath: string; draft: boolean }
    | { type: 'answerGate'; runId: string; gateId: BusinessPlanGateId; verdict: 'approve' | 'reject' }
    | { type: 'configureAuth' }
    | { type: 'registerCatalog'; source: string; ref?: string }
    | { type: 'installBundle'; version?: string }
    | { type: 'createDemoPlan' }
    | { type: 'createNewPlan'; title?: string; summary?: string }
    | {
        type: 'updateNodeApproval';
        filePath: string;
        nodeId: string;
        status: ApprovalStatus;
        owner: string;
        reference: string;
    }
    | { type: 'openSettings'; setting?: string }
    | { type: 'openExternal'; url: string };
