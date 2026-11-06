"""
"3x patients on 1/2 resources" check against a running API (stdlib only).

  # Normal: 24 slots.  Half resources: start the API with MAX_CONCURRENCY=12, or use --demo-switch.
  python scripts/load_test.py --url http://localhost:8000 --users 60 --seconds 20 [--demo-switch]

Simulates many patients and staff at once with a realistic mix:
  40% patient view (critical), 30% comparison (normal), 30% queue polling (low).
Clients retry 429/503 after Retry-After, like the real frontend.
Reports success rate and latency per priority class.
"""
import argparse
import json
import random
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict

MIX = [
    ("critical", "/api/patients/SYN-20481/patient-view", 0.4),
    ("normal", "/api/patients/SYN-20481/compare?a=v-aug&b=v-oct", 0.3),
    ("low", "/api/tickets?status=active", 0.3),
]
USERS = ["u-iyer", "u-shah", "u-rao"] + [f"sim-{i}" for i in range(1, 6)]


def get(base, path, user):
    req = urllib.request.Request(base + path, headers={"X-Demo-User": user})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
            return r.status, None
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Retry-After")
    except Exception:
        return 0, None


def worker(base, deadline, stats, lock):
    user = random.choice(USERS)
    while time.time() < deadline:
        cls, path, _ = random.choices(MIX, weights=[w for *_, w in MIX])[0]
        start = time.time()
        attempts = 0
        while True:
            attempts += 1
            status, retry_after = get(base, path, user)
            if status in (429, 503) and attempts <= 3:
                time.sleep(float(retry_after or 1) + random.random() * 0.5)
                continue
            break
        with lock:
            s = stats[cls]
            s["n"] += 1
            s["ok"] += status == 200
            s["retried"] += status == 200 and attempts > 1
            s["lat"].append(time.time() - start)
        time.sleep(random.uniform(0.05, 0.3))  # think time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--users", type=int, default=60)
    ap.add_argument("--seconds", type=int, default=20)
    ap.add_argument("--demo-switch", action="store_true", help="turn on the API's 3x/half-capacity simulation during the run")
    args = ap.parse_args()
    base = args.url.rstrip("/")

    def set_high(v):
        req = urllib.request.Request(base + "/api/__demo/settings", data=json.dumps({"highLoad": v}).encode(), method="PUT",
                                     headers={"X-Demo-User": "u-iyer", "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()

    if args.demo_switch:
        set_high(True)
    stats = defaultdict(lambda: {"n": 0, "ok": 0, "retried": 0, "lat": []})
    lock = threading.Lock()
    deadline = time.time() + args.seconds
    threads = [threading.Thread(target=worker, args=(base, deadline, stats, lock)) for _ in range(args.users)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        if args.demo_switch:
            set_high(False)

    print(f"{args.users} concurrent users for {args.seconds}s{' (3x / half-capacity simulation ON)' if args.demo_switch else ''}")
    print(f"{'class':10} {'requests':>9} {'success':>8} {'after retry':>12} {'p50 ms':>8} {'p95 ms':>8}")
    for cls, *_ in MIX:
        s = stats[cls]
        lat = sorted(s["lat"]) or [0]
        p = lambda q: int(lat[min(len(lat) - 1, int(q * len(lat)))] * 1000)  # noqa: E731
        print(f"{cls:10} {s['n']:>9} {100 * s['ok'] / max(1, s['n']):>7.1f}% {s['retried']:>12} {p(0.5):>8} {p(0.95):>8}")


if __name__ == "__main__":
    main()
