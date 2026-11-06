"""
Comparison engine. It only DESCRIBES differences between records.
It never decides which value is correct; that is a pharmacist's or clinician's job.
"""
from datetime import date

FIELDS = ["strength", "frequency", "timing", "route"]
FIELD_LABEL = {"strength": "Strength", "frequency": "Timing", "timing": "Food instruction", "route": "Route"}
OUTDATED_AFTER_DAYS = 180

FLAG_META = {
    "conflict": {"label": "Conflict", "ticket": True},
    "missing": {"label": "Missing in newer visit", "ticket": True},
    "outdated": {"label": "Outdated", "ticket": True},
    "missing_field": {"label": "Missing field", "ticket": True},
    "new": {"label": "New in newer visit", "ticket": False},
    "unchanged": {"label": "No change", "ticket": False},
}


def _norm(v) -> str:
    return "".join(str(v).lower().split())


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:]


def describe_med(m: dict | None) -> str | None:
    if not m:
        return None
    return ", ".join(x for x in [m.get("strength"), m.get("frequency"), m.get("timing"), m.get("duration")] if x)


def fmt_date(d: str) -> str:
    return date.fromisoformat(d).strftime("%d %b %Y")


def visit_summary(v: dict) -> dict:
    return {k: v[k] for k in ("id", "date", "facility", "type", "prescriber", "doc")}


def compare_visits(visits: list[dict], pid: str, a_id: str, b_id: str) -> dict | None:
    pv = [v for v in visits if v["patientId"] == pid]
    A = next((v for v in pv if v["id"] == a_id), None)
    B = next((v for v in pv if v["id"] == b_id), None)
    if not A or not B or A["id"] == B["id"]:
        return None
    if A["date"] > B["date"]:
        A, B = B, A  # A is always the older visit

    seen, order = set(), []
    for m in A["meds"] + B["meds"]:
        if m["generic"] not in seen:
            seen.add(m["generic"])
            order.append(m["generic"])

    rows = []
    for g in order:
        a = next((m for m in A["meds"] if m["generic"] == g), None)
        b = next((m for m in B["meds"] if m["generic"] == g), None)
        flags = []
        if a and b:
            diffs = [f for f in FIELDS if a.get(f) and b.get(f) and _norm(a[f]) != _norm(b[f])]
            if diffs:
                label = " and ".join(FIELD_LABEL[f] for f in diffs) + (" differs" if len(diffs) == 1 else " differ")
                flags.append({"type": "conflict", "fields": diffs, "label": label})
        elif a:
            flags.append({"type": "missing", "label": "Not listed in newer visit"})
        else:
            flags.append({"type": "new", "label": "First listed in newer visit"})
        if b and b.get("durationRequired") and not b.get("duration"):
            flags.append({"type": "missing_field", "fields": ["duration"], "label": "Duration not written"})
        if not flags:
            flags.append({"type": "unchanged", "label": "No change"})
        rows.append({"generic": g, "display": (b or a)["display"], "a": a, "b": b, "history": None, "flags": flags})

    # Outdated: only in older records, last recorded long before the newer visit.
    older = sorted((v for v in pv if v["date"] < A["date"]), key=lambda v: v["date"], reverse=True)
    last_seen = {}
    for v in older:
        for m in v["meds"]:
            if m["generic"] not in seen and m["generic"] not in last_seen:
                last_seen[m["generic"]] = (v, m)
    for g, (v, m) in last_seen.items():
        days = (date.fromisoformat(B["date"]) - date.fromisoformat(v["date"])).days
        if days < OUTDATED_AFTER_DAYS:
            continue
        months = round(days / 30.4)
        rows.append({
            "generic": g,
            "display": m["display"],
            "a": None,
            "b": None,
            "history": {"visit": visit_summary(v), "med": m},
            "flags": [{"type": "outdated", "label": f"Last recorded {fmt_date(v['date'])}, {months} months before the newer visit"}],
        })

    # Fingerprint = "the same discrepancy", so it becomes exactly one ticket.
    for r in rows:
        for f in r["flags"]:
            if FLAG_META[f["type"]]["ticket"]:
                f["fingerprint"] = "|".join([
                    pid, r["generic"], f["type"],
                    describe_med(r["a"]) or describe_med((r["history"] or {}).get("med")) or "-",
                    describe_med(r["b"]) or "-",
                ])

    summary = {}
    for r in rows:
        for f in r["flags"]:
            summary[f["type"]] = summary.get(f["type"], 0) + 1
    return {"patientId": pid, "visitA": visit_summary(A), "visitB": visit_summary(B), "rows": rows, "summary": summary}


def _source(label: str, visit: dict, med: dict) -> dict:
    return {
        "label": label,
        "visitId": visit["id"],
        "facility": visit["facility"],
        "date": visit["date"],
        "type": visit["type"],
        "prescriber": visit["prescriber"],
        "docTitle": visit["doc"]["title"],
        "line": med["line"],
        "quote": visit["doc"]["lines"][med["line"]],
        "value": describe_med(med),
        "display": med["display"],
    }


def draft_ticket(cmp: dict, row: dict, flag: dict, patient: dict, now: str) -> dict:
    A, B = cmp["visitA"], cmp["visitB"]
    t = flag["type"]
    if t == "conflict":
        sources = [_source("Source A", A, row["a"]), _source("Source B", B, row["b"])]
        decisions = [
            {"id": "confirm_a", "label": f"Confirm Source A ({A['facility']}, {fmt_date(A['date'])}) as current"},
            {"id": "confirm_b", "label": f"Confirm Source B ({B['facility']}, {fmt_date(B['date'])}) as current"},
            {"id": "clarify", "label": "Request clarification from prescriber"},
        ]
    elif t in ("missing", "outdated"):
        sources = [_source("Source", A, row["a"])] if t == "missing" else [_source("Source", row["history"]["visit"], row["history"]["med"])]
        decisions = [
            {"id": "confirm_current", "label": "Confirmed with prescriber: still current"},
            {"id": "confirm_ended", "label": "Confirmed with prescriber: no longer current"},
            {"id": "clarify", "label": "Request clarification from prescriber"},
        ]
    else:
        sources = [_source("Source", B, row["b"])]
        decisions = [
            {"id": "record_as_written", "label": "Accept record as written"},
            {"id": "clarify", "label": "Request clarification from prescriber"},
        ]
    label = flag["label"]
    return {
        "fingerprint": flag["fingerprint"],
        "patientId": patient["id"],
        "patientName": patient["name"],
        "generic": row["generic"],
        "type": t,
        "title": f"{_cap(row['generic'])}: {label[:1].lower()}{label[1:]}",
        "sources": sources,
        "decisions": decisions,
        "status": "open",
        "createdAt": now,
        "history": [{"at": now, "actor": "Comparison engine", "action": "Flag raised"}],
    }
