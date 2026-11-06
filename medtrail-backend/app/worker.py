"""
Extraction worker: takes uploaded documents from the queue, extracts text, parses medicines
and stores them as a new visit linked to the source document.

The queue lives in the database (no extra service). Jobs are claimed atomically:
  PostgreSQL: SELECT ... FOR UPDATE SKIP LOCKED  (many workers, no double processing)
  SQLite:     the write lock serialises claims
Run in-process (RUN_WORKER_IN_PROCESS=true) or as its own process:  python -m app.worker
Under overload the queue simply grows; the API stays responsive and nothing is lost.
"""
import logging
import threading
import time
from datetime import date

from . import audit
from .auth import SYSTEM
from .config import settings
from .db import dumps, get_db, now_ms
from .extraction.ocr import ExtractionError, extract_lines
from .extraction.parse import parse_document
from .idempotency import cleanup
from .repo import insert_visit

log = logging.getLogger("medtrail.worker")
STUCK_AFTER_MS = 5 * 60 * 1000
MAX_ATTEMPTS = 3
wake = threading.Event()


def claim_next():
    db = get_db()
    with db.tx() as t:
        lock = " FOR UPDATE SKIP LOCKED" if t.is_pg else ""
        row = t.one(
            "SELECT * FROM uploads WHERE (status = 'queued') OR (status = 'processing' AND started_at < ? AND attempts < ?) "
            "ORDER BY queued_at LIMIT 1" + lock,
            now_ms() - STUCK_AFTER_MS, MAX_ATTEMPTS,
        )
        if not row:
            return None
        n = t.run(
            "UPDATE uploads SET status = 'processing', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = ?",
            now_ms(), row["id"], row["status"],
        )
        return row if n == 1 else None


def process(row: dict):
    db = get_db()
    try:
        lines, method = extract_lines(row["storage_path"], row["content_type"], row["file_name"] or "")
        parsed = parse_document(lines)
    except ExtractionError as exc:
        with db.tx() as t:
            t.run("UPDATE uploads SET status = 'failed', error = ? WHERE id = ?", str(exc), row["id"])
            audit.append(t, SYSTEM, "EXTRACTION_FAILED", row["id"], str(exc))
        return
    except Exception as exc:  # unexpected: retry later, up to MAX_ATTEMPTS
        log.exception("extraction crashed for %s", row["id"])
        status = "failed" if row["attempts"] + 1 >= MAX_ATTEMPTS else "queued"
        with db.tx() as t:
            t.run("UPDATE uploads SET status = ?, error = ? WHERE id = ?", status, f"Extraction error: {exc}", row["id"])
        return

    meds = parsed["medications"]
    text_lines = [t for t, _ in lines]
    needs_check = sum(1 for m in meds if m["needsCheck"])
    extracted = {
        "method": method,
        "note": {
            "pdf-text": "Read from the PDF's text layer.",
            "ocr": "Read with OCR. Check values marked for human review against the original.",
            "text": "Read from a text document.",
        }[method],
        "lines": text_lines,
        "medications": meds,
        "prescriber": parsed["prescriber"],
    }
    with db.tx() as t:
        current = t.one("SELECT status FROM uploads WHERE id = ?", row["id"])
        if not current or current["status"] != "processing":
            return  # another worker finished it
        visit_id = None
        if meds:
            visit_id = f"v-{row['id'].lower()}"
            insert_visit(t, {
                "id": visit_id,
                "patientId": row["patient_id"],
                "date": row["visit_date"] or date.today().isoformat(),
                "facility": row["facility"] or "Unknown facility",
                "type": row["doc_type"] or "Prescription",
                "prescriber": parsed["prescriber"] or "—",
                "doc": {"title": row["file_name"], "lines": text_lines},
                "meds": [{k: v for k, v in m.items() if k != "needsCheck"} for m in meds],
            }, row["id"], audit.now_iso())
        t.run(
            "UPDATE uploads SET status = 'extracted', extracted = ?, visit_id = ?, error = NULL WHERE id = ?",
            dumps(extracted), visit_id, row["id"],
        )
        audit.append(
            t, SYSTEM, "VALUES_EXTRACTED", row["id"],
            f"{row['file_name']}: {len(meds)} medicines extracted, {needs_check} need human check",
        )


def run_once() -> bool:
    row = claim_next()
    if not row:
        return False
    process(row)
    return True


def loop(stop: threading.Event):
    last_cleanup = 0.0
    while not stop.is_set():
        try:
            busy = run_once()
            if time.time() - last_cleanup > 3600:
                with get_db().tx() as t:
                    cleanup(t, settings.idempotency_ttl_ms)
                last_cleanup = time.time()
        except Exception:
            log.exception("worker loop error")
            busy = False
        if not busy:
            wake.wait(1.0)
            wake.clear()


def start_in_background() -> threading.Event:
    stop = threading.Event()
    threading.Thread(target=loop, args=(stop,), name="extraction-worker", daemon=True).start()
    return stop


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    get_db().migrate()
    log.info("extraction worker started")
    loop(threading.Event())
