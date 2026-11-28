import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildGateResumeCommand,
    buildInstallBundleCommand,
    buildRegisterCatalogCommand,
    buildWorkflowRunCommand,
    detectCatalogIntegration,
    ensureGithubCliAuthFile,
    getSpecifyAuthPath,
    hasGithubCliAuth,
} from '../catalogIntegration';

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('catalogIntegration', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        while (tempDirs.length) {
            const dir = tempDirs.pop()!;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('creates ~/.specify/auth.json with gh-cli entries for GitHub hosts and preserves custom hosts', () => {
        const home = makeTempDir('bp-home-');
        tempDirs.push(home);

        const specifyDir = path.join(home, '.specify');
        fs.mkdirSync(specifyDir, { recursive: true });
        fs.writeFileSync(
            path.join(specifyDir, 'auth.json'),
            JSON.stringify({ version: 1, hosts: { 'custom.internal': { type: 'token', env: 'CUSTOM_TOKEN' } } }, null, 2),
            'utf8',
        );

        const authPath = ensureGithubCliAuthFile(getSpecifyAuthPath(home));
        expect(hasGithubCliAuth(authPath)).toBe(true);

        const written = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        expect(written.hosts['custom.internal']).toEqual({ type: 'token', env: 'CUSTOM_TOKEN' });
        expect(written.hosts['github.com']).toEqual({ provider: 'github-cli' });
        expect(written.hosts['api.github.com']).toEqual({ provider: 'github-cli' });
        expect(written.hosts['raw.githubusercontent.com']).toEqual({ provider: 'github-cli' });
    });

    it('detects installed bundle components, catalog registration, and paused workflow runs', () => {
        const workspace = makeTempDir('bp-ws-');
        const home = makeTempDir('bp-home-');
        tempDirs.push(workspace, home);

        const authPath = ensureGithubCliAuthFile(getSpecifyAuthPath(home));

        // Seed .specify catalog config and bundle components
        const files: Record<string, string> = {
            '.specify/catalogs.json': JSON.stringify({
                catalogs: [
                    { name: 'speckit-catalog', url: 'https://github.com/thiagomoreirac/speckit-catalog/extensions.json' },
                    { name: 'speckit-catalog', url: 'https://github.com/thiagomoreirac/speckit-catalog/presets.json' },
                    { name: 'speckit-catalog', url: 'https://github.com/thiagomoreirac/speckit-catalog/workflows.json' },
                    { name: 'speckit-catalog', url: 'https://github.com/thiagomoreirac/speckit-catalog/steps.json' },
                    { name: 'speckit-catalog', url: 'https://github.com/thiagomoreirac/speckit-catalog/bundles.json' },
                ],
            }),
            '.specify/extensions/business-plan/extension.yml': 'name: business-plan\nversion: "0.1.0"\n',
            '.specify/presets/business-plan/preset.yml': 'name: business-plan\nversion: "0.1.0"\n',
            '.specify/workflows/business-plan/workflow.yml': 'name: business-plan\nversion: "0.1.0"\n',
            '.specify/workflow-steps/business-traceability/step.yml': 'name: business-traceability\nversion: "0.1.0"\n',
            '.specify/bundles/business-plan/bundle.yml': 'name: business-plan\nversion: "0.1.0"\n',
            '.specify/workflows/runs/run-123/state.json': JSON.stringify({
                run_id: 'run-123',
                workflow_id: 'business-plan',
                status: 'paused',
                steps: {
                    'draft-plan': { status: 'completed' },
                    'review-roadmap': { status: 'paused' },
                },
            }),
        };

        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(workspace, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, 'utf8');
        }

        const state = detectCatalogIntegration(
            workspace,
            'thiagomoreirac/speckit-catalog',
            home,
        );
        expect(state.authPath).toBe(authPath);
        expect(state.authConfigured).toBe(true);
        expect(state.bundleReady).toBe(true);
        expect(state.installedCount).toBe(5);
        expect(state.totalComponents).toBe(5);
        expect(state.latestRun?.runId).toBe('run-123');
        expect(state.latestRun?.status).toBe('paused');
        expect(state.latestRun?.pausedAt).toBe('review-roadmap');
    });

    it('detects installed business-plan bundle via Spec Kit registry files', () => {
        const workspace = makeTempDir('bp-reg-ws-');
        const home = makeTempDir('bp-reg-home-');
        tempDirs.push(workspace, home);

        const files: Record<string, string> = {
            '.specify/bundle-records.json': JSON.stringify({
                bundles: [{ bundle_id: 'business-plan', version: '0.1.0' }],
            }),
            '.specify/extensions/.registry': JSON.stringify({
                extensions: { 'business-plan': { version: '0.1.0', enabled: true } },
            }),
            '.specify/presets/.registry': JSON.stringify({
                presets: { 'business-plan': { version: '0.1.0' } },
            }),
            '.specify/workflows/business-plan.yml': 'id: business-plan\nversion: "0.1.0"\n',
        };
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(workspace, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, 'utf8');
        }

        const state = detectCatalogIntegration(workspace, 'thiagomoreirac/speckit-catalog', home);
        expect(state.components.find(c => c.id === 'bundle')?.state).toBe('installed');
        expect(state.components.find(c => c.id === 'extension')?.state).toBe('installed');
        expect(state.components.find(c => c.id === 'preset')?.state).toBe('installed');
        expect(state.components.find(c => c.id === 'workflow')?.state).toBe('installed');
        expect(state.components.find(c => c.id === 'step')?.state).toBe('installed');
        expect(state.installedCount).toBe(5);
        expect(state.bundleReady).toBe(true);
    });

    it('builds safe CLI commands for catalog registration, bundle install, workflow run, and gate resume', () => {
        const regCmd = buildRegisterCatalogCommand('thiagomoreirac/speckit-catalog');
        expect(regCmd).toContain('specify extension catalog add');
        expect(regCmd).toContain('specify preset catalog add');
        expect(regCmd).toContain('specify workflow catalog add');
        expect(regCmd).toContain('specify bundle catalog add');
        expect(regCmd).toContain('thiagomoreirac/speckit-catalog');

        const installCmd = buildInstallBundleCommand('0.1.0');
        expect(installCmd).toContain('specify bundle install');
        expect(installCmd).toContain('business-plan');

        const runCmd = buildWorkflowRunCommand('examples/consuming-project/traceability.json', false);
        expect(runCmd).toContain('specify workflow run business-plan');
        expect(runCmd).toContain('examples/consuming-project/traceability.json');
        expect(runCmd).not.toContain('draft=true');

        const draftCmd = buildWorkflowRunCommand('examples/consuming-project/traceability.json', true);
        expect(draftCmd).toContain('draft=true');

        const resumeCmd = buildGateResumeCommand('run-123', 'review-plan', 'approve');
        expect(resumeCmd).toContain('specify workflow resume');
        expect(resumeCmd).toContain('run-123');
        expect(resumeCmd).toContain("printf '%s\\n' 1");

        const rejectCmd = buildGateResumeCommand('run-123', 'review-plan', 'reject');
        expect(rejectCmd).toContain("printf '%s\\n' 2");

        // Reject unsafe run IDs with shell metacharacters
        expect(buildGateResumeCommand('run; rm -rf /', 'review-plan', 'approve')).toBeUndefined();
    });
});
