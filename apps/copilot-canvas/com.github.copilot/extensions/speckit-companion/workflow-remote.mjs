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
export const validPinnedCatalogUrl = url => canonical(url, catalogSource);
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

export async function fetchPinnedCatalog(url, kind, fetchSource = fetch) {
    if (!['workflow', 'bundle'].includes(kind) || !validPinnedCatalogUrl(url)) {
        throw invalid('Choose a supported project catalog registered at a public raw GitHub JSON URL.');
    }
    const bundle = kind === 'bundle';
    const collection = bundle ? 'bundles' : 'workflows';
    const label = `The ${kind} catalog JSON`;
    const text = decodeFile(await fetchGitHubFile(url, fetchSource, catalogLimit, label), label);
    let payload;
    try { payload = JSON.parse(text); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw invalid(`${label} is not valid JSON.`);
    }
    if (bundle && payload?.schema_version != null && !/^1(?:\.|$)/.test(String(payload.schema_version).trim())) {
        throw invalid('This bundle catalog uses an unsupported schema version.');
    }
    const source = payload?.[collection];
    const entries = mapping(source) ? Object.entries(source) :
        !bundle && Array.isArray(source) ? source.map(entry => [entry?.id, entry]) : null;
    if (!entries || entries.length > 300) throw invalid(`${label} must contain a ${collection} ${bundle ? 'mapping' : 'mapping or list'} of at most 300 entries.`);
    const ids = new Set(), releases = [];
    const empty = value => value == null || ((Array.isArray(value) || mapping(value)) && !Object.keys(value).length);
    for (const [key, entry] of entries) {
        const validKey = bundle ? /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(key) : validPinnedWorkflowId(key);
        if (!validKey || !mapping(entry) || (bundle || entry.id != null) && entry.id !== key) continue;
        if (ids.has(key)) throw invalid(`${label} repeats a ${kind} identifier.`);
        ids.add(key);
        const history = mapping(entry.releases) ? Object.entries(entry.releases) : [];
        if ((entry.releases != null && !mapping(entry.releases)) || history.length > 40 ||
            history.some(([version]) => version === entry.version)) throw invalid(`${label} has an invalid release list for ${key}.`);
        for (const [version, record] of [[entry.version, entry], ...history]) {
            const releaseUrl = bundle ? record?.download_url : record?.url;
            if (!mapping(record) || typeof version !== 'string' || !/^[a-z0-9][a-z0-9.+!-]{0,63}$/i.test(version) ||
                !validPinnedUrl(releaseUrl) || (bundle ? !releaseUrl.endsWith('/bundle.yml') || (record.version != null && record.version !== version) :
                    !empty(record.requires) || !empty(record.bundled))) continue;
            const sha256 = typeof record.sha256 === 'string' && /^(?:sha256:)?([a-f0-9]{64})$/i.exec(record.sha256)?.[1]?.toLowerCase();
            if (!sha256) continue;
            if (releases.length >= 500) throw invalid(`${label} advertises too many pinned releases to review.`);
            const selection = createHash('sha256').update(JSON.stringify([url, key, version, releaseUrl, sha256])).digest('hex');
            releases.push({ key, version, url: releaseUrl, sha256, selection });
        }
    }
    return releases.sort((a, b) => a.key.localeCompare(b.key));
}
