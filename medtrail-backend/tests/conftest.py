"""Starts the real API (uvicorn) on a free port with a throwaway SQLite database."""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

_TMP = tempfile.mkdtemp(prefix="medtrail-test-")
os.environ.update({
    "DATABASE_URL": os.environ.get("TEST_DATABASE_URL", f"sqlite:///{_TMP}/test.db"),
    "STORAGE_DIR": f"{_TMP}/storage",
    "DEMO_MODE": "true",
    "AUTH_MODE": "demo",
    "MAX_CONCURRENCY": "24",
    "USER_BURST": "2000",
    "USER_RATE_PER_SEC": "2000",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def base_url():
    import uvicorn

    from app.main import app

    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=5)


class Client:
    def __init__(self, base):
        self.base = base

    def call(self, method, path, user="u-iyer", body=None, headers=None, raw=None):
        h = {"X-Demo-User": user, **(headers or {})}
        data = None
        if raw is not None:
            data = raw
        elif body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                payload = r.read()
                return r.status, (json.loads(payload) if payload else None), {k.lower(): v for k, v in r.headers.items()}
        except urllib.error.HTTPError as e:
            payload = e.read()
            return e.code, (json.loads(payload) if payload else None), {k.lower(): v for k, v in e.headers.items()}


@pytest.fixture(scope="session")
def client(base_url):
    return Client(base_url)


@pytest.fixture()
def fresh(client):
    status, _, _ = client.call("POST", "/api/__demo/reset")
    assert status == 200
    return client
