import { buildSeed } from './seed';

/*
 * Mock database kept in localStorage so every open tab sees the same data.
 * Writes are serialised with the Web Locks API (navigator.locks), which is shared
 * across tabs: two tabs claiming the same ticket really do race, and only one wins.
 * Real backend equivalent: a Postgres transaction with a conditional UPDATE.
 */
const DB_KEY = 'medtrail-mock-db-v1';
const SETTINGS_KEY = 'medtrail-mock-settings';

let memoryDb = null;
let memorySettings = { highLoad: false };

function load() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* storage blocked */ }
  return memoryDb;
}

function save(db) {
  memoryDb = db;
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch { /* storage blocked or full: keep in memory */ }
}

let chain = Promise.resolve();
function lock(fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('medtrail-mock-db', fn);
  }
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function ensure() {
  let db = load();
  if (!db) {
    db = await buildSeed();
    save(db);
  }
  return db;
}

export function readDb(fn) {
  return lock(async () => fn(await ensure()));
}

export function withDb(fn) {
  return lock(async () => {
    const db = await ensure();
    const result = await fn(db);
    save(db);
    return result;
  });
}

export function resetDb() {
  return lock(async () => {
    save(await buildSeed());
  });
}

/* ---------- simulation settings (shared across tabs) ---------- */
const settingsSubs = new Set();

export function getSettings() {
  try {
    return { highLoad: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return memorySettings;
  }
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  memorySettings = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  settingsSubs.forEach((f) => f());
}

export function subscribeSettings(f) {
  settingsSubs.add(f);
  const onStorage = (e) => {
    if (e.key === SETTINGS_KEY) f();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    settingsSubs.delete(f);
    window.removeEventListener('storage', onStorage);
  };
}

export const MOCK_KEYS = { DB_KEY, SETTINGS_KEY };
