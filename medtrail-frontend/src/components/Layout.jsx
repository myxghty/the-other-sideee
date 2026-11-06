import { useState } from 'react';
import { BACKEND_LABEL, api } from '../api/endpoints';
import { POLL } from '../config';
import { Link, navigate } from '../lib/router';
import { setUser, useLoadLevel, useUser } from '../lib/store';
import { invalidate, useQuery } from '../lib/useApi';
import { isStaff, ROLE_LABEL, USERS } from '../lib/users';
import { LoadBanner, Logo, Toasts } from './ui';

const NAV = [
  { to: '/compare', label: 'Compare lists', staff: true },
  { to: '/review', label: 'Review queue', staff: true, count: true },
  { to: '/upload', label: 'Upload document' },
  { to: '/audit', label: 'Audit history', staff: true },
  { to: '/patient', label: 'Patient view' },
  { sep: true, staff: true },
  { to: '/lab', label: 'Test lab', staff: true },
];

const BRAND_BLUE = '#2563eb';
const BRAND_WHITE = '#ffffff';
const BOX = { background: BRAND_BLUE, padding: '0 4px', borderRadius: 4 };
const NO_BOX = { background: 'transparent', padding: '0 4px', borderRadius: 4 };

export default function Layout({ active, children }) {
  const user = useUser();
  const staff = isStaff(user);
  const load = useLoadLevel();
  const [brandHover, setBrandHover] = useState(false);
  const queue = useQuery(staff ? 'tickets:active' : null, () => api.tickets({ status: 'active' }), {
    staleTime: 5000,
    refetchInterval: POLL.queue[load],
  });
  const openCount = queue.data?.total;

  function switchUser(e) {
    const next = USERS.find((u) => u.id === e.target.value);
    setUser(next.id);
    invalidate();
    navigate(isStaff(next) ? '/compare' : '/patient');
  }

  return (
    <>
      <header className="topbar">
        <div className="row" style={{ gap: 12 }}>
          <a
            className="brand"
            href="#/"
            onMouseEnter={() => setBrandHover(true)}
            onMouseLeave={() => setBrandHover(false)}
            onFocus={() => setBrandHover(true)}
            onBlur={() => setBrandHover(false)}
          >
            <Logo />
            <span className="brand-name">
              <span style={{ color: brandHover ? BRAND_BLUE : BRAND_WHITE, ...(brandHover ? NO_BOX : BOX), transition: 'color 0.15s, background 0.15s' }}>Med</span>
              <span style={{ color: brandHover ? BRAND_WHITE : BRAND_BLUE, ...(brandHover ? BOX : NO_BOX), transition: 'color 0.15s, background 0.15s' }}>Bridge</span>
            </span>
          </a>
          <span className="pill-synthetic">SYNTHETIC DATA</span>
          <span className="badge tone-neutral small">{BACKEND_LABEL}</span>
        </div>
        <label className="userbox">
          <span>Signed in as</span>
          <select value={user.id} onChange={switchUser} aria-label="Switch demo user">
            {USERS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {ROLE_LABEL[u.role]}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="shell">
        <nav className="sidenav" aria-label="Main">
          {NAV.filter((n) => !n.staff || staff).map((n, i) =>
            n.sep ? (
              <div key={`sep${i}`} className="navsep" />
            ) : (
              <Link key={n.to} to={n.to} className={`navlink ${active === n.to ? 'active' : ''}`} aria-current={active === n.to ? 'page' : undefined}>
                <span>{n.label}</span>
                {n.count && openCount > 0 && <span className="navcount">{openCount}</span>}
              </Link>
            ),
          )}
        </nav>
        <main className="main">
          <LoadBanner />
          {children}
        </main>
      </div>
      <Toasts />
    </>
  );
}