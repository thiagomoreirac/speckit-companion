import type {
    BusinessPlanWorkflowRun,
    CatalogIntegrationState,
} from '../../../src/protocol/businessPlan';
import {
    BUSINESS_PLAN_COMMANDS,
    BUSINESS_PLAN_PHASES,
    CATALOG_INDEX_FILES,
} from '../../../src/protocol/businessPlan';

export interface CatalogIntegrationPanelProps {
    catalog: CatalogIntegrationState;
    workflowRun: BusinessPlanWorkflowRun | null;
    commandSpellings: Record<string, string>;
    onConfigureAuth: () => void;
    onRegisterCatalog: (source: string) => void;
    onInstallBundle: () => void;
    onRunWorkflow: (draft: boolean) => void;
    onRunStep: (commandId: string) => void;
    onOpenCatalogRepo: () => void;
    onCreateDemoPlan: () => void;
}

export function CatalogIntegrationPanel({
    catalog,
    workflowRun,
    commandSpellings,
    onConfigureAuth,
    onRegisterCatalog,
    onInstallBundle,
    onRunWorkflow,
    onRunStep,
    onOpenCatalogRepo,
    onCreateDemoPlan,
}: CatalogIntegrationPanelProps) {
    return (
        <section class="bp-catalog-view" aria-label="SpecKit catalog integration and bundle commands">
            <div class="bp-catalog-hero">
                <div>
                    <span class="bp-section-kicker">PRIVATE CATALOG INTEGRATION</span>
                    <h2 class="bp-catalog-title">{catalog.catalogRepo}</h2>
                    <p class="bp-catalog-subtitle">
                        Connects this workspace to the <code>{catalog.bundleId}</code> bundle
                        (v{catalog.bundleVersion}) using the <code>examples/consuming-project</code> layout:
                        5 catalog indexes, 11 bundle slash commands, 4 phases, and 3 human approval gates.
                    </p>
                </div>
                <div class="bp-catalog-hero-actions">
                    <button
                        type="button"
                        class="bp-btn bp-btn-secondary bp-btn-sm"
                        onClick={onOpenCatalogRepo}
                    >
                        Open Consuming Project on GitHub
                    </button>
                    <button
                        type="button"
                        class="bp-btn bp-btn-ghost bp-btn-sm"
                        onClick={onCreateDemoPlan}
                    >
                        Create Demo Graph in Workspace
                    </button>
                </div>
            </div>

            <div class="bp-setup-grid">
                <article class="bp-setup-card">
                    <div class="bp-setup-card-head">
                        <span class="bp-setup-step">STEP 1</span>
                        <span class={`bp-status-badge ${catalog.authConfigured ? 'is-pass' : 'is-warning'}`}>
                            {catalog.authConfigured ? 'Configured' : 'Action needed'}
                        </span>
                    </div>
                    <h3 class="bp-setup-title">Private Repo Auth</h3>
                    <p class="bp-setup-desc">
                        Writes <code>~/.specify/auth.json</code> with <code>github-cli</code> so SpecKit CLI
                        authenticates private GitHub catalog downloads via <code>gh auth</code>.
                    </p>
                    <div class="bp-setup-meta">
                        Path: <code>{catalog.authPath}</code>
                    </div>
                    <button
                        type="button"
                        class="bp-btn bp-btn-secondary bp-btn-sm"
                        onClick={onConfigureAuth}
                    >
                        {catalog.authConfigured ? 'Verify / Update auth.json' : 'Configure ~/.specify/auth.json'}
                    </button>
                </article>

                <article class="bp-setup-card">
                    <div class="bp-setup-card-head">
                        <span class="bp-setup-step">STEP 2</span>
                        <span class={`bp-status-badge ${catalog.configuredCatalogs.length === CATALOG_INDEX_FILES.length ? 'is-pass' : 'is-info'}`}>
                            {catalog.configuredCatalogs.length}/{CATALOG_INDEX_FILES.length} indexes
                        </span>
                    </div>
                    <h3 class="bp-setup-title">Register Catalog Sources</h3>
                    <p class="bp-setup-desc">
                        Registers all 5 catalog index URLs (extensions, presets, workflows, steps, bundles)
                        from <code>{catalog.catalogRepo}</code>.
                    </p>
                    <div class="bp-component-pills">
                        {CATALOG_INDEX_FILES.map((idx) => (
                            <span
                                key={idx.kind}
                                class={`bp-mini-pill ${catalog.configuredCatalogs.includes(idx.kind) ? 'is-on' : ''}`}
                            >
                                {idx.kind}
                            </span>
                        ))}
                    </div>
                    <button
                        type="button"
                        class="bp-btn bp-btn-secondary bp-btn-sm"
                        onClick={() => onRegisterCatalog(catalog.catalogSource)}
                    >
                        Register 5 Catalog Indexes
                    </button>
                </article>

                <article class="bp-setup-card">
                    <div class="bp-setup-card-head">
                        <span class="bp-setup-step">STEP 3</span>
                        <span class={`bp-status-badge ${catalog.bundleReady ? 'is-pass' : 'is-warning'}`}>
                            {catalog.bundleReady
                                ? 'Installed'
                                : `${catalog.installedCount}/${catalog.totalComponents} present`}
                        </span>
                    </div>
                    <h3 class="bp-setup-title">Install Business Plan Bundle</h3>
                    <p class="bp-setup-desc">
                        Installs the <code>{catalog.bundleId}</code> bundle (extension, preset, 4-phase workflow,
                        and validation step) into <code>.specify/</code>.
                    </p>
                    <div class="bp-component-pills">
                        {catalog.components.map((comp) => (
                            <span
                                key={comp.id}
                                class={`bp-mini-pill ${comp.state === 'installed' ? 'is-on' : ''}`}
                                title={comp.path ?? comp.label}
                            >
                                {comp.id}
                            </span>
                        ))}
                    </div>
                    <button
                        type="button"
                        class="bp-btn bp-btn-primary bp-btn-sm"
                        onClick={onInstallBundle}
                    >
                        {catalog.bundleReady ? 'Reinstall / Update Bundle' : 'Install business-plan Bundle'}
                    </button>
                </article>

                <article class="bp-setup-card">
                    <div class="bp-setup-card-head">
                        <span class="bp-setup-step">STEP 4</span>
                        <span class={`bp-status-badge ${workflowRun ? 'is-info' : 'is-muted'}`}>
                            {workflowRun ? workflowRun.status : 'Not run yet'}
                        </span>
                    </div>
                    <h3 class="bp-setup-title">Run Guided Workflow</h3>
                    <p class="bp-setup-desc">
                        Launches <code>specify workflow run business-plan</code> through Plan, Strategy,
                        Delivery, and Outcomes with human approval gates.
                    </p>
                    <div class="bp-setup-meta">
                        {workflowRun
                            ? `Latest run: ${workflowRun.runId}${workflowRun.pausedAt ? ` (paused at ${workflowRun.pausedAt})` : ''}`
                            : 'No workflow runs recorded in .specify/workflows/runs/'}
                    </div>
                    <div class="bp-setup-actions-row">
                        <button
                            type="button"
                            class="bp-btn bp-btn-primary bp-btn-sm"
                            onClick={() => onRunWorkflow(false)}
                        >
                            Run Workflow
                        </button>
                        <button
                            type="button"
                            class="bp-btn bp-btn-ghost bp-btn-sm"
                            onClick={() => onRunWorkflow(true)}
                            title="Run workflow in draft mode"
                        >
                            Draft Mode
                        </button>
                    </div>
                </article>
            </div>

            <div class="bp-commands-catalog">
                <h3 class="bp-subheading">Business Plan &amp; Delivery Commands ({BUSINESS_PLAN_COMMANDS.length})</h3>
                <p class="bp-muted bp-small">
                    Click any command to dispatch it straight to your configured AI assistant, just like SpecKit&apos;s spec/plan/tasks actions.
                </p>

                <div class="bp-commands-by-phase">
                    {BUSINESS_PLAN_PHASES.map((phase) => {
                        const cmds = BUSINESS_PLAN_COMMANDS.filter((c) => c.phase === phase.id);
                        return (
                            <div class="bp-cmd-phase-group" key={phase.id}>
                                <div class="bp-cmd-phase-title">{phase.label}</div>
                                <div class="bp-cmd-cards">
                                    {cmds.map((cmd) => {
                                        const spelling = commandSpellings[cmd.id] ?? `/${cmd.id}`;
                                        return (
                                            <div class="bp-cmd-card" key={cmd.id}>
                                                <div class="bp-cmd-card-main">
                                                    <div class="bp-cmd-card-top">
                                                        <span class="bp-cmd-card-name">{cmd.label}</span>
                                                        <span class="bp-cmd-source-tag">
                                                            {cmd.source === 'bundle' ? 'business-plan' : 'speckit'}
                                                        </span>
                                                    </div>
                                                    <code class="bp-cmd-card-slash">{spelling}</code>
                                                    <p class="bp-cmd-card-desc">{cmd.description}</p>
                                                </div>
                                                <button
                                                    type="button"
                                                    class="bp-btn bp-btn-secondary bp-btn-xs"
                                                    onClick={() => onRunStep(cmd.id)}
                                                >
                                                    Run
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
