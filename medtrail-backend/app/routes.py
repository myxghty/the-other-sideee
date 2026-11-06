"""All API endpoints. The contract matches medtrail-frontend/src/api/endpoints.js."""
import hashlib
import secrets

from fastapi import APIRouter
from starlette.requests import Request

from . import audit, storage, worker
from .auth import DEMO_USERS, ENGINE, current_user, require_patient_access, require_staff
from .compare import compare_visits, draft_ticket
from .config import settings
from .db import dumps, loads, next_id, now_ms
from .errors import ApiError, fail, ok
from .http_utils import db_read, db_write, if_match, ok_json, read_json, write
from .loadshed import DemoLoadState
from .patient_view import build_patient_view
from .repo import (
    insert_ticket, load_patient, load_visits, queue_position, ticket_public, ticket_row, upload_public,
)
from .seed import seed

router = APIRouter()

ALLOWED_TYPES = {"application/pdf", "image/jpeg", "image/png", "text/plain"}
TYPE_BY_EXT = {".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".txt": "text/plain"}


def _not_found(what="Not found."):
    return ApiError(404, "NOT_FOUND", what)


# ======================================================================= basics
@router.get("/api/health")
async def health(request: Request):
    return ok_json({"ok": True})


@router.get("/api/me")
async def me(request: Request):
    return ok_json(current_user(request).public())


# ======================================================================= patients
@router.get("/api/patients/{pid}")
async def get_patient(request: Request, pid: str):
    user = current_user(request)
    require_patient_access(user, pid)

    def q(t):
        p = load_patient(t, pid)
        if not p:
            raise _not_found("Patient not found.")
        visits = t.all("SELECT facility FROM visits WHERE patient_id = ?", pid)
        return {**p, "visitCount": len(visits), "facilityCount": len({v["facility"] for v in visits})}

    return ok_json(await db_read(q))


@router.get("/api/patients/{pid}/visits")
async def get_visits(request: Request, pid: str):
    user = current_user(request)
    require_patient_access(user, pid)

    def q(t):
        visits = load_visits(t, pid)
        items = [{"id": v["id"], "date": v["date"], "facility": v["facility"], "type": v["type"],
                  "prescriber": v["prescriber"], "medCount": len(v["meds"])} for v in visits]
        return {"items": sorted(items, key=lambda v: v["date"], reverse=True)}

    return ok_json(await db_read(q))


@router.get("/api/patients/{pid}/compare")
async def get_compare(request: Request, pid: str):
    user = current_user(request)
    require_staff(user)
    a, b = request.query_params.get("a"), request.query_params.get("b")

    def q(t):
        cmp = compare_visits(load_visits(t, pid), pid, a, b)
        if not cmp:
            raise ApiError(422, "INVALID_VISITS", "Choose two different visits of this patient.")
        tickets = {r["fingerprint"]: r for r in t.all("SELECT id, status, fingerprint FROM tickets WHERE patient_id = ?", pid)}
        for row in cmp["rows"]:
            for f in row["flags"]:
                if f.get("fingerprint"):
                    tk = tickets.get(f["fingerprint"])
                    f["ticket"] = {"id": tk["id"], "status": tk["status"]} if tk else None
        return cmp

    return ok_json(await db_read(q))


@router.post("/api/patients/{pid}/flags")
async def submit_flags(request: Request, pid: str):
    user = current_user(request)
    require_staff(user)
    body = await read_json(request) or {}

    def handler(t):
        patient = load_patient(t, pid)
        if not patient:
            return fail(404, "NOT_FOUND", "Patient not found.")
        cmp = compare_visits(load_visits(t, pid), pid, body.get("a"), body.get("b"))
        if not cmp:
            return fail(422, "INVALID_VISITS", "Choose two different visits of this patient.")
        created, existing = [], []
        now = audit.now_iso()
        for row in cmp["rows"]:
            for f in row["flags"]:
                if not f.get("fingerprint"):
                    continue
                found = t.one("SELECT id FROM tickets WHERE fingerprint = ?", f["fingerprint"])
                if found:
                    existing.append(found["id"])
                    continue
                d = draft_ticket(cmp, row, f, patient, now)
                d["history"][0]["actor"] = f"{user.name} (sent from comparison)"
                tid = next_id(t, "RQ", "RQ")
                if insert_ticket(t, tid, d):  # UNIQUE(fingerprint): a racing duplicate inserts nothing
                    created.append(tid)
                    audit.append(t, user, "FLAG_RAISED", tid, d["title"])
                else:
                    existing.append(t.one("SELECT id FROM tickets WHERE fingerprint = ?", f["fingerprint"])["id"])
        return ok({"created": created, "existing": existing}, 201 if created else 200)

    return await write(request, user, {"pid": pid, **body}, handler)


@router.get("/api/patients/{pid}/patient-view")
async def get_patient_view(request: Request, pid: str):
    user = current_user(request)
    require_patient_access(user, pid)

    def q(t):
        if not load_patient(t, pid):
            raise _not_found("Patient not found.")
        tickets = {
            r["fingerprint"]: {"status": r["status"], "resolution": loads(r["resolution"])}
            for r in t.all("SELECT fingerprint, status, resolution FROM tickets WHERE patient_id = ?", pid)
        }
        return build_patient_view(load_visits(t, pid), tickets, pid)

    return ok_json(await db_read(q))


# ======================================================================= handover
def _handover_code() -> str:
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    s = "".join(secrets.choice(alphabet) for _ in range(8))
    return f"MT-{s[:4]}-{s[4:]}"


@router.post("/api/patients/{pid}/handover")
async def create_handover(request: Request, pid: str):
    user = current_user(request)
    require_patient_access(user, pid)

    def handler(t):
        if not load_patient(t, pid):
            return fail(404, "NOT_FOUND", "Patient not found.")
        code = _handover_code()
        expires = now_ms() + settings.handover_ttl_ms
        created = audit.now_iso()
        t.run("INSERT INTO handovers (code, patient_id, created_by, created_at, expires_at, scope) VALUES (?,?,?,?,?,?)",
              code, pid, user.name, created, expires, "Reconciled medication list and open discrepancies")
        audit.append(t, user, "HANDOVER_CODE_ISSUED", pid, f"Code {code}, valid 15 minutes")
        from datetime import datetime, timezone
        exp_iso = datetime.fromtimestamp(expires / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return ok({"code": code, "patientId": pid, "createdBy": user.name, "createdAt": created, "expiresAt": exp_iso,
                   "scope": "Reconciled medication list and open discrepancies"}, 201)

    return await write(request, user, {"pid": pid}, handler)


@router.get("/api/handover/{code}")
async def use_handover(request: Request, code: str):
    """Receiving facility: authorised staff open the patient's reconciled list with the code."""
    user = current_user(request)
    require_staff(user)

    def tx(t):
        h = t.one("SELECT * FROM handovers WHERE code = ?", code.strip().upper())
        if not h:
            raise _not_found("Unknown handover code.")
        if h["expires_at"] < now_ms():
            raise ApiError(410, "EXPIRED", "This handover code has expired. Ask the patient for a new one.")
        t.run("UPDATE handovers SET uses = uses + 1 WHERE code = ?", h["code"])
        audit.append(t, user, "HANDOVER_CODE_USED", h["patient_id"], f"Code {h['code']} opened by {user.name}")
        pid = h["patient_id"]
        tickets = t.all("SELECT * FROM tickets WHERE patient_id = ?", pid)
        view = build_patient_view(load_visits(t, pid), {r["fingerprint"]: {"status": r["status"], "resolution": loads(r["resolution"])} for r in tickets}, pid)
        return {
            "patient": load_patient(t, pid),
            "medications": view["items"],
            "openDiscrepancies": [ticket_public(r) for r in tickets if r["status"] != "resolved"],
            "expiresAt": h["expires_at"],
        }

    return ok_json(await db_write(tx))


# ======================================================================= review queue
@router.get("/api/tickets")
async def list_tickets(request: Request):
    user = current_user(request)
    require_staff(user)
    status = request.query_params.get("status", "active")

    def q(t):
        if status == "active":
            rows = t.all("SELECT * FROM tickets WHERE status <> 'resolved' ORDER BY created_at")
        else:
            rows = t.all("SELECT * FROM tickets WHERE status = ? ORDER BY created_at", status)
        now = now_ms()
        items = [ticket_public(r, now) for r in rows]
        return {"items": items, "total": len(items)}

    return ok_json(await db_read(q))


@router.get("/api/tickets/{tid}")
async def get_ticket(request: Request, tid: str):
    user = current_user(request)
    require_staff(user)

    def q(t):
        r = ticket_row(t, tid)
        if not r:
            raise _not_found("Ticket not found.")
        return ticket_public(r)

    return ok_json(await db_read(q))


def _conflict_reason(r: dict, user, expected, now):
    """Explains why a ticket write was refused (409 / 412), or None if it may proceed."""
    pub = ticket_public(r, now)
    if r["status"] == "resolved":
        by = (loads(r["resolution"]) or {}).get("by", {}).get("name", "someone")
        return fail(409, "ALREADY_RESOLVED", f"Already resolved by {by}.", ticket=pub)
    active = bool(r["claimed_by_id"]) and r["claim_expires_at"] > now
    if active and r["claimed_by_id"] != user.id:
        cb = loads(r["claimed_by"])
        return fail(409, "ALREADY_CLAIMED", f"Already claimed by {cb['name']}.", claimedBy=cb, ticket=pub)
    if expected is not None and expected != r["version"]:
        return fail(412, "VERSION_MISMATCH", "This ticket changed since you loaded it.", ticket=pub)
    return None


@router.post("/api/tickets/{tid}/claim")
async def claim_ticket(request: Request, tid: str):
    user = current_user(request)
    require_staff(user)
    expected = if_match(request)

    def handler(t):
        for _ in range(3):
            now = now_ms()
            r = ticket_row(t, tid)
            if not r:
                return fail(404, "NOT_FOUND", "Ticket not found.")
            if r["claimed_by_id"] == user.id and r["claim_expires_at"] > now and r["status"] != "resolved":
                return ok(ticket_public(r, now))  # already mine
            refused = _conflict_reason(r, user, expected, now)
            if refused:
                return refused
            history = loads(r["history"]) + [{"at": audit.now_iso(), "actor": user.name, "action": "Claimed for review"}]
            # The database picks exactly one winner: only one UPDATE can match this version.
            n = t.run(
                """UPDATE tickets SET claimed_by_id = ?, claimed_by = ?, claim_expires_at = ?, version = version + 1, history = ?
                   WHERE id = ? AND version = ? AND status <> 'resolved'
                     AND (claimed_by_id IS NULL OR claim_expires_at < ?)""",
                user.id, dumps(user.ref()), now + settings.claim_ttl_ms, dumps(history), tid, r["version"], now,
            )
            if n == 1:
                audit.append(t, user, "TICKET_CLAIMED", tid, r["title"])
                return ok(ticket_public(ticket_row(t, tid)))
            # Lost a race (PostgreSQL): re-read and explain who won.
        return fail(409, "CONFLICT", "Someone else changed this ticket. Please reload.")

    return await write(request, user, {"tid": tid, "v": expected}, handler)


@router.post("/api/tickets/{tid}/release")
async def release_ticket(request: Request, tid: str):
    user = current_user(request)
    require_staff(user)
    expected = if_match(request)

    def handler(t):
        now = now_ms()
        r = ticket_row(t, tid)
        if not r:
            return fail(404, "NOT_FOUND", "Ticket not found.")
        if not (r["claimed_by_id"] == user.id and r["claim_expires_at"] > now):
            return fail(409, "NOT_CLAIMANT", "You do not hold the claim on this ticket.", ticket=ticket_public(r, now))
        history = loads(r["history"]) + [{"at": audit.now_iso(), "actor": user.name, "action": "Released claim"}]
        n = t.run(
            "UPDATE tickets SET claimed_by_id = NULL, claimed_by = NULL, claim_expires_at = 0, version = version + 1, history = ? "
            "WHERE id = ? AND version = ? AND claimed_by_id = ?",
            dumps(history), tid, expected if expected is not None else r["version"], user.id,
        )
        if n == 0:
            return fail(412, "VERSION_MISMATCH", "This ticket changed since you loaded it.", ticket=ticket_public(ticket_row(t, tid)))
        audit.append(t, user, "TICKET_RELEASED", tid, r["title"])
        return ok(ticket_public(ticket_row(t, tid)))

    return await write(request, user, {"tid": tid, "v": expected}, handler)


@router.post("/api/tickets/{tid}/resolve")
async def resolve_ticket(request: Request, tid: str):
    user = current_user(request)
    require_staff(user)
    expected = if_match(request)
    body = await read_json(request) or {}

    def handler(t):
        now = now_ms()
        r = ticket_row(t, tid)
        if not r:
            return fail(404, "NOT_FOUND", "Ticket not found.")
        refused = _conflict_reason(r, user, expected, now)
        if refused:
            return refused
        if not (r["claimed_by_id"] == user.id and r["claim_expires_at"] > now):
            return fail(409, "NOT_CLAIMANT", "Your claim has expired. Claim the ticket again to resolve it.", ticket=ticket_public(r, now))
        decision = next((d for d in loads(r["decisions"]) if d["id"] == body.get("decision")), None)
        note = str(body.get("note") or "").strip()
        if not decision:
            return fail(422, "INVALID_DECISION", "Choose one of the listed options.")
        if len(note) < 10:
            return fail(422, "NOTE_REQUIRED", "Add a note of at least 10 characters.")
        at = audit.now_iso()
        status = "clarification" if decision["id"] == "clarify" else "resolved"
        resolution = {"decision": decision["id"], "label": decision["label"], "note": note, "by": user.ref(), "at": at}
        history = loads(r["history"]) + [{"at": at, "actor": user.name, "action": decision["label"], "note": note}]
        n = t.run(
            """UPDATE tickets SET status = ?, resolution = ?, history = ?, claimed_by_id = NULL, claimed_by = NULL,
                                  claim_expires_at = 0, version = version + 1
               WHERE id = ? AND version = ? AND claimed_by_id = ? AND claim_expires_at > ? AND status <> 'resolved'""",
            status, dumps(resolution), dumps(history), tid, r["version"], user.id, now,
        )
        if n == 0:
            return fail(412, "VERSION_MISMATCH", "This ticket changed while you were reviewing it.", ticket=ticket_public(ticket_row(t, tid)))
        audit.append(t, user, "CLARIFICATION_REQUESTED" if status == "clarification" else "TICKET_RESOLVED", tid, f"{decision['label']}. Note: {note}", at)
        return ok(ticket_public(ticket_row(t, tid)))

    return await write(request, user, {"tid": tid, "v": expected, **body}, handler)


# ======================================================================= audit
@router.get("/api/audit")
async def get_audit(request: Request):
    user = current_user(request)
    require_staff(user)
    try:
        limit = min(50, max(1, int(request.query_params.get("limit", 15))))
        cursor = int(request.query_params.get("cursor") or 0)
    except ValueError as exc:
        raise ApiError(400, "BAD_QUERY", "limit and cursor must be numbers.") from exc

    def q(t):
        if cursor:
            rows = t.all("SELECT * FROM audit_log WHERE seq < ? ORDER BY seq DESC LIMIT ?", cursor, limit)
        else:
            rows = t.all("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?", limit)
        items = [audit.row_to_entry(r) for r in rows]
        total = t.scalar("SELECT COUNT(*) AS n FROM audit_log")
        last = items[-1]["seq"] if items else None
        return {"items": items, "nextCursor": last if last and last > 1 else None, "total": total}

    return ok_json(await db_read(q))


@router.get("/api/audit/verify")
async def verify_audit(request: Request):
    require_staff(current_user(request))
    return ok_json(await db_read(audit.verify))


# ======================================================================= uploads
@router.get("/api/uploads")
async def list_uploads(request: Request):
    user = current_user(request)
    pid = request.query_params.get("patientId", "")
    require_patient_access(user, pid)

    def q(t):
        rows = t.all("SELECT * FROM uploads WHERE patient_id = ? AND status <> 'awaiting_file' ORDER BY created_at DESC LIMIT 10", pid)
        return {"items": [upload_public(r, queue_position(t, r)) for r in rows]}

    return ok_json(await db_read(q))


@router.get("/api/uploads/{uid}")
async def get_upload(request: Request, uid: str):
    user = current_user(request)

    def q(t):
        r = t.one("SELECT * FROM uploads WHERE id = ?", uid)
        if not r:
            raise _not_found("Upload not found.")
        require_patient_access(user, r["patient_id"])
        return upload_public(r, queue_position(t, r))

    return ok_json(await db_read(q))


@router.post("/api/uploads")
async def create_upload(request: Request):
    user = current_user(request)
    body = await read_json(request) or {}
    pid = body.get("patientId") or ""
    require_patient_access(user, pid)
    name = str(body.get("fileName") or "")[:200]
    sha = str(body.get("sha256") or "")
    size = body.get("size") or 0
    ctype = body.get("contentType") or next((v for k, v in TYPE_BY_EXT.items() if name.lower().endswith(k)), "")
    if not name or not sha:
        raise ApiError(422, "INVALID_UPLOAD", "File details are missing.")
    if ctype not in ALLOWED_TYPES:
        raise ApiError(415, "UNSUPPORTED_TYPE", "Use a PDF, JPG, PNG or text file.")
    if not isinstance(size, int) or size <= 0 or size > settings.max_upload_bytes:
        raise ApiError(413, "FILE_TOO_LARGE", f"Files must be {settings.max_upload_bytes // (1024 * 1024)} MB or smaller.")

    def handler(t):
        if not load_patient(t, pid):
            return fail(404, "NOT_FOUND", "Patient not found.")
        # Content de-duplication: the same file for the same patient is one document.
        dup = t.one("SELECT * FROM uploads WHERE patient_id = ? AND sha256 = ?", pid, sha)
        if dup:
            url = storage.make_upload_url(dup["id"]) if dup["status"] == "awaiting_file" else None
            return ok({"upload": upload_public(dup), "uploadUrl": url, "duplicate": True})
        uid = next_id(t, "UP", "UP")
        t.run(
            """INSERT INTO uploads (id, patient_id, file_name, size, sha256, content_type, doc_type, facility, visit_date,
                                    uploaded_by, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?, 'awaiting_file', ?)""",
            uid, pid, name, size, sha, ctype, body.get("docType"), body.get("facility") or None,
            body.get("visitDate") or None, user.name, audit.now_iso(),
        )
        r = t.one("SELECT * FROM uploads WHERE id = ?", uid)
        return ok({"upload": upload_public(r), "uploadUrl": storage.make_upload_url(uid), "duplicate": False}, 201)

    return await write(request, user, body, handler)


@router.put("/api/storage/{uid}")
async def put_file(request: Request, uid: str):
    """Signed upload target. Production: replace with an S3/R2 presigned URL."""
    if not storage.check_signature(uid, request.query_params.get("expires"), request.query_params.get("sig")):
        raise ApiError(403, "BAD_SIGNATURE", "This upload link is invalid or has expired.")
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > settings.max_upload_bytes:
            raise ApiError(413, "FILE_TOO_LARGE", "File is too large.")
        chunks.append(chunk)
    data = b"".join(chunks)
    actual = hashlib.sha256(data).hexdigest()

    def tx(t):
        r = t.one("SELECT * FROM uploads WHERE id = ?", uid)
        if not r:
            raise _not_found("Upload not found.")
        if not r["sha256"].startswith("fnv") and r["sha256"] != actual:
            raise ApiError(422, "HASH_MISMATCH", "The file does not match what was announced. Please upload again.")
        if r["file_received"]:
            return {"stored": True}  # retried PUT: already stored
        path = storage.save(uid, data)
        t.run("UPDATE uploads SET file_received = 1, storage_path = ? WHERE id = ?", str(path), uid)
        return {"stored": True}

    return ok_json(await db_write(tx))


@router.post("/api/uploads/{uid}/complete")
async def complete_upload(request: Request, uid: str):
    user = current_user(request)

    def handler(t):
        r = t.one("SELECT * FROM uploads WHERE id = ?", uid)
        if not r:
            return fail(404, "NOT_FOUND", "Upload not found.")
        require_patient_access(user, r["patient_id"])
        if not r["file_received"]:
            return fail(409, "FILE_MISSING", "The file has not finished uploading.")
        if r["status"] == "awaiting_file":
            t.run("UPDATE uploads SET status = 'queued', queued_at = ? WHERE id = ? AND status = 'awaiting_file'", now_ms(), uid)
            audit.append(t, user, "DOCUMENT_UPLOADED", uid, f"{r['file_name']} ({r['doc_type'] or 'document'})")
            r = t.one("SELECT * FROM uploads WHERE id = ?", uid)
        return ok(upload_public(r, queue_position(t, r)), 202)

    response = await write(request, user, {"uid": uid}, handler)
    worker.wake.set()
    return response


# ======================================================================= demo controls
def _demo_only():
    if not settings.demo_mode:
        raise _not_found()


@router.get("/api/__demo/settings")
async def demo_get_settings(request: Request):
    _demo_only()
    return ok_json({"highLoad": DemoLoadState.high_load})


@router.put("/api/__demo/settings")
async def demo_put_settings(request: Request):
    _demo_only()
    require_staff(current_user(request))
    body = await read_json(request) or {}
    value = bool(body.get("highLoad"))

    def tx(t):
        t.run("DELETE FROM demo_settings WHERE name = 'highLoad'")
        t.run("INSERT INTO demo_settings (name, value) VALUES ('highLoad', ?)", dumps(value))

    await db_write(tx)
    DemoLoadState.set(value)
    return ok_json({"highLoad": value})


@router.get("/api/__demo/stats")
async def demo_stats(request: Request):
    _demo_only()

    def q(t):
        n = lambda table: t.scalar(f"SELECT COUNT(*) AS n FROM {table}")  # noqa: E731
        return {"handovers": n("handovers"), "uploads": n("uploads"), "tickets": n("tickets"),
                "idempotencyKeys": n("idempotency_keys"), "auditEntries": n("audit_log")}

    return ok_json(await db_read(q))


@router.post("/api/__demo/reset")
async def demo_reset(request: Request):
    _demo_only()
    require_staff(current_user(request))
    from starlette.concurrency import run_in_threadpool

    from .db import get_db

    await run_in_threadpool(seed, get_db(), True)
    DemoLoadState.set(False)
    return ok_json({"reset": True, "users": [u.public() for u in DEMO_USERS], "engine": ENGINE.name})
