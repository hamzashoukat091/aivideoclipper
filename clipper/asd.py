"""Active speaker detection with LR-ASD (MIT, Liao et al. IJCV'25), CPU inference, vendored in vendor/LR-ASD.

Inputs follow the repo's Columbia_test.py exactly: 25 fps grayscale 112x112 face crops (square centred at
(cx, cy + 0.4*s), half-size 0.7*s, s = half the larger box side, median-smoothed over 13 frames) and 13-coef
MFCC at 100 frames/s (python_speech_features defaults). Output: one logit per 25 fps frame, > 0 = speaking.
Scores are averaged over chunk lengths {1,1,1,2,2,2,3,3,4,5,6} s, as the repo does for reliability.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT / "vendor" / "LR-ASD"
WEIGHTS = REPO / "weight" / "finetuning_TalkSet.model"   # TalkSet fine-tune: better in-the-wild (research/04)
DURATIONS = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6]
CROP_HALF, CROP_DROP = 0.7, 0.4


def crop_face(gray: np.ndarray, cx: float, cy: float, s: float) -> np.ndarray:
    import cv2
    h = CROP_HALF * s
    x0, x1 = int(round(cx - h)), int(round(cx + h))
    y0, y1 = int(round(cy + CROP_DROP * s - h)), int(round(cy + CROP_DROP * s + h))
    H, W = gray.shape
    pad = max(0, -x0, -y0, x1 - W, y1 - H)
    if pad:                                              # repo pads with grey 110
        gray = np.pad(gray, pad, constant_values=110)
        x0, x1, y0, y1 = x0 + pad, x1 + pad, y0 + pad, y1 + pad
    return cv2.resize(gray[y0:y1, x0:x1], (112, 112), interpolation=cv2.INTER_AREA)


class LRASD:
    def __init__(self):
        import torch
        import torch.nn as nn
        sys.path.insert(0, str(REPO))
        from model.Model import ASD_Model   # noqa: E402  (vendored repo)
        from loss import lossAV              # noqa: E402

        class Net(nn.Module):
            def __init__(self):
                super().__init__()
                self.model = ASD_Model()
                self.lossAV = lossAV()

        self.torch = torch
        self.net = Net()
        state = torch.load(str(WEIGHTS), map_location="cpu")
        own = self.net.state_dict()
        missing = [k for k in own if k not in state]
        if missing:
            raise RuntimeError(f"LR-ASD weights missing keys: {missing[:5]}")
        self.net.load_state_dict({k: v for k, v in state.items() if k in own})
        self.net.eval()

    def score(self, faces: np.ndarray, mfcc: np.ndarray) -> np.ndarray:
        """faces (T,112,112) uint8 at 25 fps, mfcc (>=4T, 13). Returns (T,) logits."""
        torch = self.torch
        T = min(len(faces), mfcc.shape[0] // 4)
        if T < 1:
            return np.zeros(len(faces))
        faces, mfcc = faces[:T], mfcc[: T * 4]
        L = T / 25
        runs = []
        with torch.no_grad():
            for dur in DURATIONS:
                out = []
                for i in range(int(math.ceil(L / dur))):
                    a = torch.FloatTensor(mfcc[i * dur * 100:(i + 1) * dur * 100]).unsqueeze(0)
                    v = torch.FloatTensor(faces[i * dur * 25:(i + 1) * dur * 25]).unsqueeze(0)
                    if v.shape[1] == 0 or a.shape[1] < 4:
                        continue
                    ea = self.net.model.forward_audio_frontend(a)
                    ev = self.net.model.forward_visual_frontend(v)
                    o = self.net.model.forward_audio_visual_backend(ea, ev)
                    out.extend(self.net.lossAV.forward(o, labels=None).tolist())
                runs.append(np.array(out[:T] + [out[-1]] * (T - len(out)) if out else np.zeros(T)))
        s = np.mean(runs, axis=0)
        if len(s) < len(faces):
            s = np.concatenate([s, np.full(len(faces) - len(s), s[-1] if len(s) else 0.0)])
        return s


def mfcc_for(wav16k: Path, t0: float, t1: float) -> np.ndarray:
    import python_speech_features
    import soundfile as sf
    x, sr = sf.read(str(wav16k), dtype="int16", start=int(t0 * 16000), stop=int(t1 * 16000))
    return python_speech_features.mfcc(x, sr, numcep=13, winlen=0.025, winstep=0.010)
