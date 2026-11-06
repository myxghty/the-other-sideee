import hashlib
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

PID = "SYN-20481"


def key():
    return f"test_{uuid.uuid4()}"


def stats(c):
    return c.call("GET", "/api/__demo/stats")[1]


# ------------------------------------------------------------------ basics & access
def test_health_and_auth(client):
    assert client.call("GET", "/api/health")[0] == 200
    assert client.call("GET", f"/api/patients/{PID}", user="nobody")[0] == 401
    status, body, _ = client.call("GET", "/api/tickets", user="u-arun")
    assert status == 403 and body["error"] == "FORBIDDEN"
    # A patient can see their own view, not someone else's.
    assert client.call("GET", f"/api/patients/{PID}/patient-view", user="u-arun")[0] == 200
    assert client.call("GET", "/api/patients/SYN-19877/patient-view", user="u-arun")[0] == 403


def test_comparison_flags_every_kind(fresh):
    status, cmp, _ = fresh.call("GET", f"/api/patients/{PID}/compare?a=v-aug&b=v-oct")
    assert status == 200
    assert cmp["summary"] == {"conflict": 2, "unchanged": 2, "missing": 1, "new": 1, "missing_field": 1, "outdated": 1}
    metformin = next(r for r in cmp["rows"] if r["generic"] == "metformin")
    assert metformin["flags"][0]["fields"] == ["strength"]
    # Values stay linked to their exact source line.
    assert cmp["visitB"]["doc"]["lines"][metformin["b"]["line"]] == "1) Tab Metformin 1000mg 1-0-1 A/F"


# ------------------------------------------------------------------ duplicates & retries
def test_flags_sent_twice_create_tickets_once(fresh):
    s1, b1, _ = fresh.call("POST", f"/api/patients/{PID}/flags", body={"a": "v-aug", "b": "v-oct"}, headers={"Idempotency-Key": key()})
    s2, b2, _ = fresh.call("POST", f"/api/patients/{PID}/flags", body={"a": "v-aug", "b": "v-oct"}, headers={"Idempotency-Key": key()})
    assert s1 == 201 and len(b1["created"]) == 3 and len(b1["existing"]) == 2
    assert s2 == 200 and b2["created"] == [] and len(b2["existing"]) == 5


def test_same_key_sent_concurrently_happens_once(fresh):
    before = stats(fresh)["handovers"]
    k = key()
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda _: fresh.call("POST", f"/api/patients/{PID}/handover", headers={"Idempotency-Key": k}), range(8)))
    codes = {b["code"] for s, b, _ in results}
    replays = sum(1 for _, _, h in results if h.get("idempotent-replayed") == "true")
    assert len(codes) == 1 and replays == 7
    assert stats(fresh)["handovers"] == before + 1


def test_key_reused_for_different_request_is_rejected(fresh):
    k = key()
    assert fresh.call("POST", f"/api/patients/{PID}/flags", body={"a": "v-aug", "b": "v-oct"}, headers={"Idempotency-Key": k})[0] in (200, 201)
    s, b, _ = fresh.call("POST", f"/api/patients/{PID}/flags", body={"a": "v-jan", "b": "v-oct"}, headers={"Idempotency-Key": k})
    assert s == 422 and b["error"] == "IDEMPOTENCY_KEY_REUSED"


def test_lost_response_then_retry_replays(fresh):
    before = stats(fresh)["handovers"]
    k = key()
    s1, _, _ = fresh.call("POST", f"/api/patients/{PID}/handover", headers={"Idempotency-Key": k, "X-Demo-Drop-Response": "1"})
    s2, b2, h2 = fresh.call("POST", f"/api/patients/{PID}/handover", headers={"Idempotency-Key": k, "X-Demo-Drop-Response": "1"})
    assert s1 == 504 and s2 == 201 and h2.get("idempotent-replayed") == "true" and b2["code"].startswith("MT-")
    assert stats(fresh)["handovers"] == before + 1


# ------------------------------------------------------------------ simultaneous claims
def test_ten_simultaneous_claims_have_one_winner(fresh):
    _, t, _ = fresh.call("GET", "/api/tickets/RQ-104")
    users = ["u-iyer", "u-shah", "u-rao"] + [f"sim-{i}" for i in range(1, 6)] + ["u-iyer", "u-shah"]

    def claim(u):
        return u, *fresh.call("POST", "/api/tickets/RQ-104/claim", user=u,
                              headers={"Idempotency-Key": key(), "If-Match": f'"{t["version"]}"'})

    with ThreadPoolExecutor(len(users)) as ex:
        results = list(ex.map(claim, users))
    winners = {u for u, s, _, _ in results if s == 200}
    assert len(winners) == 1
    winner = winners.pop()
    for u, s, body, _ in results:
        if u != winner:
            assert s == 409 and body["error"] == "ALREADY_CLAIMED"
    _, after, _ = fresh.call("GET", "/api/tickets/RQ-104")
    assert after["version"] == t["version"] + 1 and after["claimedBy"]["id"] == winner


def test_stale_version_gets_412(fresh):
    s, b, _ = fresh.call("POST", "/api/tickets/RQ-109/claim", headers={"Idempotency-Key": key(), "If-Match": '"99"'})
    assert s == 412 and b["error"] == "VERSION_MISMATCH" and b["ticket"]["version"] == 1


def test_resolve_flow_double_submit_and_patient_view(fresh):
    _, t, _ = fresh.call("GET", "/api/tickets/RQ-113")
    s, t, _ = fresh.call("POST", "/api/tickets/RQ-113/claim", headers={"Idempotency-Key": key(), "If-Match": f'"{t["version"]}"'})
    assert s == 200
    # Someone else cannot resolve it.
    s, b, _ = fresh.call("POST", "/api/tickets/RQ-113/resolve", user="u-shah",
                         body={"decision": "confirm_b", "note": "Trying without the claim"}, headers={"Idempotency-Key": key()})
    assert s == 409 and b["error"] == "ALREADY_CLAIMED"
    # Double submit with the same key: one resolution, one audit entry.
    k = key()
    body = {"decision": "confirm_b", "note": "Confirmed with Dr. P. Rao by phone."}
    h = {"Idempotency-Key": k, "If-Match": f'"{t["version"]}"'}
    with ThreadPoolExecutor(2) as ex:
        r1, r2 = list(ex.map(lambda _: fresh.call("POST", "/api/tickets/RQ-113/resolve", body=body, headers=h), range(2)))
    assert r1[0] == 200 and r2[0] == 200 and r1[1]["version"] == r2[1]["version"]
    _, entries, _ = fresh.call("GET", "/api/audit?limit=50")
    assert sum(1 for e in entries["items"] if e["action"] == "TICKET_RESOLVED" and e["target"] == "RQ-113") == 1
    # The patient now sees the verified instruction, exactly as written.
    _, view, _ = fresh.call("GET", f"/api/patients/{PID}/patient-view", user="u-arun")
    met = next(i for i in view["items"] if i["generic"] == "metformin")
    assert met["status"] == "verified" and met["asWritten"] == "Tab Metformin 1000mg 1-0-1 A/F" and met["verifiedBy"] == "R. Iyer"
    # The audit hash chain is intact.
    assert fresh.call("GET", "/api/audit/verify")[1]["ok"] is True


# ------------------------------------------------------------------ uploads & extraction
def _upload(c, content: bytes, name="rx.txt", ctype="text/plain", **meta):
    sha = hashlib.sha256(content).hexdigest()
    s, created, _ = c.call("POST", "/api/uploads", body={"patientId": PID, "fileName": name, "size": len(content), "sha256": sha,
                                                         "contentType": ctype, "docType": "Prescription", **meta},
                          headers={"Idempotency-Key": key()})
    return s, created


def test_upload_extracts_meds_into_a_new_visit(fresh):
    doc = "\n".join([
        "Lakeside Clinic - OPD", "05 Nov 2026 · Dr. N. Varma", "Rx",
        "1) Tab Metformin 1000mg 1-0-1 A/F", "2) Tab Telma 40mg OD morning", "3) Cap Amoxicillin 500mg TDS",
    ]).encode()
    s, created = _upload(fresh, doc, facility="Lakeside Clinic", visitDate="2026-11-05")
    assert s == 201 and created["duplicate"] is False
    uid = created["upload"]["id"]
    assert fresh.call("PUT", created["uploadUrl"], raw=doc, headers={"Content-Type": "text/plain"})[0] == 200
    assert fresh.call("POST", f"/api/uploads/{uid}/complete", headers={"Idempotency-Key": f"complete_{uid}"})[0] == 202
    for _ in range(60):
        _, u, _ = fresh.call("GET", f"/api/uploads/{uid}")
        if u["status"] in ("extracted", "failed"):
            break
        time.sleep(0.2)
    assert u["status"] == "extracted", u
    meds = {m["generic"]: m for m in u["extracted"]["medications"]}
    assert meds["metformin"]["strength"] == "1000 mg" and meds["metformin"]["line"] == 3
    assert meds["telmisartan"]["frequency"] == "1-0-0"
    assert meds["amoxicillin"]["frequency"] == "1-1-1" and meds["amoxicillin"]["duration"] is None  # never invented
    assert u["extracted"]["prescriber"] == "Dr. N. Varma"
    _, visits, _ = fresh.call("GET", f"/api/patients/{PID}/visits")
    assert visits["items"][0]["id"] == u["visitId"] and visits["items"][0]["facility"] == "Lakeside Clinic"
    # Same file again (any key, any user): recognised, not duplicated.
    s2, again = _upload(fresh, doc, facility="Lakeside Clinic", visitDate="2026-11-05")
    assert s2 == 200 and again["duplicate"] is True and again["upload"]["id"] == uid


def test_upload_rejects_wrong_file(fresh):
    s, created = _upload(fresh, b"what was announced")
    s, b, _ = fresh.call("PUT", created["uploadUrl"], raw=b"something else", headers={"Content-Type": "text/plain"})
    assert s == 422 and b["error"] == "HASH_MISMATCH"
    tampered = created["uploadUrl"].replace("sig=", "sig=0")
    assert fresh.call("PUT", tampered, raw=b"what was announced")[0] == 403


# ------------------------------------------------------------------ 3x load on half capacity
def test_overload_protects_patient_view(fresh):
    assert fresh.call("PUT", "/api/__demo/settings", body={"highLoad": True})[0] == 200
    try:
        paths = [("critical", f"/api/patients/{PID}/patient-view")] * 20 + \
                [("normal", f"/api/patients/{PID}/compare?a=v-aug&b=v-oct")] * 20 + \
                [("low", "/api/tickets?status=active")] * 20

        def hit(p):
            return p[0], fresh.call("GET", p[1])

        with ThreadPoolExecutor(60) as ex:
            results = list(ex.map(hit, paths))
        served = {k: sum(1 for c, (s, _, _) in results if c == k and s == 200) for k in ("critical", "normal", "low")}
        refused = [h for _, (s, _, h) in results if s in (429, 503)]
        assert served["critical"] == 20, served
        assert served["low"] < 20 and refused, served
        assert all(h.get("retry-after") and h.get("x-load-level") == "high" for h in refused)
    finally:
        fresh.call("PUT", "/api/__demo/settings", body={"highLoad": False})
