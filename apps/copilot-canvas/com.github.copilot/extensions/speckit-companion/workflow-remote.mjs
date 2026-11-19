import { createHash } from 'node:crypto';
import { load, JSON_SCHEMA } from './vendor/workflow-yaml.mjs';

const limit = 32 * 1024;
const catalogLimit = 256 * 1024;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const pinnedSource = /^https:\/\/raw\.githubusercontent\.com\/[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+\/[a-f0-9]{40}\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.ya?ml$/i;
const catalogSource = /^https:\/\/raw\.githubusercontent\.com\/[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.json$/i;
const canonical = (url, pattern) => typeof url === 'string' && url.length <= 500 && pattern.test(url) && new URL(url).href === url;
const mapping = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const reviewedWorkflowSources = '.speckit-companion/workflow-sources';
export const sourceFile = (key, digest) => `${reviewedWorkflowSources}/${key}-${digest}.yml`;
export const bundleReceiptFile = (key, digest) => `${reviewedWorkflowSources}/bundle-${key}-${digest}.json`;
export const validPinnedUrl = url => canonical(url, pinnedSource);
export const validWorkflowCatalogUrl = url => canonical(url, catalogSource);
export const validPinnedWorkflowId = key => typeof key === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(key) &&
    !['overlays', 'runs', 'steps', 'functions'].includes(key);

export function parsePinnedYaml(text) {
    let manifest;
    try { manifest = load(text, { schema: JSON_SCHEMA }); }
    catch (error) {
        if (!(error instanceof RangeError) && error.name !== 'YAMLException') throw error;
        throw invalid('The pinned source does not contain a valid standalone YAML definition.');
    }
    const seen = new Set();
    const visit = (value, depth) => {
        if (value === null || typeof value !== 'object') return;
        if (depth > 24 || seen.size >= 4096 || seen.has(value)) {
            throw invalid('The pinned definition exceeds the nesting limit or reuses YAML aliases.');
        }
        seen.add(value);
        for (const child of Object.values(value)) visit(child, depth + 1);
    };
    visit(manifest, 0);
    return manifest;
}

async function fetchGitHubFile(url, fetchSource, maxBytes, label) {
    let response;
    try { response = await fetchSource(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(12_000) }); }
    catch (error) {
        if (!(error instanceof TypeError) && !['TimeoutError', 'AbortError'].includes(error.name)) throw error;
        throw invalid('Could not read the pinned GitHub source without redirects.', 502);
    }
    if (response.redirected || !response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw invalid(`${label} must be accessible and no larger than ${maxBytes / 1024} KiB.`);
    }
    let size = 0;
    const chunks = [];
    try {
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > maxBytes) throw invalid(`${label} exceeds ${maxBytes / 1024} KiB.`);
            chunks.push(chunk);
        }
    } catch (error) {
        if (error.status || (!(error instanceof TypeError) && !['TimeoutError', 'AbortError'].includes(error.name))) throw error;
        throw invalid('The pinned GitHub source could not be read completely.', 502);
    }
    return Buffer.concat(chunks, size);
}

function decodeFile(bytes, label) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw invalid(`${label} must be valid UTF-8.`);
    }
    if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw invalid(`${label} must contain readable text.`);
    return text;
}

export async function fetchPinnedYaml(url, digest, fetchSource = fetch, kind = 'workflow') {
    if (!validPinnedUrl(url) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) {
        throw invalid('Use a public raw.githubusercontent.com YAML URL pinned to a full commit and supply the file’s SHA-256.');
    }
    const label = `The pinned ${kind} YAML`;
    const bytes = await fetchGitHubFile(url, fetchSource, limit, label);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== digest.toLowerCase()) throw invalid('The downloaded file does not match the reviewed SHA-256.', 409);
    return { url, hash, text: decodeFile(bytes, label) };
}

export async function fetchWorkflowCatalog(url, fetchSource = fetch) {
    if (!validWorkflowCatalogUrl(url)) throw invalid('Choose a project workflow catalog registered at a public raw GitHub JSON URL.');
    const label = 'The workflow catalog JSON';
    const text = decodeFile(await fetchGitHubFile(url, fetchSource, catalogLimit, label), label);
    let workflows;
    try { workflows = JSON.parse(text)?.workflows; }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw invalid('The workflow catalog is not valid JSON.');
    }
    const entries = Array.isArray(workflows) ? workflows.map(entry => [entry?.id, entry]) :
        mapping(workflows) ? Object.entries(workflows) : null;
    if (!entries || entries.length > 300) throw invalid('The workflow catalog must list no more than 300 workflows in a workflows mapping or list.');
    const ids = new Set(), releases = [];
    const empty = value => value == null || ((Array.isArray(value) || mapping(value)) && !Object.keys(value).length);
    for (const [key, entry] of entries) {
        if (!validPinnedWorkflowId(key) || !mapping(entry) || (entry.id != null && entry.id !== key)) continue;
        if (ids.has(key)) throw invalid('The workflow catalog repeats a workflow identifier.');
        ids.add(key);
        const history = mapping(entry.releases) ? Object.entries(entry.releases) : [];
        if ((entry.releases != null && !mapping(entry.releases)) || history.length > 40 ||
            history.some(([version]) => version === entry.version)) throw invalid(`The workflow catalog has an invalid release list for ${key}.`);
        for (const [version, record] of [[entry.version, entry], ...history]) {
            if (!mapping(record) || typeof version !== 'string' || !/^[a-z0-9][a-z0-9.+!-]{0,63}$/i.test(version) ||
                !validPinnedUrl(record.url) || !empty(record.requires) || !empty(record.bundled)) continue;
            const sha256 = typeof record.sha256 === 'string' && /^(?:sha256:)?([a-f0-9]{64})$/i.exec(record.sha256)?.[1]?.toLowerCase();
            if (!sha256) continue;
            if (releases.length >= 500) throw invalid('The workflow catalog advertises too many pinned releases to review.');
            const selection = createHash('sha256').update(JSON.stringify([url, key, version, record.url, sha256])).digest('hex');
            releases.push({ key, version, url: record.url, sha256, selection });
        }
    }
    return releases.sort((a, b) => a.key.localeCompare(b.key));
}
