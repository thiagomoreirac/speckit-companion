import { createHash } from 'node:crypto';
import { load, JSON_SCHEMA } from './vendor/workflow-yaml.mjs';

const limit = 32 * 1024;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const pinnedSource = /^https:\/\/raw\.githubusercontent\.com\/[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+\/[a-f0-9]{40}\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.ya?ml$/i;
export const reviewedWorkflowSources = '.speckit-companion/workflow-sources';
export const sourceFile = (key, digest) => `${reviewedWorkflowSources}/${key}-${digest}.yml`;
export const validPinnedUrl = url => typeof url === 'string' && url.length <= 500 && pinnedSource.test(url) && new URL(url).href === url;

export function parsePinnedWorkflow(text) {
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

export async function fetchPinnedWorkflow(url, digest, fetchSource = fetch) {
    if (!validPinnedUrl(url) ||
        typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) {
        throw invalid('Use a public raw.githubusercontent.com YAML URL pinned to a full commit and supply the file’s SHA-256.');
    }
    let response;
    try { response = await fetchSource(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(12_000) }); }
    catch (error) {
        if (!(error instanceof TypeError) && !['TimeoutError', 'AbortError'].includes(error.name)) throw error;
        throw invalid('Could not read the pinned GitHub source without redirects.', 502);
    }
    if (response.redirected || !response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw invalid(`The pinned workflow must be an accessible YAML file no larger than ${limit / 1024} KiB.`);
    }
    let size = 0;
    const chunks = [];
    try {
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > limit) throw invalid(`The pinned workflow exceeds ${limit / 1024} KiB.`);
            chunks.push(chunk);
        }
    } catch (error) {
        if (error.status || (!(error instanceof TypeError) && !['TimeoutError', 'AbortError'].includes(error.name))) throw error;
        throw invalid('The pinned GitHub source could not be read completely.', 502);
    }
    const bytes = Buffer.concat(chunks, size);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== digest.toLowerCase()) throw invalid('The downloaded file does not match the reviewed SHA-256.', 409);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw invalid('The pinned workflow must be valid UTF-8 YAML.');
    }
    if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw invalid('The pinned workflow must contain readable YAML.');
    return { url, hash, text };
}
