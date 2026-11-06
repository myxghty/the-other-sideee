"""
What a patient sees: (a) instructions a pharmacist verified, (b) instructions that match
across their last two records, or (c) a neutral "being reviewed" notice.
The instruction is always shown verbatim. No advice is generated.
"""
from datetime import datetime, timezone

from .compare import compare_visits
from .plain import plain_reading

IN_REVIEW_MESSAGE = (
    "Your records show different information for this medicine. A pharmacist is checking. "
    "Keep following your doctor's advice and ask them if you are unsure."
)


def _item(med, visit, status, resolution=None):
    return {
        "generic": med["generic"],
        "title": med["display"],
        "status": status,
        "asWritten": med["asWritten"],
        "plain": plain_reading(med),
        "source": {"facility": visit["facility"], "date": visit["date"], "docTitle": visit["doc"]["title"], "line": med["line"] + 1},
        "verifiedBy": resolution["by"]["name"] if resolution else None,
        "verifiedAt": resolution["at"] if resolution else None,
    }


def build_patient_view(visits: list[dict], tickets_by_fp: dict, pid: str) -> dict:
    pv = sorted((v for v in visits if v["patientId"] == pid), key=lambda v: v["date"], reverse=True)
    generated = datetime.now(timezone.utc).isoformat()
    if len(pv) < 2:
        items = [_item(m, pv[0], "consistent") for m in pv[0]["meds"]] if pv else []
        return {"patientId": pid, "generatedAt": generated, "items": items}

    cmp = compare_visits(visits, pid, pv[1]["id"], pv[0]["id"])
    items = []
    for row in cmp["rows"]:
        flags = [f for f in row["flags"] if f.get("fingerprint")]
        if not flags:
            if row["b"]:
                items.append(_item(row["b"], cmp["visitB"], "consistent"))
            continue
        tickets = [tickets_by_fp.get(f["fingerprint"]) for f in flags]
        if any(t is None or t["status"] != "resolved" for t in tickets):
            items.append({"generic": row["generic"], "title": row["generic"].capitalize(), "status": "in_review", "message": IN_REVIEW_MESSAGE})
            continue
        chosen, resolution = None, None
        for t in tickets:
            d = t["resolution"]["decision"]
            resolution = t["resolution"]
            if d == "confirm_ended":
                chosen = "ended"
                break
            if d == "confirm_a":
                chosen = (row["a"], cmp["visitA"])
            elif d == "confirm_current":
                chosen = (row["a"], cmp["visitA"]) if row["a"] else (row["history"]["med"], row["history"]["visit"])
            elif d in ("confirm_b", "record_as_written") and chosen is None:
                chosen = (row["b"], cmp["visitB"])
        if not chosen or chosen == "ended":
            continue
        items.append(_item(chosen[0], chosen[1], "verified", resolution))

    order = {"in_review": 0, "verified": 1, "consistent": 2}
    items.sort(key=lambda i: order[i["status"]])
    return {"patientId": pid, "generatedAt": generated, "items": items}
