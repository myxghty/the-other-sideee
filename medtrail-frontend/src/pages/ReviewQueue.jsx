import { useEffect, useState } from 'react';
import { api } from '../api/endpoints';
import { Badge, Button, FLAG_TONE, Loading, StaleNotice, TYPE_LABEL, fmtDate, fmtDateTime, timeAgo } from '../components/ui';
import { POLL } from '../config';
import { Link } from '../lib/router';
import { toast, useLoadLevel, useUser } from '../lib/store';
import { SKIP, invalidate, setQueryData, useIdempotentMutation, useNow, useQuery } from '../lib/useApi';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'conflict', label: 'Conflicts' },
  { id: 'missing', label: 'Missing' },
  { id: 'outdated', label: 'Outdated' },
  { id: 'clarification', label: 'Awaiting prescriber' },
];

function claimState(t, user, now) {
  if (!t.claimedBy || t.claimExpiresAt <= now) return 'free';
  return t.claimedBy.id === user.id ? 'mine' : 'other';
}

// Shared handling for 409 / 412 so every action reacts the same way to a lost race.
function handleConflict(err, id) {
  if (err.body?.ticket) setQueryData(`ticket:${id}`, err.body.ticket);
  invalidate('tickets');
  if (err.status === 409) {
    toast({ tone: 'warn', title: 'Someone got there first', body: err.message });
  } else if (err.status === 412) {
    toast({ tone: 'warn', title: 'Ticket updated by someone else', body: 'The latest version is now shown. Your note has been kept.' });
  } else {
    toast({ tone: 'error', title: 'Action not completed', body: err.message });
  }
}

function ResolveForm({ ticket }) {
  const [decision, setDecision] = useState('');
  const [note, setNote] = useState('');
  const resolve = useIdempotentMutation((key) => api.resolve(ticket.id, ticket.version, { decision, note }, key), 'resolve');

  async function submit(e) {
    e.preventDefault();
    try {
      // The signature ties the idempotency key to this exact payload + version.
      const t = await resolve.mutate(JSON.stringify({ v: ticket.version, decision, note }));
      if (t === SKIP) return;
      setQueryData(`ticket:${ticket.id}`, t);
      invalidate('tickets');
      invalidate('compare');
      invalidate('pview');
      invalidate('audit');
      toast({ tone: 'success', title: t.status === 'clarification' ? 'Clarification requested' : 'Resolved and signed', body: `${ticket.id} recorded in the audit log under your name.` });
    } catch (err) {
      handleConflict(err, ticket.id);
    }
  }

  const valid = decision && note.trim().length >= 10;
  return (
    <form className="card stack" onSubmit={submit} aria-label="Resolve ticket">
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>Decision</legend>
        {ticket.decisions.map((d) => (
          <label key={d.id} className="decision">
            <input type="radio" name="decision" value={d.id} checked={decision === d.id} onChange={() => setDecision(d.id)} />
            <span>{d.label}</span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        Reviewer note (required)
        <textarea
          className="input"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Confirmed with Dr. P. Rao by phone: dose increased on 28 Oct."
        />
        <span className="small subtle" style={{ fontWeight: 400 }}>
          At least 10 characters. Saved with your name, role and time.
        </span>
      </label>
      <div className="row">
        <Button type="submit" variant="primary" pending={resolve.pending} disabled={!valid}>
          Sign and submit
        </Button>
        <span className="small muted">Recording which source a professional verified. The original instructions are never edited.</span>
      </div>
    </form>
  );
}

function TicketDetail({ id }) {
  const user = useUser();
  const load = useLoadLevel();
  const now = useNow(1000);
  const q = useQuery(`ticket:${id}`, () => api.ticket(id), { staleTime: 3000, refetchInterval: POLL.ticket[load] });
  const t = q.data;

  const claim = useIdempotentMutation((key) => api.claim(id, t.version, key), 'claim');
  const release = useIdempotentMutation((key) => api.release(id, t.version, key), 'release');

  // Refresh as soon as a claim expires so the bar never shows a stale owner.
  useEffect(() => {
    if (t?.claimedBy && t.claimExpiresAt > Date.now()) {
      const ms = t.claimExpiresAt - Date.now() + 200;
      const timer = setTimeout(() => q.refetch(), ms);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [t?.claimExpiresAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <Loading label="Loading ticket" />;
  if (!t) return <StaleNotice query={q} />;

  const state = claimState(t, user, now);
  const left = Math.max(0, t.claimExpiresAt - now);
  const mmss = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;

  async function onClaim() {
    try {
      const nt = await claim.mutate(`${id}:${t.version}`);
      if (nt === SKIP) return;
      setQueryData(`ticket:${id}`, nt);
      invalidate('tickets');
      toast({ tone: 'success', title: `You are reviewing ${id}`, body: 'Other reviewers see it as claimed for the next 10 minutes.' });
    } catch (err) {
      handleConflict(err, id);
    }
  }
  async function onRelease() {
    try {
      const nt = await release.mutate(`${id}:${t.version}`);
      if (nt === SKIP) return;
      setQueryData(`ticket:${id}`, nt);
      invalidate('tickets');
    } catch (err) {
      handleConflict(err, id);
    }
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <StaleNotice query={q} />
      <div>
        <div className="small muted">
          {t.id} · {t.patientName} ({t.patientId}) · flagged {fmtDateTime(t.createdAt)} · version {t.version}
        </div>
        <h1 style={{ fontSize: 26, marginTop: 6 }}>{t.title}</h1>
      </div>

      {t.status === 'resolved' ? (
        <div className="claimbar claim-mine">
          <span>
            <strong>Resolved</strong> by {t.resolution.by.name} · {fmtDateTime(t.resolution.at)}: {t.resolution.label}
          </span>
        </div>
      ) : state === 'free' ? (
        <div className="claimbar claim-free">
          <span>{t.status === 'clarification' ? 'Awaiting prescriber clarification. Claim it to record the outcome.' : 'Not claimed. Claim it so no one else reviews it at the same time.'}</span>
          <Button variant="primary" pending={claim.pending} onClick={onClaim}>
            Claim for review
          </Button>
        </div>
      ) : state === 'mine' ? (
        <div className="claimbar claim-mine">
          <span>
            <strong>You are reviewing this.</strong> Claim held for {mmss}.
          </span>
          <Button size="sm" pending={release.pending} onClick={onRelease}>
            Release
          </Button>
        </div>
      ) : (
        <div className="claimbar claim-other" role="status">
          <span>
            <strong>{t.claimedBy.name}</strong> is reviewing this ticket. Read-only for you; it frees up in {mmss} if not resolved.
          </span>
        </div>
      )}

      <div className="grid-2">
        {t.sources.map((s) => (
          <article key={s.label + s.docTitle} className="card stack" style={{ gap: 8 }}>
            <div className="eyebrow">
              {s.label} · {fmtDate(s.date)}
            </div>
            <div style={{ fontWeight: 600 }}>
              {s.facility}: {s.type}
            </div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{s.display}</div>
            <div className="muted small">{s.value}</div>
            <div className="paper" style={{ lineHeight: 1.6 }}>
              “{s.quote}”
              <div className="subtle" style={{ marginTop: 4 }}>
                {s.docTitle}, line {s.line + 1} · {s.prescriber}
              </div>
            </div>
          </article>
        ))}
      </div>

      {state === 'mine' && t.status !== 'resolved' && <ResolveForm key={t.id} ticket={t} />}

      <section>
        <h2 style={{ fontSize: 18, marginBottom: 10 }}>Ticket history</h2>
        <div className="timeline">
          {[...t.history].reverse().map((h, i) => (
            <div key={i} className="tl-item">
              <span className="muted">{fmtDateTime(h.at)}</span>
              <span>
                <strong>{h.actor}</strong>: {h.action}
                {h.note && <span className="muted"> · “{h.note}”</span>}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function ReviewQueue({ id }) {
  const user = useUser();
  const load = useLoadLevel();
  const now = useNow(30_000);
  const [filter, setFilter] = useState('all');
  const q = useQuery('tickets:active', () => api.tickets({ status: 'active' }), { staleTime: 5000, refetchInterval: POLL.queue[load] });
  const all = q.data?.items || [];
  const items = all.filter((t) => (filter === 'all' ? true : filter === 'clarification' ? t.status === 'clarification' : t.type === filter || (filter === 'missing' && t.type === 'missing_field')));
  const selected = id || items[0]?.id;

  return (
    <div className="split" style={{ alignItems: 'stretch' }}>
      <section className="card card-tight secondary" style={{ maxWidth: 380 }} aria-label="Open tickets">
        <div style={{ padding: '16px 16px 8px' }}>
          <div className="row between">
            <h1 style={{ fontSize: 20 }}>Review queue</h1>
            <span className="small muted">{q.data ? `${q.data.total} open` : ''}</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 10 }}>
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className={`btn btn-sm ${filter === f.id ? 'btn-primary' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <StaleNotice query={q} />
        {q.isLoading && (
          <div style={{ padding: 16 }}>
            <Loading />
          </div>
        )}
        <div className="queue">
          {items.map((t) => {
            const st = claimState(t, user, now);
            return (
              <Link key={t.id} to={`/review/${t.id}`} className={`qitem ${t.id === selected ? 'active' : ''}`} aria-current={t.id === selected ? 'true' : undefined}>
                <div className="qmeta">
                  <span>
                    {t.id} · {t.status === 'clarification' ? 'Awaiting prescriber' : TYPE_LABEL[t.type]}
                  </span>
                  <span>{timeAgo(t.createdAt, now)}</span>
                </div>
                <div className="qtitle">{t.title}</div>
                <div className="row between small" style={{ marginTop: 4 }}>
                  <span className="muted">
                    {t.patientName} · {t.patientId}
                  </span>
                  {st === 'mine' && <Badge tone="green">You</Badge>}
                  {st === 'other' && <Badge tone="amber">{t.claimedBy.name}</Badge>}
                  {st === 'free' && <Badge tone={FLAG_TONE[t.type]}>{TYPE_LABEL[t.type]}</Badge>}
                </div>
              </Link>
            );
          })}
          {q.data && !items.length && <div style={{ padding: 16 }} className="muted">Nothing here. All caught up.</div>}
        </div>
      </section>

      <section className="primary">{selected ? <TicketDetail key={selected} id={selected} /> : !q.isLoading && <div className="card muted">No open tickets.</div>}</section>
    </div>
  );
}
