"""Run one ASR system on an ingested episode and save words in the common schema.

Usage:
  python bakeoff/run_asr.py --id ep1 --system parakeet  [--model nemo-parakeet-tdt-0.6b-v2] [--quant int8]
  python bakeoff/run_asr.py --id ep1 --system whisperx  [--model large-v3] [--compute int8]
  python bakeoff/run_asr.py --id ep1 --system scribe    [--model scribe_v2]   (needs ELEVENLABS_API_KEY in .env; PAID)

Output: data/bakeoff/<id>/asr/<system>.json
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, Word, episode_dir, save_asr, wav_seconds  # noqa: E402

PARAKEET_FRAME_S = 0.08  # 10 ms hop x 8 subsampling


def run_parakeet(wav: Path, model_name: str, quant: str | None) -> tuple[list[Word], dict]:
    import onnx_asr
    vad = onnx_asr.load_vad("silero")
    model = (onnx_asr.load_model(model_name, quantization=quant)
             .with_vad(vad, max_speech_duration_s=20, min_silence_duration_ms=250, speech_pad_ms=120)
             .with_timestamps())
    words: list[Word] = []
    for seg in model.recognize(str(wav)):
        toks, starts = seg.tokens or [], seg.timestamps or []
        cur_text, cur_start, cur_last = "", None, None
        for tok, ts in zip(toks, starts):
            t = seg.start + ts
            new_word = tok.startswith((" ", "▁")) or cur_start is None
            if new_word and cur_text.strip():
                words.append(Word(cur_text.strip(), cur_start, cur_last + PARAKEET_FRAME_S))
                cur_text, cur_start = "", None
            if cur_start is None:
                cur_start = t
            cur_text += tok.replace("▁", " ")
            cur_last = t
        if cur_text.strip():
            words.append(Word(cur_text.strip(), cur_start, min(cur_last + PARAKEET_FRAME_S, seg.end)))
    # word end = last token start + one frame; never overlap the next word
    for a, b in zip(words, words[1:]):
        a.end = min(a.end, b.start)
    return words, {"word_end_estimated": True,
                   "note": "onnx-asr exposes token start frames only; word ends = last token start + 80 ms"}


def _fill_missing(words: list[dict]) -> list[Word]:
    """WhisperX leaves numbers/symbols without timing; interpolate from neighbours."""
    out: list[Word] = []
    for i, w in enumerate(words):
        s, e = w.get("start"), w.get("end")
        if s is None or e is None:
            prev_end = next((words[j]["end"] for j in range(i - 1, -1, -1) if words[j].get("end") is not None), 0.0)
            nxt = next((words[j]["start"] for j in range(i + 1, len(words)) if words[j].get("start") is not None),
                       prev_end + 0.3)
            s, e = prev_end, nxt
        out.append(Word(w["word"], float(s), float(e)))
    return out


def run_whisperx(wav: Path, model_name: str, compute: str) -> tuple[list[Word], dict]:
    import whisperx
    audio = whisperx.load_audio(str(wav))
    model = whisperx.load_model(model_name, "cpu", compute_type=compute, language="en")
    result = model.transcribe(audio, batch_size=8, language="en")
    align_model, meta = whisperx.load_align_model(language_code="en", device="cpu")
    aligned = whisperx.align(result["segments"], align_model, meta, audio, "cpu", return_char_alignments=False)
    raw = [w for seg in aligned["segments"] for w in seg.get("words", [])]
    missing = sum(1 for w in raw if w.get("start") is None)
    return _fill_missing(raw), {"words_without_timing": missing}


def run_scribe(wav: Path, model_name: str) -> tuple[list[Word], dict]:
    import requests
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("ELEVENLABS_API_KEY missing - add it to .env (see .env.example)")
    with wav.open("rb") as f:
        r = requests.post("https://api.elevenlabs.io/v1/speech-to-text",
                          headers={"xi-api-key": key},
                          data={"model_id": model_name, "language_code": "en", "diarize": "true",
                                "tag_audio_events": "true", "timestamps_granularity": "word"},
                          files={"file": (wav.name, f, "audio/wav")}, timeout=3600)
    if r.status_code != 200:
        sys.exit(f"Scribe error {r.status_code}: {r.text[:500]}")
    body = r.json()
    words = [Word(w["text"].strip(), float(w["start"]), float(w["end"]), w.get("speaker_id"))
             for w in body.get("words", []) if w.get("type") == "word" and w["text"].strip()]
    events = [w["text"] for w in body.get("words", []) if w.get("type") == "audio_event"]
    return words, {"audio_events": len(events), "language_probability": body.get("language_probability")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--system", required=True, choices=["parakeet", "whisperx", "scribe"])
    ap.add_argument("--model")
    ap.add_argument("--quant", default=None, help="parakeet: None (fp32) or int8")
    ap.add_argument("--compute", default="int8", help="whisperx: int8 | float32")
    args = ap.parse_args()

    wav = episode_dir(args.id) / "audio16k.wav"
    if not wav.exists():
        sys.exit(f"run ingest first: {wav} missing")
    dur = wav_seconds(wav)

    t0 = time.perf_counter()
    if args.system == "parakeet":
        model = args.model or "nemo-parakeet-tdt-0.6b-v2"
        words, extra = run_parakeet(wav, model, args.quant)
    elif args.system == "whisperx":
        model = args.model or "large-v3"
        words, extra = run_whisperx(wav, model, args.compute)
    else:
        model = args.model or "scribe_v2"
        words, extra = run_scribe(wav, model)
    elapsed = time.perf_counter() - t0

    out = save_asr(args.id, args.system, model, words, dur, elapsed, extra)
    print(f"{args.system}/{model}: {len(words)} words, {dur:.0f}s audio in {elapsed:.0f}s "
          f"(RTF {elapsed / dur:.2f}) -> {out}")


if __name__ == "__main__":
    main()
