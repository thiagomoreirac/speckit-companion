import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigKeys } from '../../core/constants';
import { getProjectRoot } from '../../core/projectRoot';
import {
    ReportFile,
    ReportSet,
    readReportFolder,
    reportDirectoryOf,
} from '../reports/reportSet';
import { IdeaStage, IdeaVerdict } from './ideaValues';
import { IDEA_SET_BASE, IDEAS_DIR, readIdeaReportsAt, resolveIdeasDir, toIdeaReport } from './ideaReportModel';

export { IDEA_RATINGS, IDEA_RATING_TONES, IDEA_STAGES, IDEA_VERDICTS } from './ideaValues';
export type { IdeaRating, IdeaStage, IdeaTone, IdeaVerdict } from './ideaValues';

export { IDEAS_DIR, resolveIdeasDir } from './ideaReportModel';

/** The folder the Ideas pane reads, relative to the project root. */
export function ideasDir(root: string | undefined = getProjectRoot()): string {
    const configured = vscode.workspace.getConfiguration().get<unknown>(ConfigKeys.assessmentsDirectory);
    return resolveIdeasDir(root, configured);
}

export const IDEA_SET: ReportSet<IdeaStage> = {
    ...IDEA_SET_BASE,
    get dir() {
        return ideasDir();
    },
};

export type IdeaState = 'assessing' | 'decided';

export type IdeaReportFile = ReportFile<IdeaStage>;

export interface IdeaReport {
    slug: string;
    directory: string;
    title: string;
    reports: Record<IdeaStage, IdeaReportFile>;
    stages: IdeaStage[];
    /** The furthest stage written so far. */
    latestStage: IdeaStage;
    verdict?: IdeaVerdict;
    /** The stage the decision asks to revisit, when it needs clarification. */
    revisit?: IdeaStage;
    state: IdeaState;
}

export function readIdeaReport(directory: string): IdeaReport | undefined {
    const folder = readReportFolder(IDEA_SET, directory);
    return folder ? toIdeaReport(folder) : undefined;
}

/** Every idea under the configured assessments folder of `workspaceRoot`, ordered by slug. Empty when the folder is absent. */
export function readIdeaReports(workspaceRoot: string): IdeaReport[] {
    return readIdeaReportsAt(workspaceRoot, ideasDir(workspaceRoot));
}

export function ideaDirectoryOf(filePath: string): string | undefined {
    return reportDirectoryOf(IDEA_SET, filePath);
}

/**
 * The report file that opens an idea's page, latest stage first, when `folder` (relative to
 * `root`) is an idea folder whose real path stays inside the project. Undefined otherwise.
 */
export function ideaPageFile(root: string, folder: string): string | undefined {
    const real = (p: string): string | undefined => {
        try {
            return fs.realpathSync(p);
        } catch {
            return undefined;
        }
    };
    const realRoot = real(root);
    if (!realRoot || folder.includes(':')) return undefined;
    const dir = path.resolve(root, folder);
    return [...IDEA_SET.kinds].reverse().map(kind => path.join(dir, `${kind}.md`)).find(file => {
        const target = real(file);
        if (!ideaDirectoryOf(file) || !target) return false;
        const rel = path.relative(realRoot, target);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
        return fs.statSync(target, { throwIfNoEntry: false })?.isFile() ?? false;
    });
}
