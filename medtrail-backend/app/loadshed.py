"""
Overload protection (constraint: 3x patients on 1/2 the resources).

Every API request gets a priority. When the server is full, work is refused in this order:
  low      background polling (queue refresh, audit, upload status)   -> refused first
  normal   comparisons, uploads
  high     pharmacist actions (claim, resolve)
  critical patient medication view and handover                       -> never refused, waits
Refusals are cheap 429s with Retry-After, so clients back off instead of piling up.
Every response carries X-Load-Level so the frontend can slow its own polling.

Also: a per-user token bucket stops one client from starving everyone else.
This is per process; with several instances, each protects itself (add Redis for a
global limit if needed).
"""
import asyncio
import json
import random
import time

from .config import settings

SHARE = {"critical": 1.0, "high": 1.0, "normal": 0.75, "low": 0.5}
WAIT_BUDGET_S = {"critical": 6.0, "high": 2.0, "normal": 0.4, "low": 0.0}
RETRY_AFTER = {"critical": 1, "high": 1, "normal": 2, "low": 4}
# Demo "3x traffic": share of each class taken by simulated other users.
DEMO_BACKGROUND_SHED = {"critical": 0.0, "high": 0.05, "normal": 0.2, "low": 0.4}


def classify(method: str, path: str) -> str:
    if path.endswith("/patient-view") or path.endswith("/handover") or path.startswith("/api/handover/"):
        return "critical"
    if method != "GET" and path.startswith("/api/tickets/"):
        return "high"
    if method == "GET" and path.startswith("/api/tickets/"):
        return "high"
    if method == "GET" and (path == "/api/tickets" or path.startswith("/api/audit") or path.startswith("/api/uploads")):
        return "low"
    return "normal"


class TokenBucket:
    __slots__ = ("tokens", "updated")

    def __init__(self, burst):
        self.tokens = float(burst)
        self.updated = time.monotonic()

    def take(self, rate, burst) -> bool:
        now = time.monotonic()
        self.tokens = min(burst, self.tokens + (now - self.updated) * rate)
        self.updated = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


class DemoLoadState:
    """Shared overload switch for the demo (stored in DB so every instance sees it)."""

    high_load = False
    _checked = 0.0

    @classmethod
    async def refresh(cls):
        if not settings.demo_mode or time.monotonic() - cls._checked < 2:
            return
        cls._checked = time.monotonic()
        from starlette.concurrency import run_in_threadpool

        from .db import get_db

        def read():
            with get_db().read() as t:
                row = t.one("SELECT value FROM demo_settings WHERE name = 'highLoad'")
                return bool(json.loads(row["value"])) if row else False

        try:
            cls.high_load = await run_in_threadpool(read)
        except Exception:
            pass

    @classmethod
    def set(cls, value: bool):
        cls.high_load = value
        cls._checked = time.monotonic()


class LoadShedMiddleware:
    def __init__(self, app):
        self.app = app
        self.in_flight = 0
        self.cond: asyncio.Condition | None = None
        self.last_shed = 0.0
        self.buckets: dict[str, TokenBucket] = {}

    def capacity(self) -> int:
        cap = settings.max_concurrency
        # Demo: half the servers.
        return max(2, cap // 2) if DemoLoadState.high_load else cap

    def level(self) -> str:
        if DemoLoadState.high_load or time.monotonic() - self.last_shed < 30:
            return "high"
        return "high" if self.in_flight >= 0.75 * self.capacity() else "normal"

    async def _acquire(self, priority: str) -> bool:
        if self.cond is None:
            self.cond = asyncio.Condition()
        allowed = max(1, int(self.capacity() * SHARE[priority]))
        deadline = time.monotonic() + WAIT_BUDGET_S[priority]
        async with self.cond:
            while self.in_flight >= allowed:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                try:
                    await asyncio.wait_for(self.cond.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    return False
            self.in_flight += 1
            return True

    async def _release(self):
        async with self.cond:
            self.in_flight -= 1
            self.cond.notify_all()

    async def _reject(self, send, status, code, message, retry_after):
        self.last_shed = time.monotonic()
        body = json.dumps({"error": code, "message": message}).encode()
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"retry-after", str(retry_after).encode()),
                (b"x-load-level", b"high"),
            ],
        })
        await send({"type": "http.response.body", "body": body})

    def _client_key(self, scope) -> str:
        headers = dict(scope.get("headers") or [])
        who = headers.get(b"authorization") or headers.get(b"x-demo-user")
        if who:
            return who.decode(errors="ignore")[-64:]
        client = scope.get("client") or ("anon", 0)
        return client[0]

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/") or path in ("/api/health",) or path.startswith("/api/__demo/"):
            return await self.app(scope, receive, send)

        await DemoLoadState.refresh()
        priority = classify(scope["method"], path)

        key = self._client_key(scope)
        bucket = self.buckets.get(key)
        if bucket is None:
            if len(self.buckets) > 50_000:
                self.buckets.clear()
            bucket = self.buckets[key] = TokenBucket(settings.user_burst)
        if not bucket.take(settings.user_rate_per_sec, settings.user_burst):
            return await self._reject(send, 429, "RATE_LIMITED", "Too many requests from you. Please slow down.", 1)

        if DemoLoadState.high_load and random.random() < DEMO_BACKGROUND_SHED[priority]:
            await asyncio.sleep(0.04)
            return await self._reject(send, 429, "OVERLOADED", "Server busy. Please retry shortly.", RETRY_AFTER[priority])

        if not await self._acquire(priority):
            return await self._reject(send, 429 if priority == "low" else 503, "OVERLOADED", "Server busy. Please retry shortly.", RETRY_AFTER[priority])

        level = self.level().encode()

        async def send_with_level(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [(b"x-load-level", level)]
            await send(message)

        try:
            if DemoLoadState.high_load:
                # Half the CPU: every request takes longer.
                await asyncio.sleep(random.uniform(0.15, 0.45))
            await self.app(scope, receive, send_with_level)
        finally:
            await self._release()
