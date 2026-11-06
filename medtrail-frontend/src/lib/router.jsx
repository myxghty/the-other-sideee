import { useSyncExternalStore } from 'react';

// Hash routing works on any static host (Vercel, Netlify, S3) with no rewrite rules.
function getPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}
function subscribe(f) {
  window.addEventListener('hashchange', f);
  return () => window.removeEventListener('hashchange', f);
}

export function usePath() {
  return useSyncExternalStore(subscribe, getPath);
}

export function navigate(to) {
  window.location.hash = to;
}

export function Link({ to, children, ...rest }) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}

// matchPath('/review/:id?', '/review/RQ-114') -> { id: 'RQ-114' }
export function matchPath(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('?')[0].split('/').filter(Boolean);
  if (s.length > p.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (seg.startsWith(':')) {
      const optional = seg.endsWith('?');
      const name = seg.replace(/^:/, '').replace(/\?$/, '');
      if (s[i] === undefined) {
        if (optional) continue;
        return null;
      }
      params[name] = decodeURIComponent(s[i]);
    } else if (seg !== s[i]) {
      return null;
    }
  }
  return params;
}
