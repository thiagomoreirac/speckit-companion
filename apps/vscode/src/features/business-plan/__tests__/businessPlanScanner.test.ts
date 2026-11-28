import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanWorkspaceBusinessPlans } from '../businessPlanScanner';
import { CONSUMING_PROJECT_DEMO_GRAPH, createStarterBusinessPlanGraph } from '../demoGraph';

describe('businessPlanScanner', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        while (tempDirs.length) {
            fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
        }
    });

    it('discovers consuming-project and custom business-plan traceability graphs and ignores node_modules', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-scan-'));
        tempDirs.push(root);

        const demoPath = path.join(root, 'examples', 'consuming-project', 'traceability.json');
        fs.mkdirSync(path.dirname(demoPath), { recursive: true });
        fs.writeFileSync(demoPath, JSON.stringify(CONSUMING_PROJECT_DEMO_GRAPH, null, 2), 'utf8');

        const customPath = path.join(root, 'business-plans', 'growth', 'traceability.json');
        fs.mkdirSync(path.dirname(customPath), { recursive: true });
        fs.writeFileSync(
            customPath,
            JSON.stringify(
                createStarterBusinessPlanGraph('Growth Plan', 'Grow activation.', 'business-plans/growth/traceability.json'),
                null,
                2,
            ),
            'utf8',
        );

        const ignoredPath = path.join(root, 'node_modules', 'pkg', 'traceability.json');
        fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
        fs.writeFileSync(ignoredPath, JSON.stringify(CONSUMING_PROJECT_DEMO_GRAPH), 'utf8');

        const discovered = scanWorkspaceBusinessPlans(root);
        const relPaths = discovered.map((d) => d.summary.filePath);

        expect(relPaths).toContain('examples/consuming-project/traceability.json');
        expect(relPaths).toContain('business-plans/growth/traceability.json');
        expect(relPaths.some((p) => p.includes('node_modules'))).toBe(false);

        const demo = discovered.find((d) => d.summary.filePath === 'examples/consuming-project/traceability.json')!;
        expect(demo.summary.validationPassed).toBe(true);
        expect(demo.summary.errorCount).toBe(0);
        expect(demo.summary.coveredStages).toBe(16);
        expect(demo.summary.origin).toBe('synthetic');
    });

    it('rejects configured patterns that escape the workspace root', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-scan-escape-'));
        tempDirs.push(root);

        const discovered = scanWorkspaceBusinessPlans(root, ['../outside/traceability.json']);
        expect(discovered).toEqual([]);
    });
});
