import * as fs from 'fs';
import * as path from 'path';
import { knownValue, readReportFolders } from '../reports/reportSet';
import type { ReportFolder, ReportSet } from '../reports/reportSet';
import { buildIdeaDecision } from '../reports/ideaDecision';
import { IDEA_STAGES, IDEA_VERDICTS } from './ideaValues';
import type { IdeaStage } from './ideaValues';
import type { IdeaReport, IdeaReportFile } from './ideaReports';

export const IDEAS_DIR = path.join('.specify', 'assessments');

export function resolveIdeasDir(root: string | undefined, configured: unknown): string {
    if (typeof configured !== 'string' || configured.trim() === '') return IDEAS_DIR;
    const value = configured.trim();
    let relative = value;
    if (path.isAbsolute(value)) {
        if (!root) return IDEAS_DIR;
        relative = path.relative(root, value);
    }
    const normal = path.normalize(relative).replace(/[\\/]+$/, '');
    if (normal === '' || normal === '.' || path.isAbsolute(normal) || path.win32.isAbsolute(normal)) return IDEAS_DIR;
    if (normal.split(/[\\/]/).includes('..')) return IDEAS_DIR;
    return normal;
}

export const IDEA_SET_BASE: Omit<ReportSet<IdeaStage>, 'dir'> = {
    id: 'ideas',
    kinds: IDEA_STAGES,
    labels: { intake: 'Intake', research: 'Research', problem: 'Problem', concept: 'Concept', decision: 'Decision' },
    titlePrefixes: {
        intake: 'Idea Intake:',
        research: 'Idea Research:',
        problem: 'Problem Definition:',
        concept: 'Concept:',
        decision: 'Decision:',
    },
    panelPrefix: 'Idea',
    fallbackBadge: 'IDEA',
};

function revisitOf(report: IdeaReportFile): IdeaStage | undefined {
    try {
        const closing = buildIdeaDecision(fs.readFileSync(report.path, 'utf-8'))?.closing;
        return closing?.verdict === 'needs-clarification' ? closing.revisit : undefined;
    } catch {
        return undefined;
    }
}

export function toIdeaReport(folder: ReportFolder<IdeaStage>): IdeaReport {
    const { slug, directory, title, reports, stages } = folder;
    const verdict = knownValue(IDEA_VERDICTS, folder.fields.decision.get('verdict'));
    const revisit = verdict === 'needs-clarification' ? revisitOf(reports.decision) : undefined;
    return {
        slug, directory, title, reports, stages,
        latestStage: stages[stages.length - 1],
        verdict,
        ...(revisit && { revisit }),
        state: stages.includes('decision') ? 'decided' : 'assessing',
    };
}

export function readIdeaReportsAt(root: string, configured: unknown): IdeaReport[] {
    return readReportFolders({ ...IDEA_SET_BASE, dir: resolveIdeasDir(root, configured) }, root).map(toIdeaReport);
}
