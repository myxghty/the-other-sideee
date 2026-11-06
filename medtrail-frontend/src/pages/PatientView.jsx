import { useState } from 'react';
import { api } from '../api/endpoints';
import { Badge, Button, Loading, StaleNotice, fmtDate } from '../components/ui';
import { PATIENT_ID } from '../config';
import { toast, useUser } from '../lib/store';
import { SKIP, useIdempotentMutation, useNow, useQuery } from '../lib/useApi';

function MedCard({ item }) {
  if (item.status === 'in_review') {
    return (
      <article className="medcard pending">
        <div className="row between">
          <strong style={{ fontSize: 17, textTransform: 'capitalize' }}>{item.title}</strong>
          <Badge tone="amber">Being reviewed</Badge>
        </div>
        <div className="small" style={{ color: '#4a5263' }}>
          {item.message}
        </div>
      </article>
    );
  }
  return (
    <article className="medcard">
      <div className="row between">
        <strong style={{ fontSize: 17 }}>{item.title}</strong>
        {item.status === 'verified' ? <Badge tone="green">Verified by pharmacist</Badge> : <Badge tone="blue">Same on last two records</Badge>}
      </div>
      <div className="eyebrow">As written by your doctor</div>
      <div className="aswritten">{item.asWritten}</div>
      {item.plain && (
        <>
          <div className="eyebrow">In simple words</div>
          <div>{item.plain}</div>
        </>
      )}
      <div className="small subtle">
        From {item.source.docTitle}, line {item.source.line} · {item.source.facility}, {fmtDate(item.source.date)}
        {item.verifiedBy && ` · checked by ${item.verifiedBy}`}
      </div>
    </article>
  );
}

export default function PatientView() {
  const user = useUser();
  const pid = user.patientId || PATIENT_ID;
  const now = useNow(1000);
  const q = useQuery(`pview:${pid}`, () => api.patientView(pid), { staleTime: 10_000 });
  const [code, setCode] = useState(null);
  const handover = useIdempotentMutation((key) => api.handover(pid, key), 'handover');

  async function makeCode() {
    try {
      // Same signature until it succeeds: double taps and retries return the same code.
      const r = await handover.mutate('handover');
      if (r !== SKIP) setCode(r);
    } catch (err) {
      toast({ tone: 'error', title: 'Could not create a handover code', body: err.message });
    }
  }

  const items = q.data?.items || [];
  const left = code ? Math.max(0, new Date(code.expiresAt).getTime() - now) : 0;
  const pendingCount = items.filter((i) => i.status === 'in_review').length;

  return (
    <div className="phone" aria-label="Patient view">
      <div className="phone-head">
        <div className="row between">
          <strong style={{ fontSize: 18 }}>MedTrail</strong>
          <span className="pill-synthetic">SYNTHETIC</span>
        </div>
        <div style={{ color: '#d6e0f7', fontSize: 14 }}>Hello, {user.role === 'patient' ? user.name.split(' ')[0] : 'Arun'}</div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Your medicines</h1>
        <div style={{ color: '#d6e0f7', fontSize: 13 }}>
          {q.data ? `${items.length - pendingCount} confirmed · ${pendingCount} being reviewed` : ' '}
        </div>
      </div>
      <div className="phone-body">
        <StaleNotice query={q} />
        {q.isLoading && <Loading />}
        {items.map((it) => (
          <MedCard key={it.generic} item={it} />
        ))}

        <section className="medcard" aria-label="Handover">
          <strong>Moving to another hospital or pharmacy?</strong>
          <div className="small muted">
            Show a handover code to authorised staff. It gives them your reconciled list and any open questions for 15 minutes, and every use is logged.
          </div>
          {code && left > 0 ? (
            <>
              <div className="codebox" aria-live="polite">
                {code.code}
              </div>
              <div className="small muted" style={{ textAlign: 'center' }}>
                Valid for {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}
              </div>
            </>
          ) : (
            <Button variant="primary" pending={handover.pending} onClick={makeCode}>
              {code ? 'Code expired: create a new one' : 'Create handover code'}
            </Button>
          )}
        </section>
        <p className="small subtle" style={{ margin: 0 }}>
          MedTrail shows what your prescribers wrote. It does not change doses or tell you to stop a medicine. Ask your doctor or pharmacist about any changes.
        </p>
      </div>
    </div>
  );
}
