"""
Turns prescription lines into structured values, keeping the line number of each one.

It only EXTRACTS what is written. It never fills in a missing dose, frequency or duration:
missing values stay empty and are flagged for human review.
"""
import re

FORMS = {"tab": "tab", "tablet": "tab", "tabs": "tab", "cap": "cap", "capsule": "cap", "caps": "cap",
         "inj": "inj", "injection": "inj", "syp": "syp", "syrup": "syp", "susp": "syp", "drops": "drops"}

# Brand -> generic. Only links names for the SAME drug; it never substitutes one drug for another.
BRANDS = {
    "glycomet": "metformin", "glucophage": "metformin", "amlong": "amlodipine", "amlip": "amlodipine",
    "atorva": "atorvastatin", "lipitor": "atorvastatin", "ecosprin": "aspirin", "pan": "pantoprazole",
    "pantocid": "pantoprazole", "thyronorm": "levothyroxine", "eltroxin": "levothyroxine", "dolo": "paracetamol",
    "crocin": "paracetamol", "lantus": "insulin glargine", "basalog": "insulin glargine", "telma": "telmisartan",
}
COURSE_DRUGS = {"pantoprazole", "amoxicillin", "azithromycin", "prednisolone", "vitamin d3", "cefixime", "doxycycline"}

UNITS = "mg|mcg|µg|g|ml|iu|units|unit|u"
LINE_RE = re.compile(
    rf"""^\s*(?:\d+\s*[.)]\s*)?                          # optional numbering "1." or "2)"
        (?:(?P<form>{'|'.join(FORMS)})\.?\s+)?            # optional form prefix "Tab"
        (?P<name>[A-Za-z][A-Za-z0-9\-]*(?:\s+[A-Za-z][A-Za-z0-9\-]*){{0,2}}?)\s*
        (?P<amount>\d[\d,]*(?:\.\d+)?)\s*(?P<unit>{UNITS})\b
        (?P<rest>.*)$""",
    re.IGNORECASE | re.VERBOSE,
)
PATTERN_RE = re.compile(r"\b([0-2])\s*-\s*([0-2])\s*-\s*([0-2])\b")
DURATION_RE = re.compile(r"(?:[x×*]|for)\s*(\d+)\s*(day|days|d|week|weeks|wk|wks|month|months|mo)\b", re.IGNORECASE)
SKIP_RE = re.compile(r"^\s*(rx|pt[:.]|patient|age|mrn|review|diagnosis|dx|advice|signature|dr\.)", re.IGNORECASE)


def _unit(u: str) -> str:
    u = u.lower()
    if u in ("iu",):
        return "IU"
    if u in ("u", "unit", "units"):
        return "units"
    return "mcg" if u == "µg" else u


def _amount(a: str) -> str:
    a = a.replace(",", "")
    if "." in a:
        return a
    n = int(a)
    return f"{n:,}" if n >= 10000 else str(n)


def _frequency(text: str):
    t = f" {text.lower()} "
    m = PATTERN_RE.search(t)
    if m:
        return "-".join(m.groups())
    if re.search(r"\b(once\s+(a\s+)?week(ly)?|weekly)\b", t):
        return "weekly"
    if re.search(r"\b(tds|tid|thrice daily|three times)\b", t):
        return "1-1-1"
    if re.search(r"\b(bd|bid|twice daily|twice a day)\b", t):
        return "1-0-1"
    if re.search(r"\b(hs|at bedtime|at night|night)\b", t):
        return "0-0-1"
    if re.search(r"\bafter lunch\b", t):
        return "0-1-0"
    if re.search(r"\b(od|once daily|once a day)\b", t):
        if "morning" in t:
            return "1-0-0"
        return "once daily"
    if "morning" in t:
        return "1-0-0"
    return None


def _timing(text: str):
    t = f" {text.lower()} "
    if re.search(r"\b(a/f|af|after food|after meals?|after lunch|after breakfast|after dinner|pc)\b", t):
        return "after food"
    if re.search(r"\b(b/f|bf|before food|before meals?|before breakfast|empty stomach|ac)\b", t):
        return "before food"
    return None


def _route(text: str):
    t = f" {text.lower()} "
    for key, route in ((" sc ", "SC"), ("subcut", "SC"), (" iv ", "IV"), (" im ", "IM")):
        if key in t:
            return route
    return None


def _duration(text: str):
    m = DURATION_RE.search(text)
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2).lower()
    word = "day" if unit.startswith("d") else "week" if unit.startswith("w") else "month"
    return f"{n} {word}{'s' if n != 1 else ''}"


def parse_line(text: str, line_no: int, line_conf: float = 0.99) -> dict | None:
    if not text.strip() or SKIP_RE.match(text):
        return None
    m = LINE_RE.match(text)
    if not m:
        return None
    raw_name = m.group("name").strip()
    rest = m.group("rest") or ""
    form = FORMS.get((m.group("form") or "").lower())
    if not form:  # dispense style: "Metformin 500 mg tab × 60"
        tail = re.search(r"\b(tab|tablet|cap|capsule|inj|syp|syrup)\b", rest, re.IGNORECASE)
        form = FORMS.get(tail.group(1).lower()) if tail else None
        if not form:
            return None  # not a medicine line
    name_lower = raw_name.lower()
    generic = BRANDS.get(name_lower, BRANDS.get(name_lower.split()[0], name_lower))
    strength = f"{_amount(m.group('amount'))} {_unit(m.group('unit'))}"
    frequency = _frequency(rest)
    timing = _timing(rest)
    duration = _duration(rest)
    route = _route(rest)

    found = sum(1 for v in (strength, frequency) if v)
    confidence = round(line_conf * (1.0 if found == 2 else 0.85), 2)
    display_name = generic[:1].upper() + generic[1:]
    return {
        "generic": generic,
        "display": f"{display_name} {strength}",
        "form": form,
        "line": line_no,
        "strength": strength,
        "frequency": frequency,
        "timing": timing,
        "route": route,
        "duration": duration,
        "durationRequired": frequency == "weekly" or generic in COURSE_DRUGS,
        "confidence": confidence,
        "asWritten": re.sub(r"^\s*\d+\s*[.)]\s*", "", text).strip(),
        "needsCheck": confidence < 0.8 or not frequency,
    }


def parse_document(lines: list[tuple[str, float]]) -> dict:
    """lines: [(text, confidence 0-1)]. Returns medications + header info found in the document."""
    meds, seen = [], set()
    prescriber = None
    for i, (text, conf) in enumerate(lines):
        if prescriber is None:
            dm = re.search(r"\bDr\.?\s+[A-Z][\w.]*(?:\s+[A-Z][\w.]*)?", text)
            if dm:
                prescriber = dm.group(0).strip()
        med = parse_line(text, i, conf)
        if med and med["generic"] not in seen:
            seen.add(med["generic"])
            meds.append(med)
    return {"medications": meds, "prescriber": prescriber}
