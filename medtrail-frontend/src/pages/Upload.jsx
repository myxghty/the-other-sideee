import { useRef, useState } from 'react';
import { api } from '../api/endpoints';
import { Badge, Button, StaleNotice, fmtDateTime } from '../components/ui';
import { PATIENT_ID, POLL } from '../config';
import { fileSha256 } from '../lib/idempotency';
import { toast, useLoadLevel } from '../lib/store';
import { SKIP, invalidate, setQueryData, useIdempotentMutation, useQuery } from '../lib/useApi';

const STATUS = {
  awaiting_file: { tone: 'neutral', label: 'Uploading' },
  queued: { tone: 'amber', label: 'Queued' },
  processing: { tone: 'blue', label: 'Reading document' },
  extracted: { tone: 'green', label: 'Values extracted' },
  failed: { tone: 'red', label: 'Failed' },
};
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,application/pdf,text/plain';

function UploadStatus({ u }) {
  const s = STATUS[u.status] || STATUS.queued;
  return (
    <article className="card stack" style={{ gap: 10 }}>
      <div className="row between">
        <div>
          <div style={{ fontWeight: 600 }}>{u.fileName}</div>
          <div className="small muted">
            {u.id} · {u.docType} · uploaded by {u.uploadedBy} · {fmtDateTime(u.createdAt)}
          </div>
        </div>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      {u.status === 'queued' && (
        <div className="small muted">
          In the extraction queue{u.position ? `: ${u.position} document${u.position > 1 ? 's' : ''} ahead` : ': next in line'}. You can leave this
          page; it continues in the background.
        </div>
      )}
      {u.status === 'processing' && (
        <div className="progress" aria-label="Extraction in progress">
          <span style={{ width: '60%' }} />
        </div>
      )}
      {u.status === 'failed' && (
        <div className="notice notice-error small" role="alert">
          {u.error || 'The document could not be read.'} Check the file and upload it again.
        </div>
      )}
      {u.status === 'extracted' && u.extracted && (
        <>
          <div className="small subtle">
            {u.extracted.note}
            {u.extracted.prescriber && ` Prescriber: ${u.extracted.prescriber}.`}
            {u.visitId && ' Added to the patient’s record; compare it on the Compare page.'}
          </div>
          {u.extracted.medications.length === 0 ? (
            <div className="notice notice-info small">No medicines were recognised in this document. A pharmacist should check it.</div>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 10 }}>
              {u.extracted.medications.map((m) => (
                <li key={m.generic + m.line} className="stack" style={{ gap: 4, paddingTop: 10, borderTop: '1px solid var(--neutral-soft)' }}>
                  <div className="row between" style={{ gap: 8 }}>
                    <strong>{m.display}</strong>
                    <span className="small">
                      {Math.round(m.confidence * 100)}% {m.needsCheck && <Badge tone="amber">Needs human check</Badge>}
                    </span>
                  </div>
                  <div className="small muted">{[m.frequency, m.timing, m.duration].filter(Boolean).join(' · ') || 'No timing written'}</div>
                  <div className="mono small subtle">
                    Line {m.line + 1}: “{m.asWritten}”
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

export default function Upload() {
  const pid = PATIENT_ID;
  const load = useLoadLevel();
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [docType, setDocType] = useState('Prescription');
  const [facility, setFacility] = useState('');
  const [visitDate, setVisitDate] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const list = useQuery(`uploads:${pid}`, () => api.uploads(pid), { staleTime: 2000 });
  const items = list.data?.items || [];
  const active = items.some((u) => u.status === 'queued' || u.status === 'processing');
  // Poll only while something is in progress, and slower when the server is busy.
  useQuery(active ? `uploads-poll:${pid}` : null, async () => {
    const d = await api.uploads(pid);
    setQueryData(`uploads:${pid}`, d);
    return d;
  }, { staleTime: 0, refetchInterval: POLL.uploads[load] });

  const submit = useIdempotentMutation(async (key, f, meta) => {
    const sha256 = await fileSha256(f);
    const created = await api.createUpload({ patientId: pid, fileName: f.name, size: f.size, sha256, contentType: f.type, ...meta }, key);
    if (created.duplicate && created.upload.status !== 'awaiting_file') return { ...created, skipped: true };
    await api.putFile(created.uploadUrl, f);
    const done = await api.completeUpload(created.upload.id);
    return { ...created, upload: done };
  }, 'upload');

  function pick(f) {
    setError('');
    if (!f) return;
    if (!ACCEPT.split(',').includes(f.type)) return setError('Use a JPG, PNG, PDF or text file.');
    if (f.size > MAX_BYTES) return setError('Files must be 10 MB or smaller.');
    setFile(f);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!file) return;
    const meta = { docType, facility, visitDate };
    try {
      const r = await submit.mutate(`${file.name}:${file.size}:${file.lastModified}:${JSON.stringify(meta)}`, file, meta);
      if (r === SKIP) return;
      if (r.duplicate) {
        toast({ tone: 'info', title: 'Already uploaded', body: `This exact document is already on file as ${r.upload.id}. No duplicate was created.` });
      } else {
        toast({ tone: 'success', title: 'Document received', body: 'Values will appear here once extraction finishes.' });
      }
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      invalidate('uploads');
      invalidate('audit');
    } catch (err) {
      toast({ tone: 'error', title: 'Upload not finished', body: err.message });
    }
  }

  return (
    <div className="split">
      <form className="card stack primary" onSubmit={onSubmit} style={{ maxWidth: 720 }}>
        <div>
          <h1 style={{ fontSize: 24 }}>Upload a document</h1>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Prescriptions, discharge summaries or pharmacy records for {pid}. Use synthetic documents only.
          </p>
        </div>

        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files?.[0]);
          }}
        >
          <label className="stack" style={{ alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <span style={{ fontWeight: 600 }}>{file ? file.name : 'Drop a file here or choose one'}</span>
            <span className="small muted">{file ? `${(file.size / 1024).toFixed(0)} KB` : 'JPG, PNG, PDF or TXT, up to 10 MB'}</span>
            <input ref={inputRef} type="file" accept={ACCEPT} onChange={(e) => pick(e.target.files?.[0])} className="sr-only" />
            <span className="btn btn-sm">Choose file</span>
          </label>
        </div>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}

        <div className="grid-2">
          <label className="field">
            Document type *
            <select className="input" value={docType} onChange={(e) => setDocType(e.target.value)}>
              <option>Prescription</option>
              <option>Discharge summary</option>
              <option>Pharmacy dispense record</option>
            </select>
          </label>
          <label className="field">
            Visit date *
            <input className="input" type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} />
          </label>
          <label className="field">
            Facility *
            <input className="input" value={facility} onChange={(e) => setFacility(e.target.value)} placeholder="e.g. Green Valley Clinic" />
          </label>
        </div>

        <div className="row">
          <Button type="submit" variant="primary" pending={submit.pending} disabled={!file}>
            Upload document
          </Button>
        </div>
      </form>

      <section className="secondary stack" aria-label="Recent uploads">
        <h2 style={{ fontSize: 18 }}>Recent uploads</h2>
        <StaleNotice query={list} />
        {items.length ? items.map((u) => <UploadStatus key={u.id} u={u} />) : <div className="card muted small">No uploads in this session yet.</div>}
      </section>
    </div>
  );
}
