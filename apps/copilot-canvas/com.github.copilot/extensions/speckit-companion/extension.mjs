// SpecKit Companion spec board, as a GitHub Copilot app canvas.
// Wiring only: the board logic lives in server.mjs and specs-core.mjs, which run without the SDK.

import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { createSpecServer } from './server.mjs';
import { CANVAS_DESCRIPTION, SPEC_COMMANDS, SYSTEM_RULE, dedicatedWorkPrompt, openStatus } from './prompts.mjs';
import { linkedDraftStorage, rootSelection, validateRepositoryRoot, validateRoot } from './workspace.mjs';
import { createDedicatedWork } from './work-handoff.mjs';
import { readDeliveryRecord, reconcileDeliveryRecord } from './delivery-ledger.mjs';

const CANVAS_ID = 'speckit-spec-board';
const servers = new Map();

function serverFor(ctx) {
    const entry = servers.get(ctx.instanceId);
    if (!entry) throw new CanvasError('canvas_not_open', 'The spec board is not open. Open it first.');
    return entry;
}

function summary(spec) {
    const { id, title, statusLabel, currentStep, steps, tasks, done, pendingReviews, lastActivity, workflowError } = spec;
    return { id, title, status: statusLabel, currentStep, steps, tasks, done, pendingReviews, lastActivity, workflowError };
}

function specError(error) {
    return new CanvasError(error.status === 404 ? (error.sessionMissing ? 'session_not_found' : 'spec_not_found') : 'spec_board_error', error.message);
}

const specInput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        spec: { type: 'string', minLength: 1, description: 'Spec folder path (specs/042-foo), folder name (042-foo), or number (042).' },
    },
    required: ['spec'],
};

const coordinatedSessionSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        sessionId: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1, description: 'Actual worktree directory only if accessible from the board host.' },
        name: { type: 'string', minLength: 1 },
        activity: { type: 'string', enum: ['busy', 'idle', 'unknown'] },
        url: { type: 'string', description: 'Exact canonical ghapp://sessions/ link from app tools. Required when cwd is omitted.' },
    },
    required: ['sessionId', 'name'],
};
const requestIdSchema = { type: 'string', minLength: 36, maxLength: 36 };

function followDirectory(entry, directory) {
    try {
        entry.followWorkingDirectory(directory);
    } catch (error) {
        session?.log?.(`[speckit-canvas] cannot follow ${directory}: ${error.message}`);
    }
}

/**
 * The sessions this chat created through the runtime's session management, read-only and filtered to this session's own children.
 * The opt-in policy is the user's: it is never enabled from here, so a chat without it simply has no discovered children.
 */
async function discoverChildren() {
    const list = session.rpc?.management?.list;
    if (!list) return { children: [], note: 'This runtime does not expose session management.' };
    try {
        const { sessions } = await list({});
        const children = (sessions ?? [])
            .filter(peer => peer.parentSessionId === session.sessionId)
            .map(peer => ({ sessionId: peer.sessionId, name: peer.name, cwd: peer.cwd, state: peer.state }));
        return { children, note: null };
    } catch (error) {
        return { children: [], note: `Child sessions are not discoverable: ${error.message}` };
    }
}

const session = await joinSession({
    systemMessage: { mode: 'append', content: SYSTEM_RULE },
    canvases: [
        createCanvas({
            id: CANVAS_ID,
            displayName: 'SpecKit Companion',
            description: CANVAS_DESCRIPTION,
            inputSchema: {
                type: ['object', 'null'],
                additionalProperties: false,
                properties: {
                    root: { type: 'string', minLength: 1, description: 'Initial absolute repository directory when the chat has no saved selection. Use select_root to change a saved selection.' },
                    spec: { type: 'string', description: 'Optional spec to open focused (path, folder name, or number).' },
                },
            },
            actions: [
                {
                    name: 'select_root',
                    description: 'Select and save the absolute repository directory to scan. Use when the board is open in a Project chat rather than a repository checkout: pass the worktree path of the coordinated session that owns the repository (from the session\'s own details), never a guessed or most-recent one.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { root: { type: 'string', minLength: 1 } },
                        required: ['root'],
                    },
                    handler: (ctx) => {
                        try {
                            const snapshot = serverFor(ctx).selectRoot(ctx.input.root);
                            return { root: snapshot.root, count: snapshot.specs.length };
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'select_child',
                    description: 'Select one of the sessions this chat created (listed in the board) and save the choice. Use when the board lists several child sessions and the user says which one to show. Specs are read from that child\'s worktree; commands are sent to that exact child through session management. The board does not observe the child turn or report its progress.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { sessionId: { type: 'string', minLength: 1 } },
                        required: ['sessionId'],
                    },
                    handler: (ctx) => {
                        try {
                            const snapshot = serverFor(ctx).selectChild(ctx.input.sessionId);
                            return { root: snapshot.root, count: snapshot.specs.length };
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'update_coordinated_sessions',
                    description: 'Coordinator only: replace the complete list of your own nonarchived app sessions, including idle sessions, using scoped get_sessions_status and get_session. Include cwd only for worktrees accessible from this board; otherwise use the exact app URL. Refresh after external create, resume, switch, archive, activity or worktree changes. For a claimed dedicated work request use finish_dedicated_work instead. Never supply unrelated sessions or guess a latest session.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            sessions: {
                                type: 'array',
                                items: coordinatedSessionSchema,
                            },
                        },
                        required: ['sessions'],
                    },
                    handler: (ctx) => {
                        try {
                            const snapshot = serverFor(ctx).updateCoordinatedSessions(ctx.input.sessions);
                            return { count: snapshot.coordinatedSessions.length, root: snapshot.root, source: snapshot.boundSession };
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'bind_coordinated_session',
                    description: 'Coordinator only. Show a coordinated session\'s worktree on this board. First read that session with your get_session tool and pass its exact session id, its worktree path and its name; never guess, scan sessions, or use a latest one, and when several children exist use the one the user means. This is a caller-provided binding the board cannot verify, and it does not follow later changes: call it again whenever the child is created, resumed, switched or its worktree changes. It is saved and outranks following; use_session_directory clears it. Commands are sent to that exact session through session management, without child-turn progress tracking.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            sessionId: { type: 'string', minLength: 1 },
                            cwd: { type: 'string', minLength: 1, description: 'Absolute worktree path from get_session.' },
                            name: { type: 'string' },
                        },
                        required: ['sessionId', 'cwd'],
                    },
                    handler: (ctx) => {
                        try {
                            const snapshot = serverFor(ctx).bindSession(ctx.input);
                            return { root: snapshot.root, count: snapshot.specs.length, source: snapshot.boundSession };
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'use_session_directory',
                    description: 'Drop the saved repository selection and follow this session\'s working directory again. The board then moves with the session\'s worktree automatically.',
                    handler: (ctx) => {
                        try {
                            const snapshot = serverFor(ctx).followSession();
                            return { root: snapshot.root, count: snapshot.specs.length };
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'list_specs',
                    description: 'List the specs on the board with status, pipeline step badges and task progress. Use this to answer any question about which specs exist or where they stand, instead of reading files under specs/. Pass filter "active" to skip completed and archived specs.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { filter: { type: 'string', enum: ['all', 'active', 'done'] } },
                    },
                    handler: (ctx) => {
                        const { specs } = serverFor(ctx).snapshot;
                        const filter = ctx.input?.filter ?? 'all';
                        const picked = filter === 'all' ? specs : specs.filter(s => (filter === 'done' ? s.done : !s.done));
                        return { count: picked.length, specs: picked.map(summary) };
                    },
                },
                {
                    name: 'get_spec',
                    description: 'Get one spec: status, step badges, task list with done state, per-phase progress, run history, intent and decisions.',
                    inputSchema: specInput,
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).detail(ctx.input.spec);
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'focus_spec',
                    description: 'Select a spec on the board so the user sees its documents and pipeline. Call this whenever the user names a spec or asks to see, show or open one, instead of reading its files under specs/.',
                    inputSchema: specInput,
                    handler: (ctx) => {
                        try {
                            return summary(serverFor(ctx).focus(ctx.input.spec));
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'run_step',
                    description: 'Send a SpecKit command for a spec to the selected session when bound, otherwise to this chat. Child turn progress is not tracked.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            spec: specInput.properties.spec,
                            command: { type: 'string', enum: SPEC_COMMANDS.filter(command => command !== 'taskstoissues') },
                        },
                        required: ['spec', 'command'],
                    },
                    handler: async (ctx) => {
                        try {
                            if (ctx.input.command === 'taskstoissues') throw new Error('Create issues requires confirmation on the board.');
                            return await serverFor(ctx).run(ctx.input.spec, ctx.input.command);
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'get_autonomy_policy',
                    description: 'Read-only: inspect the repository autonomy policy parsed strictly from cached origin/HEAD (.specify/autonomy.json), or its safe default / fail-closed fallback.',
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).getAutonomyPolicy();
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'prepare_dedicated_work',
                    description: 'Read-only handoff for an explicit request to start isolated work on one spec, bug, or Ready idea. Returns the repository, exact base branch and commit, and one committed work record. Before creating a cloud worktree session, the coordinating agent must recheck the branch tip on GitHub and reuse any session already assigned to that item. Verify the new checkout starts at the reported commit before work. Never substitute the parent chat or another item. This action does not start work or grant approval.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', enum: ['spec', 'bug', 'idea'] },
                            id: { type: 'string', minLength: 1, maxLength: 320, description: 'Exact spec folder path or Companion triage record ID.' },
                            autonomyMode: { type: 'string', enum: ['gated', 'unattended'], description: 'Optional requested autonomy mode, validated against origin/HEAD .specify/autonomy.json.' },
                        },
                        required: ['kind', 'id'],
                    },
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).prepareDedicatedWork(ctx.input.kind, ctx.input.id, { autonomyMode: ctx.input.autonomyMode });
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'claim_dedicated_work',
                    description: 'Owning coordinator only: claim the exact request ID sent by the board after user confirmation. Returns the pinned handoff and previous assignment, if any. Never create work if the claim fails.',
                    inputSchema: { type: 'object', additionalProperties: false, properties: { requestId: requestIdSchema }, required: ['requestId'] },
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).claimDedicatedWork(ctx.input.requestId);
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'finish_dedicated_work',
                    description: 'Owning coordinator only: confirm the claimed request after verifying your exact child, assigned work item, isolated branch and starting revision. Updates the durable delivery ledger and picker in place. Report blocked instead if verification failed and no unresolved allocation exists. Omit cwd for open-only children; the canonical app URL is required.',
                    inputSchema: {
                        type: 'object', additionalProperties: false,
                        properties: {
                            requestId: requestIdSchema,
                            session: coordinatedSessionSchema,
                            baseRevision: { type: 'string' },
                            blocked: { type: 'string', minLength: 1, maxLength: 300 },
                            branch: { type: 'string', minLength: 1, maxLength: 200 },
                            issue: {
                                type: 'object', additionalProperties: false,
                                properties: {
                                    number: { type: 'integer', minimum: 1 },
                                    url: { type: 'string', minLength: 1 },
                                    state: { type: 'string', enum: ['open', 'closed'] },
                                },
                                required: ['number'],
                            },
                            pr: {
                                type: 'object', additionalProperties: false,
                                properties: {
                                    number: { type: 'integer', minimum: 1 },
                                    url: { type: 'string', minLength: 1 },
                                    state: { type: 'string', enum: ['open', 'closed', 'merged'] },
                                    draft: { type: 'boolean' },
                                    checks: { type: 'string', enum: ['pending', 'passing', 'failing', 'unknown'] },
                                },
                                required: ['number'],
                            },
                        },
                        required: ['requestId'],
                    },
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).finishDedicatedWork(ctx.input);
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'reconcile_delivery',
                    description: 'Coordinator only: upsert a durable delivery ledger record in .speckit-companion/delivery/ mapping a spec, bug, or idea to its GitHub issue, branch, PR, app session, and gate state. Never stores machine-local cwd paths or cross-repo URLs.',
                    inputSchema: {
                        type: 'object', additionalProperties: false,
                        properties: {
                            kind: { type: 'string', enum: ['spec', 'bug', 'idea'] },
                            id: { type: 'string', minLength: 1, maxLength: 320 },
                            path: { type: 'string', minLength: 1, maxLength: 512 },
                            repository: { type: 'string', minLength: 1, maxLength: 140 },
                            baseBranch: { type: ['string', 'null'] },
                            baseRevision: { type: ['string', 'null'] },
                            autonomyMode: { type: 'string', enum: ['gated', 'unattended'] },
                            branch: { type: ['string', 'null'] },
                            issue: {
                                type: ['object', 'null'], additionalProperties: false,
                                properties: {
                                    number: { type: 'integer', minimum: 1 },
                                    url: { type: 'string' },
                                    state: { type: 'string', enum: ['open', 'closed'] },
                                },
                                required: ['number'],
                            },
                            pr: {
                                type: ['object', 'null'], additionalProperties: false,
                                properties: {
                                    number: { type: 'integer', minimum: 1 },
                                    url: { type: 'string' },
                                    state: { type: 'string', enum: ['open', 'closed', 'merged'] },
                                    draft: { type: 'boolean' },
                                    checks: { type: 'string', enum: ['pending', 'passing', 'failing', 'unknown'] },
                                },
                                required: ['number'],
                            },
                            session: {
                                type: ['object', 'null'], additionalProperties: false,
                                properties: {
                                    sessionId: { type: 'string', minLength: 1 },
                                    name: { type: 'string', minLength: 1 },
                                    url: { type: 'string' },
                                    status: { type: 'string', enum: ['active', 'idle', 'expired', 'archived'] },
                                    assignedRevision: { type: 'string' },
                                },
                                required: ['sessionId'],
                            },
                            gate: {
                                type: ['object', 'null'], additionalProperties: false,
                                properties: {
                                    id: { type: 'string', minLength: 8, maxLength: 8 },
                                    status: { type: 'string', enum: ['awaiting-decision', 'approved', 'changes-requested', 'blocked', 'stale', 'resolved'] },
                                    prNumber: { type: 'integer', minimum: 1 },
                                    issueNumber: { type: 'integer', minimum: 1 },
                                },
                                required: ['id', 'status'],
                            },
                            state: { type: 'string', enum: ['queued', 'assigned', 'in-progress', 'awaiting-gate', 'pr-open', 'merged', 'blocked', 'expired'] },
                            detail: { type: ['string', 'null'], maxLength: 300 },
                            expectedRevision: { type: ['string', 'null'] },
                        },
                        required: ['kind', 'id'],
                    },
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).reconcileDelivery(ctx.input);
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'recover_delivery_session',
                    description: 'Coordinator only: mark an expired or missing child session on a delivery ledger entry as expired and record it in supersededSessions while preserving its existing branch, PR, issue, and gate so a replacement session can continue the same work.',
                    inputSchema: {
                        type: 'object', additionalProperties: false,
                        properties: {
                            kind: { type: 'string', enum: ['spec', 'bug', 'idea'] },
                            id: { type: 'string', minLength: 1, maxLength: 320 },
                            expiredSessionId: { type: 'string', minLength: 1 },
                            reason: { type: 'string', minLength: 1, maxLength: 300 },
                            expectedRevision: { type: ['string', 'null'] },
                        },
                        required: ['kind', 'id'],
                    },
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).recoverDelivery(ctx.input);
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'list_automation_blueprints',
                    description: 'List the loop-safe, least-privilege Cloud Autonomy Automation blueprints for the current repository along with autonomy policy compliance and GitHub Actions fallback templates.',
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).listAutomationBlueprints();
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'get_multichannel_decisions',
                    description: 'Inspect current-branch cloud gates, offline cross-branch gates across local Git refs, correlated delivery ledger records, and promotable spec ADR candidates without mutating any gate.',
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).getMultichannelDecisions();
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'preview_adr_promotions',
                    description: 'Preview schema-v1 ADR entries harvested from specs/*/.spec-context.json that are not yet present in .specify/decisions.json on origin/HEAD.',
                    handler: (ctx) => {
                        try {
                            return serverFor(ctx).previewAdrPromotions();
                        } catch (error) {
                            throw specError(error);
                        }
                    },
                },
                {
                    name: 'refresh',
                    description: 'Re-read every spec folder and update the board.',
                    handler: (ctx) => ({ count: serverFor(ctx).rescan().specs.length }),
                },
            ],
            open: async (ctx) => {
                const selection = rootSelection(session.workspacePath);
                let savedRoot = null;
                try {
                    savedRoot = selection.read();
                } catch (error) {
                    // A saved directory that is gone or unreadable no longer applies; the board follows the session until a new one is chosen.
                    session.log?.(`[speckit-canvas] ignoring the saved repository selection: ${error.message}`);
                }
                const current = ctx.session?.workingDirectory;
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    const root = savedRoot ?? ctx.input?.root ?? current;
                    if (!root) throw new CanvasError('workspace_unavailable', 'The session has no working directory.');
                    const resolvedRoot = !savedRoot && ctx.input?.root ? validateRepositoryRoot(root) : validateRoot(root);
                    if (!savedRoot && ctx.input?.root) selection.write(resolvedRoot);
                    entry = await createSpecServer({
                        root: resolvedRoot,
                        workingDirectory: current,
                        instanceId: ctx.instanceId,
                        manual: Boolean(savedRoot || ctx.input?.root),
                        bound: savedRoot ? selection.source() : null,
                        coordinatedSessions: selection.sessions(),
                        saveCoordinatedSessions: (sessions, root, source) => selection.writeSessions(sessions, root, source),
                        dedicatedWork: session.workspacePath && typeof session.send === 'function' ? createDedicatedWork({
                            storage: selection,
                            send: (requestId, row) => session.send({ prompt: dedicatedWorkPrompt(requestId, ctx.instanceId, { autonomyMode: row?.autonomyMode, autonomyPolicy: row?.autonomyPolicy }) }),
                            readLedger: (repoRoot, handoff) => {
                                try {
                                    return readDeliveryRecord(repoRoot, handoff.item.kind, handoff.item.id);
                                } catch {
                                    return null;
                                }
                            },
                            onConfirm: ({ root: repoRoot, handoff, autonomyMode, session: confirmed, baseRevision, branch, pr, issue, allowSessionReplace }) => {
                                reconcileDeliveryRecord(repoRoot, {
                                    repository: handoff.repository,
                                    item: handoff.item,
                                    baseBranch: handoff.baseBranch,
                                    baseRevision,
                                    autonomyMode,
                                    ...(branch !== undefined ? { branch } : {}),
                                    ...(pr !== undefined ? { pr } : {}),
                                    ...(issue !== undefined ? { issue } : {}),
                                    session: {
                                        sessionId: confirmed.sessionId,
                                        name: confirmed.name,
                                        ...(confirmed.url ? { url: confirmed.url } : {}),
                                        status: confirmed.activity === 'busy' ? 'active' : 'idle',
                                        assignedRevision: baseRevision,
                                    },
                                    allowSessionReplace,
                                });
                            },
                            changed: () => {
                                const sessions = selection.sessions();
                                for (const board of servers.values()) board.dedicatedWorkChanged(sessions);
                            },
                        }) : undefined,
                        saveRoot: (root, source) => selection.write(root, source),
                        linkedDraft: linkedDraftStorage(session.workspacePath, ctx.instanceId),
                        clearRoot: () => selection.clear(),
                        readSortMode: selection.sortMode,
                        saveSortMode: selection.writeSortMode,
                        discoverChildren,
                        childPollMs: 15000,
                        openTerminal: session.rpc?.canvas?.open ? async () => {
                            try {
                                await session.rpc.canvas.open({ canvasId: 'terminal', instanceId: 'companion-workspace-terminal', input: { title: 'Workspace terminal' } });
                            } catch {
                                throw new Error('This host could not open Terminal from the board. Open the Terminal canvas directly in this session.');
                            }
                        } : undefined,
                        send: async (prompt, targetSessionId = null) => {
                            if (targetSessionId) {
                                const sendToPeer = session.rpc?.management?.message;
                                if (!sendToPeer) throw new Error('This host does not expose session-management messaging. The request was not sent to the parent chat.');
                                const result = await sendToPeer({ targetSessionId, message: prompt });
                                if (!result?.accepted) throw new Error(`The selected session ${targetSessionId} did not accept the request. The request was not sent to the parent chat.`);
                                return true;
                            }
                            await session.send({ prompt });
                            return true;
                        },
                        log: (message) => session.log?.(message),
                    });
                    servers.set(ctx.instanceId, entry);
                }
                if (current) followDirectory(entry, current);
                if (ctx.input?.spec) {
                    try {
                        entry.focus(ctx.input.spec);
                    } catch { /* open unfocused when the spec is unknown */ }
                }
                const { specs } = entry.snapshot;
                const active = specs.filter(s => !s.done).length;
                return { title: 'SpecKit Companion', status: openStatus(active, specs.length), url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (!entry) return;
                servers.delete(ctx.instanceId);
                await entry.close();
            },
        }),
    ],
});

// The runtime reports this session's own working directory changes (for example into a new worktree); a preliminary event precedes the settled one.
session.on?.('session.context_changed', (event) => {
    const data = event?.data;
    const directory = data?.gitRoot ?? data?.cwd;
    if (!directory || data.pendingGitContext) return;
    for (const entry of servers.values()) followDirectory(entry, directory);
});
// A step the board sent starts when the session takes its message into a turn, and stops when that turn ends.
session.on?.('user.message', (event) => {
    if (event?.agentId || event?.checkpoint || event?.data?.isAutopilotContinuation) return;
    for (const entry of servers.values()) entry.began(event?.data?.content, event?.data);
});
session.on?.('session.idle', (event) => {
    if (event?.agentId || event?.checkpoint) return;
    for (const entry of servers.values()) {
        entry.settle(undefined, event?.data);
        entry.refreshChildren();
    }
});
session.on?.('session.autopilot_stopped', (event) => {
    if (event?.agentId || event?.checkpoint) return;
    for (const entry of servers.values()) void entry.stopAutopilot(event?.data);
});
