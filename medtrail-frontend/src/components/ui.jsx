import { dismissToast, useLoadLevel, useToasts } from '../lib/store';

export function Badge({ tone = 'neutral', children }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export function Button({ variant, size, pending, children, ...rest }) {
  const cls = ['btn', variant && `btn-${variant}`, size && `btn-${size}`].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={pending || rest.disabled} aria-busy={pending || undefined} {...rest}>
      {pending && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect x="1" y="1" width="26" height="26" rx="7" fill="#1F5FBF" />
      <path d="M8 14h4l2-5 3 10 2-5h2" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowRight() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="#5A6B80" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Loading({ label = 'Loading' }) {
  return (
    <div className="row muted" role="status">
      <span className="spinner" aria-hidden="true" /> {label}…
    </div>
  );
}

// Shown when a refresh failed but older data is still on screen (stale-while-error).
export function StaleNotice({ query }) {
  if (!query.error) return null;
  if (query.data === undefined) {
    return (
      <div className="notice notice-error" role="alert">
        <div>
          <strong>Could not load this.</strong> {query.error.message}{' '}
          <button type="button" className="btn btn-sm" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  const time = new Date(query.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div className="notice notice-info" role="status">
      Showing saved data from {time}. Refreshing again automatically.
    </div>
  );
}

export function LoadBanner() {
  const level = useLoadLevel();
  if (level !== 'high') return null;
  return (
    <div className="notice notice-load" role="status" aria-live="polite">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none', marginTop: 1 }}>
        <path d="M12 3 2 21h20L12 3Zm0 6v5m0 3v.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
      <div>
        <strong>High demand right now.</strong> Patient medication views and handovers stay available. Live updates are slowed
        and new uploads are queued; they will finish on their own. Anything you submit is saved once, even if you retry.
      </div>
    </div>
  );
}

export function Toasts() {
  const items = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <div>
            {t.title && <strong style={{ display: 'block' }}>{t.title}</strong>}
            {t.body}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function fmtDate(d) {
  if (!d) return '';
  const date = d.length === 10 ? new Date(`${d}T00:00:00`) : new Date(d);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(d) {
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(d, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m open`;
  if (s < 86400) return `${Math.round(s / 3600)}h open`;
  return `${Math.round(s / 86400)}d open`;
}

export const FLAG_TONE = {
  conflict: 'red',
  missing: 'amber',
  outdated: 'amber',
  missing_field: 'amber',
  new: 'blue',
  unchanged: 'neutral',
};

export const TYPE_LABEL = {
  conflict: 'Conflict',
  missing: 'Missing',
  outdated: 'Outdated',
  missing_field: 'Missing field',
};
