import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getProjectRoot } from '../../core/projectRoot';
import { ConfigKeys } from '../../core/constants';
import { createDispatcher, type DispatcherMap } from '../../core/utils/dispatcher';
import { runInTerminal } from '../../core/utils/terminalUtils';
import { formatCommandForProvider } from '../../ai-providers/aiProvider';
import { getAIProvider } from '../../extension';
import {
    BUSINESS_PLAN_COMMANDS,
    DEFAULT_BUNDLE_VERSION,
    DEFAULT_CATALOG_URL,
    DEFAULT_DEMO_GRAPH_PATH,
    DEFAULT_GRAPH_PATTERNS,
    type ApprovalStatus,
    type BusinessPlanPayload,
    type BusinessPlanTabId,
    type BusinessPlanToExtensionMessage,
    type ExtensionToBusinessPlanMessage,
} from '../../protocol/businessPlan';
import {
    buildGateResumeCommand,
    buildInstallBundleCommand,
    buildRegisterCatalogCommand,
    buildWorkflowRunCommand,
    detectCatalogIntegration,
    ensureGithubCliAuthFile,
    readLatestBusinessPlanRun,
} from './catalogIntegration';
import { CONSUMING_PROJECT_DEMO_GRAPH, createStarterBusinessPlanGraph } from './demoGraph';
import { scanWorkspaceBusinessPlans } from './businessPlanScanner';
import { parseAndValidateBusinessPlan } from './traceabilityValidator';

function nonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

function resolveInsideRoot(workspaceRoot: string, relPath: string): string | null {
    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(root, relPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null;
    }
    return resolved;
}

export class BusinessPlanPanel {
    public static readonly VIEW_TYPE = 'speckit.businessPlan';
    private static current: BusinessPlanPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private activePlanPath: string | null = null;
    private initialTab: BusinessPlanTabId | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;

    static show(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        onDataChanged: () => void,
        planPath?: string,
        tab?: BusinessPlanTabId,
    ): BusinessPlanPanel | undefined {
        const workspaceRoot = getProjectRoot();
        if (!workspaceRoot) {
            void vscode.window.showErrorMessage('Open a folder before opening Business Plans.');
            return undefined;
        }

        if (BusinessPlanPanel.current) {
            if (planPath) BusinessPlanPanel.current.activePlanPath = planPath;
            if (tab) BusinessPlanPanel.current.initialTab = tab;
            BusinessPlanPanel.current.panel.reveal(vscode.ViewColumn.Active);
            void BusinessPlanPanel.current.sendState();
            return BusinessPlanPanel.current;
        }

        const panel = vscode.window.createWebviewPanel(
            BusinessPlanPanel.VIEW_TYPE,
            'Business Plan',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview')),
                ],
            },
        );
        panel.iconPath = {
            light: vscode.Uri.file(path.join(context.extensionPath, 'assets', 'icons', 'spec-kit-dark.svg')),
            dark: vscode.Uri.file(path.join(context.extensionPath, 'assets', 'icons', 'spec-kit-light.svg')),
        };

        BusinessPlanPanel.current = new BusinessPlanPanel(
            panel,
            context,
            workspaceRoot,
            outputChannel,
            onDataChanged,
            planPath ?? null,
            tab,
        );
        return BusinessPlanPanel.current;
    }

    static refreshIfOpen(): void {
        if (BusinessPlanPanel.current) {
            void BusinessPlanPanel.current.sendState();
        }
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly workspaceRoot: string,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly onDataChanged: () => void,
        initialPlanPath: string | null,
        initialTab?: BusinessPlanTabId,
    ) {
        this.panel = panel;
        this.activePlanPath = initialPlanPath;
        this.initialTab = initialTab;
        this.panel.webview.html = this.html();

        this.disposables.push(
            this.panel.onDidDispose(() => this.dispose()),
            this.panel.webview.onDidReceiveMessage((msg: BusinessPlanToExtensionMessage) => {
                void this.dispatch(msg);
            }),
        );

        this.watchWorkspace();
    }

    private watchWorkspace(): void {
        const patterns = [
            '**/traceability.json',
            '.specify/workflows/runs/**/*',
            '.specify/extensions/business-plan/**/*',
            '.specify/presets/business-plan/**/*',
            '.specify/workflows/business-plan/**/*',
            '.specify/bundles/business-plan/**/*',
        ];
        for (const glob of patterns) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.workspaceRoot, glob),
            );
            const schedule = () => {
                if (this.refreshTimer) clearTimeout(this.refreshTimer);
                this.refreshTimer = setTimeout(() => {
                    this.onDataChanged();
                    void this.sendState();
                }, 250);
            };
            this.disposables.push(
                watcher,
                watcher.onDidChange(schedule),
                watcher.onDidCreate(schedule),
                watcher.onDidDelete(schedule),
            );
        }
    }

    private readonly handlers: DispatcherMap<BusinessPlanToExtensionMessage, []> = {
        ready: async () => {
            await this.sendState();
        },
        refresh: async () => {
            this.onDataChanged();
            await this.sendState();
            await this.notice('info', 'Refreshed business plan state and catalog integration.');
        },
        selectPlan: async ({ filePath }) => {
            if (!resolveInsideRoot(this.workspaceRoot, filePath)) return;
            this.activePlanPath = filePath;
            this.initialTab = undefined;
            await this.sendState();
        },
        openSource: async ({ filePath }) => {
            const abs = resolveInsideRoot(this.workspaceRoot, filePath);
            if (!abs || !fs.existsSync(abs)) {
                await this.notice('error', `File not found: ${filePath}`);
                return;
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
            await vscode.window.showTextDocument(doc, { preview: false });
        },
        runStep: async ({ commandId, graphPath, nodeId }) => {
            const known = BUSINESS_PLAN_COMMANDS.find((c) => c.id === commandId);
            if (!known) {
                await this.notice('error', `Unknown business plan command: ${commandId}`);
                return;
            }
            const formatted = formatCommandForProvider(known.id);
            const contextParts: string[] = [];
            if (graphPath) contextParts.push(`graph=${graphPath}`);
            if (nodeId) contextParts.push(`node=${nodeId}`);
            const prompt = contextParts.length > 0
                ? `/${formatted} ${contextParts.join(' ')}`
                : `/${formatted}`;

            try {
                await getAIProvider().executeInTerminal(prompt, `Business Plan - ${known.label}`);
                await this.notice('done', `Sent /${formatted} to your assistant.`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.outputChannel.appendLine(`[BusinessPlan] runStep failed: ${msg}`);
                await this.notice('error', `Could not launch /${formatted}: ${msg}`);
            }
        },
        runWorkflow: async ({ graphPath, draft }) => {
            if (!resolveInsideRoot(this.workspaceRoot, graphPath)) {
                await this.notice('error', 'Graph path must remain inside the project folder.');
                return;
            }
            const command = buildWorkflowRunCommand(graphPath, draft);
            await this.runTerminalCommand('SpecKit: Business Plan Workflow', command);
            await this.notice(
                'info',
                `Started business-plan workflow (${draft ? 'draft' : 'final'} mode) in terminal.`,
            );
        },
        answerGate: async ({ runId, gateId, verdict }) => {
            const command = buildGateResumeCommand(runId, gateId, verdict);
            if (!command) {
                await this.notice('error', `Cannot resume gate "${gateId}" for run "${runId}".`);
                return;
            }
            await this.runTerminalCommand(`SpecKit: ${gateId}`, command);
            await this.notice(
                'done',
                `Submitted "${verdict}" decision to ${gateId} gate in terminal.`,
            );
        },
        configureAuth: async () => {
            try {
                const authPath = ensureGithubCliAuthFile();
                await this.runTerminalCommand(
                    'SpecKit: GitHub CLI Auth',
                    'gh auth status || gh auth login',
                );
                await this.sendState();
                this.onDataChanged();
                await this.notice(
                    'done',
                    `Configured GitHub CLI auth entries in ${authPath}. Verify gh auth in the terminal.`,
                );
            } catch (err) {
                await this.notice(
                    'error',
                    `Failed to configure auth.json: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
        registerCatalog: async ({ source, ref }) => {
            const effectiveSource = source.trim() || this.configuredCatalogSource();
            const command = buildRegisterCatalogCommand(effectiveSource, ref);
            await this.runTerminalCommand('SpecKit: Register Catalog', command);
            await this.notice(
                'info',
                'Running catalog registration for extensions, presets, workflows, steps, and bundles in terminal.',
            );
        },
        installBundle: async ({ version }) => {
            const command = buildInstallBundleCommand(version || DEFAULT_BUNDLE_VERSION);
            await this.runTerminalCommand('SpecKit: Install Business Plan Bundle', command);
            await this.notice(
                'info',
                `Running "${command}" in terminal. The panel refreshes automatically once installed.`,
            );
        },
        createDemoPlan: async () => {
            const targetRel = DEFAULT_DEMO_GRAPH_PATH;
            const targetAbs = resolveInsideRoot(this.workspaceRoot, targetRel);
            if (!targetAbs) return;
            try {
                fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
                fs.writeFileSync(
                    targetAbs,
                    `${JSON.stringify(CONSUMING_PROJECT_DEMO_GRAPH, null, 2)}\n`,
                    'utf8',
                );
                this.activePlanPath = targetRel;
                this.initialTab = 'overview';
                this.onDataChanged();
                await this.sendState();
                await this.notice(
                    'done',
                    `Created consuming-project example graph at ${targetRel} (16 stages, 8/8 checks passing).`,
                );
            } catch (err) {
                await this.notice(
                    'error',
                    `Could not create example graph: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
        createNewPlan: async ({ title, summary }) => {
            let planTitle = title?.trim();
            if (!planTitle) {
                planTitle = (
                    await vscode.window.showInputBox({
                        title: 'New Business Plan',
                        prompt: 'Enter a short name for this business plan (e.g. Q3 Onboarding Growth)',
                        placeHolder: 'q3-onboarding-growth',
                        validateInput: (val) => (val.trim().length === 0 ? 'Name is required.' : undefined),
                    })
                )?.trim();
            }
            if (!planTitle) return;

            let planSummary = summary?.trim();
            if (!planSummary) {
                planSummary = (
                    await vscode.window.showInputBox({
                        title: 'Business Plan Summary',
                        prompt: 'Briefly describe the business problem or objective this plan addresses',
                        placeHolder: 'Reduce new-user onboarding drop-off across self-serve signups.',
                    })
                )?.trim();
            }

            const slug = planTitle
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'business-plan';
            const relPath = `business-plans/${slug}/traceability.json`;
            const absPath = resolveInsideRoot(this.workspaceRoot, relPath);
            if (!absPath) return;

            try {
                fs.mkdirSync(path.dirname(absPath), { recursive: true });
                const graph = createStarterBusinessPlanGraph(planTitle, planSummary ?? '', relPath);
                fs.writeFileSync(absPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
                this.activePlanPath = relPath;
                this.initialTab = 'overview';
                this.onDataChanged();
                await this.sendState();
                await this.notice('done', `Created starter business plan at ${relPath}.`);
            } catch (err) {
                await this.notice(
                    'error',
                    `Could not create business plan: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
        updateNodeApproval: async ({ filePath, nodeId, status, owner, reference }) => {
            const abs = resolveInsideRoot(this.workspaceRoot, filePath);
            if (!abs || !fs.existsSync(abs)) {
                await this.notice('error', `Graph file not found: ${filePath}`);
                return;
            }
            const cleanOwner = owner.trim();
            const cleanRef = reference.trim();
            if (!cleanOwner || !cleanRef) {
                await this.notice('error', 'Approval owner and reference are required.');
                return;
            }
            try {
                const raw = fs.readFileSync(abs, 'utf8');
                const parsed = JSON.parse(raw) as {
                    nodes?: Array<Record<string, unknown>>;
                };
                if (!Array.isArray(parsed.nodes)) {
                    await this.notice('error', 'Graph file has no nodes array.');
                    return;
                }
                const target = parsed.nodes.find((n) => n.id === nodeId);
                if (!target) {
                    await this.notice('error', `Node "${nodeId}" not found.`);
                    return;
                }
                const nextStatus: ApprovalStatus =
                    status === 'approved' || status === 'rejected' ? status : 'pending';
                target.approval = {
                    status: nextStatus,
                    owner: cleanOwner,
                    reference: cleanRef,
                };
                const tmp = `${abs}.tmp`;
                fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
                fs.renameSync(tmp, abs);
                this.onDataChanged();
                await this.sendState();
                await this.notice('done', `Recorded "${nextStatus}" approval on ${nodeId}.`);
            } catch (err) {
                await this.notice(
                    'error',
                    `Failed to update approval: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
        openSettings: async ({ setting }) => {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                setting || 'speckit.businessPlan',
            );
        },
        openExternal: async ({ url }) => {
            if (/^https:\/\//i.test(url)) {
                await vscode.env.openExternal(vscode.Uri.parse(url));
            }
        },
    };

    private readonly dispatch = createDispatcher(this.handlers, {
        onUnhandled: (message) =>
            this.outputChannel.appendLine(
                `[BusinessPlan] ignored message: ${(message as { type: string }).type}`,
            ),
    });

    private async runTerminalCommand(name: string, command: string): Promise<void> {
        const terminal = vscode.window.createTerminal({
            name,
            cwd: this.workspaceRoot,
        });
        await runInTerminal(terminal, command);
    }

    private configuredCatalogSource(): string {
        return vscode.workspace
            .getConfiguration('speckit')
            .get<string>(ConfigKeys.businessPlanCatalogSource.replace(/^speckit\./, ''), DEFAULT_CATALOG_URL);
    }

    private configuredGraphPaths(): string[] {
        return vscode.workspace
            .getConfiguration('speckit')
            .get<string[]>(ConfigKeys.businessPlanGraphPaths.replace(/^speckit\./, ''), [
                ...DEFAULT_GRAPH_PATTERNS,
            ]);
    }

    private async sendState(): Promise<void> {
        const discovered = scanWorkspaceBusinessPlans(this.workspaceRoot, this.configuredGraphPaths());
        const plans = discovered.map((d) => d.summary);

        if (!this.activePlanPath || !plans.some((p) => p.filePath === this.activePlanPath)) {
            this.activePlanPath = plans[0]?.filePath ?? null;
        }

        let graph = null;
        let validation = null;
        let parseError: string | undefined;

        if (this.activePlanPath) {
            const abs = resolveInsideRoot(this.workspaceRoot, this.activePlanPath);
            if (abs && fs.existsSync(abs)) {
                try {
                    const raw = fs.readFileSync(abs, 'utf8');
                    const parsed = parseAndValidateBusinessPlan(raw);
                    graph = parsed.graph;
                    validation = parsed.report;
                    parseError = parsed.parseError;
                } catch (err) {
                    parseError = err instanceof Error ? err.message : String(err);
                }
            }
        }

        const catalog = detectCatalogIntegration(this.workspaceRoot, this.configuredCatalogSource());
        const workflowRun =
            readLatestBusinessPlanRun(this.workspaceRoot, this.activePlanPath ?? undefined) ??
            catalog.latestRun ??
            null;

        const commandSpellings: Record<string, string> = {};
        for (const cmd of BUSINESS_PLAN_COMMANDS) {
            commandSpellings[cmd.id] = `/${formatCommandForProvider(cmd.id)}`;
        }

        const activeSummary = plans.find((p) => p.filePath === this.activePlanPath);
        this.panel.title = activeSummary ? `Business Plan · ${activeSummary.title}` : 'Business Plan';

        const payload: BusinessPlanPayload = {
            workspaceName: path.basename(this.workspaceRoot),
            plans,
            activePlanPath: this.activePlanPath,
            graph,
            parseError,
            validation,
            catalog,
            commandSpellings,
            workflowRun,
            initialTab: this.initialTab,
        };
        this.initialTab = undefined;

        await this.post({ type: 'state', payload });
    }

    private notice(tone: 'info' | 'done' | 'error', text: string): Thenable<boolean> {
        return this.post({ type: 'notice', tone, text });
    }

    private post(message: ExtensionToBusinessPlanMessage): Thenable<boolean> {
        return this.panel.webview.postMessage(message);
    }

    private html(): string {
        const webview = this.panel.webview;
        const dist = vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview'));
        const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'business-plan.js'));
        const styles = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'business-plan.css'));
        const tokens = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'tokens.css'));
        const id = nonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${id}'; font-src ${webview.cspSource};">
<link href="${tokens}" rel="stylesheet">
<link href="${styles}" rel="stylesheet">
<title>Business Plan</title>
</head>
<body>
<div id="app-root"></div>
<script nonce="${id}" src="${script}"></script>
</body>
</html>`;
    }

    private dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        BusinessPlanPanel.current = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
