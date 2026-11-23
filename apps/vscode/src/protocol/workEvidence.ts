import type { entityDiagram } from './entityDiagram';
import type { WireflowPreview } from './wireflowPreview';

export type WorkSourceKind = 'business-plan' | 'epic' | 'idea' | 'bug';

export interface WorkSource {
    kind: WorkSourceKind;
    id: string;
    title: string;
}

export interface WorkRecord extends WorkSource {
    schema: 1;
    kind: 'business-plan' | 'epic';
    description: string;
    outcome: string;
    parent: string | null;
    dependencies: string[];
    createdAt: string;
}

export interface WorkLink {
    schema: 1;
    spec: string;
    source: WorkSource;
    createdAt: string;
}

export interface Artifact {
    path: string;
    kind: 'document' | 'image' | 'diagram' | 'prototype' | 'evidence';
    mime: string | null;
}

export interface GateRevision {
    run: string;
    step: string;
    version: string;
}

export interface ArtifactReview {
    schema: 1;
    spec: string;
    path: string;
    version: string;
    decision: 'approve' | 'request-changes';
    note: string;
    recordedAt: string;
    gate?: GateRevision;
    snapshot?: true;
}

export interface ArtifactComparison {
    path: string;
    mime: Artifact['mime'];
    reviewed: { revision: string; content: string };
    current: { revision: string; content: string };
}

export type WorkEvidenceRequest = { type: 'workEvidence'; request: number } & (
    | { action: 'list' }
    | { action: 'preview'; path: string }
    | { action: 'compare'; path: string; reviewed: string }
    | { action: 'create'; kind: WorkRecord['kind']; title: string; description: string }
    | { action: 'link'; id: string }
    | { action: 'impact'; path: string; revision: string; question: string }
    | { action: 'review'; path: string; revision: string; decision: ArtifactReview['decision']; note: string; keepSnapshot?: boolean }
);

export type WorkEvidenceResponse = { type: 'workEvidenceResult'; request: number } & (
    | { action: 'list'; spec: string; records: WorkRecord[]; links: WorkLink[]; files: Artifact[] }
    | { action: 'preview'; artifact: Artifact & { revision: string; content: string; diagram: ReturnType<typeof entityDiagram>; wireflow: WireflowPreview | null }; reviews: ArtifactReview[] }
    | { action: 'compare'; comparison: ArtifactComparison }
    | { action: 'create' | 'link' | 'impact' | 'review' }
    | { action: 'error'; message: string }
);
