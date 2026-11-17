"""Parse the pipeline's ASS caption files (clipper/captions.py) into CaptionEvent dicts."""
from __future__ import annotations

import re
from typing import Any

ACTIVE_TAG = re.compile(r"\\1?c&H00E5FF&", re.IGNORECASE)   # the active-word colour written by clipper/captions.py
OVERRIDE = re.compile(r"\{[^}]*\}")
TIME = re.compile(r"^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$")
MARK = "\x00"


def parse_time(value: str) -> float:
    m = TIME.match(value.strip())
    if not m:
        raise ValueError(f"bad ASS time {value!r}")
    h, mi, s, frac = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + (int(frac) / 10 ** len(frac) if frac else 0.0)


def _plain(text: str) -> tuple[str, int | None]:
    """Strip override blocks; return (plain text, index of the word that carried the active colour tag or None)."""
    marked = OVERRIDE.sub(lambda m: MARK if ACTIVE_TAG.search(m.group(0)) else "", text)
    marked = marked.replace("\\N", " ").replace("\\n", " ").replace("\\h", " ")
    active = None
    words = marked.split()
    for i, w in enumerate(words):
        if MARK in w and w.replace(MARK, ""):
            active = i
            break
    plain = " ".join(w.replace(MARK, "") for w in words if w.replace(MARK, ""))
    return plain, active


def parse_ass(content: str) -> list[dict[str, Any]]:
    """Dialogue events in file order. Format field order comes from the [Events] `Format:` line when present."""
    fields = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"]
    events: list[dict[str, Any]] = []
    in_events = False
    for raw in content.splitlines():
        line = raw.strip()
        if line.startswith("["):
            in_events = line.lower() == "[events]"
            continue
        if not in_events:
            continue
        if line.lower().startswith("format:"):
            fields = [f.strip() for f in line.split(":", 1)[1].split(",")]
            continue
        if not line.lower().startswith("dialogue:"):
            continue
        values = line.split(":", 1)[1].lstrip().split(",", len(fields) - 1)
        if len(values) != len(fields):
            continue
        row = dict(zip(fields, values))
        try:
            start, end = parse_time(row["Start"]), parse_time(row["End"])
        except (KeyError, ValueError):
            continue
        hook = row.get("Style", "").strip().lower() == "hook"
        text, active = _plain(row.get("Text", ""))
        events.append({"start": round(start, 3), "end": round(end, 3), "text": text,
                       "active": None if hook else active, "kind": "hook" if hook else "caption"})
    return events
