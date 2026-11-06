"""
Append-only, hash-chained audit log.
Each entry stores the hash of the previous one, so editing any past entry breaks every
link after it. The frontend re-computes the same hashes to show "chain verified".
"""
import hashlib
from datetime import datetime, timezone

from .db import Tx


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def audit_hash(e: dict) -> str:
    # Must match src/lib/hash.js in the frontend exactly.
    payload = "|".join(
        [e["prevHash"], str(e["seq"]), e["at"], e["actor"], e["role"], e["action"], e.get("target") or "", e.get("detail") or ""]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def append(t: Tx, actor, action: str, target: str, detail: str, at: str | None = None) -> dict:
    if t.is_pg:
        # Serialise appends across all API instances for this transaction only.
        t.one("SELECT pg_advisory_xact_lock(724301)")
    last = t.one("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
    e = {
        "seq": (last["seq"] if last else 0) + 1,
        "at": at or now_iso(),
        "actor": actor.name,
        "role": actor.role,
        "action": action,
        "target": target,
        "detail": detail,
        "prevHash": last["hash"] if last else "GENESIS",
    }
    e["hash"] = audit_hash(e)
    t.run(
        "INSERT INTO audit_log (seq, at, actor, role, action, target, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)",
        e["seq"], e["at"], e["actor"], e["role"], e["action"], e["target"], e["detail"], e["prevHash"], e["hash"],
    )
    return e


def row_to_entry(r: dict) -> dict:
    return {
        "seq": r["seq"],
        "at": r["at"],
        "actor": r["actor"],
        "role": r["role"],
        "action": r["action"],
        "target": r["target"],
        "detail": r["detail"],
        "prevHash": r["prev_hash"],
        "hash": r["hash"],
    }


def verify(t: Tx) -> dict:
    """Server-side check of the whole chain."""
    prev = "GENESIS"
    checked = 0
    for r in t.all("SELECT * FROM audit_log ORDER BY seq"):
        e = row_to_entry(r)
        if e["prevHash"] != prev or audit_hash(e) != e["hash"]:
            return {"ok": False, "brokenAt": e["seq"], "checked": checked}
        prev = e["hash"]
        checked += 1
    return {"ok": True, "checked": checked}
