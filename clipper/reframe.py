"""Stage 3 - reframe 16:9 -> 9:16: shots, faces, tracks, active speaker, layout per shot, L1-optimal camera path.

Usage:
  python clipper/reframe.py --id JOB [--clip c02 ...] [--preview] [--proxy-width 640]
  python clipper/reframe.py --id JOB --start 100 --end 130 --preview        # ad-hoc range (clip id "manual")

Reads  source.*, probe.json, words.json, candidates.json (cut_in/cut_out per clip), edits/<clip>.json (optional
       user shot edits, re-applied after every analysis; the untouched plan is kept as `auto_shots`)
Writes reframe/<clip>.json         crop track: per-shot layout + per-frame crop boxes in SOURCE pixels, QA metrics
       reframe/<clip>_preview.mp4  (--preview) quick 540x960 check render. NOT the final render: stage 4 renders
                                   once from the source with these crops, captions and loudness.

Design: research/04-reframing.md. CPU only, free. v1 speaker evidence = landmark-aligned mouth motion, gated by
speech from words.json, smoothed with a Viterbi switch penalty and a 1 s minimum hold. Planned: LR-ASD scores and
pyannote diarization fusion (needs HF_TOKEN) as stronger evidence.

Frame indexing: every decode uses `-ss cut_in -t dur -vf fps=<probe fps_render>` so frame i is cut_in + i/fps in
analysis, preview and final render alike.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from fractions import Fraction
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, job_dir, read_json, stage_banner, write_json  # noqa: E402
from edits import apply_shot_edits, load_edits  # noqa: E402

YUNET = ROOT / "models" / "face_detection_yunet_2023mar.onnx"
OUT_W, OUT_H = 1080, 1920
DET_SCORE, TRACK_START_SCORE = 0.45, 0.65
FACE_MIN_W, FACE_MAX_W = 0.035, 0.55          # fraction of frame width (autoclip's tested values)
IOU_MATCH, MAX_GAP_S, MIN_TRACK_S = 0.25, 0.35, 0.5
MIN_SHOT_S = 0.4
MAIN_TRACK_SHARE = 0.30                       # a track must be visible in >=30% of the shot to matter
TWO_FIT = 0.85                                # two faces fit one 9:16 crop if their union <= 85% of crop width
SPLIT_TALK_SHARE = 0.20                       # both must hold >=20% of the shot's speaking frames for SPLIT
SWITCH_PENALTY_S, MIN_HOLD_S, LEAD_S = 0.6, 1.0, 0.2
MOTION_SMOOTH_S = 0.4
W1, W2, W3, W_T = 10.0, 1.0, 100.0, 1.0      # L1 path weights (Grundmann et al. 2011), target fidelity
DEADBAND = 0.06                               # target error below 6% of crop width is free (no micro-pans)
FACE_MARGIN = 0.10


# ---------------------------------------------------------------- decoding

def frames(media: Path, t0: float, dur: float, fps: str, width: int, height: int, matrix: str | None = None):
    """BGR frames. matrix (e.g. 'bt709') makes the YUV->RGB conversion explicit; swscale otherwise assumes BT.601,
    which shifts colours on HD sources - irrelevant for analysis, required for the final render."""
    vf = f"fps={fps},scale={width}:{height}:flags=area"
    if matrix:
        vf += f":in_color_matrix={matrix}:in_range=tv,format=bgr24"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{t0:.3f}", "-i", str(media), "-t", f"{dur:.3f}",
           "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=width * height * 3 * 4)
    n = width * height * 3
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield np.frombuffer(buf, np.uint8).reshape(height, width, 3)
    p.stdout.close()
    p.wait()


# ---------------------------------------------------------------- analysis pass (proxy)

def mouth_patch(gray: np.ndarray, lm: np.ndarray):
    import cv2
    (rx, ry), (lx, ly) = lm[3], lm[4]                  # YuNet landmarks: reye, leye, nose, rmouth, lmouth
    d = max(np.hypot(lx - rx, ly - ry), 4.0)
    cx, cy = (rx + lx) / 2, (ry + ly) / 2
    x0, x1 = int(cx - 0.75 * d), int(cx + 0.75 * d)
    y0, y1 = int(cy - 0.35 * d), int(cy + 0.60 * d)
    h, w = gray.shape
    if x0 < 0 or y0 < 0 or x1 > w or y1 > h or x1 - x0 < 4 or y1 - y0 < 3:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], (32, 20), interpolation=cv2.INTER_AREA).astype(np.float32)


def analyse(media: Path, t0: float, dur: float, fps: str, pw: int, ph: int):
    import cv2
    from scenedetect import FrameTimecode
    from scenedetect.detectors import AdaptiveDetector
    fpsf = float(Fraction(fps))
    det = cv2.FaceDetectorYN.create(str(YUNET), "", (pw, ph), DET_SCORE, 0.3, 5000)
    # min_scene_len 2: the detector's own minimum counts from the clip's first frame, so a cut 0.25 s into the
    # clip was invisible (c03 flashed 8 frames of the wrong shot). Short shots are merged below instead, except
    # at the clip edges, where they become held frames (see apply_edge_holds).
    sd = AdaptiveDetector(min_scene_len=2)
    cuts, dets = [], []
    n = 0
    for img in frames(media, t0, dur, fps, pw, ph):
        cuts += [c.frame_num for c in sd.process_frame(FrameTimecode(n, fps=fpsf), img)]
        _, faces = det.detect(img)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        fl = []
        for f in faces if faces is not None else []:
            x, y, w, h = f[:4]
            if not (FACE_MIN_W * pw <= w <= FACE_MAX_W * pw):
                continue
            lm = f[4:14].reshape(5, 2)
            fl.append({"box": np.array([x, y, w, h], np.float32), "lm": lm, "score": float(f[14]),
                       "patch": mouth_patch(gray, lm)})
        dets.append(fl)
        n += 1
    cuts += [c.frame_num for c in sd.post_process(FrameTimecode(n, fps=fpsf))]
    bounds = sorted({0, n, *[c for c in cuts if 0 < c < n]})
    shots = merge_short_shots([(a, b) for a, b in zip(bounds, bounds[1:]) if b > a], int(MIN_SHOT_S * fpsf))
    return shots, dets, n


def merge_short_shots(shots: list[tuple[int, int]], min_len: int) -> list[tuple[int, int]]:
    """Merge interior shots shorter than min_len into the previous shot; keep short FIRST/LAST shots separate
    (they are camera cuts right at the clip edge and get a held frame instead of a wrong crop)."""
    out: list[list[int]] = []
    for i, (a, b) in enumerate(shots):
        if out and 0 < i < len(shots) - 1 and b - a < min_len:
            out[-1][1] = b
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


EDGE_HOLD_MAX_S = 0.5     # an edge shot shorter than this shows a held frame of its neighbour


def apply_edge_holds(shots: list[dict], fpsf: float) -> list[dict]:
    """A camera cut within EDGE_HOLD_MAX_S of the clip start/end that could not be avoided (it falls inside
    speech, so cutsnap could not move the edge) leaves a sliver shot. Instead of cropping it badly, show the
    neighbouring shot's first (start) or last (end) frame, held still, with its framing. `hold_frame` is the
    clip-relative source frame to show; the renderer and previews honour it."""
    if len(shots) < 2:
        return shots
    out = list(shots)
    for edge, nb_i, frame_of in ((0, 1, lambda nb: nb["f0"]), (len(out) - 1, len(out) - 2, lambda nb: nb["f1"] - 1)):
        s, nb = out[edge], out[nb_i]
        n = s["f1"] - s["f0"]
        if n >= EDGE_HOLD_MAX_S * fpsf or nb.get("hold_frame") is not None:
            continue
        held = {k: v for k, v in nb.items() if k not in ("f0", "f1", "x", "speaker_track", "hard_cuts")}
        held.update(f0=s["f0"], f1=s["f1"], hold_frame=frame_of(nb),
                    reason=f"held frame: camera cut {n / fpsf:.2f}s from the clip edge, inside speech")
        if nb["layout"] == "TRACK":
            xi = 0 if edge == 0 else -1
            held.update(x=[nb["x"][xi]] * n, speaker_track=[nb["speaker_track"][xi]] * n, hard_cuts=[])
        out[edge] = held
    return out


def frames_with_holds(frame_iter, shots: list[dict]):
    """Yield (i, image) in output order, substituting held frames. Start holds need a frame that is decoded
    later, so frames are buffered until it arrives (a few frames, < EDGE_HOLD_MAX_S)."""
    want = {s["hold_frame"] for s in shots if s.get("hold_frame") is not None}
    hold_of = {}
    for s in shots:
        if s.get("hold_frame") is not None:
            for i in range(s["f0"], s["f1"]):
                hold_of[i] = s["hold_frame"]
    kept: dict[int, np.ndarray] = {}
    pending: list[int] = []                       # output indices waiting for a frame not decoded yet
    for k, img in enumerate(frame_iter):
        if k in want:
            kept[k] = img
        if k in hold_of and hold_of[k] > k:       # start hold: wait for the future frame
            pending.append(k)
            continue
        for p in pending:                         # flush waiting outputs once their frame exists
            if hold_of[p] in kept:
                yield p, kept[hold_of[p]]
        pending = [p for p in pending if hold_of[p] not in kept]
        yield k, kept[hold_of[k]] if k in hold_of else img
    for p in pending:                             # source ended before the held frame (should not happen)
        if hold_of[p] in kept:
            yield p, kept[hold_of[p]]


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a[0], a[1], a[0] + a[2], a[1] + a[3]
    bx1, by1, bx2, by2 = b[0], b[1], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0.0, min(ax2, bx2) - max(ax1, bx1)), max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-6)


def track_shot(dets, f0: int, f1: int, fpsf: float) -> list[dict]:
    """ByteTrack-style: high-score detections start/extend tracks, low-score ones only extend. Gaps interpolated."""
    from scipy.optimize import linear_sum_assignment
    tracks, live = [], []
    max_gap = int(MAX_GAP_S * fpsf)
    for f in range(f0, f1):
        ds = dets[f]
        live = [t for t in live if f - t["last"] <= max_gap]
        used = set()
        for pool in ([i for i, d in enumerate(ds) if d["score"] >= TRACK_START_SCORE],
                     [i for i, d in enumerate(ds) if d["score"] < TRACK_START_SCORE]):
            pool = [i for i in pool if i not in used]
            free = [t for t in live if t["last"] != f]
            if pool and free:
                cost = np.array([[1 - iou(t["obs"][t["last"]]["box"], ds[i]["box"]) for i in pool] for t in free])
                for r, c in zip(*linear_sum_assignment(cost)):
                    if 1 - cost[r, c] >= IOU_MATCH:
                        free[r]["obs"][f] = ds[pool[c]]
                        free[r]["last"] = f
                        used.add(pool[c])
        for i, d in enumerate(ds):
            if i not in used and d["score"] >= TRACK_START_SCORE:
                t = {"obs": {f: d}, "last": f}
                tracks.append(t)
                live.append(t)
    out = []
    for t in tracks:
        fs = sorted(t["obs"])
        if (fs[-1] - fs[0] + 1) < MIN_TRACK_S * fpsf:
            continue
        box = np.zeros((f1 - f0, 4), np.float32)
        have = np.zeros(f1 - f0, bool)
        for f in fs:
            box[f - f0] = t["obs"][f]["box"]
            have[f - f0] = True
        idx = np.arange(f1 - f0)
        span = (idx >= fs[0] - f0) & (idx <= fs[-1] - f0)
        for k in range(4):
            box[span, k] = np.interp(idx[span], idx[have], box[have, k])
        out.append({"box": box, "present": span, "obs": t["obs"]})
    return out


def motion(track: dict, f0: int, n: int, fpsf: float) -> np.ndarray:
    m = np.zeros(n, np.float32)
    prev = None
    for i in range(n):
        o = track["obs"].get(f0 + i)
        p = o["patch"] if o else None
        if p is not None and prev is not None:
            m[i] = float(np.mean(np.abs(p - prev))) / 255.0
        prev = p if p is not None else prev
    k = max(1, int(MOTION_SMOOTH_S * fpsf))
    m = np.convolve(m, np.ones(k) / k, mode="same")
    base = np.percentile(m[track["present"]], 20) if track["present"].any() else 0.0
    return np.clip(m - base, 0, None)


def viterbi(score: np.ndarray, penalty: float) -> np.ndarray:
    """score: (T, K), higher = more likely speaking. Returns state per frame."""
    T, K = score.shape
    acc = score[0].copy()
    back = np.zeros((T, K), np.int32)
    for t in range(1, T):
        stay = acc
        best = int(np.argmax(acc))
        switch = acc[best] - penalty
        back[t] = np.where(stay >= switch, np.arange(K), best)
        acc = np.maximum(stay, switch) + score[t]
    path = np.zeros(T, np.int32)
    path[-1] = int(np.argmax(acc))
    for t in range(T - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


def enforce_hold(path: np.ndarray, min_len: int, lead: int) -> np.ndarray:
    """Merge runs shorter than min_len into the previous run, then move each switch `lead` frames earlier."""
    p = path.copy()
    changed = True
    while changed:
        changed = False
        runs, s = [], 0
        for t in range(1, len(p) + 1):
            if t == len(p) or p[t] != p[s]:
                runs.append((s, t))
                s = t
        for i, (a, b) in enumerate(runs):
            if b - a < min_len and len(runs) > 1:
                p[a:b] = p[a - 1] if i > 0 else p[b]
                changed = True
                break
    out = p.copy()
    for t in range(1, len(p)):
        if p[t] != p[t - 1]:
            out[max(0, t - lead):t] = p[t]
    return out


# ---------------------------------------------------------------- camera path

def l1_path(target: np.ndarray, lo: np.ndarray, hi: np.ndarray, dz: float) -> np.ndarray:
    """min W1|D1p| + W2|D2p| + W3|D3p| + W_T*max(|p-t|-dz,0)  s.t. lo <= p <= hi.  (LP via HiGHS)"""
    from scipy import sparse
    from scipy.optimize import linprog
    n = len(target)
    if n < 4:
        return np.clip(target, lo, hi)
    D = [sparse.diags([-1, 1], [0, 1], shape=(n - 1, n), dtype=float)]
    D.append(sparse.diags([1, -2, 1], [0, 1, 2], shape=(n - 2, n), dtype=float))
    D.append(sparse.diags([-1, 3, -3, 1], [0, 1, 2, 3], shape=(n - 3, n), dtype=float))
    sizes = [n - 1, n - 2, n - 3, n]
    nv = n + sum(sizes)
    c = np.concatenate([np.zeros(n), W1 * np.ones(n - 1), W2 * np.ones(n - 2), W3 * np.ones(n - 3), W_T * np.ones(n)])
    rows, rhs = [], []
    off = n
    for Dk, sz in zip(D, sizes[:3]):
        S = sparse.hstack([sparse.csr_matrix((sz, off)), -sparse.eye(sz), sparse.csr_matrix((sz, nv - off - sz))])
        P = sparse.hstack([Dk, sparse.csr_matrix((sz, nv - n))])
        rows += [P + S, -P + S]
        rhs += [np.zeros(sz), np.zeros(sz)]
        off += sz
    E = sparse.hstack([sparse.csr_matrix((n, off)), -sparse.eye(n)])
    I = sparse.hstack([sparse.eye(n), sparse.csr_matrix((n, nv - n))])
    rows += [I + E, -I + E]
    rhs += [target + dz, -target + dz]
    bounds = [(float(a), float(b)) for a, b in zip(lo, hi)] + [(0, None)] * (nv - n)
    res = linprog(c, A_ub=sparse.vstack(rows).tocsr(), b_ub=np.concatenate(rhs), bounds=bounds, method="highs")
    return res.x[:n] if res.status == 0 else np.clip(target, lo, hi)


# ---------------------------------------------------------------- layout + crops

def even(v: float) -> int:
    return int(round(v / 2) * 2)


def panel_crop(box_src: np.ndarray, W: int, H: int, aspect: float, face_scale: float) -> dict:
    """Static crop around a face (median box over the shot), eyes ~40% from the top."""
    x, y, w, h = box_src
    ch = min(H, max(h * face_scale, 0.35 * H))
    cw = ch * aspect
    if cw > W:
        cw, ch = W, W / aspect
    cx, cy = x + w / 2, y + h * 0.40
    left = np.clip(cx - cw / 2, 0, W - cw)
    top = np.clip(cy - 0.40 * ch, 0, H - ch)
    return {"x": even(left), "y": even(top), "w": even(cw), "h": even(ch)}


def plan_shot(tracks, motions, speech, f0, f1, fpsf, W, H, sx, prev_layout) -> dict:
    n = f1 - f0
    cw = even(H * 9 / 16)
    main = [i for i, t in enumerate(tracks) if t["present"].mean() >= MAIN_TRACK_SHARE]
    shot = {"f0": f0, "f1": f1, "faces": len(main)}
    if not main:
        return {**shot, "layout": "FIT", "reason": "no usable face"}
    boxes = {i: tracks[i]["box"] * sx for i in main}          # proxy -> source pixels
    med = {i: np.median(boxes[i][tracks[i]["present"]], axis=0) for i in main}

    # who speaks: Viterbi over main tracks. Evidence is ~[-1, 1] per frame (LR-ASD logit/3, or scaled mouth
    # motion); absent faces get -1; frames with no speech carry no evidence (0 for all), so the camera holds.
    score = np.stack([np.where(tracks[i]["present"], motions[i], -1.0) for i in main], axis=1)
    score = np.where(speech[:, None] > 0, score, 0.0)
    # switching costs ~SWITCH_PENALTY_S seconds of half-strength evidence
    active = enforce_hold(viterbi(np.clip(score, -1, 1), SWITCH_PENALTY_S * fpsf * 0.5),
                          int(MIN_HOLD_S * fpsf), int(LEAD_S * fpsf))
    talk = np.array([(active == k)[speech > 0].mean() if (speech > 0).any() else 0 for k in range(len(main))])
    shot["talk_share"] = [round(float(v), 2) for v in talk]

    if len(main) >= 2:
        order = sorted(main, key=lambda i: med[i][0])           # left to right
        x0 = min(med[i][0] for i in main)
        x1 = max(med[i][0] + med[i][2] for i in main)
        if x1 - x0 <= TWO_FIT * cw:
            cx = (x0 + x1) / 2
            left = even(np.clip(cx - cw / 2, 0, W - cw))
            return {**shot, "layout": "GROUP", "crop": {"x": left, "y": 0, "w": cw, "h": H},
                    "reason": f"{len(main)} faces fit one 9:16 crop"}
        if len(main) == 2 and all(talk[main.index(i)] >= SPLIT_TALK_SHARE for i in main):
            top, bot = order
            return {**shot, "layout": "SPLIT",
                    "top": panel_crop(med[top], W, H, 9 / 8, 3.0), "bottom": panel_crop(med[bot], W, H, 9 / 8, 3.0),
                    "reason": "two people far apart, both talk"}
        if len(main) >= 3:
            return {**shot, "layout": "FIT", "reason": f"{len(main)} faces spread wide"}

    # TRACK: follow the active face; hard cut (separate path) when the speaker jumps far
    tgt = np.zeros(n)
    lo, hi = np.zeros(n), np.zeros(n)
    for t in range(n):
        i = main[active[t]]
        bx = boxes[i][t] if tracks[i]["present"][t] else med[i]
        m = FACE_MARGIN * bx[2]
        tgt[t] = bx[0] + bx[2] / 2 - cw / 2
        lo[t] = max(0.0, bx[0] + bx[2] + m - cw)
        hi[t] = min(W - cw, bx[0] - m)
        if lo[t] > hi[t]:
            lo[t] = hi[t] = np.clip(tgt[t], 0, W - cw)
    pieces, s = [], 0
    for t in range(1, n + 1):
        if t == n or (active[t] != active[t - 1] and abs(tgt[t] - tgt[t - 1]) > cw / 3):
            pieces.append((s, t))
            s = t
    x = np.concatenate([l1_path(tgt[a:b], lo[a:b], hi[a:b], DEADBAND * cw) for a, b in pieces])
    x = np.clip(np.round(x), 0, W - cw).astype(int)
    inside = np.mean([(x[t] <= boxes[main[active[t]]][t][0]) and
                      (x[t] + cw >= boxes[main[active[t]]][t][0] + boxes[main[active[t]]][t][2])
                      for t in range(n) if tracks[main[active[t]]]["present"][t]] or [1.0])
    return {**shot, "layout": "TRACK", "w": cw, "h": H, "x": x.tolist(), "speaker_track": active.tolist(),
            "hard_cuts": [f0 + a for a, _ in pieces[1:]], "face_inside": round(float(inside), 4),
            "reason": "single speaker in frame" if len(main) == 1 else "follow active speaker"}


def qa(shots: list[dict], fpsf: float) -> dict:
    xs = [np.array(s["x"]) for s in shots if s["layout"] == "TRACK"]
    v = np.concatenate([np.abs(np.diff(x)) for x in xs if len(x) > 1]) if xs else np.zeros(1)
    rev = sum(int(np.sum(np.diff(np.sign(np.diff(x)[np.abs(np.diff(x)) > 0.5])) != 0)) for x in xs if len(x) > 2)
    secs = sum(len(x) for x in xs) / fpsf or 1
    inside = [s["face_inside"] for s in shots if s["layout"] == "TRACK"]
    return {"layouts": {k: sum(1 for s in shots if s["layout"] == k) for k in ("TRACK", "GROUP", "SPLIT", "FIT")},
            "track_velocity_p95_px": round(float(np.percentile(v, 95)), 2),
            "direction_reversals_per_s": round(rev / secs, 3),
            "face_inside_min": min(inside) if inside else None}


# ---------------------------------------------------------------- preview

def preview(media: Path, plan: dict, out: Path, fps: str) -> None:
    import cv2
    W, H = plan["src_w"], plan["src_h"]
    pw, ph = OUT_W // 2, OUT_H // 2
    by_frame = []
    for s in plan["shots"]:
        by_frame += [s] * (s["f1"] - s["f0"])
    enc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", f"{pw}x{ph}", "-r", fps, "-i", "-", "-ss", f"{plan['cut_in']:.3f}", "-t", f"{plan['duration']:.3f}",
         "-i", str(media), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", str(out)], stdin=subprocess.PIPE)
    for i, img in frames_with_holds(frames(media, plan["cut_in"], plan["duration"], fps, W, H), plan["shots"]):
        s = by_frame[min(i, len(by_frame) - 1)]
        L = s["layout"]
        if L == "TRACK":
            x = s["x"][min(i - s["f0"], len(s["x"]) - 1)]
            o = cv2.resize(img[:, x:x + s["w"]], (pw, ph), interpolation=cv2.INTER_AREA)
        elif L == "GROUP":
            c = s["crop"]
            o = cv2.resize(img[c["y"]:c["y"] + c["h"], c["x"]:c["x"] + c["w"]], (pw, ph), interpolation=cv2.INTER_AREA)
        elif L == "SPLIT":
            o = np.vstack([cv2.resize(img[c["y"]:c["y"] + c["h"], c["x"]:c["x"] + c["w"]], (pw, ph // 2),
                                      interpolation=cv2.INTER_AREA) for c in (s["top"], s["bottom"])])
        else:
            bg = cv2.resize(img, (int(W * ph / H), ph))
            off = (bg.shape[1] - pw) // 2
            o = (cv2.GaussianBlur(bg[:, off:off + pw], (0, 0), 25) * 0.45).astype(np.uint8)
            fg = cv2.resize(img, (pw, int(H * pw / W)), interpolation=cv2.INTER_AREA)
            y0 = (ph - fg.shape[0]) // 2
            o[y0:y0 + fg.shape[0]] = fg
        cv2.putText(o, L, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)   # debug label
        enc.stdin.write(np.ascontiguousarray(o).tobytes())
    enc.stdin.close()
    enc.wait()


# ---------------------------------------------------------------- main

def asd_evidence(media: Path, wav: Path, cut_in: float, dur: float, fps: str, W: int, H: int, sx: float,
                 per_shot: list) -> list[list[np.ndarray]]:
    """LR-ASD logits per track per frame, scaled to ~[-1, 1]. One full-resolution decode pass cuts the face crops
    from median-smoothed tracks (as the repo does), then each track is resampled to 25 fps and scored."""
    import cv2
    from scipy.signal import medfilt
    from asd import LRASD, crop_face, mfcc_for
    fpsf = float(Fraction(fps))
    geo = []                                  # per shot, per track: (cx, cy, s) arrays in source pixels
    for f0, f1, tracks in per_shot:
        g = []
        for t in tracks:
            b = t["box"] * sx
            k = 13 if len(b) >= 13 else (len(b) // 2) * 2 + 1
            s = medfilt(np.maximum(b[:, 2], b[:, 3]) / 2, k)
            cx, cy = medfilt(b[:, 0] + b[:, 2] / 2, k), medfilt(b[:, 1] + b[:, 3] / 2, k)
            g.append((cx, cy, s))
            t["crops"] = {}
        geo.append(g)
    shot_of = np.zeros(sum(f1 - f0 for f0, f1, _ in per_shot), np.int32)
    for si, (f0, f1, _) in enumerate(per_shot):
        shot_of[f0:f1] = si
    for f, img in enumerate(frames(media, cut_in, dur, fps, W, H)):
        if f >= len(shot_of):
            break
        si = shot_of[f]
        f0, _, tracks = per_shot[si]
        gray = None
        for t, (cx, cy, s) in zip(tracks, geo[si]):
            j = f - f0
            if t["present"][j]:
                gray = gray if gray is not None else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                t["crops"][j] = crop_face(gray, cx[j], cy[j], s[j])
    model = LRASD()
    out = []
    for f0, f1, tracks in per_shot:
        evs = []
        for t in tracks:
            idx = np.flatnonzero(t["present"])
            a, b = idx[0], idx[-1] + 1
            T = int((b - a) / fpsf * 25)
            if T < 25:                                       # under 1 s: not enough for the model
                evs.append(np.where(t["present"], 0.0, -1.0))
                continue
            pick = np.clip(a + np.round(np.arange(T) / 25 * fpsf).astype(int), a, b - 1)
            faces = np.stack([t["crops"][j] for j in pick])
            mf = mfcc_for(wav, cut_in + (f0 + a) / fpsf, cut_in + (f0 + b) / fpsf + 0.1)
            sc = model.score(faces, mf)
            e = np.full(f1 - f0, -1.0)
            e[a:b] = np.interp((np.arange(a, b) - a) / fpsf, np.arange(T) / 25, sc)
            t["asd_mean"] = float(sc.mean())
            evs.append(np.clip(e / 3.0, -1, 1))
            del t["crops"]
        out.append(evs)
    return out


def reframe_clip(d: Path, clip_id: str, cut_in: float, cut_out: float, pr: dict, media: Path, words: list,
                 proxy_w: int, do_preview: bool, use_asd: bool = True, cand: dict | None = None) -> dict:
    t0 = time.perf_counter()
    fps = pr["fps_render"]
    fpsf = float(Fraction(fps))
    W, H = pr["width"], pr["height"]
    pw = proxy_w
    ph = even(pw * H / W)
    sx = W / pw
    dur = cut_out - cut_in
    shots_fr, dets, n = analyse(media, cut_in, dur, fps, pw, ph)
    t_an = time.perf_counter() - t0

    tt = cut_in + np.arange(n) / fpsf                      # speech gate: a word is being said at this frame
    speech = np.zeros(n, np.float32)
    for w in words:
        if w["end"] > cut_in and w["start"] < cut_out:
            speech[(tt >= w["start"] - 0.05) & (tt <= w["end"] + 0.05)] = 1.0

    per_shot = [(f0, f1, track_shot(dets, f0, f1, fpsf)) for f0, f1 in shots_fr]
    evidence = "LR-ASD (finetuning_TalkSet) + speech gate"
    if use_asd:
        try:
            ev = asd_evidence(media, d / "audio16k.wav", cut_in, dur, fps, W, H, sx, per_shot)
        except Exception as e:                       # never lose the clip over the speaker model
            print(f"  {clip_id}: LR-ASD failed ({e}); falling back to mouth motion", file=sys.stderr)
            use_asd = False
    if not use_asd:
        evidence = "mouth-motion fallback (weak: cannot tell laughing from talking)"
        ev = []
        for f0, f1, tracks in per_shot:
            ms = [motion(t, f0, f1 - f0, fpsf) for t in tracks]
            p95 = np.percentile(np.concatenate(ms), 95) if ms and np.concatenate(ms).max() > 0 else 1.0
            ev.append([np.clip(m / p95, 0, 1) for m in ms])
    t_asd = time.perf_counter() - t0 - t_an

    shots, prev = [], None
    for (f0, f1, tracks), evs in zip(per_shot, ev):
        s = plan_shot(tracks, evs, speech[f0:f1], f0, f1, fpsf, W, H, sx, prev)
        prev = s["layout"]
        shots.append(s)
    shots = apply_edge_holds(shots, fpsf)
    plan = {"clip": clip_id, "cut_in": cut_in, "cut_out": cut_out, "duration": round(dur, 3), "fps": fps,
            "frames": n, "src_w": W, "src_h": H, "out_w": OUT_W, "out_h": OUT_H, "proxy_w": pw,
            "speaker_evidence": evidence, "asd_seconds": round(t_asd, 1), "shots": shots,
            "qa": qa(shots, fpsf), "analysis_seconds": round(t_an, 1)}
    edits = load_edits(d / "edits" / f"{clip_id}.json", cand or {})     # user framing edits survive re-analysis
    for w in apply_shot_edits(plan, edits):
        print(f"  {clip_id}: {w}", file=sys.stderr)
    rd = d / "reframe"
    rd.mkdir(exist_ok=True)
    write_json(rd / f"{clip_id}.json", plan)
    msg = (f"  {clip_id}: {n} frames, {len(shots)} shots {plan['qa']['layouts']}, "
           f"reversals/s {plan['qa']['direction_reversals_per_s']}, face inside min {plan['qa']['face_inside_min']}"
           f" (analysis {t_an:.0f}s)")
    if do_preview:
        preview(media, plan, rd / f"{clip_id}_preview.mp4", fps)
        msg += f", preview {time.perf_counter() - t0 - t_an:.0f}s"
    print(msg, flush=True)
    return plan


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--clip", nargs="*", help="clip ids from candidates.json (default: all)")
    ap.add_argument("--start", type=float)
    ap.add_argument("--end", type=float)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--proxy-width", type=int, default=640)
    ap.add_argument("--no-asd", action="store_true", help="use the weak mouth-motion fallback instead of LR-ASD")
    args = ap.parse_args()
    stage_banner("reframe", args.id)
    d = job_dir(args.id)
    if not YUNET.exists():
        sys.exit(f"missing face model {YUNET} (see clipper/README.md)")
    pr = read_json(d / "probe.json")
    media = Path(read_json(d / "meta.json")["media"])
    words = read_json(d / "words.json")["words"]
    if args.start is not None:
        clips = [("manual", args.start, args.end, None)]
    else:
        cands = read_json(d / "candidates.json")
        clips = [(c["id"], c["cut_in"], c["cut_out"], c) for c in cands if not args.clip or c["id"] in args.clip]
    if pr.get("rotation"):
        sys.exit("rotated sources are not supported yet")
    for cid, a, b, cand in clips:
        reframe_clip(d, cid, a, b, pr, media, words, args.proxy_width, args.preview, use_asd=not args.no_asd,
                     cand=cand)


if __name__ == "__main__":
    main()
