import {
    HistoryEntryBy,
    lifecycleStepFor,
    SpecContext,
    STATUS_OWNING_STEP,
    Status,
    StepName,
    inFlightStatusForStep,
} from '../../core/types/specContext';
import { deriveSpecName } from '../../core/utils/specDisplayName';
import { appendTransition, setStepCompleted, setStepStarted } from './specContextWriter';

export const FORCE_STATUS_CHOICES: Status[] = [
    'specifying',
    'specified',
    'planning',
    'planned',
    'ready-to-implement',
    'implementing',
    'implemented',
    'completed',
];

export function lifecycleFallback(specDir: string, step: StepName): SpecContext {
    return {
        workflow: 'speckit',
        specName: deriveSpecName(specDir),
        branch: '',
        currentStep: step,
        status: 'draft',
        history: [],
    };
}

export function setSpecContextStatus(
    ctx: SpecContext,
    status: Status,
    by: HistoryEntryBy = 'extension'
): SpecContext {
    if (ctx.currentStep === 'converge') return { ...ctx, status };
    return appendTransition(
        { ...ctx, status },
        {
            step: ctx.currentStep,
            substep: null,
            kind: 'complete',
            by,
            at: new Date().toISOString(),
        }
    );
}

export function forceSpecContextStatus(
    ctx: SpecContext,
    status: Status,
    by: HistoryEntryBy = 'user'
): SpecContext {
    if (status === 'completed' || status === 'archived') {
        return setSpecContextStatus(ctx, status, by);
    }
    const owning = STATUS_OWNING_STEP.get(status);
    if (!owning) return setSpecContextStatus(ctx, status, by);

    const aligned: SpecContext = { ...ctx, currentStep: owning.step };
    return owning.settled
        ? setStepCompleted(aligned, owning.step, by)
        : setStepStarted(aligned, owning.step, by, undefined, false);
}

export function reactivateSpecContext(
    ctx: SpecContext,
    by: HistoryEntryBy = 'extension'
): SpecContext {
    const step = lifecycleStepFor(ctx.currentStep);
    const status = inFlightStatusForStep(step) ?? ctx.status;
    return appendTransition(
        { ...ctx, currentStep: step, status },
        {
            step,
            substep: null,
            kind: 'complete',
            by,
            at: new Date().toISOString(),
        }
    );
}
