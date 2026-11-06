"""
File storage behind short-lived signed upload URLs.

Local disk by default. In production swap `make_upload_url` / `save` / `path_for` for S3 or
Cloudflare R2 presigned PUT URLs so files go straight to storage, not through the API servers.
"""
import hashlib
import hmac
import time
from pathlib import Path

from .config import settings

URL_TTL_S = 15 * 60


def _sign(upload_id: str, expires: int) -> str:
    msg = f"{upload_id}:{expires}".encode()
    return hmac.new(settings.signing_secret.encode(), msg, hashlib.sha256).hexdigest()[:32]


def make_upload_url(upload_id: str) -> str:
    expires = int(time.time()) + URL_TTL_S
    return f"/api/storage/{upload_id}?expires={expires}&sig={_sign(upload_id, expires)}"


def check_signature(upload_id: str, expires: str, sig: str) -> bool:
    try:
        exp = int(expires)
    except (TypeError, ValueError):
        return False
    if exp < time.time():
        return False
    return hmac.compare_digest(_sign(upload_id, exp), sig or "")


def path_for(upload_id: str) -> Path:
    root = Path(settings.storage_dir)
    root.mkdir(parents=True, exist_ok=True)
    safe = "".join(c for c in upload_id if c.isalnum() or c in "-_")
    return root / safe


def save(upload_id: str, data: bytes) -> Path:
    p = path_for(upload_id)
    tmp = p.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(p)  # atomic: a retried PUT never leaves a half-written file
    return p
