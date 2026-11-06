"""Synthetic demo data (identical to the frontend mock). Never real patients."""
import re
from datetime import datetime, timedelta, timezone

from . import audit
from .auth import ENGINE, SYSTEM, User
from .compare import compare_visits, draft_ticket
from .db import Database, dumps
from .repo import insert_ticket, insert_visit

PATIENTS = [
    {"id": "SYN-20481", "name": "Arun Kumar", "age": 58, "sex": "M", "allergies": "None recorded"},
    {"id": "SYN-19877", "name": "Meena S.", "age": 46, "sex": "F", "allergies": "None recorded"},
    {"id": "SYN-18302", "name": "Joseph D.", "age": 67, "sex": "M", "allergies": "Penicillin (synthetic record)"},
]


def med(generic, display, form, line, **f):
    base = {
        "generic": generic, "display": display, "form": form, "line": line,
        "strength": None, "frequency": None, "timing": None, "route": None, "duration": None,
        "durationRequired": False, "confidence": 0.95,
    }
    base.update(f)
    return base


def visit(vid, pid, d, facility, vtype, prescriber, title, lines, meds):
    strip = lambda s: re.sub(r"^\s*\d+[.)]\s*", "", s)  # noqa: E731
    for m in meds:
        m["asWritten"] = strip(lines[m["line"]])
    return {"id": vid, "patientId": pid, "date": d, "facility": facility, "type": vtype, "prescriber": prescriber,
            "doc": {"title": title, "lines": lines}, "meds": meds}


def arun_visits():
    P = "SYN-20481"
    return [
        visit("v-jan", P, "2026-01-18", "City General Hospital", "OPD prescription", "Dr. S. Menon", "opd-18jan.pdf", [
            "City General Hospital — OPD prescription",
            "18 Jan 2026 · Dr. S. Menon",
            "Pt: Arun Kumar · 58 M · MRN SYN-20481",
            "Rx",
            "Tab Metformin 500mg 1-0-1 A/F",
            "Inj Insulin glargine 10 units SC at night",
            "Review after 3 months",
        ], [
            med("metformin", "Metformin 500 mg", "tab", 4, strength="500 mg", frequency="1-0-1", timing="after food"),
            med("insulin glargine", "Insulin glargine 10 units", "inj", 5, strength="10 units", frequency="0-0-1", route="SC", confidence=0.89),
        ]),
        visit("v-jun", P, "2026-06-03", "Sunrise Pharmacy", "Dispense record", "—", "dispense-03jun.pdf", [
            "Sunrise Pharmacy — Dispense record",
            "03 Jun 2026 · Patient: Arun Kumar",
            "Metformin 500 mg tab × 60",
            "Amlodipine 5 mg tab × 30",
            "Atorvastatin 20 mg tab × 30",
        ], [
            med("metformin", "Metformin 500 mg", "tab", 2, strength="500 mg", confidence=0.98),
            med("amlodipine", "Amlodipine 5 mg", "tab", 3, strength="5 mg", confidence=0.98),
            med("atorvastatin", "Atorvastatin 20 mg", "tab", 4, strength="20 mg", confidence=0.98),
        ]),
        visit("v-aug", P, "2026-08-12", "City General Hospital", "Discharge summary", "Dr. S. Menon", "discharge-12aug.pdf", [
            "City General Hospital — Discharge summary",
            "12 Aug 2026 · Dr. S. Menon",
            "Pt: Arun Kumar · 58 M · MRN SYN-20481",
            "Medications on discharge:",
            "1. Tab Metformin 500mg BD A/F",
            "2. Tab Amlodipine 5mg OD morning",
            "3. Tab Atorvastatin 20mg HS",
            "4. Tab Aspirin 75mg after lunch",
            "5. Tab Pantoprazole 40mg OD B/F × 14 days",
        ], [
            med("metformin", "Metformin 500 mg", "tab", 4, strength="500 mg", frequency="1-0-1", timing="after food"),
            med("amlodipine", "Amlodipine 5 mg", "tab", 5, strength="5 mg", frequency="1-0-0"),
            med("atorvastatin", "Atorvastatin 20 mg", "tab", 6, strength="20 mg", frequency="0-0-1"),
            med("aspirin", "Aspirin 75 mg", "tab", 7, strength="75 mg", frequency="0-1-0", timing="after food"),
            med("pantoprazole", "Pantoprazole 40 mg", "tab", 8, strength="40 mg", frequency="once daily", timing="before food", duration="14 days"),
        ]),
        visit("v-oct", P, "2026-10-28", "Green Valley Clinic", "OPD prescription", "Dr. P. Rao", "opd-28oct.jpg", [
            "Green Valley Clinic — OPD",
            "28 Oct 2026 · Dr. P. Rao",
            "Pt: Arun Kumar · Age 58",
            "Rx",
            "1) Tab Metformin 1000mg 1-0-1 A/F",
            "2) Tab Atorvastatin 20mg 0-0-1",
            "3) Tab Amlodipine 5mg 0-0-1",
            "4) Tab Aspirin 75mg 0-1-0",
            "5) Cap Vitamin D3 60000 IU once weekly",
        ], [
            med("metformin", "Metformin 1000 mg", "tab", 4, strength="1000 mg", frequency="1-0-1", timing="after food", confidence=0.94),
            med("atorvastatin", "Atorvastatin 20 mg", "tab", 5, strength="20 mg", frequency="0-0-1"),
            med("amlodipine", "Amlodipine 5 mg", "tab", 6, strength="5 mg", frequency="0-0-1", confidence=0.92),
            med("aspirin", "Aspirin 75 mg", "tab", 7, strength="75 mg", frequency="0-1-0"),
            med("vitamin d3", "Vitamin D3 60,000 IU", "cap", 8, strength="60,000 IU", frequency="weekly", durationRequired=True, confidence=0.91),
        ]),
    ]


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def seed(db: Database, force: bool = False):
    with db.tx() as t:
        if not force and t.scalar("SELECT COUNT(*) AS n FROM patients"):
            return False
        for table in ("idempotency_keys", "handovers", "audit_log", "tickets", "medications", "visits", "uploads", "patients", "counters", "demo_settings"):
            t.run(f"DELETE FROM {table}")
        for p in PATIENTS:
            t.run("INSERT INTO patients (id, name, age, sex, allergies) VALUES (?,?,?,?,?)", p["id"], p["name"], p["age"], p["sex"], p["allergies"])

        now = datetime.now(timezone.utc)
        hours_ago = lambda h: _iso(now - timedelta(hours=h))  # noqa: E731
        visits = arun_visits()
        patient_user = User("u-arun", "Arun Kumar", "patient", "SYN-20481")
        for v in visits:
            insert_visit(t, v, None, f"{v['date']}T09:30:00.000Z")
            audit.append(t, patient_user, "DOCUMENT_UPLOADED", v["doc"]["title"], f"{v['type']}, {v['facility']}", f"{v['date']}T09:30:00.000Z")
            audit.append(t, SYSTEM, "VALUES_EXTRACTED", v["doc"]["title"], f"{len(v['meds'])} medicines extracted and linked to source lines", f"{v['date']}T09:31:00.000Z")

        # Arun's conflicts are already in the queue; the other flags are left for "Send flags to review".
        cmp = compare_visits(visits, "SYN-20481", "v-aug", "v-oct")
        n = 113
        for row in cmp["rows"]:
            for f in row["flags"]:
                if f["type"] != "conflict":
                    continue
                d = draft_ticket(cmp, row, f, PATIENTS[0], hours_ago(2))
                insert_ticket(t, f"RQ-{n}", d)
                audit.append(t, ENGINE, "FLAG_RAISED", f"RQ-{n}", d["title"], hours_ago(2))
                n += 1

        other = [
            ("RQ-109", PATIENTS[1], "levothyroxine", "missing_field", "Levothyroxine: duration not written", 26,
             {"label": "Source", "visitId": "x", "facility": "Lakeview Clinic", "date": "2026-11-02", "type": "OPD prescription",
              "prescriber": "Dr. K. Iqbal", "docTitle": "opd-02nov.jpg", "line": 4, "quote": "Tab Levothyroxine 50mcg 1-0-0 empty stomach",
              "value": "50 mcg, 1-0-0", "display": "Levothyroxine 50 mcg"},
             [{"id": "record_as_written", "label": "Accept record as written"}, {"id": "clarify", "label": "Request clarification from prescriber"}]),
            ("RQ-104", PATIENTS[2], "insulin aspart", "outdated", "Insulin aspart: last recorded 9 months ago", 70,
             {"label": "Source", "visitId": "y", "facility": "City General Hospital", "date": "2026-02-06", "type": "Discharge summary",
              "prescriber": "Dr. S. Menon", "docTitle": "discharge-06feb.pdf", "line": 6, "quote": "Inj Insulin aspart 8 units SC before meals",
              "value": "8 units, 1-1-1", "display": "Insulin aspart 8 units"},
             [{"id": "confirm_current", "label": "Confirmed with prescriber: still current"},
              {"id": "confirm_ended", "label": "Confirmed with prescriber: no longer current"},
              {"id": "clarify", "label": "Request clarification from prescriber"}]),
        ]
        for tid, p, generic, ttype, title, age_h, source, decisions in other:
            at = hours_ago(age_h)
            insert_ticket(t, tid, {
                "fingerprint": f"{p['id']}|{generic}|{ttype}|{source['value']}", "patientId": p["id"], "patientName": p["name"],
                "generic": generic, "type": ttype, "title": title, "sources": [source], "decisions": decisions, "createdAt": at,
                "history": [{"at": at, "actor": "Comparison engine", "action": "Flag raised"}],
            })

        t.run("INSERT INTO counters (name, value) VALUES (?, ?)", "RQ", 114)
        t.run("INSERT INTO counters (name, value) VALUES (?, ?)", "UP", 117)
        t.run("INSERT INTO demo_settings (name, value) VALUES (?, ?)", "highLoad", dumps(False))
    return True
