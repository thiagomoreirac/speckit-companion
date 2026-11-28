import * as vscode from 'vscode';
import { getProjectRoot } from '../../core/projectRoot';
import { Commands, ConfigKeys, TreeItemContext } from '../../core/constants';
import {
    BUSINESS_PLAN_PHASES,
    DEFAULT_CATALOG_URL,
    DEFAULT_GRAPH_PATTERNS,
    type BusinessPlanPhaseId,
    type BusinessPlanSummary,
    type CatalogIntegrationState,
} from '../../protocol/businessPlan';
import { detectCatalogIntegration } from './catalogIntegration';
import { scanWorkspaceBusinessPlans } from './businessPlanScanner';

type BusinessPlanTreeNodeKind =
    | 'catalog-status'
    | 'plan'
    | 'plan-phase'
    | 'plan-source'
    | 'action-demo';

export class BusinessPlanTreeItem extends vscode.TreeItem {
    public readonly nodeKind: BusinessPlanTreeNodeKind;
    public readonly filePath?: string;
    public readonly phaseId?: BusinessPlanPhaseId;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        nodeKind: BusinessPlanTreeNodeKind,
        opts?: {
            description?: string;
            tooltip?: string;
            icon?: vscode.ThemeIcon;
            contextValue?: string;
            command?: vscode.Command;
            filePath?: string;
            phaseId?: BusinessPlanPhaseId;
        },
    ) {
        super(label, collapsibleState);
        this.nodeKind = nodeKind;
        this.filePath = opts?.filePath;
        this.phaseId = opts?.phaseId;
        if (opts?.description) this.description = opts.description;
        if (opts?.tooltip) this.tooltip = opts.tooltip;
        if (opts?.icon) this.iconPath = opts.icon;
        if (opts?.contextValue) this.contextValue = opts.contextValue;
        if (opts?.command) this.command = opts.command;
    }
}

export class BusinessPlanPaneProvider implements vscode.TreeDataProvider<BusinessPlanTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<BusinessPlanTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<BusinessPlanTreeItem | undefined | void> =
        this._onDidChangeTreeData.event;

    private plans: BusinessPlanSummary[] = [];
    private catalog: CatalogIntegrationState | null = null;

    constructor(private readonly outputChannel: vscode.OutputChannel) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BusinessPlanTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: BusinessPlanTreeItem): BusinessPlanTreeItem[] {
        const workspaceRoot = getProjectRoot();
        if (!workspaceRoot) return [];

        if (!element) {
            return this.buildRootItems(workspaceRoot);
        }

        if (element.nodeKind === 'plan' && element.filePath) {
            return this.buildPlanChildren(element.filePath);
        }

        return [];
    }

    private buildRootItems(workspaceRoot: string): BusinessPlanTreeItem[] {
        const config = vscode.workspace.getConfiguration('speckit');
        const graphPaths = config.get<string[]>(
            ConfigKeys.businessPlanGraphPaths.replace(/^speckit\./, ''),
            [...DEFAULT_GRAPH_PATTERNS],
        );
        const catalogSource = config.get<string>(
            ConfigKeys.businessPlanCatalogSource.replace(/^speckit\./, ''),
            DEFAULT_CATALOG_URL,
        );

        try {
            this.catalog = detectCatalogIntegration(workspaceRoot, catalogSource);
            this.plans = scanWorkspaceBusinessPlans(workspaceRoot, graphPaths).map((d) => d.summary);
        } catch (err) {
            this.outputChannel.appendLine(`[BusinessPlan] scan failed: ${String(err)}`);
            this.plans = [];
        }

        const items: BusinessPlanTreeItem[] = [];

        if (this.catalog) {
            const c = this.catalog;
            const statusDesc = c.bundleReady
                ? `v${c.bundleVersion} · ready`
                : `${c.installedCount}/${c.totalComponents} installed`;
            const statusIcon = c.bundleReady
                ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
                : new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('charts.yellow'));
            items.push(
                new BusinessPlanTreeItem(
                    c.bundleReady ? 'Catalog: business-plan' : 'Setup: speckit-catalog',
                    vscode.TreeItemCollapsibleState.None,
                    'catalog-status',
                    {
                        description: statusDesc,
                        tooltip: c.bundleReady
                            ? `Connected to ${c.catalogRepo} (${c.bundleId} v${c.bundleVersion})`
                            : `Configure ${c.catalogRepo} and install the ${c.bundleId} bundle`,
                        icon: statusIcon,
                        contextValue: TreeItemContext.businessPlanCatalog,
                        command: {
                            command: Commands.businessPlanOpen,
                            title: 'Open Business Plan Integration',
                            arguments: [undefined, 'catalog'],
                        },
                    },
                ),
            );
        }

        if (this.plans.length === 0) {
            items.push(
                new BusinessPlanTreeItem(
                    'Load consuming-project example',
                    vscode.TreeItemCollapsibleState.None,
                    'action-demo',
                    {
                        description: '16-stage demo',
                        tooltip: 'Create examples/consuming-project/traceability.json from thiagomoreirac/speckit-catalog and open the Business Plan interface',
                        icon: new vscode.ThemeIcon('sparkle'),
                        command: {
                            command: Commands.businessPlanOpenDemo,
                            title: 'Load Consuming-Project Example',
                        },
                    },
                ),
            );
            return items;
        }

        for (const plan of this.plans) {
            const icon = plan.parseError
                ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
                : plan.validationPassed
                    ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
                    : new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));

            const statusLabel = plan.parseError
                ? 'parse error'
                : plan.validationPassed
                    ? `${plan.coveredStages}/${plan.totalStages} stages · valid`
                    : `${plan.errorCount} ${plan.errorCount === 1 ? 'issue' : 'issues'}`;

            items.push(
                new BusinessPlanTreeItem(
                    plan.title,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'plan',
                    {
                        description: statusLabel,
                        tooltip: `${plan.title}\n${plan.summary}\nFile: ${plan.filePath}`,
                        icon,
                        contextValue: TreeItemContext.businessPlanItem,
                        filePath: plan.filePath,
                        command: {
                            command: Commands.businessPlanOpen,
                            title: 'Open Business Plan',
                            arguments: [plan.filePath],
                        },
                    },
                ),
            );
        }

        return items;
    }

    private buildPlanChildren(filePath: string): BusinessPlanTreeItem[] {
        const plan = this.plans.find((p) => p.filePath === filePath);
        if (!plan) return [];

        const phaseOrder: Record<BusinessPlanPhaseId, number> = {
            plan: 0,
            strategy: 1,
            delivery: 2,
            outcomes: 3,
        };
        const currentIdx = phaseOrder[plan.currentPhase];

        const children: BusinessPlanTreeItem[] = BUSINESS_PLAN_PHASES.map((phase, idx) => {
            const icon =
                idx < currentIdx
                    ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'))
                    : idx === currentIdx
                        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
                        : new vscode.ThemeIcon('circle-outline');

            return new BusinessPlanTreeItem(
                phase.label,
                vscode.TreeItemCollapsibleState.None,
                'plan-phase',
                {
                    description: phase.gateLabel ? `→ ${phase.gateLabel}` : `${phase.kinds.length} stages`,
                    tooltip: phase.description,
                    icon,
                    filePath,
                    phaseId: phase.id,
                    command: {
                        command: Commands.businessPlanOpen,
                        title: `Open ${phase.label}`,
                        arguments: [filePath, idx === 3 && !plan.validationPassed ? 'validation' : 'overview'],
                    },
                },
            );
        });

        children.push(
            new BusinessPlanTreeItem(
                'Open traceability.json',
                vscode.TreeItemCollapsibleState.None,
                'plan-source',
                {
                    description: filePath,
                    icon: new vscode.ThemeIcon('json'),
                    filePath,
                    command: {
                        command: Commands.businessPlanOpenSource,
                        title: 'Open Traceability JSON',
                        arguments: [filePath],
                    },
                },
            ),
        );

        return children;
    }
}
