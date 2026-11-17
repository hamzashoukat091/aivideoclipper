"""Fetch a test episode's audio and human reference transcript for the ASR bake-off.

Usage:
  python bakeoff/ingest.py <youtube-url | local-media-file> --id ep1 [--start 600 --duration 1200]
                           [--ref path/to/reference.(vtt|srt|txt)]

Writes data/bakeoff/<id>/:
  source.*            original best-audio download (or nothing, for a local file)
  audio16k.wav        16 kHz mono PCM slice that every system transcribes
  reference.json      human reference cues inside the slice (times relative to slice start)
  meta.json           source, slice window, reference origin

Reference priority: --ref file > YouTube *manual* English captions. Auto-captions are never used as reference
(they are machine output). If neither exists, scoring falls back to cross-system agreement only.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import episode_dir  # noqa: E402

TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})")


def _ts(s: str) -> float:
    m = TS.search(s)
    if not m:
        raise ValueError(s)
    h, mnt, sec, ms = m.groups()
    return int(h or 0) * 3600 + int(mnt) * 60 + int(sec) + int(ms) / 1000


def parse_cues(path: Path) -> list[dict]:
    """Parse VTT/SRT into [{start,end,text}]. TXT -> one cue with no timing (start=end=None)."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() == ".txt":
        return [{"start": None, "end": None, "text": " ".join(raw.split())}]
    cues, block = [], []
    for line in raw.splitlines() + [""]:
        if line.strip():
            block.append(line)
            continue
        timing = next((i for i, l in enumerate(block) if "-->" in l), None)
        if timing is not None:
            a, b = block[timing].split("-->")[:2]
            text = " ".join(block[timing + 1:])
            text = re.sub(r"<[^>]+>", "", html.unescape(text))   # inline tags
            text = re.sub(r"^\s*(>>|-)\s*", "", text)              # speaker-change markers
            text = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", text)       # [Music], (laughs)
            text = " ".join(text.split())
            if text:
                cues.append({"start": _ts(a), "end": _ts(b.split()[0]), "text": text})
        block = []
    return cues


def windows_ca_bundle() -> str | None:
    """Export the Windows trusted roots to a PEM so every yt-dlp HTTP backend (incl. curl_cffi, which ships its
    own bundle) verifies TLS against the same store as the OS. Needed on machines with a TLS-inspecting root."""
    import ssl
    if not hasattr(ssl, "enum_certificates"):
        return None
    pem = episode_dir("_certs") / "windows-roots.pem"
    blobs = {c for store in ("ROOT", "CA") for c, enc, trust in ssl.enum_certificates(store)
             if enc == "x509_asn" and (trust is True or "1.3.6.1.5.5.7.3.1" in trust)}
    pem.write_text("".join(ssl.DER_cert_to_PEM_cert(b) for b in blobs), encoding="ascii")
    return str(pem)


def run(cmd: list[str], env: dict | None = None, attempts: int = 1) -> None:
    print("+", " ".join(cmd), flush=True)
    for i in range(attempts):
        if subprocess.run(cmd, env=env).returncode == 0:
            return
        if i + 1 < attempts:
            import time
            print(f"attempt {i + 1} failed; retrying in {10 * (i + 1)}s (YouTube 403s are often transient)")
            time.sleep(10 * (i + 1))
    raise SystemExit(f"command failed after {attempts} attempts: {cmd[0]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--id", required=True)
    ap.add_argument("--start", type=float, default=0.0, help="slice start, seconds")
    ap.add_argument("--duration", type=float, default=None, help="slice length, seconds (default: to end)")
    ap.add_argument("--ref", type=Path, default=None, help="hand-checked reference transcript")
    args = ap.parse_args()

    d = episode_dir(args.id)
    is_url = re.match(r"https?://", args.source) is not None
    ref_origin = None

    if is_url:
        import os
        yt_env = dict(os.environ)
        ca = windows_ca_bundle()
        if ca:
            yt_env.update(CURL_CA_BUNDLE=ca, SSL_CERT_FILE=ca, REQUESTS_CA_BUNDLE=ca)
        # no-certifi: verify TLS against the Windows cert store (this machine has a TLS-inspecting root there)
        run(["yt-dlp", "--compat-options", "no-certifi", "--no-playlist", "--retries", "10", "--no-progress",
             "-f", "bestaudio", "-o", str(d / "source.%(ext)s"),
             "--write-info-json", "--write-subs", "--sub-langs", "en,en-US,en-GB", "--sub-format", "vtt",
             args.source], env=yt_env, attempts=3)
        media = next(p for p in d.glob("source.*") if p.suffix not in (".json", ".vtt"))
    else:
        media = Path(args.source).resolve()
        if not media.exists():
            sys.exit(f"not found: {media}")

    wav = d / "audio16k.wav"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(args.start), "-i", str(media)]
    if args.duration:
        cmd += ["-t", str(args.duration)]
    run(cmd + ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)])

    ref_path = args.ref
    if ref_path is None:
        manual = sorted(d.glob("source.en*.vtt"))
        if manual:
            ref_path, ref_origin = manual[0], "youtube-manual-captions"
    else:
        ref_origin = "user-supplied"

    cues: list[dict] = []
    if ref_path:
        end = args.start + args.duration if args.duration else float("inf")
        for c in parse_cues(ref_path):
            if c["start"] is None:          # untimed txt: assume it covers exactly the slice
                cues.append(c)
            elif c["start"] >= args.start and c["end"] <= end:   # only cues fully inside the slice
                cues.append({"start": c["start"] - args.start, "end": c["end"] - args.start, "text": c["text"]})
    (d / "reference.json").write_text(json.dumps(cues, indent=1), encoding="utf-8")

    meta = {"source": args.source, "media": str(media), "start": args.start, "duration": args.duration,
            "reference": str(ref_path) if ref_path else None, "reference_origin": ref_origin,
            "reference_cues": len(cues)}
    (d / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(json.dumps(meta, indent=1))
    if not cues:
        print("WARNING: no human reference found - WER cannot be computed for this episode. "
              "Pass --ref with a hand-checked transcript.", file=sys.stderr)


if __name__ == "__main__":
    main()
