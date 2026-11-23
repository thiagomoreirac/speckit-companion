import { signal } from '@preact/signals';
import type { WorkEvidenceResponse } from '../../../src/protocol/workEvidence';

export const workEvidenceReply = signal<WorkEvidenceResponse | null>(null);
