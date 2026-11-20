import { writeFileSync } from 'node:fs';
import { workspaceEntry } from '../com.github.copilot/extensions/speckit-companion/workflow-inventory.mjs';
import { exportApmImport } from '../com.github.copilot/extensions/speckit-companion/workflow-apm.mjs';

const [target = 'both', ...extra] = process.argv.slice(2);
const name = 'companion-hve-import.json';
try {
    if (!['copilot', 'claude', 'both'].includes(target) || extra.length) {
        throw new Error('Choose exactly one target: copilot, claude, or both.');
    }
    const data = await exportApmImport(workspaceEntry, target);
    writeFileSync(name, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Download ${name} to preview the ${target} import in Companion.\n`);
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
