const slots = ['specify', 'plan', 'tasks', 'implement'];
const reserved = new Set(['speckit', 'companion', 'auto', 'default', 'spec-kit']);
const slash = value => typeof value === 'string' && /^\/?[a-z0-9][a-z0-9:._-]*(?: [^\r\n]+)?$/i.test(value.trim())
    ? `/${value.trim().replace(/^\//, '')}` : null;

export function customSteps(workflow) {
    return Object.fromEntries(slots.map(name => [name, slash(workflow.steps?.length
        ? workflow.steps.find(step => step.name === name)?.command : workflow[`step-${name}`])]));
}

export function customWorkflowPhases(workflow) {
    return (workflow?.steps ?? []).filter(step => !slots.includes(step.name)).flatMap(step => {
        const command = slash(step.command);
        if (!command) return [];
        return [{
            name: step.name,
            title: step.label || step.name.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()),
            command,
            file: step.actionOnly ? null : step.file ?? `${step.name}.md`,
            actionOnly: Boolean(step.actionOnly),
        }];
    });
}

export function customWorkflows(settings) {
    const seen = new Set(reserved);
    return (settings.customWorkflows ?? []).filter(workflow => {
        if (seen.has(workflow.name) || (workflow.supportedAiProviders?.length && !workflow.supportedAiProviders.includes('copilot'))) return false;
        seen.add(workflow.name);
        return Object.values(customSteps(workflow)).some(Boolean) || customWorkflowPhases(workflow).length > 0;
    });
}

export function customActions(settings, workflow) {
    const globalCount = (settings.customCommands ?? []).length;
    return [...(settings.customCommands ?? []), ...(workflow?.commands ?? [])].flatMap((entry, index) => {
        if (typeof entry === 'string') entry = { name: entry };
        const name = entry.name?.trim();
        let raw = entry.command?.trim() || name;
        if (index < globalCount && raw && !raw.startsWith('/')) raw = raw.startsWith('speckit.') ? raw : `speckit.${raw}`;
        const command = slash(raw);
        if (!command) return [];
        return [{ id: `custom:${index}`, title: entry.title || name || command, command, step: entry.step || 'all',
            tooltip: entry.tooltip, requiresSpecDir: entry.requiresSpecDir !== false, autoExecute: entry.autoExecute !== false }];
    });
}

export function targetCustomAction(action, id) {
    if (!action.requiresSpecDir) return action.command;
    return action.command.includes('${specDir}') ? action.command.replaceAll('${specDir}', id) : `${action.command} ${id}`;
}
