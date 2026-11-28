/**
 * @jest-environment jsdom
 */

import { render } from 'preact';
import { BusinessPlanApp } from '../BusinessPlanApp';
import { CONSUMING_PROJECT_DEMO_GRAPH } from '../../../../src/features/business-plan/demoGraph';
import { validateBusinessPlanObject } from '../../../../src/features/business-plan/traceabilityValidator';
import {
    BUSINESS_PLAN_COMMANDS,
    DEFAULT_BUNDLE_ID,
    DEFAULT_BUNDLE_VERSION,
    DEFAULT_CATALOG_REPO,
    DEFAULT_CATALOG_URL,
    DEFAULT_DEMO_GRAPH_PATH,
    type BusinessPlanPayload,
    type BusinessPlanToExtensionMessage,
} from '../../../../src/protocol/businessPlan';

function buildPayload(overrides: Partial<BusinessPlanPayload> = {}): BusinessPlanPayload {
    const validation = validateBusinessPlanObject(CONSUMING_PROJECT_DEMO_GRAPH);
    const commandSpellings: Record<string, string> = {};
    for (const cmd of BUSINESS_PLAN_COMMANDS) {
        commandSpellings[cmd.id] = `/${cmd.id}`;
    }

    return {
        workspaceName: 'consuming-project',
        plans: [
            {
                id: 'bp-1',
                title: 'Consuming Project Business Plan',
                summary: 'Synthetic 16-stage example business plan.',
                filePath: DEFAULT_DEMO_GRAPH_PATH,
                nodeCount: CONSUMING_PROJECT_DEMO_GRAPH.nodes.length,
                linkCount: CONSUMING_PROJECT_DEMO_GRAPH.links.length,
                coveredStages: 16,
                totalStages: 16,
                currentPhase: 'outcomes',
                origin: 'synthetic',
                approvalStatus: 'approved',
                validationPassed: validation.passed,
                errorCount: validation.errorCount,
            },
        ],
        activePlanPath: DEFAULT_DEMO_GRAPH_PATH,
        graph: CONSUMING_PROJECT_DEMO_GRAPH,
        validation,
        catalog: {
            catalogRepo: DEFAULT_CATALOG_REPO,
            catalogSource: DEFAULT_CATALOG_URL,
            bundleId: DEFAULT_BUNDLE_ID,
            bundleVersion: DEFAULT_BUNDLE_VERSION,
            specifyInitialized: true,
            authPath: '~/.specify/auth.json',
            authConfigured: false,
            bootstrapInstalled: false,
            configuredCatalogs: ['extension', 'bundle'],
            components: [
                { id: 'extension', name: 'business-plan', label: 'Extension', state: 'installed', version: '0.1.0' },
                { id: 'preset', name: 'business-plan', label: 'Preset', state: 'missing' },
                { id: 'workflow', name: 'business-plan', label: 'Workflow', state: 'missing' },
                { id: 'step', name: 'business-plan-validate', label: 'Step', state: 'missing' },
                { id: 'bundle', name: 'business-plan', label: 'Bundle', state: 'missing' },
            ],
            installedCount: 1,
            totalComponents: 5,
            bundleReady: false,
        },
        commandSpellings,
        workflowRun: null,
        ...overrides,
    };
}

function mountApp(payload: BusinessPlanPayload | null) {
    const sent: BusinessPlanToExtensionMessage[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
        <BusinessPlanApp
            payload={payload}
            notice={null}
            onDismissNotice={() => {}}
            send={(msg) => sent.push(msg)}
        />,
        container,
    );
    return { container, sent };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    document.body.innerHTML = '';
});

describe('BusinessPlanApp', () => {
    it('renders onboarding actions when no business plan graph exists', () => {
        const { container, sent } = mountApp(
            buildPayload({ plans: [], activePlanPath: null, graph: null, validation: null }),
        );
        expect(container.textContent).toContain('Trace strategy to delivery before writing code');

        const demoBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('Load Consuming-Project Demo'),
        );
        expect(demoBtn).toBeDefined();
        demoBtn!.click();
        expect(sent).toContainEqual({ type: 'createDemoPlan' });
    });

    it('renders the 16-stage dossier, opens the NodeInspector on click, and submits human approvals', async () => {
        const { container, sent } = mountApp(buildPayload());

        expect(container.textContent).toContain('16/16');
        expect(container.textContent).toContain('8/8 checks passing');

        const firstCard = container.querySelector('.bp-node-card') as HTMLElement | null;
        expect(firstCard).not.toBeNull();
        firstCard!.click();
        await flush();

        const inspector = container.querySelector('.bp-inspector');
        expect(inspector).not.toBeNull();

        const ownerInput = inspector!.querySelector('input[type="text"]') as HTMLInputElement;
        expect(ownerInput).not.toBeNull();
        ownerInput.value = 'alice';
        ownerInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();

        const form = inspector!.querySelector('form.bp-approval-form') as HTMLFormElement | null;
        expect(form).not.toBeNull();
        form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await flush();

        expect(sent.some((m) => m.type === 'updateNodeApproval' && m.owner === 'alice')).toBe(true);
    });

    it('switches across Traceability Chain, Validation, and Catalog tabs and dispatches catalog actions', async () => {
        const { container, sent } = mountApp(buildPayload());

        const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
        const pipelineTab = tabs.find((t) => t.textContent?.includes('Traceability Chain'))!;
        const validationTab = tabs.find((t) => t.textContent?.includes('Validation'))!;
        const catalogTab = tabs.find((t) => t.textContent?.includes('Catalog & Commands'))!;

        pipelineTab.click();
        await flush();
        expect(container.querySelector('.bp-phase-swimlanes')).not.toBeNull();

        validationTab.click();
        await flush();
        expect(container.textContent).toContain('All 8/8 deterministic checks passing');

        catalogTab.click();
        await flush();
        expect(container.textContent).toContain('thiagomoreirac/speckit-catalog');

        const authBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('Configure ~/.specify/auth.json'),
        )!;
        authBtn.click();
        expect(sent).toContainEqual({ type: 'configureAuth' });

        const installBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('Install business-plan'),
        )!;
        installBtn.click();
        expect(sent).toContainEqual({ type: 'installBundle' });
    });

    it('renders paused human gate controls and dispatches approve/reject decisions', () => {
        const { container, sent } = mountApp(
            buildPayload({
                workflowRun: {
                    runId: 'run-99',
                    workflowId: 'business-plan',
                    status: 'paused',
                    pausedAt: 'review-roadmap',
                    workSeconds: 12,
                    steps: [],
                },
            }),
        );

        expect(container.textContent).toContain('review-roadmap');
        const approveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('Approve Gate'),
        )!;
        approveBtn.click();

        expect(sent).toContainEqual({
            type: 'answerGate',
            runId: 'run-99',
            gateId: 'review-roadmap',
            verdict: 'approve',
        });
    });
});
