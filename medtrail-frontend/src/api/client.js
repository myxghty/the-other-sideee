import { API_URL, USE_MOCK } from '../config';
import { getUser, reportLoad } from '../lib/store';
import { mockFetch } from './mock/server';

export class ApiError extends Error {
  constructor(status, body, message) {
    super(message || body?.message || `Request failed (${status})`);
    this.status = status; // 0 = network failure / no response
    this.body = body;
    this.code = body?.error;
  }
}

// Plug your auth provider in here (e.g. Supabase session access_token).
function getAuthToken() {
  return null;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const inflightGets = new Map();

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

// Honour Retry-After from the server; otherwise exponential backoff with full jitter,
// so thousands of clients don't retry in lock-step and re-overload the server.
function backoffMs(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds)) return seconds * 1000 + Math.random() * 500;
  const base = 400;
  const cap = 8000;
  return Math.random() * Math.min(cap, base * 2 ** attempt);
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * request(path, options) -> { data, status, headers, attempts }
 *
 * Retries only when it is safe to:
 *  - GET / PUT (idempotent by definition)
 *  - POST that carries an Idempotency-Key (server replays the first result)
 * Never retries 4xx business errors such as 409 Conflict or 412 Precondition Failed.
 */
export function request(path, options = {}) {
  const method = options.method || 'GET';
  if (method === 'GET' && !options.noDedupe) {
    // Identical GETs already in flight share one network call.
    if (inflightGets.has(path)) return inflightGets.get(path);
    const p = doRequest(path, options).finally(() => inflightGets.delete(path));
    inflightGets.set(path, p);
    return p;
  }
  return doRequest(path, options);
}

async function doRequest(path, options) {
  const {
    method = 'GET',
    body,
    idempotencyKey,
    ifMatch,
    retries,
    timeoutMs = 15_000,
    headers: extraHeaders = {},
    signal,
    onRetry,
  } = options;

  const external = /^https?:\/\//.test(path); // e.g. presigned storage URL
  const url = external ? path : API_URL + path;
  const canRetry = method === 'GET' || method === 'PUT' || !!idempotencyKey;
  const maxRetries = retries ?? (canRetry ? 4 : 0);
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;

  for (let attempt = 0; ; attempt++) {
    const headers = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined && !isBlob) headers['Content-Type'] = 'application/json';
    if (isBlob && body.type) headers['Content-Type'] = body.type;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (ifMatch !== undefined && ifMatch !== null) headers['If-Match'] = `"${ifMatch}"`;
    if (!external) {
      const token = getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      // Demo sign-in (AUTH_MODE=demo on the backend, and the mock): the chosen user travels in a header.
      else if (!headers['X-Demo-User']) headers['X-Demo-User'] = getUser().id;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let res = null;
    let networkError = null;
    try {
      const init = {
        method,
        headers,
        body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
        signal: ctrl.signal,
      };
      res = await (USE_MOCK && !external ? mockFetch : fetch)(url, init);
    } catch (err) {
      networkError = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (res) {
      const level = res.headers.get('X-Load-Level');
      if (level) reportLoad(level);
      if (res.status === 429 || res.status === 503) reportLoad('high');
    }

    const retryable = networkError ? !signal?.aborted : RETRYABLE_STATUS.has(res.status);
    if (retryable && attempt < maxRetries) {
      onRetry?.(attempt + 1, res?.status ?? 'network');
      await sleep(backoffMs(attempt, res?.headers.get('Retry-After')), signal);
      continue;
    }

    if (networkError) {
      if (signal?.aborted) throw networkError;
      throw new ApiError(0, null, 'Could not reach the server. Your action may not have been saved; it is safe to try again.');
    }

    const data = await parseBody(res);
    if (!res.ok) {
      if (res.status === 429 || res.status === 503) {
        throw new ApiError(res.status, data, 'The service is very busy. Please try again in a moment.');
      }
      throw new ApiError(res.status, data);
    }
    return { data, status: res.status, headers: res.headers, attempts: attempt + 1 };
  }
}
