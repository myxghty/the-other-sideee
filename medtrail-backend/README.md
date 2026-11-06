# MedTrail: backend (Python / FastAPI)

API for **PS4: The Forgotten Prescription**. It serves the MedTrail React frontend.
All data is synthetic.

## Run it locally

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --env-file .env
```

- API: http://localhost:8000, interactive docs: http://localhost:8000/docs
- Starts with SQLite (`medtrail.db`), creates tables and loads the synthetic demo patient.
- OCR for photos needs the **tesseract** program: `sudo apt install tesseract-ocr` / `brew install tesseract` /
  Windows installer from the Tesseract project. PDFs with a text layer and `.txt` files work without it.

Connect the frontend: in `medtrail-frontend/.env` set `VITE_USE_MOCK=false`, then `npm run dev`.
The Vite dev server forwards `/api` to `localhost:8000`. The badge in the header changes to "Python backend".

Sample documents for uploads: `python scripts/make_samples.py` → `samples/opd-05nov.{pdf,png,txt}`.

## Tests

```bash
pytest -q                                              # 12 tests, starts its own server
python scripts/race_test.py --url http://localhost:8000 --users 20
python scripts/load_test.py --url http://localhost:8000 --users 60 --seconds 20 --demo-switch
```

| Test | Proves |
|---|---|
| `test_ten_simultaneous_claims_have_one_winner` | 10 users claim one ticket together → 1 winner, 9 × 409 with the winner's name |
| `test_same_key_sent_concurrently_happens_once` | 8 identical requests at once → 1 record, 7 replays |
| `test_lost_response_then_retry_replays` | server saves, response lost (504), client retries → replay, still 1 record |
| `test_key_reused_for_different_request_is_rejected` | same key, different body → 422 |
| `test_stale_version_gets_412` | write with an old version → 412 |
| `test_flags_sent_twice_create_tickets_once` | one ticket per discrepancy, however often it is sent |
| `test_resolve_flow_double_submit_and_patient_view` | double submit → 1 resolution, 1 audit entry; patient sees verified text verbatim |
| `test_upload_extracts_meds_into_a_new_visit` | upload → queue → extraction with line numbers → new visit; same file again → no duplicate |
| `test_upload_rejects_wrong_file` | file must match its announced SHA-256; upload links are signed |
| `test_overload_protects_patient_view` | 3× / ½ capacity: all patient views served, background work refused first with Retry-After |

## Constraint 1: 3× patients on ½ the resources (`app/loadshed.py`, `app/worker.py`)

| What | How |
|---|---|
| Priority admission | Each request is classed **critical** (patient view, handover) › **high** (claim/resolve) › **normal** (compare, upload) › **low** (polling, audit). When busy, low is refused first; critical waits up to 6 s for a slot instead of failing. |
| Cheap refusals | Refused requests get `429/503` + `Retry-After` immediately, before any database work. |
| Load signal | Every response has `X-Load-Level`; the frontend slows its polling and shows a banner. |
| Fairness | Per-user token bucket (`USER_RATE_PER_SEC`, `USER_BURST`). |
| Heavy work off the request path | OCR runs from a database-backed queue (`SELECT … FOR UPDATE SKIP LOCKED` on PostgreSQL). Under load the queue grows; requests stay fast. |
| Uploads | Clients send files to a signed URL; swap `app/storage.py` for S3/R2 presigned URLs so files bypass the API. |
| Scale out | Stateless API; run more instances behind the platform's load balancer. |

Measured locally, 60 users for 15 s with the simulation on: critical 100% served (p95 0.7 s), normal 100% (some after
retry), low 83% (refused first, retried later).

## Constraint 2: same resource claimed or changed at once, retries, duplicates

| What | How (where) |
|---|---|
| One claimant | Conditional `UPDATE … WHERE version = ? AND (claimed_by_id IS NULL OR claim_expires_at < now)`; the database lets exactly one through (`routes.py: claim_ticket`). Losers get `409 ALREADY_CLAIMED` with the winner's name. Claims expire after 10 min. |
| No lost updates | Every ticket write checks `If-Match: "<version>"` → `412 VERSION_MISMATCH` with the current ticket. |
| Exactly-once writes | `Idempotency-Key` stored **in the same transaction** as the change (`idempotency.py`). A racing duplicate hits the primary key, rolls back its own changes and replays the first response (`Idempotent-Replayed: true`). |
| Same discrepancy, one ticket | `UNIQUE(fingerprint)` + `ON CONFLICT DO NOTHING`. |
| Same file, one document | `UNIQUE(patient_id, sha256)`; the PUT verifies the hash. |
| Tamper-evident history | Audit log is append-only and hash-chained; appends are serialised (advisory lock on PostgreSQL); `GET /api/audit/verify` checks the whole chain. |

## Operational boundary

- Extraction only records what is written. Missing values stay empty and are marked "needs human check"; nothing is inferred.
- Brand → generic mapping only links names of the **same** drug; nothing is ever substituted.
- The comparison engine describes differences; only pharmacist/clinician roles can resolve, with a required note.
- Patients see instructions verbatim; plain readings come from fixed templates; unresolved items say "being reviewed".
- No endpoint creates prescriptions, changes doses or tells a patient to stop a medicine.

## API

Same contract as the frontend (`medtrail-frontend/src/api/endpoints.js`). Highlights:

```
GET  /api/patients/{pid}            /visits   /compare?a=&b=   /patient-view
POST /api/patients/{pid}/flags      (Idempotency-Key)
POST /api/patients/{pid}/handover   (Idempotency-Key)   ->  code valid 15 min
GET  /api/handover/{code}           staff at the next facility open the reconciled list (logged)
GET  /api/tickets   /api/tickets/{id}
POST /api/tickets/{id}/claim | release | resolve   (If-Match + Idempotency-Key)
GET  /api/audit?limit=&cursor=      /api/audit/verify
POST /api/uploads -> PUT {uploadUrl} -> POST /api/uploads/{id}/complete -> GET /api/uploads/{id}
GET|PUT /api/__demo/settings   GET /api/__demo/stats   POST /api/__demo/reset    (DEMO_MODE only)
```

Errors are `{"error": "CODE", "message": "..."}`. Auth: `X-Demo-User` header in demo mode, or a Bearer JWT
(`AUTH_MODE=jwt`, role in `app_metadata.role`, e.g. from Supabase Auth).

## Deploy

1. **Database**: create a PostgreSQL database on Supabase or Neon; set `DATABASE_URL`. Tables are created on start.
2. **API**: deploy this folder with the `Dockerfile` (includes Tesseract) to Render, Railway or Fly.io.
   Set `DEMO_MODE`, `SIGNING_SECRET` (same on every instance), `CORS_ORIGINS=https://your-frontend.vercel.app`.
3. **Worker** (optional): keep `RUN_WORKER_IN_PROCESS=true`, or run `python -m app.worker` as a separate service and
   set it to `false` on the API.
4. **Frontend**: on Vercel/Netlify set `VITE_USE_MOCK=false` and `VITE_API_URL=https://your-api.example`.

## Layout

```
app/
  main.py          FastAPI app, CORS, middleware, startup (migrate, seed, worker)
  routes.py        every endpoint
  idempotency.py   exactly-once writes
  loadshed.py      priority admission control, rate limits, overload simulation
  db.py            SQLite / PostgreSQL layer;  schema.sql
  compare.py       comparison engine;  patient_view.py;  plain.py (reviewed templates)
  audit.py         hash-chained audit log
  extraction/      ocr.py (pypdf / Tesseract), parse.py (prescription line parser)
  worker.py        extraction queue worker;  storage.py (signed upload URLs)
  auth.py          demo users / JWT;  seed.py (synthetic data)
scripts/           race_test.py, load_test.py, make_samples.py
tests/             pytest suite (starts a real server)
```
