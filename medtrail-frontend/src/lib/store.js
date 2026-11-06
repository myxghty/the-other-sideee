import { useSyncExternalStore } from 'react';
import { USERS } from './users';

function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      subs.forEach((f) => f());
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

// Selectors must return primitives or stable references.
export function useStore(store, selector) {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

/* ---------- current user (per tab, so two tabs can be two pharmacists) ---------- */
const session = {
  get(k) {
    try { return sessionStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ }
  },
};

export const sessionStore = createStore({ userId: session.get('medtrail.user') || 'u-iyer' });

export function getUser() {
  return USERS.find((u) => u.id === sessionStore.get().userId) || USERS[0];
}
export function setUser(id) {
  session.set('medtrail.user', id);
  sessionStore.set({ userId: id });
}
export function useUser() {
  const id = useStore(sessionStore, (s) => s.userId);
  return USERS.find((u) => u.id === id) || USERS[0];
}

/* ---------- load level (driven by server signals: 429 / 503 / X-Load-Level) ---------- */
export const loadStore = createStore({ level: 'normal' });
let decayTimer;
export function reportLoad(level) {
  if (level !== 'high') return;
  if (loadStore.get().level !== 'high') loadStore.set({ level: 'high' });
  clearTimeout(decayTimer);
  // Drop back to normal after 30 s with no further high-load signals.
  decayTimer = setTimeout(() => loadStore.set({ level: 'normal' }), 30_000);
}
export function useLoadLevel() {
  return useStore(loadStore, (s) => s.level);
}

/* ---------- toasts ---------- */
export const toastStore = createStore({ items: [] });
let toastId = 0;
export function toast(t) {
  const id = ++toastId;
  toastStore.set((s) => ({ items: [...s.items, { id, tone: 'info', ...t }].slice(-4) }));
  setTimeout(() => dismissToast(id), t.duration ?? 6000);
}
export function dismissToast(id) {
  toastStore.set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
}
export function useToasts() {
  return useStore(toastStore, (s) => s.items);
}
