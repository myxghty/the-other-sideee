import { useState } from 'react';
import { api } from '../api/endpoints';
import SourceDoc from '../components/SourceDoc';
import { ArrowRight, Badge, Button, FLAG_TONE, Loading, StaleNotice, fmtDate } from '../components/ui';
import { PATIENT_ID } from '../config';
import { Link } from '../lib/router';
import { toast } from '../lib/store';
import { SKIP, invalidate, useIdempotentMutation, useQuery } from '../lib/useApi';

const SUMMARY_LABEL = {
  conflict: 'conflicting',
  missing: 'missing in newer visit',
  outdated: 'outdated',
  missing_field: 'missing field',
  new: 'new in newer visit',
  unchanged: 'unchanged',
};
const SUMMARY_ORDER = ['conflict', 'missing', 'outdated', 'missing_field', 'new', 'unchanged'];

function rowTone(row) {
  const types = row.flags.map((f) => f.type);
  if (types.includes('conflict')) return 'row-red';
  if (types.some((t) => ['missing', 'outdated', 'missing_field'].includes(t))) return 'row-amber';
  if (types.includes('new')) return 'row-blue';
  return '';
}

function MedCell({ med, other, fields, selected, onSelect, emptyText }) {
  if (!med) return <span className="subtle">{emptyText}</span>;
  const diff = (f) => fields?.includes(f) && other;
  return (
    <button type="button" className={`cellbtn ${selected ? 'selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <span className={diff('strength') ? 'diff' : ''}>{med.strength}</span>
      {med.frequency && (
        <>
          {' · '}
          <span className={diff('frequency') ? 'diff' : ''}>{med.frequency}</span>
        </>
      )}
      {med.timing && <> · <span className={diff('timing') ? 'diff' : ''}>{med.timing}</span></>}
      {med.duration && <> · {med.duration}</>}
      <span className="mono subtle small" style={{ display: 'block', marginTop: 2 }}>
        “{med.asWritten}”
      </span>
    </button>
  );
}

function TicketCell({ flags }) {
  const ticketed = flags.filter((f) => f.fingerprint);
  if (!ticketed.length) return <span className="subtle small">Not needed</span>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {ticketed.map((f) =>
        f.ticket ? (
          <Link key={f.fingerprint} to={`/review/${f.ticket.id}`} className="small">
            {f.ticket.id} · {f.ticket.status === 'resolved' ? 'Resolved' : f.ticket.status === 'clarification' ? 'Awaiting prescriber' : 'In queue'}
          </Link>
        ) : (
          <span key={f.fingerprint} className="small result-mid">
            Not sent yet
          </span>
        ),
      )}
    </div>
  );
}

export default function Compare() {
  const pid = PATIENT_ID;
  const patient = useQuery(`patient:${pid}`, () => api.patient(pid), { staleTime: 60_000 });
  const visits = useQuery(`visits:${pid}`, () => api.visits(pid), { staleTime: 60_000 });
  const list = visits.data?.items || [];
  const [pick, setPick] = useState({});
  const a = pick.a || list[1]?.id;
  const b = pick.b || list[0]?.id;
  const cmp = useQuery(a && b && a !== b ? `compare:${pid}:${a}:${b}` : null, () => api.compare(pid, a, b), { staleTime: 20_000 });
  const [focus, setFocus] = useState(null);

  const send = useIdempotentMutation((key) => api.submitFlags(pid, { a, b }, key), 'flags');

  const rows = cmp.data?.rows || [];
  const unsent = rows.flatMap((r) => r.flags).filter((f) => f.fingerprint && !f.ticket).length;
  const flagged = rows.find((r) => r.flags.some((f) => f.fingerprint));
  const current = focus && rows.find((r) => r.generic === focus.generic) ? focus : flagged ? { generic: flagged.generic, side: flagged.b ? 'b' : flagged.a ? 'a' : 'h' } : null;
  const focusRow = current && rows.find((r) => r.generic === current.generic);

  let source = null;
  if (focusRow && cmp.data) {
    if (current.side === 'h' && focusRow.history) source = { visit: focusRow.history.visit, med: focusRow.history.med, label: 'Older record' };
    else if (current.side === 'a' && focusRow.a) source = { visit: cmp.data.visitA, med: focusRow.a, label: 'Visit A' };
    else if (focusRow.b) source = { visit: cmp.data.visitB, med: focusRow.b, label: 'Visit B' };
    else if (focusRow.a) source = { visit: cmp.data.visitA, med: focusRow.a, label: 'Visit A' };
  }

  async function onSend() {
    try {
      const r = await send.mutate(`${a}:${b}`);
      if (r === SKIP) return;
      if (r.created.length) {
        toast({ tone: 'success', title: `${r.created.length} flag${r.created.length > 1 ? 's' : ''} sent to review`, body: r.existing.length ? `${r.existing.length} were already in the queue and were not duplicated.` : 'A pharmacist will review them.' });
      } else {
        toast({ tone: 'info', title: 'Nothing new to send', body: `All ${r.existing.length} flags are already in the review queue.` });
      }
      invalidate('compare');
      invalidate('tickets');
    } catch (err) {
      toast({ tone: 'error', title: 'Flags not sent', body: err.message });
    }
  }

  const visitOption = (v) => `${fmtDate(v.date)} · ${v.facility} (${v.type})`;
  const p = patient.data;

  return (
    <>
      <section className="card row between">
        <div>
          <div className="eyebrow">Patient · MRN {pid}</div>
          {p ? (
            <>
              <h1 style={{ fontSize: 26, marginTop: 4 }}>
                {p.name}, {p.age} {p.sex}
              </h1>
              <div className="muted small" style={{ marginTop: 4 }}>
                Known allergies: {p.allergies} · {p.visitCount} records across {p.facilityCount} facilities
              </div>
            </>
          ) : (
            <Loading label="Loading patient" />
          )}
        </div>
        <div className="row">
          <Link to="/upload" className="btn">
            Upload prescription
          </Link>
          <Button variant="primary" pending={send.pending} disabled={!unsent} onClick={onSend}>
            {unsent ? `Send ${unsent} flag${unsent > 1 ? 's' : ''} to review` : 'All flags in review'}
          </Button>
        </div>
      </section>

      <section className="row" style={{ alignItems: 'stretch' }}>
        {['a', 'b'].map((side, i) => (
          <div key={side} style={{ display: 'contents' }}>
            {i === 1 && (
              <div className="row" style={{ flex: 'none' }}>
                <ArrowRight />
              </div>
            )}
            <label className="card field" style={{ flex: '1 1 280px', padding: '12px 16px' }}>
              <span className="eyebrow">{side === 'a' ? 'Visit A (older)' : 'Visit B (newer)'}</span>
              <select
                className="input"
                value={(side === 'a' ? a : b) || ''}
                onChange={(e) => {
                  setPick((s) => ({ a, b, ...s, [side]: e.target.value }));
                  setFocus(null);
                }}
              >
                {list.map((v) => (
                  <option key={v.id} value={v.id}>
                    {visitOption(v)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
      </section>

      {a === b && <div className="notice notice-error">Choose two different visits to compare.</div>}
      <StaleNotice query={cmp} />

      {cmp.data && (
        <section className="row" aria-label="Summary">
          {SUMMARY_ORDER.filter((t) => cmp.data.summary[t]).map((t) => (
            <Badge key={t} tone={FLAG_TONE[t]}>
              {cmp.data.summary[t]} {SUMMARY_LABEL[t]}
            </Badge>
          ))}
        </section>
      )}

      <div className="split">
        <section className="card card-tight primary">
          {cmp.isLoading ? (
            <div style={{ padding: 20 }}>
              <Loading label="Comparing records" />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data" style={{ minWidth: 780 }}>
                <caption className="sr-only">Medication comparison between two visits</caption>
                <thead>
                  <tr>
                    <th scope="col">Medicine</th>
                    <th scope="col">Visit A {cmp.data && `(${fmtDate(cmp.data.visitA.date)})`}</th>
                    <th scope="col">Visit B {cmp.data && `(${fmtDate(cmp.data.visitB.date)})`}</th>
                    <th scope="col">Flag</th>
                    <th scope="col">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const conflict = r.flags.find((f) => f.type === 'conflict');
                    const sel = current?.generic === r.generic ? current.side : null;
                    return (
                      <tr key={r.generic} className={rowTone(r)}>
                        <th scope="row" style={{ fontWeight: 600, textAlign: 'left', padding: '12px 16px', textTransform: 'capitalize' }}>
                          {r.generic}
                        </th>
                        <td>
                          {r.history ? (
                            <button type="button" className={`cellbtn ${sel === 'h' ? 'selected' : ''}`} onClick={() => setFocus({ generic: r.generic, side: 'h' })}>
                              <span className="subtle">Not listed</span>
                              <span className="small" style={{ display: 'block' }}>
                                Older record: {r.history.med.display}, {fmtDate(r.history.visit.date)}
                              </span>
                            </button>
                          ) : (
                            <MedCell med={r.a} other={r.b} fields={conflict?.fields} selected={sel === 'a'} onSelect={() => setFocus({ generic: r.generic, side: 'a' })} emptyText="Not listed" />
                          )}
                        </td>
                        <td>
                          <MedCell med={r.b} other={r.a} fields={conflict?.fields} selected={sel === 'b'} onSelect={() => setFocus({ generic: r.generic, side: 'b' })} emptyText="Not listed" />
                        </td>
                        <td>
                          <div className="stack" style={{ gap: 6 }}>
                            {r.flags.map((f) => (
                              <span key={f.type} className={`small ${f.type === 'conflict' ? 'result-bad' : f.type === 'unchanged' ? 'subtle' : f.type === 'new' ? '' : 'result-mid'}`} style={f.type === 'new' ? { color: 'var(--accent-ink)', fontWeight: 600 } : undefined}>
                                {f.label}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
                          <TicketCell flags={r.flags} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="card secondary stack" aria-label="Source document">
          {source ? (
            <>
              <div className="eyebrow">
                Source · {source.label} · line {source.med.line + 1}
              </div>
              <div className="small muted">
                {source.visit.facility} · {source.visit.type} · {fmtDate(source.visit.date)}
                <br />
                <span className="mono">{source.visit.doc.title}</span>
              </div>
              <SourceDoc lines={source.visit.doc.lines} highlight={source.med.line} label={`${source.visit.doc.title}, line ${source.med.line + 1} highlighted`} />
              <div className="small muted">
                Extracted <strong style={{ color: 'var(--ink)' }}>{source.med.display}</strong> · OCR confidence {Math.round(source.med.confidence * 100)}%
                {source.med.confidence < 0.9 && <span className="result-mid"> · needs human check</span>}
              </div>
              <div className="small subtle">Click any value in the table to see the line it came from.</div>
            </>
          ) : (
            <div className="muted small">Select a value to see its source line.</div>
          )}
        </aside>
      </div>

      <p className="notice notice-info" style={{ margin: 0 }}>
        MedBridge highlights differences between records. It does not decide which instruction is correct: every flag is resolved by a qualified pharmacist or clinician.
      </p>
    </>
  );
}
