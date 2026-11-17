"""Fixtures: a temp project root with a copy of test_fallon's small JSON files, tiny ffmpeg-made media, and fake
clipper/*.py scripts (so no test can ever run the real pipeline or a paid API call)."""
from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app import create_app

from .helpers import BASE_URL, JOB

PROJECT = Path(__file__).resolve().parents[2]
REAL_JOB = PROJECT / "data" / "jobs" / "test_fallon"
SMALL_FILES = ["meta.json", "probe.json", "heatmap.json", "chapters.json", "info.json", "transcript.json",
               "words.json", "sentences.json", "candidates.json", "review.md"]
SCRIPTS = ["ingest.py", "transcribe.py", "diarize.py", "sentences.py", "select_clips.py", "reframe.py", "render.py"]

FAKE_SCRIPT = r'''
"""Fake pipeline stage for server tests. Behaviour per script name comes from <root>/fake.json."""
import json, os, subprocess, sys, time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
name = Path(__file__).name
cfg = {}
if (root / "fake.json").exists():
    cfg = json.loads((root / "fake.json").read_text(encoding="utf-8")).get(name, {})
with open(root / "calls.jsonl", "a", encoding="utf-8") as f:
    f.write(json.dumps({"script": name, "argv": sys.argv[1:]}) + "\n")
if name == "select_clips.py" and "--dry-run" in sys.argv:
    print("=== select [demo] ===")
    print("2 proposal calls (12,345 input tokens), ~8 judge calls, 3 rerank calls.")
    print("Estimated cost: ~$0.12 (PAID; rough - thinking tokens vary). Prompts written to selection")
    sys.exit(0)
if cfg.get("child"):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    (root / "child.pid").write_text(str(child.pid))
print(f"{name} start ünïcødé", flush=True)
for i in range(cfg.get("lines", 3)):
    print(f"line {i}", flush=True)
print("progress 10%\rprogress 50%\rprogress 100%", flush=True)
sys.stderr.write("to stderr\n")
sys.stderr.flush()
time.sleep(cfg.get("sleep", 0))
for rel in cfg.get("touch", []):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{}", encoding="utf-8")
sys.exit(cfg.get("exit", 0))
'''


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True,
                   stdin=subprocess.DEVNULL)


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not on PATH")
    d = tmp_path_factory.mktemp("media")
    ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i",
           "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
           str(d / "source.mp4"))
    ffmpeg("-f", "lavfi", "-i", "testsrc=size=108x192:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
           str(d / "clip.mp4"))
    return d


def build_root(root: Path, media_dir: Path) -> Path:
    if not REAL_JOB.is_dir():
        pytest.skip("data/jobs/test_fallon is not present")
    d = root / "data" / "jobs" / JOB
    d.mkdir(parents=True)
    for name in SMALL_FILES:
        shutil.copy2(REAL_JOB / name, d / name)
    for sub, pattern in (("selection", "*.json"), ("reframe", "*.json"), ("captions", "*.ass"),
                         ("renders", "*.report.json")):
        (d / sub).mkdir()
        for f in (REAL_JOB / sub).glob(pattern):
            shutil.copy2(f, d / sub / f.name)
    shutil.copy2(media_dir / "source.mp4", d / "source.mp4")
    for rep in (d / "renders").glob("*.report.json"):
        shutil.copy2(media_dir / "clip.mp4", d / "renders" / rep.name.replace(".report.json", ".mp4"))
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    meta["media"] = str(d / "source.mp4")
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    probe = json.loads((d / "probe.json").read_text(encoding="utf-8"))
    probe.update(vcodec="h264", duration=2.0, width=320, height=180)
    (d / "probe.json").write_text(json.dumps(probe), encoding="utf-8")
    (root / "clipper").mkdir()
    for s in SCRIPTS:
        (root / "clipper" / s).write_text(FAKE_SCRIPT, encoding="utf-8")
    return root


@pytest.fixture
def root(tmp_path: Path, media_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for var in ("ANTHROPIC_API_KEY", "HF_TOKEN", "ELEVENLABS_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    return build_root(tmp_path / "proj ünï", media_dir)      # space + unicode in every path on purpose


@pytest.fixture
def job_dir(root: Path) -> Path:
    return root / "data" / "jobs" / JOB


@pytest.fixture
def client(root: Path) -> Iterator[TestClient]:
    with TestClient(create_app(root, allowed_hosts=("127.0.0.1", "localhost")), base_url=BASE_URL) as c:
        yield c
