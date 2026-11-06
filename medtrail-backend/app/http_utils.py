"""Small helpers shared by the route handlers."""
import json
import re

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse

from .db import get_db
from .errors import ApiError
from .idempotency import demo_fail_after_commit, run_write


async def read_json(request: Request):
    raw = await request.body()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(400, "BAD_JSON", "Request body is not valid JSON.") from exc


def if_match(request: Request) -> int | None:
    """If-Match: "3"  ->  3. The version the client last saw."""
    h = request.headers.get("if-match")
    if not h:
        return None
    m = re.search(r"\d+", h)
    if not m:
        raise ApiError(400, "BAD_IF_MATCH", 'If-Match must look like "3".')
    return int(m.group(0))


async def db_read(fn):
    def run():
        with get_db().read() as t:
            return fn(t)

    return await run_in_threadpool(run)


async def db_write(fn):
    """Write without idempotency (used by the storage PUT, which is idempotent by nature)."""

    def run():
        with get_db().tx() as t:
            return fn(t)

    return await run_in_threadpool(run)


async def write(request: Request, user, body, handler) -> JSONResponse:
    """Runs a write handler with Idempotency-Key support. handler(tx) -> (status, payload)."""
    key = request.headers.get("idempotency-key")
    status, payload, headers = await run_in_threadpool(
        run_write, key=key, method=request.method, path=request.url.path, user=user, body=body, handler=handler
    )
    if status < 300 and demo_fail_after_commit(request, key):
        # Demo: the work is saved, but the client "never hears back". Its retry gets the replay.
        return JSONResponse({"error": "GATEWAY_TIMEOUT", "message": "Response lost (simulated)."}, status_code=504)
    return JSONResponse(payload, status_code=status, headers=headers)


def ok_json(data, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status)
