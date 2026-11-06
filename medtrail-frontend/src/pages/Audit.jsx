import { useEffect, useState } from 'react';
import { api } from '../api/endpoints';
import { Badge, Button, Loading, StaleNotice, fmtDateTime } from '../components/ui';
import { verifyChain } from '../lib/hash';
import { useQuery } from '../lib/useApi';

const ACTION_TONE = {
  TICKET_RESOLVED: 'green',
  CLARIFICATION_REQUESTED: 'amber',
  FLAG_RAISED: 'red',
  TICKET_CLAIMED: 'blue',
  TICKET_RELEASED: 'neutral',
  HANDOVER_CODE_ISSUED: 'blue',
};

export default function Audit() {
  const first = useQuery('audit:first', () => api.audit(), { staleTime: 10_000 });
  const [more, setMore] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [check, setCheck] = useState(null);

  // A refreshed first page resets the extra pages.
  useEffect(() => {
    setMore([]);
    setCursor(first.data?.nextCursor);
  }, [first.data]);

  const entries = [...(first.data?.items || []), ...more];

  useEffect(() => {
    let cancelled = false;
    if (entries.length) verifyChain(entries).then((r) => !cancelled && setCheck(r));
    return () => {
      cancelled = true;
    };
  }, [entries.length, first.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await api.audit(cursor);
      setMore((m) => [...m, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <section className="card row between">
        <div>
          <h1 style={{ fontSize: 24 }}>Audit history</h1>
          <div className="muted small" style={{ marginTop: 4 }}>
            Every upload, extraction, flag, claim, decision and handover. Entries are append-only and hash-chained.
          </div>
        </div>
        {check && (
          <Badge tone={check.broken.length ? 'red' : 'green'}>
            {check.broken.length ? `Chain broken at #${check.broken.join(', #')}` : `Hash chain verified · ${check.ok} entries checked`}
          </Badge>
        )}
      </section>
      <StaleNotice query={first} />
      <section className="card card-tight">
        {first.isLoading ? (
          <div style={{ padding: 20 }}>
            <Loading />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data" style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Action</th>
                  <th scope="col">Details</th>
                  <th scope="col">Hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.seq}>
                    <td className="mono small">{e.seq}</td>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDateTime(e.at)}
                    </td>
                    <td className="small">
                      <strong>{e.actor}</strong>
                      <div className="subtle">{e.role}</div>
                    </td>
                    <td>
                      <Badge tone={ACTION_TONE[e.action] || 'neutral'}>{e.action.replaceAll('_', ' ').toLowerCase()}</Badge>
                    </td>
                    <td className="small">
                      <span className="mono">{e.target}</span>
                      <div className="muted">{e.detail}</div>
                    </td>
                    <td className="mono small subtle" title={`hash ${e.hash}\nprev ${e.prevHash}`}>
                      {e.hash.slice(0, 8)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {cursor && (
        <div>
          <Button pending={loadingMore} onClick={loadMore}>
            Load older entries
          </Button>
        </div>
      )}
    </>
  );
}
