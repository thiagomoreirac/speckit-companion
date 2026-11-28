import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    CATALOG_AUTH_HOSTS,
    CATALOG_INDEX_FILES,
    DEFAULT_BUNDLE_ID,
    DEFAULT_BUNDLE_VERSION,
    DEFAULT_CATALOG_REPO,
    DEFAULT_CATALOG_URL,
    type BusinessPlanGateId,
    type BusinessPlanWorkflowRun,
    type BusinessPlanWorkflowStepRun,
    type CatalogComponentStatus,
    type CatalogIndexKind,
    type CatalogIntegrationState,
} from '../../protocol/businessPlan';

const SAFE_RUN_ID = /^\w[\w.-]*$/;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_REF = /^[0-9A-Za-z._/-]{1,120}$/;

const BUNDLE_GATES: Record<BusinessPlanGateId, readonly ['approve', 'reject']> = {
    'review-plan': ['approve', 'reject'],
    'review-roadmap': ['approve', 'reject'],
    'review-outcomes': ['approve', 'reject'],
};

function readTextSafe(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
    const raw = readTextSafe(filePath);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function extractYamlVersion(filePath: string): string | undefined {
    const text = readTextSafe(filePath);
    if (!text) return undefined;
    const match = text.match(/^\s*version:\s*["']?([^"'\s#]+)["']?/m);
    return match?.[1];
}

export function getSpecifyAuthPath(homeDir: string = os.homedir()): string {
    return path.join(homeDir, '.specify', 'auth.json');
}

export function hasGithubCliAuth(authFilePath: string = getSpecifyAuthPath()): boolean {
    const json = readJsonSafe(authFilePath);
    if (!json) return false;
    const rawEntries = Array.isArray(json.credentials)
        ? json.credentials
        : Array.isArray(json.hosts)
            ? json.hosts
            : json;
    if (Array.isArray(rawEntries)) {
        const covered = new Set<string>();
        for (const item of rawEntries) {
            if (typeof item === 'object' && item !== null) {
                const host = (item as Record<string, unknown>).host;
                if (typeof host === 'string') covered.add(host);
            }
        }
        return CATALOG_AUTH_HOSTS.every((h) => covered.has(h));
    }
    if (typeof rawEntries === 'object' && rawEntries !== null) {
        const hostsObj = (rawEntries as Record<string, unknown>).hosts ?? rawEntries;
        if (typeof hostsObj === 'object' && hostsObj !== null) {
            const keys = new Set(Object.keys(hostsObj as Record<string, unknown>));
            return CATALOG_AUTH_HOSTS.every((h) => keys.has(h));
        }
    }
    return false;
}

/**
 * Safely merges the `github-cli` host entries required by `thiagomoreirac/speckit-catalog`
 * into `~/.specify/auth.json` without discarding existing credentials.
 */
export function ensureGithubCliAuthFile(authFilePath: string = getSpecifyAuthPath()): string {
    const dir = path.dirname(authFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const existing = readJsonSafe(authFilePath) ?? {};
    const existingHosts =
        typeof existing.hosts === 'object' && existing.hosts !== null && !Array.isArray(existing.hosts)
            ? { ...(existing.hosts as Record<string, unknown>) }
            : {};

    for (const host of CATALOG_AUTH_HOSTS) {
        if (!existingHosts[host]) {
            existingHosts[host] = { provider: 'github-cli' };
        }
    }

    const next = {
        ...existing,
        version: existing.version ?? 1,
        hosts: existingHosts,
    };

    fs.writeFileSync(authFilePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return authFilePath;
}

function detectConfiguredCatalogs(workspaceRoot: string, homeDir: string): CatalogIndexKind[] {
    const found = new Set<CatalogIndexKind>();
    const candidateFiles = [
        path.join(workspaceRoot, '.specify', 'catalogs.yml'),
        path.join(workspaceRoot, '.specify', 'catalogs.json'),
        path.join(workspaceRoot, '.specify', 'config.yml'),
        path.join(homeDir, '.specify', 'catalogs.yml'),
        path.join(homeDir, '.specify', 'catalogs.json'),
        path.join(homeDir, '.specify', 'config.yml'),
    ];
    for (const file of candidateFiles) {
        const text = readTextSafe(file);
        if (!text) continue;
        for (const idx of CATALOG_INDEX_FILES) {
            if (text.includes(idx.file) || text.includes('speckit-catalog')) {
                found.add(idx.kind);
            }
        }
    }
    return CATALOG_INDEX_FILES.map((c) => c.kind).filter((k) => found.has(k));
}

function firstExisting(candidates: string[]): string | undefined {
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

export function detectCatalogIntegration(
    workspaceRoot: string,
    catalogSource: string = DEFAULT_CATALOG_URL,
    homeDir: string = os.homedir(),
): CatalogIntegrationState {
    const specifyDir = path.join(workspaceRoot, '.specify');
    const specifyInitialized = fs.existsSync(specifyDir);
    const authPath = getSpecifyAuthPath(homeDir);
    const authConfigured = hasGithubCliAuth(authPath);

    const bundleRecords = readJsonSafe(path.join(specifyDir, 'bundle-records.json'));
    const rawBundles = bundleRecords?.bundles;
    const bundleRecord: Record<string, unknown> | undefined = Array.isArray(rawBundles)
        ? (rawBundles.find(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                ((item as Record<string, unknown>).bundle_id === DEFAULT_BUNDLE_ID ||
                    (item as Record<string, unknown>).id === DEFAULT_BUNDLE_ID),
        ) as Record<string, unknown> | undefined)
        : rawBundles && typeof rawBundles === 'object'
            ? ((rawBundles as Record<string, Record<string, unknown>>)[DEFAULT_BUNDLE_ID])
            : undefined;

    const extRegistry = readJsonSafe(path.join(specifyDir, 'extensions', '.registry'));
    const extEntry = (extRegistry?.extensions as Record<string, Record<string, unknown>> | undefined)?.[DEFAULT_BUNDLE_ID];
    const extRegistered = Boolean(extEntry && extEntry.enabled !== false);

    const presetRegistry = readJsonSafe(path.join(specifyDir, 'presets', '.registry'));
    const presetEntry = (presetRegistry?.presets as Record<string, Record<string, unknown>> | undefined)?.[DEFAULT_BUNDLE_ID];
    const presetRegistered = Boolean(presetEntry && presetEntry.enabled !== false);

    const workflowRegistry = readJsonSafe(path.join(specifyDir, 'workflows', 'workflow-registry.json'));
    const workflowEntry = (workflowRegistry?.workflows as Record<string, Record<string, unknown>> | undefined)?.[DEFAULT_BUNDLE_ID];
    const workflowRegistered = Boolean(workflowEntry && workflowEntry.enabled !== false);

    const extPath = firstExisting([
        path.join(specifyDir, 'extensions', 'business-plan', 'extension.yml'),
        path.join(workspaceRoot, 'extensions', 'business-plan', 'extension.yml'),
    ]);
    const presetPath = firstExisting([
        path.join(specifyDir, 'presets', 'business-plan', 'preset.yml'),
        path.join(workspaceRoot, 'presets', 'business-plan', 'preset.yml'),
    ]);
    const workflowPath = firstExisting([
        path.join(specifyDir, 'workflows', 'business-plan', 'workflow.yml'),
        path.join(specifyDir, 'workflows', 'business-plan.yml'),
        path.join(workspaceRoot, 'workflows', 'business-plan', 'workflow.yml'),
    ]);
    const stepPath = firstExisting([
        path.join(specifyDir, 'workflow-steps', 'business-traceability', 'step.yml'),
        path.join(specifyDir, 'steps', 'business-traceability', 'step.yml'),
        path.join(workspaceRoot, 'workflow-steps', 'business-traceability', 'step.yml'),
    ]);
    const bundlePath = firstExisting([
        path.join(specifyDir, 'bundles', 'business-plan', 'bundle.yml'),
        path.join(workspaceRoot, 'bundles', 'business-plan', 'bundle.yml'),
    ]);

    const extInstalled = Boolean(extPath || extRegistered);
    const presetInstalled = Boolean(presetPath || presetRegistered);
    const workflowInstalled = Boolean(workflowPath || workflowRegistered);
    const stepInstalled = Boolean(stepPath || bundleRecord);
    const allFourCoreInstalled = Boolean(extInstalled && presetInstalled && workflowInstalled && stepInstalled);
    const bundleRecordVersion = typeof bundleRecord?.version === 'string' ? bundleRecord.version : undefined;

    const components: CatalogComponentStatus[] = [
        {
            id: 'bundle',
            name: DEFAULT_BUNDLE_ID,
            label: 'Business Plan Bundle',
            state: bundlePath || bundleRecord || allFourCoreInstalled ? 'installed' : 'missing',
            version:
                (bundlePath ? extractYamlVersion(bundlePath) : undefined) ??
                bundleRecordVersion ??
                (allFourCoreInstalled ? DEFAULT_BUNDLE_VERSION : undefined),
            path: bundlePath
                ? path.relative(workspaceRoot, bundlePath)
                : bundleRecord
                    ? path.join('.specify', 'bundle-records.json')
                    : undefined,
        },
        {
            id: 'extension',
            name: 'business-plan',
            label: 'Extension (11 commands)',
            state: extInstalled ? 'installed' : 'missing',
            version: (extPath ? extractYamlVersion(extPath) : undefined) ?? (typeof extEntry?.version === 'string' ? extEntry.version : undefined),
            path: extPath ? path.relative(workspaceRoot, extPath) : extRegistered ? path.join('.specify', 'extensions', '.registry') : undefined,
        },
        {
            id: 'preset',
            name: 'business-plan',
            label: 'Preset & Templates',
            state: presetInstalled ? 'installed' : 'missing',
            version: (presetPath ? extractYamlVersion(presetPath) : undefined) ?? (typeof presetEntry?.version === 'string' ? presetEntry.version : undefined),
            path: presetPath ? path.relative(workspaceRoot, presetPath) : presetRegistered ? path.join('.specify', 'presets', '.registry') : undefined,
        },
        {
            id: 'workflow',
            name: 'business-plan',
            label: 'Workflow (4 phases · 3 gates)',
            state: workflowInstalled ? 'installed' : 'missing',
            version: (workflowPath ? extractYamlVersion(workflowPath) : undefined) ?? (typeof workflowEntry?.version === 'string' ? workflowEntry.version : undefined),
            path: workflowPath ? path.relative(workspaceRoot, workflowPath) : workflowRegistered ? path.join('.specify', 'workflows', 'workflow-registry.json') : undefined,
        },
        {
            id: 'step',
            name: 'business-traceability',
            label: 'Traceability Validator Step',
            state: stepInstalled ? 'installed' : 'missing',
            version: (stepPath ? extractYamlVersion(stepPath) : undefined) ?? bundleRecordVersion,
            path: stepPath ? path.relative(workspaceRoot, stepPath) : bundleRecord ? path.join('.specify', 'bundle-records.json') : undefined,
        },
    ];

    const bootstrapInstalled =
        fs.existsSync(path.join(workspaceRoot, '.github', 'prompts', 'business-plan.prompt.md')) ||
        fs.existsSync(path.join(workspaceRoot, '.github', 'instructions', 'business-traceability.instructions.md')) ||
        fs.existsSync(path.join(workspaceRoot, 'schemas', 'business-traceability.schema.json'));

    const installedCount = components.filter((c) => c.state === 'installed').length;
    const latestRun = readLatestBusinessPlanRun(workspaceRoot);

    return {
        catalogRepo: DEFAULT_CATALOG_REPO,
        catalogSource: catalogSource.trim() || DEFAULT_CATALOG_URL,
        bundleId: DEFAULT_BUNDLE_ID,
        bundleVersion: DEFAULT_BUNDLE_VERSION,
        specifyInitialized,
        authConfigured,
        authPath,
        bundleReady: allFourCoreInstalled,
        installedCount,
        totalComponents: components.length,
        components,
        bootstrapInstalled,
        configuredCatalogs: detectConfiguredCatalogs(workspaceRoot, homeDir),
        latestRun,
    };
}

/**
 * Reads the latest `business-plan` workflow run from `.specify/workflows/runs/`.
 */
export function readLatestBusinessPlanRun(
    workspaceRoot: string,
    graphPath?: string,
): BusinessPlanWorkflowRun | undefined {
    const runsDir = path.join(workspaceRoot, '.specify', 'workflows', 'runs');
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(runsDir, { withFileTypes: true });
    } catch {
        return undefined;
    }

    const candidates: Array<{ run: BusinessPlanWorkflowRun; updatedMs: number }> = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(runsDir, entry.name);
        const state = readJsonSafe(path.join(runDir, 'state.json'));
        if (!state || state.workflow_id !== DEFAULT_BUNDLE_ID) continue;

        const inputs = readJsonSafe(path.join(runDir, 'inputs.json'));
        const inputGraph = typeof inputs?.graph === 'string' ? inputs.graph : undefined;
        if (graphPath && inputGraph && path.normalize(inputGraph) !== path.normalize(graphPath)) {
            continue;
        }

        const logSteps = parseRunLog(path.join(runDir, 'log.jsonl'));
        const rawSteps = isRecord(state.steps) ? state.steps : {};
        const stepIds = new Set<string>([...Object.keys(rawSteps), ...logSteps.order]);

        const steps: BusinessPlanWorkflowStepRun[] = [];
        let pausedAt: string | undefined;
        let workSeconds = 0;

        for (const stepId of stepIds) {
            const rawStep = isRecord(rawSteps[stepId]) ? (rawSteps[stepId] as Record<string, unknown>) : undefined;
            const status = typeof rawStep?.status === 'string' ? rawStep.status : '';
            const logInfo = logSteps.byId.get(stepId);
            const isGate = stepId.startsWith('review-') || Boolean(logInfo?.gate);

            let mappedState: BusinessPlanWorkflowStepRun['state'] = 'running';
            if (status === 'completed' || status === 'done' || status === 'skipped') {
                mappedState = 'done';
            } else if (status === 'paused' || status === 'waiting' || status === 'awaiting_input') {
                mappedState = 'paused';
                pausedAt = stepId;
            } else if (status === 'failed' || status === 'error') {
                mappedState = 'failed';
            }

            if (logInfo?.seconds !== undefined && !isGate) {
                workSeconds += logInfo.seconds;
            }

            steps.push({
                id: stepId,
                state: mappedState,
                gate: isGate,
                seconds: logInfo?.seconds,
            });
        }

        let updatedMs = 0;
        try {
            updatedMs = fs.statSync(path.join(runDir, 'state.json')).mtimeMs;
        } catch {
            updatedMs = 0;
        }

        candidates.push({
            updatedMs,
            run: {
                runId: typeof state.run_id === 'string' ? state.run_id : entry.name,
                workflowId: DEFAULT_BUNDLE_ID,
                graphPath: inputGraph,
                status: typeof state.status === 'string' ? state.status : 'running',
                pausedAt,
                workSeconds,
                steps,
            },
        });
    }

    candidates.sort((a, b) => b.updatedMs - a.updatedMs);
    return candidates[0]?.run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRunLog(logPath: string): {
    order: string[];
    byId: Map<string, { gate: boolean; seconds?: number }>;
} {
    const order: string[] = [];
    const starts = new Map<string, number>();
    const byId = new Map<string, { gate: boolean; seconds?: number }>();
    const raw = readTextSafe(logPath);
    if (!raw) return { order, byId };

    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            continue;
        }
        const stepId = typeof event.step_id === 'string' ? event.step_id : undefined;
        if (!stepId) continue;
        if (!byId.has(stepId)) {
            order.push(stepId);
            byId.set(stepId, { gate: false });
        }
        const entry = byId.get(stepId)!;
        const evName = typeof event.event === 'string' ? event.event : '';
        if (evName.includes('pause') || evName.includes('gate')) {
            entry.gate = true;
        }
        const ts = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
        if (!Number.isNaN(ts)) {
            if (evName === 'step_started') {
                starts.set(stepId, ts);
            } else if ((evName === 'step_completed' || evName === 'step_failed') && starts.has(stepId)) {
                entry.seconds = Math.max(0, Math.round((ts - starts.get(stepId)!) / 1000));
            }
        }
    }

    return { order, byId };
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolves a base catalog URL or local directory into the 5 index locations
 * (`extensions.json`, `presets.json`, `workflows.json`, `steps.json`, `bundles.json`).
 */
export function resolveCatalogIndexUrls(
    source: string,
    ref?: string,
): Array<{ kind: CatalogIndexKind; file: string; url: string }> {
    const trimmed = source.trim().replace(/\/+$/, '');
    const githubMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (githubMatch) {
        const owner = githubMatch[1];
        const repo = githubMatch[2];
        const pinnedRef = ref && SAFE_REF.test(ref.trim()) ? ref.trim() : 'main';
        const base = `https://raw.githubusercontent.com/${owner}/${repo}/${pinnedRef}/catalogs`;
        return CATALOG_INDEX_FILES.map((item) => ({
            kind: item.kind,
            file: item.file,
            url: `${base}/${item.file}`,
        }));
    }

    if (/^https?:\/\//i.test(trimmed)) {
        const base = trimmed.endsWith('/catalogs') ? trimmed : `${trimmed}/catalogs`;
        return CATALOG_INDEX_FILES.map((item) => ({
            kind: item.kind,
            file: item.file,
            url: `${base}/${item.file}`,
        }));
    }

    const baseDir = trimmed.endsWith('catalogs') ? trimmed : path.join(trimmed, 'catalogs');
    return CATALOG_INDEX_FILES.map((item) => ({
        kind: item.kind,
        file: item.file,
        url: path.join(baseDir, item.file),
    }));
}

export function buildRegisterCatalogCommand(source: string, ref?: string): string {
    const urls = resolveCatalogIndexUrls(source, ref);
    const commands = urls.map(
        (entry) => `specify ${entry.kind} catalog add ${shellQuote(entry.url)} --name speckit-catalog`,
    );
    return commands.join(' && ');
}

export function buildInstallBundleCommand(version: string = DEFAULT_BUNDLE_VERSION): string {
    const safeVersion = SAFE_VERSION.test(version.trim()) ? version.trim() : DEFAULT_BUNDLE_VERSION;
    return `specify bundle install ${DEFAULT_BUNDLE_ID} --version ${safeVersion}`;
}

export function buildWorkflowRunCommand(graphPath: string, draft: boolean): string {
    return `specify workflow run ${DEFAULT_BUNDLE_ID} --input graph=${shellQuote(graphPath)} --input draft=${draft ? 'true' : 'false'}`;
}

export function buildGateResumeCommand(
    runId: string,
    gateId: BusinessPlanGateId,
    verdict: 'approve' | 'reject',
): string | undefined {
    if (!SAFE_RUN_ID.test(runId)) return undefined;
    const options = BUNDLE_GATES[gateId];
    if (!options) return undefined;
    const choiceIndex = options.indexOf(verdict) + 1;
    if (choiceIndex <= 0) return undefined;
    return `printf '%s\\n' ${choiceIndex} | specify workflow resume ${runId}`;
}
