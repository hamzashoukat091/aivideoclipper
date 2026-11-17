"""Shared helpers for the ASR bake-off: paths, word schema, sentence grouping, text normalization."""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

# This machine has a TLS-inspecting root in the Windows cert store; verify against the OS store
# (still full verification) instead of certifi's bundle.
try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

import sys

for _s in (sys.stdout, sys.stderr):   # Windows consoles default to cp1252
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "bakeoff"

# Prices in USD per hour of audio. From research/02 (not re-verified at billing time).
PRICE_PER_HOUR = {"scribe_v2": 0.20, "scribe_v3": None, "parakeet": 0.0, "whisperx": 0.0}


@dataclass
class Word:
    w: str
    start: float
    end: float
    speaker: str | None = None


def episode_dir(episode_id: str) -> Path:
    d = DATA / episode_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_asr(episode_id: str, system: str, model: str, words: list[Word],
             audio_seconds: float, runtime_seconds: float, extra: dict | None = None) -> Path:
    out = episode_dir(episode_id) / "asr" / f"{system}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "system": system,
        "model": model,
        "audio_seconds": round(audio_seconds, 2),
        "runtime_seconds": round(runtime_seconds, 2),
        "rtf": round(runtime_seconds / audio_seconds, 3) if audio_seconds else None,
        "words": [asdict(w) for w in words],
        **(extra or {}),
    }
    out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    return out


def load_asr(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    data["words"] = [Word(**w) for w in data["words"]]
    return data


_SENT_END = re.compile(r"[.?!][\"')\]]*$")


def sentences(words: list[Word]) -> list[list[Word]]:
    """Group words into sentences on terminal punctuation."""
    out: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        cur.append(w)
        if _SENT_END.search(w.w):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


_PUNCT = re.compile(r"[^\w\s']")


def norm_tokens(text: str) -> list[str]:
    """Lowercase, drop punctuation (keep apostrophes), split hyphens. Deliberately simple and
    identical for every system, so WER differences come from the systems, not the normalizer."""
    text = text.lower().replace("-", " ").replace("’", "'")
    text = _PUNCT.sub(" ", text)
    return [t.strip("'") for t in text.split() if t.strip("'")]


def wav_seconds(path: Path) -> float:
    import soundfile as sf
    info = sf.info(str(path))
    return info.frames / info.samplerate
