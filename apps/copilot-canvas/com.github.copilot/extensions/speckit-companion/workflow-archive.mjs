import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const readManifest = `
import stat
import sys
import zipfile

limit = int(sys.argv[1])
name = sys.argv[2]
try:
    with zipfile.ZipFile("release.zip") as archive:
        entries = archive.infolist()
        manifests = [entry for entry in entries if entry.filename == name]
        if len(entries) > 1024 or len(manifests) != 1 or (name == "workflow.yml" and len(entries) != 1):
            raise ValueError()
        entry = manifests[0]
        mode = stat.S_IFMT(entry.external_attr >> 16)
        if entry.orig_filename != name or entry.is_dir() or mode not in (0, stat.S_IFREG) or not 0 < entry.file_size <= limit:
            raise ValueError()
        if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError()
        with archive.open(entry) as stream:
            data = stream.read(limit + 1)
            if len(data) != entry.file_size:
                raise ValueError()
        sys.stdout.buffer.write(data)
except (ValueError, EOFError, OSError, RuntimeError, zipfile.BadZipFile):
    sys.exit(2)
`;
const invalid = message => Object.assign(new Error(message), { status: 400 });

export async function inspectCatalogArchive(bytes, limit, entry) {
    const root = mkdtempSync(join(tmpdir(), 'canvas-release-zip-'));
    try {
        writeFileSync(join(root, 'release.zip'), bytes, { flag: 'wx', mode: 0o600 });
        const interpreters = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
        for (const python of interpreters) {
            try {
                const { stdout } = await exec(python, ['-I', '-S', '-B', '-c', readManifest, String(limit), entry],
                    { cwd: root, encoding: 'buffer', timeout: 10_000, maxBuffer: limit + 1024, windowsHide: true });
                return stdout;
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                if (error.code === 2) throw invalid(entry === 'workflow.yml' ?
                    `Choose a ZIP containing only a regular root workflow.yml, at most ${limit / 1024} KiB, or a standalone YAML definition.` :
                    `Choose a valid ZIP with one regular bundle.yml at its root, at most ${limit / 1024} KiB.`);
                throw invalid('Could not inspect the catalog ZIP with Python 3 on the canvas host.');
            }
        }
        throw invalid(`Install Python 3 on the canvas host to review catalog ZIPs, or choose a pinned ${entry}.`);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
