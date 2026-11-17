"""Stage 1c - diarize: who speaks when (pyannote community-1, CPU), then label every word with a speaker.

Usage:
  python clipper/diarize.py --id JOB [--speakers N | --min-speakers A --max-speakers B]
  python clipper/diarize.py --id JOB --merge-only     # rebuild words.json from existing files (no token needed)

Needs HF_TOKEN in .env, and the model's terms accepted once at
https://huggingface.co/pyannote/speaker-diarization-community-1 (free, CC-BY-4.0).

Reads  audio16k.wav, transcript.json
Writes diarization.json  {model, runtime_seconds, speakers: [{id, seconds, share}],
                          turns: [{start,end,speaker}]            # may overlap (crosstalk) - reframe uses these
                          exclusive: [{start,end,speaker}]}       # one speaker at a time - word labels use these
       words.json        the transcript words + "speaker" (null when diarization is unavailable); the file every
                         later stage reads
"""
from __future__ import annotations

import argparse
import bisect
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import job_dir, load_env, read_json, stage_banner, write_json  # noqa: E402

MODEL = "pyannote/speaker-diarization-community-1"
NEAREST_S = 0.5   # a word in no turn takes the nearest turn's speaker if within this distance


def run_pyannote(wav: Path, token: str, num: int | None, lo: int | None, hi: int | None) -> dict:
    import soundfile as sf
    import torch
    from pyannote.audio import Pipeline
    torch.set_num_threads(os.cpu_count() or 4)
    pipe = Pipeline.from_pretrained(MODEL, token=token)
    if pipe is None:
        sys.exit(f"could not load {MODEL}: accept its terms on Hugging Face with the account that owns HF_TOKEN")
    x, sr = sf.read(str(wav), dtype="float32")           # in-memory input avoids torchcodec/ffmpeg DLL issues
    kw = {k: v for k, v in (("num_speakers", num), ("min_speakers", lo), ("max_speakers", hi)) if v}
    try:
        from pyannote.audio.pipelines.utils.hook import ProgressHook
        with ProgressHook() as hook:
            out = pipe({"waveform": torch.from_numpy(x)[None], "sample_rate": sr}, hook=hook, **kw)
    except ImportError:
        out = pipe({"waveform": torch.from_numpy(x)[None], "sample_rate": sr}, **kw)

    def turns(ann) -> list[dict]:
        return [{"start": round(s.start, 3), "end": round(s.end, 3), "speaker": spk}
                for s, _, spk in ann.itertracks(yield_label=True)]

    return {"turns": turns(out.speaker_diarization), "exclusive": turns(out.exclusive_speaker_diarization)}


def label_words(words: list[dict], exclusive: list[dict]) -> int:
    """Speaker = the exclusive turn overlapping the word most; else nearest turn within NEAREST_S. Returns #unlabelled."""
    ex = sorted(exclusive, key=lambda t: t["start"])
    starts = [t["start"] for t in ex]
    missing = 0
    for w in words:
        i = bisect.bisect_right(starts, w["end"])
        best, best_ov = None, 0.0
        for t in ex[max(0, i - 4): i]:
            ov = min(w["end"], t["end"]) - max(w["start"], t["start"])
            if ov > best_ov:
                best, best_ov = t["speaker"], ov
        if best is None and ex:
            mid = (w["start"] + w["end"]) / 2
            cand = [t for t in ex[max(0, i - 2): i + 1]]
            if cand:
                t = min(cand, key=lambda t: min(abs(mid - t["start"]), abs(mid - t["end"])))
                if min(abs(mid - t["start"]), abs(mid - t["end"])) <= NEAREST_S:
                    best = t["speaker"]
        w["speaker"] = best
        missing += best is None
    return missing


def build_words(d: Path) -> Path:
    tr = read_json(d / "transcript.json")
    words = [dict(w) for w in tr["words"]]
    diar = d / "diarization.json"
    if diar.exists():
        missing = label_words(words, read_json(diar)["exclusive"])
        src = MODEL
    else:
        for w in words:
            w["speaker"] = None
        missing, src = len(words), None
    out = write_json(d / "words.json", {"language": tr["language"], "asr_model": tr["model"], "diarization": src,
                                        "unlabelled_words": missing, "words": words})
    print(f"words.json: {len(words)} words, {missing} without speaker")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--speakers", type=int, help="exact speaker count, if known (most reliable)")
    ap.add_argument("--min-speakers", type=int)
    ap.add_argument("--max-speakers", type=int)
    ap.add_argument("--merge-only", action="store_true")
    args = ap.parse_args()

    t0 = stage_banner("diarize", args.id)
    d = job_dir(args.id)
    if not (d / "transcript.json").exists():
        sys.exit("run transcribe first: transcript.json missing")
    if args.merge_only:
        build_words(d)
        return

    load_env()
    token = os.environ.get("HF_TOKEN")
    if not token:
        print(f"HF_TOKEN missing in .env - skipping diarization (speakers will be null).\n"
              f"Get a free read token at https://huggingface.co/settings/tokens and accept the terms at "
              f"https://huggingface.co/{MODEL}", file=sys.stderr)
        build_words(d)
        sys.exit(2)

    res = run_pyannote(d / "audio16k.wav", token, args.speakers, args.min_speakers, args.max_speakers)
    total = {}
    for t in res["exclusive"]:
        total[t["speaker"]] = total.get(t["speaker"], 0.0) + t["end"] - t["start"]
    talk = sum(total.values()) or 1.0
    speakers = [{"id": s, "seconds": round(v, 1), "share": round(v / talk, 3)}
                for s, v in sorted(total.items(), key=lambda kv: -kv[1])]
    write_json(d / "diarization.json", {"model": MODEL, "runtime_seconds": round(time.perf_counter() - t0, 1),
                                        "speakers": speakers, **res})
    print("speakers:", ", ".join(f"{s['id']} {s['share']:.0%}" for s in speakers))
    build_words(d)


if __name__ == "__main__":
    main()
