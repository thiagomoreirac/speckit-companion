import {
    CONSUMING_PROJECT_DEMO_GRAPH,
    createStarterBusinessPlanGraph,
} from '../demoGraph';
import {
    parseAndValidateBusinessPlan,
    validateBusinessPlanObject,
} from '../traceabilityValidator';
import type { BusinessPlanGraph } from '../../../protocol/businessPlan';

function cloneDemo(): BusinessPlanGraph {
    return JSON.parse(JSON.stringify(CONSUMING_PROJECT_DEMO_GRAPH)) as BusinessPlanGraph;
}

describe('traceabilityValidator', () => {
    it('passes all 8 checks for the consuming-project demo graph', () => {
        const report = validateBusinessPlanObject(CONSUMING_PROJECT_DEMO_GRAPH);
        expect(report.passed).toBe(true);
        expect(report.errorCount).toBe(0);
        expect(report.checks).toHaveLength(8);
        expect(report.checks.every((c) => c.passed)).toBe(true);
    });

    it('detects duplicate JSON keys during strict raw parse', () => {
        const raw = `{
            "version": 1,
            "version": 2,
            "nodes": [],
            "links": []
        }`;
        const result = parseAndValidateBusinessPlan(raw);
        expect(result.graph).toBeNull();
        expect(result.parseError).toContain('version');
        expect(result.report.passed).toBe(false);
        expect(result.report.checks.find((c) => c.id === 'schema')?.passed).toBe(false);
    });

    it('detects duplicate objective summaries under the duplicates check', () => {
        const graph = cloneDemo();
        const obj = graph.nodes.find((n) => n.kind === 'objective')!;
        graph.nodes.push({
            id: 'OBJ-DUP',
            kind: 'objective',
            summary: `  ${obj.summary.toUpperCase()}  `,
            provenance: { origin: 'declared', reference: 'test.md' },
        });
        graph.links.push({ from: graph.nodes[0].id, to: 'OBJ-DUP' });
        const report = validateBusinessPlanObject(graph);
        expect(report.passed).toBe(false);
        const dupCheck = report.checks.find((c) => c.id === 'duplicates')!;
        expect(dupCheck.passed).toBe(false);
        expect(dupCheck.issues.some((i) => i.nodeId === 'OBJ-DUP')).toBe(true);
    });

    it('flags missing or invalid claim classifications and missing basis', () => {
        const graph = cloneDemo();
        const planNode = graph.nodes.find((n) => n.kind === 'business-plan')!;
        planNode.claims = [
            { classification: 'fact', text: 'Missing basis claim', basis: '' },
        ];
        const report = validateBusinessPlanObject(graph);
        expect(report.passed).toBe(false);
        const check = report.checks.find((c) => c.id === 'classification')!;
        expect(check.passed).toBe(false);
        expect(check.issues.some((i) => i.nodeId === planNode.id)).toBe(true);
    });

    it('flags orphan nodes that are disconnected from the graph', () => {
        const graph = cloneDemo();
        graph.nodes.push({
            id: 'obj-orphan',
            kind: 'objective',
            summary: 'Orphan objective with no links.',
            provenance: { origin: 'declared', reference: 'test.md' },
        });
        const report = validateBusinessPlanObject(graph);
        expect(report.passed).toBe(false);
        const check = report.checks.find((c) => c.id === 'orphans')!;
        expect(check.passed).toBe(false);
        expect(check.issues.some((i) => i.nodeId === 'obj-orphan')).toBe(true);
    });

    it('flags backwards or illegal stage jumps while permitting allowed shortcuts', () => {
        const graph = cloneDemo();
        // Illegal backwards link: task -> objective
        const taskNode = graph.nodes.find((n) => n.kind === 'task')!;
        const objNode = graph.nodes.find((n) => n.kind === 'objective')!;
        graph.links.push({ from: taskNode.id, to: objNode.id });

        const report = validateBusinessPlanObject(graph);
        expect(report.passed).toBe(false);
        const check = report.checks.find((c) => c.id === 'traceability')!;
        expect(check.passed).toBe(false);
    });

    it('flags metrics without a measurement task or outcome measurement', () => {
        const graph = cloneDemo();
        const metric = graph.nodes.find((n) => n.kind === 'metric')!;
        const taskAndOutcomeIds = new Set(
            graph.nodes
                .filter((n) => n.kind === 'task' || n.kind === 'outcome-measurement')
                .map((n) => n.id),
        );
        graph.links = graph.links.filter(
            (l) => !(l.from === metric.id && taskAndOutcomeIds.has(l.to)),
        );
        const report = validateBusinessPlanObject(graph);
        expect(report.passed).toBe(false);
        const check = report.checks.find((c) => c.id === 'metrics')!;
        expect(check.passed).toBe(false);
        expect(check.issues.some((i) => i.nodeId === metric.id)).toBe(true);
    });

    it('flags governed nodes with pending approval and passes once approved', () => {
        const graph = cloneDemo();
        const roadmap = graph.nodes.find((n) => n.kind === 'roadmap-item')!;
        roadmap.approval = {
            status: 'pending',
            owner: 'vp-product',
            reference: 'review-pending',
        };
        const report = validateBusinessPlanObject(graph);
        expect(report.passed).toBe(false);
        const check = report.checks.find((c) => c.id === 'approvals')!;
        expect(check.passed).toBe(false);
        expect(check.issues.some((i) => i.nodeId === roadmap.id)).toBe(true);

        roadmap.approval.status = 'approved';
        const approvedReport = validateBusinessPlanObject(graph);
        expect(approvedReport.checks.find((c) => c.id === 'approvals')?.passed).toBe(true);
    });

    it('flags nodes missing provenance metadata', () => {
        const graph = cloneDemo();
        const epic = graph.nodes.find((n) => n.kind === 'epic')!;
        delete epic.provenance;
        const report = validateBusinessPlanObject(graph);
        expect(report.passed).toBe(false);
        const check = report.checks.find((c) => c.id === 'provenance')!;
        expect(check.passed).toBe(false);
        expect(check.issues.some((i) => i.nodeId === epic.id)).toBe(true);
    });

    it('creates a valid starter business plan graph with declared provenance', () => {
        const starter = createStarterBusinessPlanGraph(
            'Q4 Expansion',
            'Expand self-serve conversion.',
            'business-plans/q4-expansion/traceability.json',
        );
        expect(starter.version).toBe(1);
        expect(starter.nodes).toHaveLength(1);
        expect(starter.nodes[0].kind).toBe('business-plan');
        expect(starter.nodes[0].provenance?.origin).toBe('declared');
        const report = validateBusinessPlanObject(starter);
        expect(report.checks.find((c) => c.id === 'schema')?.passed).toBe(true);
        expect(report.checks.find((c) => c.id === 'provenance')?.passed).toBe(true);
        expect(report.checks.find((c) => c.id === 'orphans')?.passed).toBe(true);
    });
});
