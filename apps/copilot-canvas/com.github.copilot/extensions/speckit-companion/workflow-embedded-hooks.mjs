import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const vendor = fileURLToPath(new URL('./vendor/', import.meta.url));
const editRecipe = `
import json
import pathlib
import runpy
import sys

vendor = pathlib.Path(sys.argv[1])
parse = runpy.run_path(str(vendor / "companion_config.py"))["load_yaml"]
writer = runpy.run_path(str(vendor / "config_write.py"))
raw, expected, command, when, anchor, index, move = json.loads(pathlib.Path("request.json").read_text(encoding="utf-8"))
try:
    config = parse(raw)
    if config != expected:
        raise ValueError("The canvas and Companion read this recipe differently.")
    anchors = config["commands"][command]["hooks"][when]
    wanted = anchors[anchor]
    if not isinstance(wanted, list):
        raise ValueError("This editor supports hooks declared as block lists.")
    if move is None:
        next_text = writer["replace_hook"](raw, command, when, anchor, index, None)
        wanted.pop(index)
        if not wanted:
            del anchors[anchor]
            if not anchors:
                config["commands"][command]["hooks"][when] = None
    else:
        next_text = writer["move_hook"](raw, command, when, anchor, index, when, anchor, move)
        wanted.insert(move, wanted.pop(index))
    result = parse(next_text)
    if result != config:
        raise ValueError("The edit would change other Companion settings.")
    print(json.dumps({"text": next_text}))
except (ValueError, KeyError, IndexError, writer["ConfigWriteError"]) as exc:
    print(json.dumps({"error": str(exc)}))
`;

export async function planEmbeddedHookEdit(raw, config, edge, move) {
    const invalid = message => Object.assign(new Error(message), { status: 400 });
    const crlf = raw.includes('\r\n');
    if (crlf && raw.replaceAll('\r\n', '').includes('\n')) throw invalid('Normalize mixed line endings before editing this recipe.');
    const directory = mkdtempSync(join(tmpdir(), 'canvas-node-hook-'));
    try {
        writeFileSync(join(directory, 'request.json'), JSON.stringify([raw, config, edge.commandKey, edge.timing, edge.anchor, edge.order, move]),
            { flag: 'wx', mode: 0o600 });
        const args = ['-I', '-S', '-B', '-X', 'utf8', '-c', editRecipe, vendor];
        let output;
        const interpreters = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
        for (const interpreter of interpreters) {
            try {
                ({ stdout: output } = await exec(interpreter, args, { cwd: directory, timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true }));
                break;
            } catch (error) {
                if (error.code !== 'ENOENT') throw invalid('The bundled Companion recipe editor could not validate this change. Check that Python 3 is installed on the canvas host.');
            }
        }
        if (output === undefined) throw invalid('Install Python 3 on the canvas host to preview embedded hook edits.');
        const result = JSON.parse(output);
        if (typeof result.text !== 'string') throw invalid(result.error ?? 'The Companion recipe editor returned no change.');
        return crlf ? result.text.replaceAll('\n', '\r\n') : result.text;
    } finally { rmSync(directory, { recursive: true, force: true }); }
}
