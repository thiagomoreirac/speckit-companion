import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, projectDirectory, projectPath } from './vendor/work-evidence.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_BYTES = 64 * 1024;
const areas = new Set(['bug-triage', 'idea-triage', 'product-updates', 'routine-drafts']);

function directory(area) {
    if (!areas.has(area)) throw new Error('Unknown board record type.');
    return `.speckit-companion/${area}`;
}

function recordName(area, id) {
    if (typeof id !== 'string' || !ID.test(id) || /[. ]$/.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(id)) {
        throw new Error('Invalid board record ID.');
    }
    return `${directory(area)}/${id}.json`;
}

export function boardRecord(root, area, id) {
    const name = recordName(area, id);
    const file = projectPath(root, name);
    if (!file) {
        if (lstatSync(join(root, name), { throwIfNoEntry: false })) throw new Error('The board record is not a regular repository file.');
        return null;
    }
    if (lstatSync(file).size > MAX_BYTES) throw new Error('This board record is too large to open.');
    const raw = readFileSync(file, 'utf8');
    const value = JSON.parse(raw);
    if (!value || value.schema !== 1 || value.id !== id) throw new Error('This board record has an unsupported format.');
    return { ...value, revision: digest(raw) };
}

export function boardRecords(root, area) {
    const path = directory(area);
    const folder = projectPath(root, path, 'directory');
    if (!folder) {
        if (lstatSync(join(root, path), { throwIfNoEntry: false })) throw new Error('The board storage is not a regular repository folder.');
        return [];
    }
    const names = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json'));
    if (names.length > 500) throw new Error('This board view supports at most 500 records.');
    return names.map(entry => boardRecord(root, area, entry.name.slice(0, -5))).filter(Boolean);
}

export function saveBoardRecord(root, area, id, fields, expected) {
    const name = recordName(area, id);
    const folder = projectDirectory(root, directory(area));
    const file = join(root, name);
    const lock = join(folder, `.${digest(id.toLowerCase())}.lock`);
    try {
        writeFileSync(lock, '', { flag: 'wx' });
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Another writer is updating this record. Reload before trying again.');
        throw error;
    }
    try {
        if ((boardRecord(root, area, id)?.revision ?? null) !== expected) {
            throw Object.assign(new Error('This record changed. Reload it before saving.'), { status: 409 });
        }
        const value = { ...fields, schema: 1, id };
        const raw = `${JSON.stringify(value, null, 2)}\n`;
        if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('This board record exceeds the storage limit.');
        const temp = join(folder, `.${randomBytes(12).toString('hex')}.tmp`);
        writeFileSync(temp, raw, { flag: 'wx' });
        try {
            renameSync(temp, file);
        } catch (error) {
            unlinkSync(temp);
            throw error;
        }
        return { ...value, revision: digest(raw) };
    } finally {
        unlinkSync(lock);
    }
}

export function fieldText(value, label, limit, required = true) {
    if (typeof value !== 'string' || value.length > limit || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
        throw new Error(`Enter ${label} (${limit} characters or fewer).`);
    }
    return value.trim();
}
