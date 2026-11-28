import * as fs from 'fs';
import * as path from 'path';
import {
    DEFAULT_GRAPH_PATTERNS,
    NODE_KINDS,
    type ApprovalStatus,
    type BusinessPlanSummary,
    type ProvenanceOrigin,
} from '../../protocol/businessPlan';
import { inferCurrentPhase, parseAndValidateBusinessPlan } from './traceabilityValidator';

export interface DiscoveredBusinessPlan {
    absolutePath: string;
    relativePath: string;
    summary: BusinessPlanSummary;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', '.serena', '.pytest_cache']);

/**
 * Resolves configured graph patterns safely within `workspaceRoot` (never escaping it)
 * and returns deduplicated relative paths sorted lexicographically.
 */
export function discoverBusinessPlanPaths(
    workspaceRoot: string,
    patterns: readonly string[] = DEFAULT_GRAPH_PATTERNS,
): string[] {
    const found = new Set<string>();
    const rootResolved = path.resolve(workspaceRoot);

    const addIfInside = (absPath: string) => {
        const resolved = path.resolve(absPath);
        if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
            return;
        }
        try {
            if (fs.statSync(resolved).isFile()) {
                found.add(path.relative(rootResolved, resolved).split(path.sep).join('/'));
            }
        } catch {
            // ignore missing or unreadable paths
        }
    };

    for (const pattern of patterns) {
        const trimmed = pattern.trim();
        if (!trimmed || trimmed.startsWith('/') || trimmed.includes('..')) continue;

        if (!trimmed.includes('*')) {
            addIfInside(path.join(rootResolved, trimmed));
            continue;
        }

        const parts = trimmed.split('/');
        const wildcardIdx = parts.findIndex((p) => p.includes('*'));
        const baseRel = parts.slice(0, wildcardIdx).join('/');
        const baseDir = baseRel ? path.join(rootResolved, baseRel) : rootResolved;
        const targetFile = parts[parts.length - 1];
        if (!fs.existsSync(baseDir)) continue;
        walkForFile(baseDir, targetFile, 4, addIfInside);
    }

    return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function walkForFile(
    dir: string,
    targetFilename: string,
    maxDepth: number,
    onMatch: (absPath: string) => void,
): void {
    if (maxDepth < 0) return;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile()) {
            if (targetFilename === '*' || entry.name === targetFilename) {
                onMatch(full);
            }
        } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
            walkForFile(full, targetFilename, maxDepth - 1, onMatch);
        }
    }
}

export function summarizeBusinessPlanFile(
    workspaceRoot: string,
    relativePath: string,
): DiscoveredBusinessPlan {
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    let raw = '';
    try {
        raw = fs.readFileSync(absolutePath, 'utf8');
    } catch (err) {
        return {
            absolutePath,
            relativePath,
            summary: {
                id: path.basename(path.dirname(relativePath)) || relativePath,
                filePath: relativePath,
                title: friendlyTitleFromPath(relativePath),
                summary: `Unable to read file: ${err instanceof Error ? err.message : String(err)}`,
                origin: 'unknown',
                approvalStatus: 'unreviewed',
                nodeCount: 0,
                linkCount: 0,
                coveredStages: 0,
                totalStages: NODE_KINDS.length,
                validationPassed: false,
                errorCount: 1,
                currentPhase: 'plan',
                parseError: err instanceof Error ? err.message : String(err),
            },
        };
    }

    const parsed = parseAndValidateBusinessPlan(raw);
    const rootNode = parsed.graph?.nodes.find((n) => n.kind === 'business-plan');
    const coveredStages = parsed.graph
        ? new Set(parsed.graph.nodes.map((n) => n.kind)).size
        : 0;
    const origin: ProvenanceOrigin | 'unknown' = rootNode?.provenance?.origin ?? 'unknown';
    const approvalStatus: ApprovalStatus | 'unreviewed' = rootNode?.approval?.status ?? 'unreviewed';

    return {
        absolutePath,
        relativePath,
        summary: {
            id: rootNode?.id ?? friendlyTitleFromPath(relativePath),
            filePath: relativePath,
            title: rootNode?.id ?? friendlyTitleFromPath(relativePath),
            summary: rootNode?.summary ?? parsed.parseError ?? 'Business plan traceability graph',
            origin,
            approvalStatus,
            nodeCount: parsed.graph?.nodes.length ?? 0,
            linkCount: parsed.graph?.links.length ?? 0,
            coveredStages,
            totalStages: NODE_KINDS.length,
            validationPassed: parsed.report.passed,
            errorCount: parsed.report.errorCount,
            currentPhase: inferCurrentPhase(parsed.graph),
            parseError: parsed.parseError,
        },
    };
}

export function scanWorkspaceBusinessPlans(
    workspaceRoot: string,
    patterns: readonly string[] = DEFAULT_GRAPH_PATTERNS,
): DiscoveredBusinessPlan[] {
    const relPaths = discoverBusinessPlanPaths(workspaceRoot, patterns);
    return relPaths.map((rel) => summarizeBusinessPlanFile(workspaceRoot, rel));
}

function friendlyTitleFromPath(relPath: string): string {
    const parent = path.basename(path.dirname(relPath));
    if (parent && parent !== '.') {
        return parent
            .split(/[-_]+/)
            .filter(Boolean)
            .map((part) => (part.length > 1 ? part[0].toUpperCase() + part.slice(1) : part.toUpperCase()))
            .join(' ');
    }
    return path.basename(relPath, '.json');
}
