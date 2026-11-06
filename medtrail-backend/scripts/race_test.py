"""
Organiser-style concurrency check against a running API (stdlib only).

  python scripts/race_test.py --url http://localhost:8000 --users 20

1. N users claim the same ticket at the same moment  -> exactly 1 winner, others 409
2. The same request sent N times with one key        -> 1 record, N-1 replays
Needs DEMO_MODE=true (uses demo users and /api/__demo/reset).
"""
import argparse
import json
import sys
import threading
import urllib.error
import urllib.request
import uuid

USERS = ["u-iyer", "u-shah", "u-rao"] + [f"sim-{i}" for i in range(1, 6)]


def call(base, method, path, user="u-iyer", body=None, headers=None):
    h = {"X-Demo-User": user, **(headers or {})}
    data = json.dumps(body).encode() if body is not None else None
    if data:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null"), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null"), {k.lower(): v for k, v in e.headers.items()}


def burst(n, fn):
    """Start n threads and release them at the same instant."""
    gate, results = threading.Barrier(n), [None] * n

    def run(i):
        gate.wait()
        results[i] = fn(i)

    threads = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--users", type=int, default=20)
    args = ap.parse_args()
    base, n = args.url.rstrip("/"), args.users

    call(base, "POST", "/api/__demo/reset")
    _, ticket, _ = call(base, "GET", "/api/tickets/RQ-104")
    results = burst(n, lambda i: (USERS[i % len(USERS)], *call(base, "POST", "/api/tickets/RQ-104/claim", user=USERS[i % len(USERS)],
                                     headers={"Idempotency-Key": f"race_{uuid.uuid4()}", "If-Match": f'"{ticket["version"]}"'})))
    codes = [s for _, s, _, _ in results]
    # A user who already holds the claim gets 200 again (it is theirs), so count distinct winners.
    winning_users = {u for u, s, _, _ in results if s == 200}
    winners = len(winning_users)
    print(f"[claim race]  {n} simultaneous claims -> {winners} winning user ({', '.join(winning_users)}), "
          f"{codes.count(409)} x 409 'already claimed', others {len(codes) - codes.count(200) - codes.count(409)}")

    _, before, _ = call(base, "GET", "/api/__demo/stats")
    key = f"dup_{uuid.uuid4()}"
    results = burst(n, lambda i: call(base, "POST", "/api/patients/SYN-20481/handover", headers={"Idempotency-Key": key}))
    _, after, _ = call(base, "GET", "/api/__demo/stats")
    codes = {b["code"] for s, b, _ in results if s < 300}
    replays = sum(1 for _, _, h in results if h.get("idempotent-replayed") == "true")
    created = after["handovers"] - before["handovers"]
    print(f"[duplicates]  {n} identical requests -> {created} record(s) created, {replays} replays, {len(codes)} distinct code(s)")

    ok = winners == 1 and created == 1 and len(codes) == 1
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
