# VideoClipper

Turns a long YouTube video into finished vertical clips (1080×1920, captions, speaker framing, loudness-matched).

## Start the app
Double-click **`Clipper Studio.cmd`** in this folder. It opens http://127.0.0.1:8765 in your browser; close the
black window to stop it. (Terminal: `.venv/Scripts/python -m server`.) The app is local only.

## Use it
1. **New job** (top right): paste a YouTube link. Download, transcript and sentences run by themselves (free).
2. **Overview → Select clips**: shows a free cost estimate first; nothing is spent until you press
   "Spend ~$X and run". Sonnet judge is the default (~$0.10 per 10 min of video).
3. **Clips**: approve or reject picks; read why each was chosen (and what the judge rejected).
4. **Overview → Run everything** (or Reframe, then Render): makes the vertical videos (free, on this laptop:
   about 2 minutes to frame and 2–3 minutes to render per 30 s clip).
5. **Studio**: watch the clip next to the original with the crop drawn on it. Press **Edit** to trim, change the
   framing per shot, fix caption words, change the hook or title; **Save**, then **Render** (Fast to check, Final to post).
   "Reset clip to automatic" undoes all edits.
6. Download the MP4 from the Studio, or **Export zip** on the Clips screen. Files: `data/jobs/<id>/renders/`.

## Optional keys (`.env` in this folder, then restart the app)
- `ANTHROPIC_API_KEY` — needed for clip selection (paid).
- `HF_TOKEN` — free; labels who speaks (accept the terms of `pyannote/speaker-diarization-community-1` first).

## For developers
Pipeline: `clipper/` (see `clipper/README.md`). Server: `server/` (`pytest server/tests`). Interface: `web/`
(`npm run dev` with the server on 8765; `npm run build` to update what the app serves). Spec: `docs/UI_SPEC.md`.
