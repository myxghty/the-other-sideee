/*
 * In-browser mock of the MedTrail API. It behaves the way the real backend must:
 *  - Idempotency-Key: first response stored, duplicates get the same response (+ Idempotent-Replayed)
 *  - If-Match versions: stale writes get 412; losing a claim race gets 409
 *  - Priority-based load shedding: under overload, background work is refused first (429 + Retry-After)
 *    while patient handover reads keep being served
 */
import { findUser, isStaff } from '../../lib/users';
import { addAudit } from './audit';
import { compareVisits, draftTicket } from './compare';
import { getSettings, readDb, resetDb, setSettings, withDb } from './db';
import { buildPatientView } from './patientView';

const CLAIM_TTL_MS = 10 * 60 * 1000;
const HANDOVER_TTL_MS = 15 * 60 * 1000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const ok = (body, status = 200, headers) => ({ status, body, headers });
const fail = (status, error, message, extra = {}) => ({ status, body: { error, message, ...extra } });
const notFound = () => fail(404, 'NOT_FOUND', 'Not found.');
const forbidden = () => fail(403, 'FORBIDDEN', 'Your role cannot do this.');

/* ---------------- routing ---------------- */
const routes = [];
// kind: 'read' (shared lock, no write) | 'tx' (write, no idempotency) | 'mutation' (write + idempotency)
function on(method, pattern, priority, kind, handler) {
  const keys = [];
  const re = new RegExp(
    `^${pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, re, keys, priority, kind, handler });
}

/* ---------------- capacity model (simulation of the 3x / half-capacity scenario) ---------------- */
const limiter = { inFlight: 0 };
// Share of capacity each priority class may use. Critical and staff actions can use all of it.
const SHARE = { critical: 1, high: 1, normal: 0.75, low: 0.5 };
// Extra rejection probability from "other users" when overloaded.
const BACKGROUND_SHED = { critical: 0, high: 0.05, normal: 0.2, low: 0.4 };
const RETRY_AFTER = { critical: 1, high: 1, normal: 2, low: 4 };

async function acquire(priority, highLoad) {
  const capacity = highLoad ? 4 : 12;
  const allowed = Math.max(1, Math.floor(capacity * SHARE[priority]));
  const waitBudget = { critical: 6000, high: 2000, normal: 400, low: 0 }[priority];
  const deadline = Date.now() + waitBudget;
  while (limiter.inFlight >= allowed) {
    if (Date.now() >= deadline) return false;
    await delay(30);
  }
  limiter.inFlight++;
  return true;
}

function latency(highLoad) {
  const base = 120 + Math.random() * 230;
  return highLoad ? base * 2.5 : base;
}

/* ---------------- helpers ---------------- */
function parseIfMatch(h) {
  if (!h) return null;
  const n = Number(String(h).replace(/["W/]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const claimActive = (t, now = Date.now()) => !!t.claimedBy && t.claimExpiresAt > now;

function publicTicket(t) {
  const { fingerprint, ...rest } = t;
  return { ...rest, claimedBy: claimActive(t) ? t.claimedBy : null };
}

const nextId = (db, prefix) => `${prefix}-${db.seq++}`;

function randomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `MT-${s.slice(0, 4)}-${s.slice(4)}`;
}

/* ---------------- patients & comparison ---------------- */
on('GET', '/api/patients/:pid', 'normal', 'read', (ctx, db) => {
  const p = db.patients[ctx.params.pid];
  if (!p) return notFound();
  const visits = db.visits.filter((v) => v.patientId === p.id);
  return ok({ ...p, visitCount: visits.length, facilityCount: new Set(visits.map((v) => v.facility)).size });
});

on('GET', '/api/patients/:pid/visits', 'normal', 'read', (ctx, db) => {
  const items = db.visits
    .filter((v) => v.patientId === ctx.params.pid)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((v) => ({ id: v.id, date: v.date, facility: v.facility, type: v.type, prescriber: v.prescriber, medCount: v.meds.length }));
  return ok({ items });
});

on('GET', '/api/patients/:pid/compare', 'normal', 'read', (ctx, db) => {
  const cmp = compareVisits(db, ctx.params.pid, ctx.query.get('a'), ctx.query.get('b'));
  if (!cmp) return fail(422, 'INVALID_VISITS', 'Choose two different visits.');
  for (const r of cmp.rows) {
    for (const f of r.flags) {
      if (!f.fingerprint) continue;
      const t = db.tickets.find((x) => x.fingerprint === f.fingerprint);
      f.ticket = t ? { id: t.id, status: t.status } : null;
    }
  }
  return ok(cmp);
});

on('POST', '/api/patients/:pid/flags', 'normal', 'mutation', async (ctx, db) => {
  if (!isStaff(ctx.user)) return forbidden();
  const patient = db.patients[ctx.params.pid];
  if (!patient) return notFound();
  const cmp = compareVisits(db, patient.id, ctx.body?.a, ctx.body?.b);
  if (!cmp) return fail(422, 'INVALID_VISITS', 'Choose two different visits.');
  const created = [];
  const existing = [];
  const now = new Date().toISOString();
  for (const row of cmp.rows) {
    for (const f of row.flags) {
      if (!f.fingerprint) continue;
      // Real backend: UNIQUE(fingerprint) + INSERT ... ON CONFLICT DO NOTHING
      const found = db.tickets.find((t) => t.fingerprint === f.fingerprint);
      if (found) {
        existing.push(found.id);
        continue;
      }
      const t = draftTicket(cmp, row, f, patient, now);
      t.id = nextId(db, 'RQ');
      t.history[0].actor = `${ctx.user.name} (sent from comparison)`;
      db.tickets.push(t);
      created.push(t.id);
      await addAudit(db, ctx.user, 'FLAG_RAISED', t.id, t.title);
    }
  }
  return ok({ created, existing }, created.length ? 201 : 200);
});

/* ---------------- review queue ---------------- */
on('GET', '/api/tickets', 'low', 'read', (ctx, db) => {
  if (!isStaff(ctx.user)) return forbidden();
  const status = ctx.query.get('status') || 'active';
  const items = db.tickets
    .filter((t) => (status === 'active' ? t.status !== 'resolved' : t.status === status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(publicTicket);
  return ok({ items, total: items.length });
});

on('GET', '/api/tickets/:id', 'high', 'read', (ctx, db) => {
  if (!isStaff(ctx.user)) return forbidden();
  const t = db.tickets.find((x) => x.id === ctx.params.id);
  return t ? ok(publicTicket(t)) : notFound();
});

on('POST', '/api/tickets/:id/claim', 'high', 'mutation', async (ctx, db) => {
  if (!isStaff(ctx.user)) return forbidden();
  const t = db.tickets.find((x) => x.id === ctx.params.id);
  if (!t) return notFound();
  const now = Date.now();
  if (t.status === 'resolved') {
    return fail(409, 'ALREADY_RESOLVED', 'This ticket has already been resolved.', { ticket: publicTicket(t) });
  }
  if (claimActive(t, now) && t.claimedBy.id === ctx.user.id) return ok(publicTicket(t));
  if (claimActive(t, now)) {
    return fail(409, 'ALREADY_CLAIMED', `Already claimed by ${t.claimedBy.name}.`, {
      claimedBy: t.claimedBy,
      ticket: publicTicket(t),
    });
  }
  const expected = parseIfMatch(ctx.headers['if-match']);
  if (expected !== null && expected !== t.version) {
    return fail(412, 'VERSION_MISMATCH', 'This ticket changed since you loaded it.', { ticket: publicTicket(t) });
  }
  // Real backend: UPDATE tickets SET claimed_by=$me, claim_expires_at=now()+'10 min', version=version+1
  //   WHERE id=$id AND version=$v AND (claimed_by IS NULL OR claim_expires_at < now()) RETURNING *;
  //   0 rows -> 409/412. The database guarantees only one claimant.
  t.claimedBy = { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role };
  t.claimExpiresAt = now + CLAIM_TTL_MS;
  t.version++;
  t.history.push({ at: new Date(now).toISOString(), actor: ctx.user.name, action: 'Claimed for review' });
  await addAudit(db, ctx.user, 'TICKET_CLAIMED', t.id, t.title);
  return ok(publicTicket(t));
});

on('POST', '/api/tickets/:id/release', 'high', 'mutation', async (ctx, db) => {
  if (!isStaff(ctx.user)) return forbidden();
  const t = db.tickets.find((x) => x.id === ctx.params.id);
  if (!t) return notFound();
  if (!claimActive(t) || t.claimedBy.id !== ctx.user.id) {
    return fail(409, 'NOT_CLAIMANT', 'You do not hold the claim on this ticket.', { ticket: publicTicket(t) });
  }
  t.claimedBy = null;
  t.claimExpiresAt = 0;
  t.version++;
  t.history.push({ at: new Date().toISOString(), actor: ctx.user.name, action: 'Released claim' });
  await addAudit(db, ctx.user, 'TICKET_RELEASED', t.id, t.title);
  return ok(publicTicket(t));
});

on('POST', '/api/tickets/:id/resolve', 'high', 'mutation', async (ctx, db) => {
  if (!isStaff(ctx.user)) return forbidden();
  const t = db.tickets.find((x) => x.id === ctx.params.id);
  if (!t) return notFound();
  const now = Date.now();
  if (t.status === 'resolved') {
    return fail(409, 'ALREADY_RESOLVED', `Already resolved by ${t.resolution?.by.name}.`, { ticket: publicTicket(t) });
  }
  if (!claimActive(t, now) || t.claimedBy.id !== ctx.user.id) {
    const msg = claimActive(t, now)
      ? `Your claim ended and ${t.claimedBy.name} is now reviewing this ticket.`
      : 'Your claim has expired. Claim the ticket again to resolve it.';
    return fail(409, 'NOT_CLAIMANT', msg, { ticket: publicTicket(t) });
  }
  const expected = parseIfMatch(ctx.headers['if-match']);
  if (expected !== null && expected !== t.version) {
    return fail(412, 'VERSION_MISMATCH', 'This ticket changed while you were reviewing it.', { ticket: publicTicket(t) });
  }
  const decision = t.decisions.find((d) => d.id === ctx.body?.decision);
  const note = String(ctx.body?.note || '').trim();
  if (!decision) return fail(422, 'INVALID_DECISION', 'Choose one of the listed options.');
  if (note.length < 10) return fail(422, 'NOTE_REQUIRED', 'Add a note of at least 10 characters.');

  const at = new Date(now).toISOString();
  t.status = decision.id === 'clarify' ? 'clarification' : 'resolved';
  t.resolution = { decision: decision.id, label: decision.label, note, by: { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role }, at };
  t.claimedBy = null;
  t.claimExpiresAt = 0;
  t.version++;
  t.history.push({ at, actor: ctx.user.name, action: decision.label, note });
  await addAudit(
    db,
    ctx.user,
    decision.id === 'clarify' ? 'CLARIFICATION_REQUESTED' : 'TICKET_RESOLVED',
    t.id,
    `${decision.label}. Note: ${note}`,
    at,
  );
  return ok(publicTicket(t));
});

/* ---------------- audit ---------------- */
on('GET', '/api/audit', 'low', 'read', (ctx, db) => {
  if (!isStaff(ctx.user)) return forbidden();
  const limit = Math.min(50, Number(ctx.query.get('limit')) || 15);
  const cursor = Number(ctx.query.get('cursor')) || Infinity;
  const items = [...db.audit].reverse().filter((e) => e.seq < cursor).slice(0, limit);
  const last = items[items.length - 1];
  return ok({ items, nextCursor: last && last.seq > 1 ? last.seq : null, total: db.audit.length });
});

/* ---------------- uploads (async extraction through a queue) ---------------- */
function advanceUpload(db, u, highLoad, now = Date.now()) {
  if (u.status !== 'queued' && u.status !== 'processing') return null;
  const waited = now - u.queuedAt;
  const queueMs = highLoad ? 9000 : 1500;
  const workMs = highLoad ? 7000 : 2500;
  // Simulated "documents ahead of you" in the queue.
  u.position = Math.max(0, Math.ceil((queueMs - waited) / 1500));
  if (waited >= queueMs && u.status === 'queued') u.status = 'processing';
  if (waited >= queueMs + workMs) {
    u.status = 'extracted';
    u.position = 0;
    // Same shape as the Python worker's output. The mock cannot read files, so it returns a sample.
    u.extracted = {
      method: 'mock',
      note: 'Sample extraction from the mock backend. The Python backend reads the real file (PDF text or OCR).',
      prescriber: 'Dr. N. Varma',
      lines: ['Lakeside Clinic - OPD', '05 Nov 2026 - Dr. N. Varma', 'Rx', '1) Tab Pantoprazole 40mg OD B/F x 14 days', '2) Cap Vitamin D3 60000 IU once weekly'],
      medications: [
        { generic: 'pantoprazole', display: 'Pantoprazole 40 mg', line: 3, strength: '40 mg', frequency: 'once daily', timing: 'before food', duration: '14 days', confidence: 0.91, needsCheck: false, asWritten: 'Tab Pantoprazole 40mg OD B/F x 14 days' },
        { generic: 'vitamin d3', display: 'Vitamin D3 60,000 IU', line: 4, strength: '60,000 IU', frequency: 'weekly', timing: null, duration: null, confidence: 0.72, needsCheck: true, asWritten: 'Cap Vitamin D3 60000 IU once weekly' },
      ],
    };
    return 'extracted';
  }
  return null;
}

async function progressUploads(ctx, db, list) {
  const { highLoad } = getSettings();
  for (const u of list) {
    if (advanceUpload(db, u, highLoad) === 'extracted') {
      await addAudit(db, { name: 'MedTrail extraction', role: 'system' }, 'VALUES_EXTRACTED', u.id, `${u.fileName}: 2 medicines extracted, 1 needs human check`);
    }
  }
}

on('GET', '/api/uploads', 'low', 'tx', async (ctx, db) => {
  const pid = ctx.query.get('patientId');
  // Uploads whose file never arrived (abandoned) are not shown.
  const list = db.uploads.filter((u) => u.patientId === pid && u.status !== 'awaiting_file');
  await progressUploads(ctx, db, list);
  return ok({ items: [...list].reverse().slice(0, 10) });
});

on('GET', '/api/uploads/:id', 'low', 'tx', async (ctx, db) => {
  const u = db.uploads.find((x) => x.id === ctx.params.id);
  if (!u) return notFound();
  await progressUploads(ctx, db, [u]);
  return ok(u);
});

on('POST', '/api/uploads', 'normal', 'mutation', async (ctx, db) => {
  const { patientId, fileName, size, sha256, docType, facility, visitDate } = ctx.body || {};
  if (!patientId || !sha256 || !fileName) return fail(422, 'INVALID_UPLOAD', 'File details are missing.');
  if (size > 10 * 1024 * 1024) return fail(413, 'FILE_TOO_LARGE', 'Files must be 10 MB or smaller.');
  // Content dedupe: the same file for the same patient is one document, whoever sends it and however often.
  const dup = db.uploads.find((u) => u.patientId === patientId && u.sha256 === sha256);
  if (dup) return ok({ upload: dup, uploadUrl: `/mock-storage/${dup.id}`, duplicate: true });
  const u = {
    id: nextId(db, 'UP'),
    patientId,
    fileName,
    size,
    sha256,
    docType,
    facility,
    visitDate,
    uploadedBy: ctx.user.name,
    status: 'awaiting_file',
    fileReceived: false,
    createdAt: new Date().toISOString(),
  };
  db.uploads.push(u);
  return ok({ upload: u, uploadUrl: `/mock-storage/${u.id}`, duplicate: false }, 201);
});

on('PUT', '/mock-storage/:id', 'normal', 'tx', (ctx, db) => {
  const u = db.uploads.find((x) => x.id === ctx.params.id);
  if (!u) return notFound();
  u.fileReceived = true;
  return ok({ stored: true });
});

on('POST', '/api/uploads/:id/complete', 'normal', 'mutation', async (ctx, db) => {
  const u = db.uploads.find((x) => x.id === ctx.params.id);
  if (!u) return notFound();
  if (!u.fileReceived) return fail(409, 'FILE_MISSING', 'The file has not finished uploading.');
  if (u.status === 'awaiting_file') {
    u.status = 'queued';
    u.queuedAt = Date.now();
    advanceUpload(db, u, getSettings().highLoad);
    await addAudit(db, ctx.user, 'DOCUMENT_UPLOADED', u.id, `${u.fileName} (${u.docType || 'document'})`);
  }
  return ok(u, 202);
});

/* ---------------- patient view & handover (critical path) ---------------- */
on('GET', '/api/patients/:pid/patient-view', 'critical', 'read', (ctx, db) => {
  if (ctx.user.role === 'patient' && ctx.user.patientId !== ctx.params.pid) return forbidden();
  if (!db.patients[ctx.params.pid]) return notFound();
  return ok(buildPatientView(db, ctx.params.pid));
});

on('POST', '/api/patients/:pid/handover', 'critical', 'mutation', async (ctx, db) => {
  if (ctx.user.role === 'patient' && ctx.user.patientId !== ctx.params.pid) return forbidden();
  const h = {
    code: randomCode(),
    patientId: ctx.params.pid,
    createdBy: ctx.user.name,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + HANDOVER_TTL_MS).toISOString(),
    scope: 'Reconciled medication list and open discrepancies',
  };
  db.handovers.push(h);
  await addAudit(db, ctx.user, 'HANDOVER_CODE_ISSUED', ctx.params.pid, `Code ${h.code}, valid 15 minutes`);
  return ok(h, 201);
});

/* ---------------- test-lab helpers ---------------- */
on('GET', '/api/__demo/stats', 'critical', 'read', (ctx, db) =>
  ok({
    handovers: db.handovers.length,
    uploads: db.uploads.length,
    tickets: db.tickets.length,
    idempotencyKeys: Object.keys(db.idem).length,
    auditEntries: db.audit.length,
  }),
);

on('GET', '/api/__demo/settings', 'critical', 'read', () => ok({ highLoad: getSettings().highLoad }));
on('PUT', '/api/__demo/settings', 'critical', 'read', (ctx) => {
  setSettings({ highLoad: !!ctx.body?.highLoad });
  return ok({ highLoad: !!ctx.body?.highLoad });
});

/* ---------------- dispatcher ---------------- */
const droppedOnce = new Set();

function makeResponse({ status, body, headers = {} }, highLoad) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Load-Level': highLoad ? 'high' : 'normal', ...headers },
  });
}

function pruneIdempotency(db) {
  const keys = Object.keys(db.idem);
  if (keys.length <= 400) return;
  keys.sort((a, b) => db.idem[a].at - db.idem[b].at);
  for (const k of keys.slice(0, keys.length - 400)) delete db.idem[k];
}

async function runMutation(ctx, handler) {
  return withDb(async (db) => {
    const key = ctx.headers['idempotency-key'];
    const fingerprint = `${ctx.method} ${ctx.path} ${ctx.user.id} ${JSON.stringify(ctx.body ?? null)}`;
    if (key) {
      const hit = db.idem[key];
      if (hit) {
        if (hit.fingerprint !== fingerprint) {
          return fail(422, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request.');
        }
        return { ...hit.response, headers: { ...(hit.response.headers || {}), 'Idempotent-Replayed': 'true' } };
      }
    }
    const response = await handler(ctx, db);
    // Real backend: store in the same DB transaction (UNIQUE idempotency_key), keep 24 h.
    if (key && response.status < 500) {
      db.idem[key] = { fingerprint, response, at: Date.now() };
      pruneIdempotency(db);
    }
    return response;
  });
}

export async function mockFetch(input, init = {}) {
  const url = new URL(input, 'http://mock.local');
  const method = (init.method || 'GET').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
  const { highLoad } = getSettings();

  const r = routes.find((x) => x.method === method && x.re.test(url.pathname));
  if (url.pathname === '/api/__demo/reset' && method === 'POST') {
    await resetDb();
    return makeResponse(ok({ reset: true }), highLoad);
  }
  if (!r) return makeResponse(notFound(), highLoad);

  // Overload simulation: refuse early (cheaply) instead of letting every request time out.
  const shed = () =>
    makeResponse(
      {
        ...fail(429, 'OVERLOADED', 'Server busy. Please retry shortly.'),
        headers: { 'Retry-After': String(RETRY_AFTER[r.priority]), 'X-Load-Level': 'high' },
      },
      true,
    );
  if (highLoad && Math.random() < BACKGROUND_SHED[r.priority]) {
    await delay(40);
    return shed();
  }
  if (!(await acquire(r.priority, highLoad))) return shed();

  try {
    await delay(latency(highLoad));
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const m = url.pathname.match(r.re);
    const params = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1]);
    });
    let body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        return makeResponse(fail(400, 'BAD_JSON', 'Malformed JSON.'), highLoad);
      }
    }
    const user = findUser(headers['x-demo-user']) || findUser('u-iyer');
    const ctx = { method, path: url.pathname, params, query: url.searchParams, headers, body, user };

    let result;
    if (r.kind === 'mutation') result = await runMutation(ctx, r.handler);
    else if (r.kind === 'tx') result = await withDb((db) => r.handler(ctx, db));
    else result = await readDb((db) => r.handler(ctx, db));

    // Test lab: simulate the response being lost on the way back (server already did the work).
    const dropKey = headers['idempotency-key'] || url.pathname;
    if (headers['x-demo-drop-response'] && !droppedOnce.has(dropKey)) {
      droppedOnce.add(dropKey);
      throw new TypeError('Failed to fetch (simulated lost response)');
    }
    return makeResponse(result, highLoad);
  } finally {
    limiter.inFlight--;
  }
}
