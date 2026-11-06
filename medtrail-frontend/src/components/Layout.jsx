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

export default function Layout({ active, children }) {
  const user = useUser();
  const staff = isStaff(user);
  const load = useLoadLevel();
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
          <a className="brand" href="#/">
            <Logo />
            <span className="brand-name">MedBridge</span>
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
