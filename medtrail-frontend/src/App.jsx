import { useEffect } from 'react';
import { MOCK_KEYS } from './api/mock/db';
import Layout from './components/Layout';
import Audit from './pages/Audit';
import Compare from './pages/Compare';
import PatientView from './pages/PatientView';
import ReviewQueue from './pages/ReviewQueue';
import TestLab from './pages/TestLab';
import Upload from './pages/Upload';
import { matchPath, navigate, usePath } from './lib/router';
import { useUser } from './lib/store';
import { invalidate } from './lib/useApi';
import { isStaff } from './lib/users';

const ROUTES = [
  { path: '/compare', nav: '/compare', staff: true, render: () => <Compare /> },
  { path: '/review/:id?', nav: '/review', staff: true, render: (p) => <ReviewQueue id={p.id} /> },
  { path: '/upload', nav: '/upload', render: () => <Upload /> },
  { path: '/audit', nav: '/audit', staff: true, render: () => <Audit /> },
  { path: '/patient', nav: '/patient', render: () => <PatientView /> },
  { path: '/lab', nav: '/lab', staff: true, render: () => <TestLab /> },
];

export default function App() {
  const path = usePath();
  const user = useUser();
  const staff = isStaff(user);

  // Another tab changed shared data (mock mode) -> refresh what's on screen.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === MOCK_KEYS.DB_KEY || e.key === MOCK_KEYS.SETTINGS_KEY) invalidate();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  let match = null;
  for (const r of ROUTES) {
    const params = matchPath(r.path, path);
    if (params && (!r.staff || staff)) {
      match = { route: r, params };
      break;
    }
  }

  useEffect(() => {
    if (!match) navigate(staff ? '/compare' : '/patient');
  }, [match, staff]);

  return <Layout active={match?.route.nav}>{match ? match.route.render(match.params) : null}</Layout>;
}
