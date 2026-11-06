import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { newKey } from './idempotency';

/*
 * A tiny query cache (stale-while-revalidate):
 * - one in-flight request per key, shared by every component that needs it
 * - cached data stays on screen when a refresh fails (important under overload)
 * - polling pauses while the tab is hidden
 */
const cache = new Map();

function entry(key) {
  if (!cache.has(key)) {
    cache.set(key, { data: undefined, error: null, updatedAt: 0, promise: null, subs: new Set() });
  }
  return cache.get(key);
}

function notify(e, msg) {
  e.subs.forEach((f) => f(msg));
}

function fetchEntry(key, fn) {
  const e = entry(key);
  if (e.promise) return e.promise;
  e.promise = (async () => {
    try {
      e.data = await fn();
      e.error = null;
      e.updatedAt = Date.now();
    } catch (err) {
      e.error = err;
    } finally {
      e.promise = null;
      notify(e);
    }
  })();
  notify(e);
  return e.promise;
}

export function setQueryData(key, data) {
  const e = entry(key);
  e.data = data;
  e.error = null;
  e.updatedAt = Date.now();
  notify(e);
}

// Mark matching keys stale and refetch the ones currently on screen.
export function invalidate(prefix = '') {
  for (const [k, e] of cache) {
    if (k.startsWith(prefix)) {
      e.updatedAt = 0;
      notify(e, 'invalidate');
    }
  }
}

export function useQuery(key, fn, { staleTime = 15_000, refetchInterval = 0 } = {}) {
  const [, force] = useReducer((x) => x + 1, 0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!key) return undefined;
    const e = entry(key);
    const sub = (msg) => {
      if (msg === 'invalidate') fetchEntry(key, () => fnRef.current());
      else force();
    };
    e.subs.add(sub);
    if (Date.now() - e.updatedAt > staleTime) fetchEntry(key, () => fnRef.current());
    return () => e.subs.delete(sub);
  }, [key, staleTime]);

  useEffect(() => {
    if (!key || !refetchInterval) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchEntry(key, () => fnRef.current());
    }, refetchInterval);
    return () => clearInterval(id);
  }, [key, refetchInterval]);

  const e = key ? entry(key) : null;
  return {
    data: e?.data,
    error: e?.error ?? null,
    isLoading: !!e && e.data === undefined && !e.error,
    isFetching: !!e?.promise,
    updatedAt: e?.updatedAt ?? 0,
    refetch: () => key && fetchEntry(key, () => fnRef.current()),
  };
}

// Returned to repeat calls (double clicks) so callers can skip showing the result twice.
export const SKIP = Symbol('duplicate-submit');

// Runs an async action and ignores repeat calls while one is in flight (no double submits).
export function useMutation(fn) {
  const [state, setState] = useState({ pending: false, error: null, data: null });
  const inflight = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const mutate = useCallback((...args) => {
    if (inflight.current) return inflight.current.then(() => SKIP, () => SKIP);
    setState((s) => ({ ...s, pending: true, error: null }));
    const p = (async () => {
      try {
        const data = await fnRef.current(...args);
        setState({ pending: false, error: null, data });
        return data;
      } catch (err) {
        setState({ pending: false, error: err, data: null });
        throw err;
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  }, []);

  return { ...state, mutate };
}

/*
 * Like useMutation, but manages an Idempotency-Key per user intent.
 * mutate(signature, ...args): `signature` describes the payload. The same signature
 * reuses the same key (safe "try again" after a timeout); a changed payload gets a new key.
 * The key is dropped after success or after a definite rejection (4xx).
 */
export function useIdempotentMutation(fn, prefix) {
  const keyRef = useRef(null);
  const sigRef = useRef(null);
  return useMutation(async (signature, ...args) => {
    if (!keyRef.current || sigRef.current !== signature) {
      keyRef.current = newKey(prefix);
      sigRef.current = signature;
    }
    try {
      const result = await fn(keyRef.current, ...args);
      keyRef.current = null;
      return result;
    } catch (err) {
      const uncertain = err.status === 0 || err.status === 429 || err.status >= 500;
      if (!uncertain) keyRef.current = null;
      throw err;
    }
  });
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
