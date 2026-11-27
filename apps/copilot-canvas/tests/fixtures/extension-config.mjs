import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'example-reporter';
export const title = 'Example Reporter';
export const nativeFile = 'report.yml';
export const original = '# Keep this heading\napiToken: synthetic-credential\nextra:\n  flags: [one, two] # keep this comment\n';
export const schemaData = {
    'x-companion-version': 1,
    type: 'object',
    required: ['format'],
    properties: {
        format: { type: 'string', title: 'Report format', enum: ['brief', 'detailed'] },
        includeSummary: { type: 'boolean', title: 'Include summary' },
        limit: { type: 'integer', title: 'Item limit', minimum: 1, maximum: 100 },
        apiToken: { type: 'string', title: 'Service credential', writeOnly: true },
    },
};

export function seedExtensionConfig(root) {
    const extensions = join(root, '.specify', 'extensions');
    const directory = join(extensions, id);
    const registry = join(extensions, '.registry');
    const schema = join(directory, `${nativeFile}.companion-schema.json`);
    const config = join(directory, nativeFile);
    const manifest = join(directory, 'extension.yml');
    const hooks = join(root, '.specify', 'extensions.yml');
    const register = (name, description, files = '') => {
        const path = join(extensions, name);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'extension.yml'), `extension:\n  id: ${name}\n  name: ${description}\n  version: 1.2.3\n  repository: https://github.com/example/${name}\n${files}`);
    };
    register(id, title, `provides:\n  config:\n    - name: ${nativeFile}\n      required: true\n    - name: secondary.json\n`);
    register('template-tool', 'Template Tool', 'provides:\n  config:\n    - name: native.yml\n      template: base.yml\n      required: true\n');
    register('manual-tool', 'Manual Tool');
    writeFileSync(join(extensions, 'template-tool', 'base.yml'), 'template: not-a-value-to-display\n');
    writeFileSync(registry, JSON.stringify({ extensions: {
        [id]: { version: '1.2.3', enabled: true }, 'template-tool': { version: '1.2.3', enabled: false }, 'manual-tool': { version: '1.2.3' },
    } }));
    writeFileSync(hooks, `hooks:\n  after_plan:\n    - extension: ${id}\n      enabled: true\n      command: synthetic-command-not-called\n`);
    writeFileSync(schema, JSON.stringify(schemaData));
    writeFileSync(join(directory, 'secondary.json.companion-schema.json'), JSON.stringify(schemaData));
    writeFileSync(config, original);
    return { registry, config, hooks, schema, manifest, directory };
}
