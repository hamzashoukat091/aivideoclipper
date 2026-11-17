"""Snap clip edges to camera cuts that fall in the silence before the first word / after the last word.

Why: a clip whose audio cut sits a few frames before a camera cut starts on a sliver of the previous shot (e.g.
4 frames of a wide two-shot before the close-up). The reframer cannot frame that sliver well, so it flashes.
If the camera cut lies in the pause, starting (or ending) exactly on it costs no words: the cut moves only inside
the silence that was already chosen. Found while checking the Studio view, 2026-11-17.

Only free local work (ffmpeg decode of ~1 s per edge + PySceneDetect ContentDetector).
"""
from __future__ import annotations

import subprocess
from fractions import Fraction
from pathlib import Path

import numpy as np

WINDOW_S = 0.6            # how far from the edge a camera cut is looked for
SPEECH_GUARD_S = 0.03     # never move the in-point closer than this to the first word
TAIL_GUARD_S = 0.06       # never move the out-point closer than this to the end of the last word
PRE_ROLL_S = 0.25         # decode a little before the window so the detector has context
PROXY_W, PROXY_H = 320, 180


def _frames(media: Path, t0: float, dur: float, fps: str):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{max(t0, 0):.3f}", "-i", str(media),
           "-t", f"{dur:.3f}", "-an", "-vf", f"fps={fps},scale={PROXY_W}:{PROXY_H}:flags=area",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = PROXY_W * PROXY_H * 3
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield np.frombuffer(buf, np.uint8).reshape(PROXY_H, PROXY_W, 3)
    p.stdout.close()
    p.wait()


def camera_cuts(media: Path, t0: float, t1: float, fps: str) -> list[float]:
    """Times (source seconds, first frame of the new shot) of hard cuts in [t0, t1]."""
    from scenedetect import FrameTimecode
    from scenedetect.detectors import ContentDetector
    fpsf = float(Fraction(fps))
    start = max(t0 - PRE_ROLL_S, 0.0)
    det = ContentDetector(min_scene_len=1)
    cuts: list[int] = []
    for n, img in enumerate(_frames(media, start, t1 - start + 1 / fpsf, fps)):
        cuts += [c.frame_num for c in det.process_frame(FrameTimecode(n, fps=fpsf), img)]
    times = [start + c / fpsf for c in cuts]
    return [t for t in times if t0 <= t <= t1]


def snap(media: Path, fps: str, cut_in: float, cut_out: float, speech_start: float, speech_end: float
         ) -> tuple[float, float, list[str]]:
    """Return (cut_in, cut_out, notes). Edges move only inside the silence, never across a word."""
    fpsf = float(Fraction(fps))
    half = 0.5 / fpsf
    notes: list[str] = []
    a, b = cut_in, min(cut_in + WINDOW_S, speech_start - SPEECH_GUARD_S)
    if b - a > 1 / fpsf:
        cuts = camera_cuts(media, a, b, fps)
        if cuts:
            new = round(cuts[-1] + half, 3)        # the latest cut before speech: no frame of the old shot left
            if new < speech_start - SPEECH_GUARD_S:
                notes.append(f"start moved {new - cut_in:+.3f}s to a camera cut")
                cut_in = new
    a, b = max(cut_out - WINDOW_S, speech_end + TAIL_GUARD_S), cut_out
    if b - a > 1 / fpsf:
        cuts = camera_cuts(media, a, b, fps)
        if cuts:
            new = round(cuts[0] - half, 3)         # end just before the first cut after speech
            if new > speech_end + TAIL_GUARD_S:
                notes.append(f"end moved {new - cut_out:+.3f}s to a camera cut")
                cut_out = new
    return cut_in, cut_out, notes
