"""Word-timed, styled ASS captions for a 1080x1920 clip (rules: research/05-captions-rendering.md).

Chunks of 1-3 words (<= MAX_CHARS) in caps; one Dialogue event per spoken word containing the whole chunk, the
active word coloured (no alpha dimming, no per-word scaling -> no reflow); the chunk pops in once on entry.
Position follows the layout at that moment: TRACK/GROUP lower-middle (inside every platform's safe zone), SPLIT on
the seam between panels, FIT above the video band. Optional on-screen hook box at the top for the first seconds.
User edits (clipper/edits.py) can turn captions off, pin them to one position, change their size, and set the
hook text and duration; chunk width scales with the size so bigger text still fits the frame.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from edits import POSITION_Y  # noqa: E402

FONT, HOOK_FONT = "Montserrat Black", "Montserrat ExtraBold"
# Caption style: 7 px black outline, NO drop shadow. The 3 px semi-transparent shadow read as a grey second copy of
# the text behind the caption on skin tones (user report 2026-11-17); compared on one frame, no-shadow was cleanest.
SIZE, HOOK_SIZE = 84, 62
MAX_WORDS, MAX_CHARS = 3, 14
MAX_CHUNK_S, MIN_CHUNK_S, PAUSE_BREAK_S, GAP_HOLD_S = 1.8, 0.28, 0.28, 0.30
LEAD_S, TAIL_S = 0.03, 0.15
ACTIVE = r"&H00E5FF&"                     # BGR: warm yellow
Y_BY_LAYOUT = {"TRACK": 1150, "GROUP": 1150, "SPLIT": 960, "FIT": 520}
HOOK_Y, HOOK_S, HOOK_LINE_CHARS = 290, 3.0, 22    # top of the safe zone (y >= 270): stays above most faces
FUNCTION_WORDS = {"a", "an", "the", "to", "of", "and", "in", "on", "at", "for", "with", "i", "my", "your", "his",
                  "her", "their", "our", "is", "was", "but", "or", "so", "that", "this", "it's", "i'm", "you"}
HARD = re.compile(r"[.?!][\"')\]]*$")
SOFT = re.compile(r"[,;:—–-][\"')\]]*$")


def ts(t: float) -> str:
    t = max(t, 0.0)
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def clean(w: str) -> str:
    return w.strip().upper().replace("{", "(").replace("}", ")").replace("\\", "/")


def chunk(words: list[dict], max_chars: int = MAX_CHARS) -> list[list[dict]]:
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        text = " ".join(clean(x["w"]) for x in cur)
        brk = (nxt is None or HARD.search(w["w"]) or SOFT.search(w["w"])
               or nxt["start"] - w["end"] > PAUSE_BREAK_S or len(cur) >= MAX_WORDS
               or len(text) + 1 + len(clean(nxt["w"])) > max_chars
               or nxt["end"] - cur[0]["start"] > MAX_CHUNK_S)
        # never end a chunk on a function word unless forced by punctuation/pause/end
        soft_only = nxt is not None and not (HARD.search(w["w"]) or SOFT.search(w["w"])
                                             or nxt["start"] - w["end"] > PAUSE_BREAK_S)
        if brk and soft_only and re.sub(r"\W", "", w["w"].lower()) in FUNCTION_WORDS and len(cur) > 1:
            out.append(cur[:-1])
            cur = [w]
            continue
        if brk:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    merged = []                                   # merge micro-chunks into the previous one
    for c in out:
        if merged and c[-1]["end"] - c[0]["start"] < MIN_CHUNK_S and c[0]["start"] - merged[-1][-1]["end"] < 0.15 \
                and len(merged[-1]) + len(c) <= MAX_WORDS \
                and len(" ".join(clean(w["w"]) for w in merged[-1] + c)) <= max_chars + 4:
            merged[-1] = merged[-1] + c
        else:
            merged.append(c)
    return merged


def wrap(text: str, n: int) -> str:
    lines, cur = [], ""
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > n:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    return "\\N".join(lines + [cur])


def build_ass(words: list[dict], clip_dur: float, layout_at, hook: str | None, *, hook_s: float = HOOK_S,
              captions: bool = True, position: str = "auto", size: int = SIZE) -> str:
    """words: [{w, start, end}] relative to clip start. layout_at(t) -> layout name.
    position: "auto" (per layout, Y_BY_LAYOUT) or "upper"/"middle"/"lower" (fixed y); size: caption font px."""
    max_chars = max(8, round(MAX_CHARS * SIZE / size))
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
LayoutResX: 1080
LayoutResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{FONT},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,7,0,5,60,60,0,1
Style: Hook,{HOOK_FONT},{HOOK_SIZE},&H00FFFFFF,&H00FFFFFF,&H28000000,&H00000000,0,0,0,0,100,100,0,0,3,22,0,5,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    if hook:
        ev.append(f"Dialogue: 1,{ts(0)},{ts(min(hook_s, clip_dur))},Hook,,0,0,0,,"
                  f"{{\\an5\\pos(540,{HOOK_Y})\\fad(120,250)}}{wrap(clean(hook), HOOK_LINE_CHARS)}")
    chunks = chunk([w for w in words if w["end"] > 0 and w["start"] < clip_dur], max_chars) if captions else []
    caps: list[list] = []                          # [start, end, text] for layer-0 caption events
    for ci, c in enumerate(chunks):
        nxt = chunks[ci + 1][0]["start"] if ci + 1 < len(chunks) else None
        c_end = nxt if nxt is not None and nxt - c[-1]["end"] < GAP_HOLD_S else c[-1]["end"] + TAIL_S
        c_end = min(c_end, clip_dur)
        y = POSITION_Y.get(position) or Y_BY_LAYOUT.get(layout_at((c[0]["start"] + c[-1]["end"]) / 2), 1150)
        toks = [clean(w["w"]) for w in c]
        for k, w in enumerate(c):
            s = max(0.0, c[0]["start"] - LEAD_S) if k == 0 else w["start"]
            e = c[k + 1]["start"] if k + 1 < len(c) else c_end
            if e - s < 0.02:
                continue
            body = " ".join(f"{{\\1c{ACTIVE}}}{t}{{\\1c&H00FFFFFF&}}" if j == k else t for j, t in enumerate(toks))
            anim = "\\fscx82\\fscy82\\t(0,90,\\fscx106\\fscy106)\\t(90,150,\\fscx100\\fscy100)" if k == 0 else ""
            caps.append([s, e, f"{{\\an5\\pos(540,{y}){anim}}}{body}"])
    # Never two captions on screen at once: a chunk's early start (LEAD_S) used to overlap the previous chunk's
    # hold, drawing the old text behind the new one for a frame (2026-11-17 user report: "something behind").
    caps.sort(key=lambda x: x[0])
    for a, b in zip(caps, caps[1:]):
        a[1] = min(a[1], b[0])
    for s, e, text in caps:
        if e - s >= 0.02:
            ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Cap,,0,0,0,,{text}")
    return head + "\n".join(ev) + "\n"
