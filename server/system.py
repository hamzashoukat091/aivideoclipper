"""SystemInfo pieces: tool versions (cached), API key presence (booleans only), bundled assets, spend ledger."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from dotenv import dotenv_values

from .jobs import cost_usd
from .paths import JOB_ID

TOOL_CACHE_S = 60.0
TOOLS: dict[str, list[str]] = {"ffmpeg": ["-version"], "ffprobe": ["-version"], "yt-dlp": ["--version"],
                               "deno": ["--version"], "node": ["--version"]}
KEY_VARS = {"anthropic": "ANTHROPIC_API_KEY", "hf": "HF_TOKEN", "elevenlabs": "ELEVENLABS_API_KEY"}


def key_presence(root: Path) -> dict[str, bool]:
    """Which API keys are configured (process environment or `<root>/.env`). Values are read only to test for
    non-emptiness and are never stored, returned or exported to os.environ."""
    try:
        dot = dotenv_values(root / ".env") if (root / ".env").is_file() else {}
    except (OSError, ValueError):
        dot = {}
    return {name: bool((os.environ.get(var) or "").strip() or (dot.get(var) or "").strip())
            for name, var in KEY_VARS.items()}


def asset_presence(root: Path) -> dict[str, bool]:
    fonts = root / "assets" / "fonts"
    return {"yunet": (root / "models" / "face_detection_yunet_2023mar.onnx").is_file(),
            "lrasd": (root / "vendor" / "LR-ASD" / "weight" / "finetuning_TalkSet.model").is_file(),
            "fonts": (fonts / "Montserrat-Black.ttf").is_file() and (fonts / "Montserrat-ExtraBold.ttf").is_file()}


def _first_line(text: str) -> str | None:
    """First non-empty line, without trailing build/copyright noise
    ('ffmpeg version 2024-09-19-git-… Copyright (c) 2000-2024 …' -> 'ffmpeg version 2024-09-19-git-…')."""
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), None)
    if line and " Copyright" in line:
        line = line.split(" Copyright", 1)[0].strip()
    return line[:200] if line else None


def _probe_tool(name: str, args: list[str]) -> dict[str, Any]:
    exe = shutil.which(name) or shutil.which(name, path=str(Path(sys.executable).parent))
    if exe is None:
        return {"ok": False, "version": None}
    try:
        p = subprocess.run([exe, *args], check=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=15, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return {"ok": False, "version": None}
    return {"ok": p.returncode == 0, "version": _first_line(p.stdout or p.stderr or "")}


class ToolCache:
    """Tool versions, refreshed at most every TOOL_CACHE_S seconds."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._at = 0.0
        self._value: dict[str, dict[str, Any]] = {}

    def get(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            if not self._value or time.monotonic() - self._at > TOOL_CACHE_S:
                tools = {name: _probe_tool(name, args) for name, args in TOOLS.items()}
                tools["python"] = {"ok": True, "version": f"Python {sys.version.split()[0]}"}
                self._value, self._at = tools, time.monotonic()
            return {k: dict(v) for k, v in self._value.items()}


def spend(jobs_dir: Path) -> dict[str, Any]:
    by_job = []
    if jobs_dir.is_dir():
        for d in sorted(jobs_dir.iterdir()):
            if d.is_dir() and JOB_ID.fullmatch(d.name):
                usd = cost_usd(d)
                if usd > 0:
                    by_job.append({"job_id": d.name, "usd": round(usd, 4)})
    by_job.sort(key=lambda r: -r["usd"])
    return {"total_usd": round(sum(r["usd"] for r in by_job), 4), "by_job": by_job}
