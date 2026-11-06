# MedTrail: frontend

Medication-continuity and safe-handover platform for **PS4: The Forgotten Prescription**.
UI direction: **Clinical Ledger**. All data is synthetic.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

Runs fully in the browser with a **mock backend** (`VITE_USE_MOCK=true`, the default), so you can demo before the
backend exists. The mock stores data in `localStorage` and locks writes across tabs, so two open tabs behave like two
users hitting one server.

To use the **Python backend** (`medtrail-backend`): start it on `:8000`, copy `.env.example` to `.env`, set
`VITE_USE_MOCK=false`, and run `npm run dev`. The dev server forwards `/api` to the backend, and the header badge
switches from "Mock backend" to "Python backend". The Test lab works against both.

For production, set `VITE_API_URL` to the API's address, run `npm run build`, and deploy `dist/`
(Vercel / Netlify). Add the site's address to the backend's `CORS_ORIGINS`.

## Pages

| Route | Who | What it does |
|---|---|---|
| `#/compare` | Pharmacist, clinician | Diff two visits; every value links to its source line; send flags to review |
| `#/review/:id` | Pharmacist, clinician | Claim → review both sources → decide with a required note → signed |
| `#/upload` | Everyone | Upload document → queued extraction → values with confidence |
| `#/audit` | Pharmacist, clinician | Append-only, hash-chained log; chain verified in the browser |
| `#/patient` | Patient (and staff preview) | Verified instructions verbatim + plain reading; handover code |
| `#/lab` | Staff | Reproduces the organiser's concurrency and overload tests |

Switch user (top right) to act as R. Iyer, A. Shah (both pharmacists), Dr. P. Rao or the patient. The user is
stored per tab, so tab 1 can be Iyer and tab 2 Shah.

## Constraint 1: 3× patients, ½ resources

**Principle: protect the critical path, degrade everything else in order, never lose or double-apply work.**

| Layer | What happens |
|---|---|
| Frontend hosting | Static build on a CDN (Vercel/Netlify). Page loads never touch the API servers. |
| Client retries | Only safe requests retry; exponential backoff with full jitter; `Retry-After` honoured (`src/api/client.js`). |
| Client load | Identical in-flight GETs are merged; cached data stays on screen if a refresh fails; polling slows 10 s → 60 s under load and pauses in hidden tabs (`src/lib/useApi.js`, `src/config.js`). |
| Uploads | File goes straight to object storage via a presigned URL; OCR runs in a queue; the UI shows queue position instead of waiting. |
| Server priority | **critical**: patient view, handover · **high**: claim/resolve · **normal**: compare, upload · **low**: list polling, audit. Under overload, low is refused first with `429 + Retry-After`; critical waits for capacity instead of failing. |
| Signals | Server sends `X-Load-Level: high`; the app shows a calm banner and slows itself down. |

Demo: Test lab → turn on "Simulate 3× patients with ½ capacity" → "Fire 60 requests at once".
Expected: patient handover 20/20 served; comparisons served after backoff; background refreshes refused first.

## Constraint 2: simultaneous claims, retries, duplicates

| Mechanism | Guarantees |
|---|---|
| **Claim = conditional update** (`version` + `claimed_by`) | Exactly one claimant; others get `409 ALREADY_CLAIMED` with the winner's name. Claims expire after 10 min. |
| **`If-Match: "<version>"`** on every write | Stale writes get `412 VERSION_MISMATCH`; the UI reloads the latest version and keeps the user's note. |
| **`Idempotency-Key`** on every POST | Server stores the first response per key and replays it (`Idempotent-Replayed: true`). Same key + different body → `422`. |
| Key per **intent**, not per attempt | `useIdempotentMutation` reuses the key for retries and "try again"; a new key only when the payload changes. |
| Content de-duplication | Upload: SHA-256 of the file per patient. Flags: a fingerprint per discrepancy (`UNIQUE`). |
| In-flight guard | Double clicks reuse the running request; buttons disable while pending. |

Demo: Test lab → "Fire 5 claims at once" (1 winner, 4× 409), "Send same request 3×", "Upload same file 3×",
"Lose a response, then retry" (server did the work, response dropped, client retries, gets the replay: 1 record).
By hand: open `#/review/RQ-113` in two tabs as two pharmacists and click **Claim** in both.

## Resources to set up

| # | Resource | Suggested (free tier is enough) | Used for |
|---|---|---|---|
| 1 | Node.js 20+ | nodejs.org | Run/build this frontend |
| 2 | Git repo | GitHub | Code, CI |
| 3 | Static hosting + CDN | Vercel or Netlify | Frontend (`dist/`) |
| 4 | API server | `medtrail-backend` (Python, FastAPI) on Render / Railway / Fly.io, ≥2 instances | REST API below, stateless |
| 5 | PostgreSQL + pooler | Supabase or Neon | All records, tickets, idempotency keys, audit log |
| 6 | Redis (optional) | Upstash | Only if you need a global rate limit across instances; the queue runs in PostgreSQL |
| 7 | Object storage | Supabase Storage, Cloudflare R2 or S3 | Uploaded documents via presigned URLs |
| 8 | OCR | Tesseract (included in the backend Dockerfile) | Extraction worker, in-process or `python -m app.worker` |
| 9 | Auth | Supabase Auth or Clerk | Login; role (patient / pharmacist / clinician) in the token |
| 10 | Load testing | `medtrail-backend/scripts/load_test.py` and `race_test.py` (no install needed) | Prove both constraints against the real API |
| 11 | Error monitoring (optional) | Sentry | Frontend + API errors |

## API contract (what the backend must implement)

All writes accept `Idempotency-Key`. Ticket writes require `If-Match: "<version>"`.

```
GET  /api/patients/:pid
GET  /api/patients/:pid/visits
GET  /api/patients/:pid/compare?a=:visitId&b=:visitId
POST /api/patients/:pid/flags                {a, b}          -> {created[], existing[]}
GET  /api/tickets?status=active
GET  /api/tickets/:id
POST /api/tickets/:id/claim                  If-Match        -> 200 | 409 ALREADY_CLAIMED | 412
POST /api/tickets/:id/release                If-Match        -> 200 | 409 NOT_CLAIMANT
POST /api/tickets/:id/resolve                If-Match {decision, note} -> 200 | 409 | 412 | 422
GET  /api/audit?limit=&cursor=
POST /api/uploads                            {patientId, fileName, size, sha256, docType, facility, visitDate}
                                             -> {upload, uploadUrl, duplicate}
PUT  <uploadUrl>                             (presigned storage URL)
POST /api/uploads/:id/complete               -> 202 {status: queued, position}
GET  /api/uploads/:id  |  GET /api/uploads?patientId=
GET  /api/patients/:pid/patient-view
POST /api/patients/:pid/handover             -> {code, expiresAt}
```

Errors: `{ "error": "CODE", "message": "Human readable" }`. Overload: `429` + `Retry-After` + `X-Load-Level: high`.
Response shapes: see `src/api/mock/server.js`; the mock is the reference implementation.

### Key SQL for the backend

```sql
-- Claim: the database decides the single winner.
UPDATE tickets
   SET claimed_by = $user, claim_expires_at = now() + interval '10 minutes', version = version + 1
 WHERE id = $id AND version = $expected_version
   AND status <> 'resolved'
   AND (claimed_by IS NULL OR claim_expires_at < now())
RETURNING *;            -- 0 rows: re-read and answer 409 (claimed) or 412 (stale)

-- Idempotency: one row per key, written in the same transaction as the change.
CREATE TABLE idempotency_keys (
  key text PRIMARY KEY, user_id text NOT NULL, request_hash text NOT NULL,
  status int NOT NULL, response jsonb NOT NULL, created_at timestamptz DEFAULT now()
);

-- One ticket per discrepancy, however many times it is sent.
CREATE UNIQUE INDEX tickets_fingerprint ON tickets (fingerprint);

-- Audit: insert-only for the app role.
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
```

## Operational boundary (built into the UI)

- The app never generates prescriptions, substitutes medicines, suggests doses or tells a patient to stop.
- Conflicts show both sources; only a pharmacist or clinician can resolve them, with a required note.
- Patients see the instruction **verbatim**; the plain reading comes from fixed reviewed templates and is omitted when
  no template matches. Unresolved items show a neutral "being reviewed" message.

## Project layout

```
src/
  api/client.js        fetch wrapper: retries, backoff, idempotency, If-Match, load signals
  api/endpoints.js     every API call (the contract)
  api/mock/            in-browser backend: server, comparison engine, seed data, audit chain
  lib/useApi.js        query cache, useMutation, useIdempotentMutation
  lib/                 router, store (user, load, toasts), hashing, plain-language templates
  components/          layout, UI primitives, source document viewer
  pages/               Compare, ReviewQueue, Upload, Audit, PatientView, TestLab
```
