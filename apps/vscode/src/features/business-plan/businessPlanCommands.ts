import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Commands } from '../../core/constants';
import { getProjectRoot } from '../../core/projectRoot';
import {
    DEFAULT_BUNDLE_VERSION,
    DEFAULT_DEMO_GRAPH_PATH,
    type BusinessPlanTabId,
} from '../../protocol/businessPlan';
import { runInTerminal } from '../../core/utils/terminalUtils';
import { buildInstallBundleCommand, buildWorkflowRunCommand } from './catalogIntegration';
import { CONSUMING_PROJECT_DEMO_GRAPH, createStarterBusinessPlanGraph } from './demoGraph';
import { BusinessPlanPaneProvider, type BusinessPlanTreeItem } from './businessPlanPaneProvider';
import { BusinessPlanPanel } from './businessPlanPanel';
import { scanWorkspaceBusinessPlans } from './businessPlanScanner';

export function registerBusinessPlanCommands(
    context: vscode.ExtensionContext,
    pane: BusinessPlanPaneProvider,
    outputChannel: vscode.OutputChannel,
): void {
    const refreshAll = () => {
        pane.refresh();
        BusinessPlanPanel.refreshIfOpen();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(
            Commands.businessPlanOpen,
            (filePathOrItem?: string | BusinessPlanTreeItem, tab?: BusinessPlanTabId) => {
                const filePath =
                    typeof filePathOrItem === 'string'
                        ? filePathOrItem
                        : filePathOrItem?.filePath;
                BusinessPlanPanel.show(context, outputChannel, () => pane.refresh(), filePath, tab);
            },
        ),

        vscode.commands.registerCommand(Commands.businessPlanRefresh, () => {
            refreshAll();
        }),

        vscode.commands.registerCommand(
            Commands.businessPlanOpenSource,
            async (filePathOrItem?: string | BusinessPlanTreeItem) => {
                const workspaceRoot = getProjectRoot();
                if (!workspaceRoot) return;
                const relPath =
                    typeof filePathOrItem === 'string'
                        ? filePathOrItem
                        : filePathOrItem?.filePath;
                if (!relPath) return;
                const abs = path.resolve(workspaceRoot, relPath);
                if (!abs.startsWith(path.resolve(workspaceRoot) + path.sep) || !fs.existsSync(abs)) {
                    void vscode.window.showWarningMessage(`Business plan file not found: ${relPath}`);
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
                await vscode.window.showTextDocument(doc, { preview: false });
            },
        ),

        vscode.commands.registerCommand(Commands.businessPlanOpenDemo, async () => {
            const workspaceRoot = getProjectRoot();
            if (!workspaceRoot) {
                void vscode.window.showErrorMessage('Open a folder first.');
                return;
            }
            const targetAbs = path.join(workspaceRoot, DEFAULT_DEMO_GRAPH_PATH);
            if (!fs.existsSync(targetAbs)) {
                fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
                fs.writeFileSync(
                    targetAbs,
                    `${JSON.stringify(CONSUMING_PROJECT_DEMO_GRAPH, null, 2)}\n`,
                    'utf8',
                );
            }
            pane.refresh();
            BusinessPlanPanel.show(
                context,
                outputChannel,
                () => pane.refresh(),
                DEFAULT_DEMO_GRAPH_PATH,
                'overview',
            );
        }),

        vscode.commands.registerCommand(Commands.businessPlanCreate, async () => {
            const workspaceRoot = getProjectRoot();
            if (!workspaceRoot) {
                void vscode.window.showErrorMessage('Open a folder first.');
                return;
            }

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(add) New Business Plan',
                        description: 'Create a blank starter traceability.json under business-plans/',
                        action: 'new' as const,
                    },
                    {
                        label: '$(sparkle) Load Consuming-Project Example',
                        description: 'Create examples/consuming-project/traceability.json from speckit-catalog',
                        action: 'demo' as const,
                    },
                ],
                { title: 'Create Business Plan', placeHolder: 'Choose how to start' },
            );
            if (!choice) return;

            if (choice.action === 'demo') {
                await vscode.commands.executeCommand(Commands.businessPlanOpenDemo);
                return;
            }

            const title = (
                await vscode.window.showInputBox({
                    title: 'New Business Plan',
                    prompt: 'Enter a short name for this business plan',
                    placeHolder: 'Q3 Onboarding Growth',
                    validateInput: (val) => (val.trim().length === 0 ? 'Name is required.' : undefined),
                })
            )?.trim();
            if (!title) return;

            const summary = (
                await vscode.window.showInputBox({
                    title: 'Business Plan Summary',
                    prompt: 'Briefly describe the business problem or objective',
                    placeHolder: 'Reduce new-user onboarding drop-off across self-serve signups.',
                })
            )?.trim();

            const slug =
                title
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '') || 'business-plan';
            const relPath = `business-plans/${slug}/traceability.json`;
            const absPath = path.join(workspaceRoot, relPath);
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            const graph = createStarterBusinessPlanGraph(title, summary ?? '', relPath);
            fs.writeFileSync(absPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

            pane.refresh();
            BusinessPlanPanel.show(context, outputChannel, () => pane.refresh(), relPath, 'overview');
        }),

        vscode.commands.registerCommand(Commands.businessPlanInstallBundle, async () => {
            const workspaceRoot = getProjectRoot();
            if (!workspaceRoot) {
                void vscode.window.showErrorMessage('Open a folder first.');
                return;
            }
            const terminal = vscode.window.createTerminal({
                name: 'SpecKit: Install Business Plan Bundle',
                cwd: workspaceRoot,
            });
            await runInTerminal(terminal, buildInstallBundleCommand(DEFAULT_BUNDLE_VERSION));
        }),

        vscode.commands.registerCommand(
            Commands.businessPlanRunWorkflow,
            async (filePathOrItem?: string | BusinessPlanTreeItem) => {
                const workspaceRoot = getProjectRoot();
                if (!workspaceRoot) {
                    void vscode.window.showErrorMessage('Open a folder first.');
                    return;
                }

                let graphPath =
                    typeof filePathOrItem === 'string'
                        ? filePathOrItem
                        : filePathOrItem?.filePath;

                if (!graphPath) {
                    const plans = scanWorkspaceBusinessPlans(workspaceRoot);
                    if (plans.length === 0) {
                        void vscode.window.showWarningMessage(
                            'No business plan traceability.json found. Create one first.',
                        );
                        return;
                    }
                    if (plans.length === 1) {
                        graphPath = plans[0].relativePath;
                    } else {
                        const picked = await vscode.window.showQuickPick(
                            plans.map((p) => ({
                                label: p.summary.title,
                                description: p.relativePath,
                                path: p.relativePath,
                            })),
                            { title: 'Select Business Plan Graph' },
                        );
                        if (!picked) return;
                        graphPath = picked.path;
                    }
                }

                const mode = await vscode.window.showQuickPick(
                    [
                        {
                            label: '$(beaker) Draft run (draft=true)',
                            description: 'Explore and draft artifacts with relaxed gate strictness',
                            draft: true,
                        },
                        {
                            label: '$(verified) Full review run (draft=false)',
                            description: 'Enforce full 8-check validation and human approval gates',
                            draft: false,
                        },
                    ],
                    { title: 'Run Business Plan Workflow' },
                );
                if (!mode) return;

                const terminal = vscode.window.createTerminal({
                    name: 'SpecKit: Business Plan Workflow',
                    cwd: workspaceRoot,
                });
                await runInTerminal(terminal, buildWorkflowRunCommand(graphPath, mode.draft));
            },
        ),
    );
}
