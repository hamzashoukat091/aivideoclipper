# ASR bake-off

Decides the transcription engine (CLAUDE.md "Chosen stack"). Compares Parakeet-TDT-0.6B-v2 (local, onnx-asr),
WhisperX large-v3 + wav2vec2 alignment (local), and ElevenLabs Scribe (PAID API) on the same audio slices.

## Setup (once)
```
python -m venv .venv
.venv/Scripts/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
.venv/Scripts/python -m pip install "onnx-asr[cpu,hub]" whisperx jiwer requests python-dotenv soundfile truststore
```
For Scribe, copy `.env.example` to `.env` and set `ELEVENLABS_API_KEY`.

This machine re-signs TLS (antivirus/proxy root in the Windows store). The scripts handle it without disabling
verification: Python uses `truststore`; yt-dlp gets `--compat-options no-certifi` plus an exported Windows-roots PEM.

## Run (per episode)
```
.venv/Scripts/python bakeoff/ingest.py <url-or-file> --id ep1 --start 600 --duration 1200 [--ref ref.vtt]
.venv/Scripts/python bakeoff/run_asr.py --id ep1 --system parakeet
.venv/Scripts/python bakeoff/run_asr.py --id ep1 --system whisperx      # slow on CPU: ~5x real time
.venv/Scripts/python bakeoff/run_asr.py --id ep1 --system scribe        # PAID, ~$0.20/audio-hour
.venv/Scripts/python bakeoff/score.py --ids ep1 ep2 ep3
```
Report: `data/bakeoff/report.md`. Blind listening pack: `data/bakeoff/<id>/listen/` (key in `KEY_dont_peek.json`).

## Picking good test episodes
- Episodes **with human-made English captions** (CC icon, not "auto-generated"), or supply `--ref` with a
  hand-checked transcript. Without a reference, only timing agreement and boundary checks are possible.
- Cover the hard cases: 2+ speakers with crosstalk, fast talker, background music/noise, jargon/names.
- 20-minute slices keep CPU time sane (WhisperX ~100 min, Parakeet ~7 min per slice on this laptop).

## How to decide
1. Listening pack first: which system clips syllables at sentence starts/ends (that's what breaks clips).
2. WER (no fillers) second: differences under ~1 point are noise at this sample size.
3. Then speed/cost. Ties go to the free/local option.

## Known caveats
- onnx-asr gives Parakeet token *start* frames only; word ends are estimated (last token start + 80 ms).
- Parakeet runs on VAD chunks (max 20 s); punctuation can break at chunk edges, which affects sentence splitting.
- YouTube manual captions are often lightly edited (fillers removed), so WER is "agreement with captions".
- Boundary risk is an energy heuristic and noisy on small samples - the listening pack is the arbiter.
