"""
Plain-language readings from fixed, pharmacist-reviewed templates.
Shown beside the original instruction, never instead of it. No template -> nothing shown.
"""

FREQ = {
    "1-0-1": "One {u} in the morning and one at night",
    "1-0-0": "One {u} in the morning",
    "0-0-1": "One {u} at night",
    "0-1-0": "One {u} in the afternoon",
    "1-1-1": "One {u} in the morning, one in the afternoon and one at night",
    "weekly": "One {u} once a week",
}
UNIT = {"tab": "tablet", "cap": "capsule"}
TIMING = {"after food": "after food", "before food": "before food"}


def plain_reading(m: dict) -> str | None:
    unit = UNIT.get(m.get("form"))
    freq = FREQ.get(m.get("frequency"))
    if not unit or not freq:
        return None
    s = freq.replace("{u}", unit)
    if m.get("timing") in TIMING:
        s += f", {TIMING[m['timing']]}"
    if m.get("duration"):
        s += f", for {m['duration']}"
    return s + "."
