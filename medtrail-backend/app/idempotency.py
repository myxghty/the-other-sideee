"""
Safe writes under retries, duplicates and races.

Every write runs through `run_write`:
  1. If the Idempotency-Key was already used, return the stored response (replay).
  2. Otherwise run the handler and store {key -> response} IN THE SAME TRANSACTION.
  3. If two identical requests race, the second INSERT of the key violates the primary key,
     its whole transaction (including its side effects) rolls back, and it replays the first.
So an action happens exactly once, whatever the client, network or organiser does.
"""
import hashlib
import json
import random
import time

from .db import dumps, get_db, loads, now_ms
from .errors import ApiError

REPLAY_HEADER = "Idempotent-Replayed"
_failed_once: set[str] = set()


def _request_hash(method: str, path: str, user_id: str, body) -> str:
    raw = json.dumps([method, path, user_id, body], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def run_write(*, key: str | None, method: str, path: str, user, body, handler, max_attempts: int = 5):
    """handler(tx) -> (status, payload). Returns (status, payload, extra_headers)."""
    db = get_db()
    if key is not None and (len(key) < 8 or len(key) > 200):
        raise ApiError(400, "BAD_IDEMPOTENCY_KEY", "Idempotency-Key must be 8-200 characters.")
    req_hash = _request_hash(method, path, user.id, body)

    def lookup():
        with db.read() as t:
            return t.one("SELECT * FROM idempotency_keys WHERE key = ?", key)

    def replay(row):
        if row["user_id"] != user.id or row["request_hash"] != req_hash:
            return 422, {"error": "IDEMPOTENCY_KEY_REUSED", "message": "This request key was already used for a different request."}, {}
        return row["status_code"], loads(row["response"]), {REPLAY_HEADER: "true"}

    if key:
        row = lookup()
        if row:
            return replay(row)

    for attempt in range(max_attempts):
        try:
            with db.tx() as t:
                status, payload = handler(t)
                if key and status < 500:
                    t.run(
                        "INSERT INTO idempotency_keys (key, user_id, request_hash, status_code, response, created_at) VALUES (?,?,?,?,?,?)",
                        key, user.id, req_hash, status, dumps(payload), now_ms(),
                    )
            return status, payload, {}
        except db.IntegrityError:
            # A concurrent duplicate committed first, or a unique constraint (fingerprint,
            # file hash, audit seq) was hit by a racing request. Replay or re-run on fresh data.
            if key:
                row = lookup()
                if row:
                    return replay(row)
        except db.RetryableError:
            pass
        time.sleep(random.uniform(0.005, 0.03) * (attempt + 1))
    raise ApiError(503, "BUSY_RETRY", "Too many people changed this at once. Please try again.", headers={"Retry-After": "1"})


def demo_fail_after_commit(request, key: str | None) -> bool:
    """Demo only: simulate a response lost after the server saved the work (once per key)."""
    from .config import settings

    if not settings.demo_mode or not request.headers.get("x-demo-drop-response") or not key:
        return False
    if key in _failed_once:
        return False
    _failed_once.add(key)
    return True


def cleanup(t, older_than_ms: int):
    t.run("DELETE FROM idempotency_keys WHERE created_at < ?", now_ms() - older_than_ms)
