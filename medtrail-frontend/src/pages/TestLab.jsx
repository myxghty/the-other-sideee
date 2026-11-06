import { useState } from 'react';
import { request } from '../api/client';
import { BACKEND_LABEL, api, demoApi } from '../api/endpoints';
import { Badge, Button } from '../components/ui';
import { PATIENT_ID } from '../config';
import { fileSha256, newKey } from '../lib/idempotency';
import { invalidate, setQueryData, useQuery } from '../lib/useApi';
import { SIM_USERS } from '../lib/users';

const pid = PATIENT_ID;

function Section({ title, children, intro }) {
  return (
    <section className="card stack">
      <div>
        <h2 style={{ fontSize: 19 }}>{title}</h2>
        {intro && <p className="muted small" style={{ margin: '4px 0 0' }}>{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/* 1. Simultaneous claims on one ticket */
function RaceTest() {
  const tickets = useQuery('tickets:active', () => api.tickets({ status: 'active' }), { staleTime: 5000 });
  const free = (tickets.data?.items || []).filter((t) => !t.claimedBy);
  const [ticketId, setTicketId] = useState('');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const target = ticketId || free[0]?.id;

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const t = await api.ticket(target);
      const started = performance.now();
      const rows = await Promise.all(
        SIM_USERS.map(async (u) => {
          try {
            const r = await request(`/api/tickets/${t.id}/claim`, {
              method: 'POST',
              ifMatch: t.version,
              idempotencyKey: newKey('race'),
              headers: { 'X-Demo-User': u.id },
            });
            return { user: u, ok: true, status: r.status, text: 'Claimed the ticket' };
          } catch (e) {
            return { user: u, ok: false, status: e.status, text: e.message };
          }
        }),
      );
      setResult({ ticket: t.id, rows, ms: Math.round(performance.now() - started) });
      invalidate('ticket');
    } finally {
      setRunning(false);
    }
  }

  async function resetClaim() {
    const winner = result?.rows.find((r) => r.ok);
    if (!winner) return;
    const t = await api.ticket(result.ticket);
    await request(`/api/tickets/${t.id}/release`, { method: 'POST', ifMatch: t.version, idempotencyKey: newKey('rel'), headers: { 'X-Demo-User': winner.user.id } }).catch(() => {});
    setResult(null);
    invalidate('ticket');
  }

  return (
    <Section
      title="Two or more users claim the same ticket at the same moment"
      intro="Five simulated pharmacists send a claim for the same ticket in parallel, all holding the same version. Exactly one must win; the others get a clear 409 with the winner's name."
    >
      <div className="row">
        <label className="field" style={{ minWidth: 260 }}>
          Ticket
          <select className="input" value={target || ''} onChange={(e) => setTicketId(e.target.value)}>
            {free.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} · {t.title}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" pending={running} disabled={!target} onClick={run} style={{ alignSelf: 'flex-end' }}>
          Fire 5 claims at once
        </Button>
        {result?.rows.some((r) => r.ok) && (
          <Button onClick={resetClaim} style={{ alignSelf: 'flex-end' }}>
            Release winner's claim
          </Button>
        )}
      </div>
      {!free.length && tickets.data && <div className="small muted">No unclaimed tickets. Release one in the review queue first.</div>}
      {result && (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Simulated user</th>
                  <th scope="col">HTTP</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.user.id}>
                    <td>{r.user.name}</td>
                    <td className="mono">{r.status}</td>
                    <td className={r.ok ? 'result-ok' : 'result-mid'}>{r.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Badge tone={result.rows.filter((r) => r.ok).length === 1 ? 'green' : 'red'}>
            {result.rows.filter((r) => r.ok).length} winner out of {result.rows.length} · {result.ms} ms
          </Badge>
          <div className="small muted">Open the review queue in two tabs as R. Iyer and A. Shah and try it by hand: the losing tab is told who has it.</div>
        </>
      )}
    </Section>
  );
}

/* 2. Duplicate submissions and retries */
function DuplicateTest() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState('');

  async function stats() {
    return demoApi.stats();
  }

  async function sameKeyThreeTimes() {
    setBusy('key');
    const before = await stats();
    const key = newKey('dup');
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        request(`/api/patients/${pid}/handover`, { method: 'POST', idempotencyKey: key })
          .then((r) => ({ code: r.data.code, replayed: r.headers.get('Idempotent-Replayed') === 'true', status: r.status }))
          .catch((e) => ({ error: e.message, status: e.status })),
      ),
    );
    const after = await stats();
    const codes = new Set(results.map((r) => r.code).filter(Boolean));
    setRows((x) => [
      {
        name: '3 identical handover requests sent together (one Idempotency-Key)',
        detail: results.map((r) => `${r.status}${r.replayed ? ' replayed' : ''}`).join(' · '),
        created: after.handovers - before.handovers,
        pass: codes.size === 1 && after.handovers - before.handovers === 1,
      },
      ...x,
    ]);
    setBusy('');
  }

  async function sameFileThreeTimes() {
    setBusy('file');
    const before = await stats();
    const file = new File([`synthetic test document ${Date.now()}`], 'duplicate-test.pdf', { type: 'application/pdf' });
    const sha256 = await fileSha256(file);
    // Three different keys: like three people or tabs uploading the same paper.
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        api.createUpload({ patientId: pid, fileName: file.name, size: file.size, sha256, contentType: 'application/pdf', docType: 'Prescription' }, newKey('dupfile')),
      ),
    );
    const after = await stats();
    const ids = new Set(results.map((r) => r.upload.id));
    setRows((x) => [
      {
        name: 'Same document uploaded 3 times in parallel (different keys)',
        detail: `upload ids: ${[...ids].join(', ')}`,
        created: after.uploads - before.uploads,
        pass: ids.size === 1 && after.uploads - before.uploads === 1,
      },
      ...x,
    ]);
    setBusy('');
  }

  async function lostResponse() {
    setBusy('lost');
    const before = await stats();
    const r = await request(`/api/patients/${pid}/handover`, {
      method: 'POST',
      idempotencyKey: newKey('lost'),
      headers: { 'X-Demo-Drop-Response': '1' },
    });
    const after = await stats();
    setRows((x) => [
      {
        name: 'Response lost after the server saved it; the client retries on its own',
        detail: `${r.attempts} attempts · replayed: ${r.headers.get('Idempotent-Replayed') === 'true' ? 'yes' : 'no'} · code ${r.data.code}`,
        created: after.handovers - before.handovers,
        pass: after.handovers - before.handovers === 1 && r.attempts > 1,
      },
      ...x,
    ]);
    setBusy('');
  }

  return (
    <Section
      title="Near-simultaneous requests, retries and duplicate submissions"
      intro="Each write carries an Idempotency-Key. The server keeps the first response for that key and replays it, so the action happens once. Uploads are also de-duplicated by file content."
    >
      <div className="row">
        <Button pending={busy === 'key'} onClick={sameKeyThreeTimes}>
          Send same request 3×
        </Button>
        <Button pending={busy === 'file'} onClick={sameFileThreeTimes}>
          Upload same file 3×
        </Button>
        <Button pending={busy === 'lost'} onClick={lostResponse}>
          Lose a response, then retry
        </Button>
      </div>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col">What came back</th>
                <th scope="col">Records created</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.name}</td>
                  <td className="mono small">{r.detail}</td>
                  <td className="mono">{r.created}</td>
                  <td className={r.pass ? 'result-ok' : 'result-bad'}>{r.pass ? 'Pass: one effect' : 'Fail'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/* 3. 3x patients on half the resources */
const CLASSES = [
  { id: 'critical', name: 'Patient handover view', path: `/api/patients/${pid}/patient-view` },
  { id: 'normal', name: 'Medication comparison', path: `/api/patients/${pid}/compare?a=v-aug&b=v-oct` },
  { id: 'low', name: 'Background queue refresh', path: '/api/tickets?status=active' },
];

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

function LoadTest() {
  const settings = useQuery('demo-settings', () => demoApi.settings(), { staleTime: 2000, refetchInterval: 5000 });
  const highLoad = !!settings.data?.highLoad;
  async function toggle(value) {
    setQueryData('demo-settings', { highLoad: value });
    try {
      setQueryData('demo-settings', await demoApi.setHighLoad(value));
    } catch {
      settings.refetch();
    }
  }
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [result, setResult] = useState(null);
  const N = 20;

  async function burst() {
    setRunning(true);
    setDone(0);
    setResult(null);
    const jobs = [];
    for (const c of CLASSES) {
      for (let i = 0; i < N; i++) {
        const sep = c.path.includes('?') ? '&' : '?';
        jobs.push(
          (async () => {
            const t0 = performance.now();
            try {
              const r = await request(`${c.path}${sep}burst=${i}`, { retries: 3, noDedupe: true });
              return { cls: c.id, ok: true, attempts: r.attempts, ms: performance.now() - t0 };
            } catch (e) {
              return { cls: c.id, ok: false, status: e.status, ms: performance.now() - t0 };
            } finally {
              setDone((d) => d + 1);
            }
          })(),
        );
      }
    }
    const all = await Promise.all(jobs);
    setResult(
      CLASSES.map((c) => {
        const mine = all.filter((r) => r.cls === c.id);
        const served = mine.filter((r) => r.ok);
        return {
          ...c,
          first: served.filter((r) => r.attempts === 1).length,
          retried: served.filter((r) => r.attempts > 1).length,
          failed: mine.length - served.length,
          p50: pct(served.map((r) => r.ms), 50),
          p95: pct(served.map((r) => r.ms), 95),
        };
      }),
    );
    setRunning(false);
  }

  return (
    <Section
      title="3× patients on ½ the resources"
      intro="Turn on the overload simulation (half the servers, three times the traffic from other users), then fire 60 requests at once and see what each class of work gets."
    >
      <label className="switch">
        <input type="checkbox" checked={highLoad} onChange={(e) => toggle(e.target.checked)} />
        Simulate 3× patients with ½ capacity {highLoad ? '(on for everyone)' : '(off)'}
      </label>
      <div className="row">
        <Button variant="primary" pending={running} onClick={burst}>
          Fire 60 requests at once
        </Button>
        {running && <span className="small muted">{done} / {CLASSES.length * N} finished</span>}
      </div>
      {result && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Request class</th>
                <th scope="col">Priority</th>
                <th scope="col">Served first try</th>
                <th scope="col">Served after backoff</th>
                <th scope="col">Gave up</th>
                <th scope="col">p50 / p95 ms</th>
              </tr>
            </thead>
            <tbody>
              {result.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td>
                    <Badge tone={r.id === 'critical' ? 'green' : r.id === 'normal' ? 'blue' : 'neutral'}>{r.id}</Badge>
                  </td>
                  <td className="mono">{r.first}</td>
                  <td className="mono">{r.retried}</td>
                  <td className={`mono ${r.failed ? 'result-bad' : ''}`}>{r.failed}</td>
                  <td className="mono">
                    {r.p50} / {r.p95}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="notice notice-info small">
        What to look for: the patient handover view is never refused; it waits for capacity. Comparisons mostly succeed after a
        short backoff. Background refreshes are refused first and simply try again later. Nothing is lost, and no request is
        processed twice.
      </div>
    </Section>
  );
}

export default function TestLab() {
  return (
    <>
      <section className="card row between">
        <div>
          <h1 style={{ fontSize: 24 }}>Test lab</h1>
          <div className="muted small" style={{ marginTop: 4 }}>
            Reproduce the organiser&apos;s scenarios against the {BACKEND_LABEL.toLowerCase()}. Data is shared by everyone using it.
          </div>
        </div>
        <Button
          size="sm"
          variant="danger"
          onClick={async () => {
            await demoApi.reset();
            invalidate();
          }}
        >
          Reset demo data
        </Button>
      </section>
      <RaceTest />
      <DuplicateTest />
      <LoadTest />
    </>
  );
}
