import { useEffect, useState } from 'preact/hooks';
import type { ArtifactComparison, WorkEvidenceRequest, WorkEvidenceResponse, WorkRecord } from '../../../../src/protocol/workEvidence';
import { specMoved } from '../signals';
import type { VSCodeApi } from '../types';
import { workEvidenceReply } from '../workEvidenceReply';
import { StaticWireflow } from './StaticWireflow';

declare const vscode: VSCodeApi;

type RequestBody<T = WorkEvidenceRequest> = T extends WorkEvidenceRequest ? Omit<T, 'type' | 'request'> : never;
type List = Extract<WorkEvidenceResponse, { action: 'list' }>;
type Preview = Extract<WorkEvidenceResponse, { action: 'preview' }>;
let nextRequest = 0;

export function WorkEvidence() {
    const [list, setList] = useState<List>();
    const [preview, setPreview] = useState<Preview>();
    const [comparison, setComparison] = useState<ArtifactComparison>();
    const [keepSnapshot, setKeepSnapshot] = useState(false);
    const [pending, setPending] = useState<number>();
    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    const [source, setSource] = useState('');
    const [kind, setKind] = useState<WorkRecord['kind']>('business-plan');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [note, setNote] = useState('');
    const [question, setQuestion] = useState('');
    const reply = workEvidenceReply.value;

    function send(message: RequestBody) {
        const request = ++nextRequest;
        setPending(request);
        setError('');
        vscode.postMessage({ ...message, type: 'workEvidence', request });
    }

    useEffect(() => {
        if (!reply || reply.request !== pending) return;
        setPending(undefined);
        switch (reply.action) {
            case 'list': setList(reply); break;
            case 'preview': setPreview(reply); setComparison(undefined); break;
            case 'compare': setComparison(reply.comparison); break;
            case 'error': setError(reply.message); break;
            case 'review':
                setNotice('Local decision recorded. The workflow did not advance.');
                setNote('');
                setKeepSnapshot(false);
                if (preview) send({ action: 'preview', path: preview.artifact.path });
                break;
            case 'impact': setNotice('Explanation request sent to the configured assistant.'); break;
            case 'create':
                setTitle('');
                setDescription('');
                setNotice('Work record saved and linked.');
                send({ action: 'list' });
                break;
            case 'link':
                setSource('');
                setNotice('Work record linked.');
                send({ action: 'list' });
                break;
        }
    }, [reply, pending]);

    if (specMoved.value) return null;
    const busy = pending !== undefined;
    const artifact = preview?.artifact;
    const options = list?.records.filter(record => !list.links.some(link => link.source.id === record.id)) ?? [];
    const label = (path: string) => list ? path.slice(list.spec.length + 1) : path;
    const review = (decision: 'approve' | 'request-changes') => {
        if (artifact) send({ action: 'review', path: artifact.path, revision: artifact.revision, decision, note, keepSnapshot });
    };
    return (
        <details class="work-evidence" onToggle={event => {
            if (event.currentTarget.open && !list && !busy) send({ action: 'list' });
        }}>
            <summary>Linked work and evidence</summary>
            <div class="work-evidence__body" aria-busy={busy}>
                {error && <p role="alert">{error}</p>}
                {notice && !error && <p role="status">{notice}</p>}
                {busy && <p role="status">Loading…</p>}
                <button type="button" disabled={busy} onClick={() => {
                    setNotice('');
                    setPreview(undefined);
                    send({ action: 'list' });
                }}>Refresh list</button>
                {list && (
                    <>
                        <section aria-label="Linked work">
                            <h3>Linked work</h3>
                            {list.links.length ? (
                                <ul>{list.links.map(link => <li key={`${link.source.kind}:${link.source.id}`}>{link.source.title} ({link.source.kind.replace('-', ' ')})</li>)}</ul>
                            ) : <p>No source records linked to this spec.</p>}
                            {options.length > 0 && (
                                <form class="work-evidence__fields" onSubmit={event => {
                                    event.preventDefault();
                                    if (source && !busy) send({ action: 'link', id: source });
                                }}>
                                    <label>Existing plan or epic<select value={source} onChange={event => setSource(event.currentTarget.value)} required>
                                        <option value="">Choose a record</option>
                                        {options.map(record => <option key={record.id} value={record.id}>{record.title} ({record.kind.replace('-', ' ')})</option>)}
                                    </select></label>
                                    <div><button type="submit" disabled={busy || !source}>Link record</button></div>
                                </form>
                            )}
                            <details>
                                <summary>Create and link a work record</summary>
                                <form class="work-evidence__fields" onSubmit={event => {
                                    event.preventDefault();
                                    if (!busy) send({ action: 'create', kind, title, description });
                                }}>
                                    <label>Type<select value={kind} onChange={event => setKind(event.currentTarget.value === 'epic' ? 'epic' : 'business-plan')}>
                                        <option value="business-plan">Business plan</option>
                                        <option value="epic">Epic</option>
                                    </select></label>
                                    <label>Title<input value={title} onInput={event => setTitle(event.currentTarget.value)} maxLength={160} required /></label>
                                    <label>Description<textarea value={description} onInput={event => setDescription(event.currentTarget.value)} rows={3} maxLength={12000} required /></label>
                                    <div><button type="submit" disabled={busy || !title.trim() || !description.trim()}>Create and link</button></div>
                                </form>
                            </details>
                        </section>
                        <section aria-label="Evidence">
                            <h3>Evidence</h3>
                            {list.files.length ? <label>Artifact<select value={artifact?.path ?? ''} disabled={busy} onChange={event => {
                                const path = event.currentTarget.value;
                                setNotice('');
                                setPreview(undefined);
                                setNote('');
                                setKeepSnapshot(false);
                                setQuestion('');
                                if (path) send({ action: 'preview', path });
                            }}>
                                <option value="">Choose an artifact</option>
                                {list.files.map(file => <option key={file.path} value={file.path}>{label(file.path)}</option>)}
                            </select></label> : <p>No supported artifacts in this spec folder.</p>}
                            {artifact && preview && (
                                <div class="work-evidence__fields">
                                    <div class="work-evidence__actions">
                                        <span>SHA-256 <code title={artifact.revision}>{artifact.revision.slice(0, 12)}</code></span>
                                        <button type="button" disabled={busy} onClick={() => send({ action: 'preview', path: artifact.path })}>Refresh artifact</button>
                                    </div>
                                    {artifact.mime
                                        ? <img src={`data:${artifact.mime};base64,${artifact.content}`} alt={label(artifact.path)} />
                                        : artifact.diagram ? (
                                            <section aria-label="Entity relationship preview">
                                                <div class="work-evidence__entities">
                                                    {artifact.diagram.entities.map(entity => (
                                                        <section key={entity.name}>
                                                            <h4>{entity.name}</h4>
                                                            {entity.fields.length > 0 && <ul>{entity.fields.map((field, i) => <li key={i}>{field}</li>)}</ul>}
                                                        </section>
                                                    ))}
                                                </div>
                                                <ol>{artifact.diagram.relationships.map((rel, i) => (
                                                    <li key={i}><strong>{rel.from}</strong> <code>{rel.cardinality}</code> <strong>{rel.to}</strong>: {rel.label}</li>
                                                ))}</ol>
                                                <details><summary>View source</summary><pre tabIndex={0} aria-label="Artifact source">{artifact.content}</pre></details>
                                            </section>
                                        ) : artifact.wireflow ? <StaticWireflow preview={artifact.wireflow} source={artifact.content} />
                                            : <pre tabIndex={0} aria-label="Artifact source">{artifact.content}</pre>}
                                    <label>Focus question (optional)<input value={question} onInput={event => setQuestion(event.currentTarget.value)} maxLength={1200} /></label>
                                    <div><button type="button" disabled={busy} onClick={() => send({ action: 'impact', path: artifact.path, revision: artifact.revision, question })}>Explain code impact</button></div>
                                    <label>Review note (optional)<textarea value={note} onInput={event => setNote(event.currentTarget.value)} maxLength={2000} rows={2} /></label>
                                    <label class="work-evidence__check"><input type="checkbox" checked={keepSnapshot} onChange={event => setKeepSnapshot(event.currentTarget.checked)} /> Keep a copy for comparison</label>
                                    <p>Decisions are recorded for these artifact bytes. They do not advance the workflow.</p>
                                    <div class="work-evidence__actions">
                                        <button type="button" disabled={busy} onClick={() => review('request-changes')}>Request changes</button>
                                        <button type="button" disabled={busy} onClick={() => review('approve')}>Approve artifact</button>
                                    </div>
                                    {preview.reviews.length > 0 && <ul>{preview.reviews.map((item, index) => (
                                        <li key={`${item.recordedAt}:${index}`}>
                                            <strong>{item.decision === 'approve' ? 'Approved' : 'Changes requested'}</strong>
                                            {' · '}{item.version === artifact.revision ? 'This revision' : `Older revision ${item.version.slice(0, 12)}`}
                                            {item.gate && ` · Recorded at gate ${item.gate.step}`}
                                            {item.note && <p>{item.note}</p>}
                                            {item.snapshot && item.version !== artifact.revision && <div>
                                                <button type="button" disabled={busy} onClick={() => {
                                                    setComparison(undefined);
                                                    send({ action: 'compare', path: artifact.path, reviewed: item.version });
                                                }}>Compare with current · {item.version.slice(0, 12)}</button>
                                            </div>}
                                        </li>
                                    ))}</ul>}
                                    {comparison?.path === artifact.path && <section aria-label="Artifact revision comparison">
                                        <h3>Artifact revision comparison</h3>
                                        <div class="work-evidence__comparison">
                                            {([['Reviewed revision', comparison.reviewed], ['Current revision', comparison.current]] as const).map(([heading, copy]) => (
                                                <section key={heading}>
                                                    <h4>{heading} <code title={copy.revision}>{copy.revision.slice(0, 12)}</code></h4>
                                                    {comparison.mime
                                                        ? <img src={`data:${comparison.mime};base64,${copy.content}`} alt={`${heading}: ${label(comparison.path)}`} />
                                                        : <pre tabIndex={0} aria-label={`${heading} source`}>{copy.content}</pre>}
                                                </section>
                                            ))}
                                        </div>
                                    </section>}
                                </div>
                            )}
                        </section>
                    </>
                )}
            </div>
        </details>
    );
}
