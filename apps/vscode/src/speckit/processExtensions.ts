import * as vscode from 'vscode';
import { runInTerminal } from '../core/utils/terminalUtils';
import { CLI_PREREQ_COMMAND } from './specKitExtensionInstall';
import type { ProcessExtensionId } from './processExtensionInfo';

export { BUNDLED_AUTHOR, PROCESS_EXTENSION_IDS, coerceProcessExtensionId, processExtensionInfo, processExtensionState } from './processExtensionInfo';
export type { ProcessExtensionId, ProcessExtensionInfo, ProcessExtensionState } from './processExtensionInfo';

/** Runs `specify extension enable <id>` in a terminal at the project folder. */
export async function runSpecifyExtensionEnable(id: ProcessExtensionId, root: string | undefined): Promise<vscode.Terminal | undefined> {
    if (!root) return undefined;
    const terminal = vscode.window.createTerminal({ name: `Turn on Spec Kit ${id} extension`, cwd: root });
    terminal.show();
    await runInTerminal(terminal, `specify extension enable ${id}`);
    return terminal;
}

const installing = new Map<ProcessExtensionId, vscode.Terminal>();

export function _resetForTests(): void {
    installing.clear();
}

export async function runSpecifyExtensionAdd(
    id: ProcessExtensionId,
    root: string | undefined,
): Promise<vscode.Terminal | undefined> {
    if (!root) return undefined;
    // A terminal still open from an earlier try is reused, so a retry runs there instead of piling up terminals.
    const open = installing.get(id);
    const terminal = open && open.exitStatus === undefined
        ? open
        : vscode.window.createTerminal({ name: `Install Spec Kit ${id} extension`, cwd: root });
    installing.set(id, terminal);
    terminal.show();
    if (terminal !== open) {
        await runInTerminal(terminal, `echo "Prerequisite (github-source spec-kit CLI): ${CLI_PREREQ_COMMAND}"`);
    }
    // --force: the registry can still list an extension whose folder is gone, and a plain add would refuse.
    await runInTerminal(terminal, `specify extension add ${id} --force`);
    return terminal;
}
