"""Loading rows and turning them into the JSON shapes the frontend expects."""
from .db import Tx, dumps, loads, now_ms


def load_patient(t: Tx, pid: str) -> dict | None:
    return t.one("SELECT id, name, age, sex, allergies FROM patients WHERE id = ?", pid)


def load_visits(t: Tx, pid: str) -> list[dict]:
    visits = t.all("SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date", pid)
    meds = t.all(
        "SELECT m.visit_id, m.idx, m.data FROM medications m JOIN visits v ON v.id = m.visit_id WHERE v.patient_id = ? ORDER BY m.visit_id, m.idx",
        pid,
    )
    by_visit: dict[str, list] = {}
    for m in meds:
        by_visit.setdefault(m["visit_id"], []).append(loads(m["data"]))
    return [
        {
            "id": v["id"],
            "patientId": v["patient_id"],
            "date": v["visit_date"],
            "facility": v["facility"],
            "type": v["type"],
            "prescriber": v["prescriber"],
            "doc": {"title": v["doc_title"], "lines": loads(v["doc_lines"])},
            "meds": by_visit.get(v["id"], []),
        }
        for v in visits
    ]


def insert_visit(t: Tx, v: dict, upload_id: str | None, created_at: str):
    t.run(
        "INSERT INTO visits (id, patient_id, visit_date, facility, type, prescriber, doc_title, doc_lines, upload_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        v["id"], v["patientId"], v["date"], v["facility"], v["type"], v["prescriber"], v["doc"]["title"], dumps(v["doc"]["lines"]), upload_id, created_at,
    )
    for i, m in enumerate(v["meds"]):
        t.run("INSERT INTO medications (visit_id, idx, data) VALUES (?,?,?)", v["id"], i, dumps(m))


# ---------- tickets ----------
def ticket_row(t: Tx, tid: str) -> dict | None:
    return t.one("SELECT * FROM tickets WHERE id = ?", tid)


def ticket_public(r: dict, now: int | None = None) -> dict:
    now = now or now_ms()
    active = bool(r["claimed_by_id"]) and r["claim_expires_at"] > now
    return {
        "id": r["id"],
        "patientId": r["patient_id"],
        "patientName": r["patient_name"],
        "generic": r["generic"],
        "type": r["type"],
        "title": r["title"],
        "sources": loads(r["sources"]),
        "decisions": loads(r["decisions"]),
        "status": r["status"],
        "claimedBy": loads(r["claimed_by"]) if active else None,
        "claimExpiresAt": r["claim_expires_at"] if active else 0,
        "version": r["version"],
        "createdAt": r["created_at"],
        "history": loads(r["history"]),
        "resolution": loads(r["resolution"]),
    }


def insert_ticket(t: Tx, tid: str, d: dict) -> bool:
    """Returns False if a ticket with the same fingerprint already exists."""
    n = t.run(
        """INSERT INTO tickets (id, fingerprint, patient_id, patient_name, generic, type, title, sources, decisions,
                               status, version, created_at, history)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT (fingerprint) DO NOTHING""",
        tid, d["fingerprint"], d["patientId"], d["patientName"], d["generic"], d["type"], d["title"],
        dumps(d["sources"]), dumps(d["decisions"]), d.get("status", "open"), d["createdAt"], dumps(d["history"]),
    )
    return n == 1


# ---------- uploads ----------
def upload_public(r: dict, position: int | None = None) -> dict:
    return {
        "id": r["id"],
        "patientId": r["patient_id"],
        "fileName": r["file_name"],
        "size": r["size"],
        "sha256": r["sha256"],
        "contentType": r["content_type"],
        "docType": r["doc_type"],
        "facility": r["facility"],
        "visitDate": r["visit_date"],
        "uploadedBy": r["uploaded_by"],
        "status": r["status"],
        "position": position or 0,
        "createdAt": r["created_at"],
        "extracted": loads(r["extracted"]),
        "error": r["error"],
        "visitId": r["visit_id"],
    }


def queue_position(t: Tx, r: dict) -> int:
    if r["status"] != "queued":
        return 0
    return t.scalar("SELECT COUNT(*) AS n FROM uploads WHERE status = 'queued' AND queued_at < ?", r["queued_at"]) or 0
