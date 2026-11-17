"""Read endpoints: health, system, jobs list/detail, transcript, selection, clips, files, thumbnail, poster, zip."""
from __future__ import annotations

import io
import json
import os
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from .helpers import JOB

STAGE_KEYS = ["ingest", "transcribe", "diarize", "sentences", "select", "reframe", "render"]
SUMMARY_KEYS = {"id", "title", "channel", "source", "duration", "height", "fps", "created", "updated",
                "thumbnail_url", "stages", "clips", "cost_usd", "active_run", "warnings"}
DETAIL_KEYS = SUMMARY_KEYS | {"meta", "probe", "heatmap", "chapters", "source_media", "info", "speakers"}
CANDIDATE_EXTRA = {"text", "reframe", "render"}


def test_health(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["version"]


def test_system_reports_key_presence_never_values(client: TestClient, root: Path,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    (root / ".env").write_text("HF_TOKEN=hf_SECRETVALUE123\nELEVENLABS_API_KEY=\n", encoding="utf-8")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-SECRETVALUE456")
    r = client.get("/api/system")
    assert r.status_code == 200
    body = r.json()
    assert body["keys"] == {"anthropic": True, "hf": True, "elevenlabs": False}
    assert "SECRETVALUE" not in r.text
    assert "HF_TOKEN" not in os.environ                       # .env is read, never exported
    assert set(body) == {"version", "root", "jobs_dir", "tools", "keys", "assets", "queue", "spend"}
    assert set(body["tools"]) == {"ffmpeg", "ffprobe", "yt-dlp", "deno", "python", "node"}
    assert all(set(t) == {"ok", "version"} for t in body["tools"].values())
    assert body["assets"] == {"yunet": False, "lrasd": False, "fonts": False}
    assert body["queue"] == {"running": None, "queued": []}
    assert body["spend"]["by_job"] == [{"job_id": JOB, "usd": pytest.approx(0.0999)}]


def test_jobs_list_skips_hidden_and_unfinished(client: TestClient, root: Path) -> None:
    jobs = root / "data" / "jobs"
    for name in ("_certs", ".hidden", "empty", "Upper"):
        (jobs / name).mkdir()
        (jobs / name / "meta.json").write_text("{}") if name != "empty" else None
    r = client.get("/api/jobs")
    assert r.status_code == 200
    assert [j["id"] for j in r.json()] == [JOB]
    job = r.json()[0]
    assert set(job) == SUMMARY_KEYS
    assert [s["key"] for s in job["stages"]] == STAGE_KEYS


def test_jobs_sorted_by_updated(client: TestClient, root: Path, job_dir: Path) -> None:
    other = root / "data" / "jobs" / "older"
    other.mkdir()
    (other / "meta.json").write_text(json.dumps({"title": "Older"}))
    old = time.time() - 3600
    os.utime(other / "meta.json", (old, old))
    os.utime(other, (old, old))
    assert [j["id"] for j in client.get("/api/jobs").json()] == [JOB, "older"]
    later = time.time() + 10
    os.utime(other / "meta.json", (later, later))
    assert [j["id"] for j in client.get("/api/jobs").json()] == ["older", JOB]


def test_job_detail(client: TestClient, job_dir: Path) -> None:
    r = client.get(f"/api/jobs/{JOB}")
    assert r.status_code == 200
    j = r.json()
    assert set(j) == DETAIL_KEYS
    assert j["title"].startswith("Anne Hathaway") and j["channel"]
    assert j["height"] == 1080 and j["fps"] == pytest.approx(29.97, abs=0.01)
    assert j["thumbnail_url"] == f"/api/jobs/{JOB}/thumbnail"
    assert j["source_media"] == {"url": f"/media/{JOB}/source", "playable_hint": True, "proxy_url": None}
    assert j["info"]["webpage_url"].startswith("https://www.youtube.com/") and j["info"]["view_count"] > 0
    assert set(j["info"]) <= {"webpage_url", "upload_date", "view_count", "thumbnail"}
    assert j["speakers"] == []
    assert j["heatmap"] and set(j["heatmap"][0]) == {"start", "end", "value"}
    assert j["chapters"][0]["title"]
    assert j["clips"] == {"candidates": 3, "approved": 0, "rejected": 0, "pending": 3, "reframed": 3,
                          "rendered": 3, "failed_checks": 0}
    assert j["cost_usd"] == pytest.approx(0.0999)
    assert "No HF_TOKEN: speakers unlabelled" in j["warnings"]
    assert j["active_run"] is None
    states = {s["key"]: s["state"] for s in j["stages"]}
    assert states == {"ingest": "done", "transcribe": "done", "diarize": "skipped", "sentences": "done",
                      "select": "done", "reframe": "done", "render": "done"}
    diar = next(s for s in j["stages"] if s["key"] == "diarize")
    assert diar["note"] == "No HF_TOKEN — speakers not labelled"
    select = next(s for s in j["stages"] if s["key"] == "select")
    assert "$0.10 spent" in select["note"]
    out = {o["path"] for o in select["outputs"]}
    assert {"candidates.json", "review.md", "selection/cost.json"} <= out
    for stage in j["stages"]:
        assert set(stage) == {"key", "label", "state", "updated", "note", "outputs"}
        for o in stage["outputs"]:
            assert set(o) == {"path", "size", "mtime", "kind", "url"}


def test_job_not_found_and_bad_id(client: TestClient) -> None:
    r = client.get("/api/jobs/nope")
    assert r.status_code == 404 and r.json()["error"] == "not_found" and r.json()["message"]
    r = client.get("/api/jobs/BAD..ID")
    assert r.status_code == 400 and r.json()["error"] == "bad_id"
    r = client.get("/api/jobs/_certs")
    assert r.status_code == 400


def test_transcript_from_sentences(client: TestClient) -> None:
    t = client.get(f"/api/jobs/{JOB}/transcript").json()
    assert t["language"] == "en" and t["model"].startswith("whisperx")
    assert t["word_count"] == 1971 and len(t["sentences"]) == 283
    s0 = t["sentences"][0]
    assert set(s0) == {"i", "start", "end", "speaker", "text", "heat", "loud_z", "pause_before", "pause_after"}


def test_transcript_fallback_to_segments(client: TestClient, job_dir: Path) -> None:
    (job_dir / "sentences.json").unlink()
    t = client.get(f"/api/jobs/{JOB}/transcript").json()
    assert len(t["sentences"]) == 274
    assert t["sentences"][3]["i"] == 3 and t["sentences"][0]["heat"] is None and t["sentences"][0]["loud_z"] == 0.0
    for name in ("transcript.json",):
        (job_dir / name).unlink()
    assert client.get(f"/api/jobs/{JOB}/transcript").status_code == 404


def test_selection(client: TestClient, job_dir: Path) -> None:
    s = client.get(f"/api/jobs/{JOB}/selection").json()
    assert set(s) == {"candidates", "rejected_by_judge", "cost", "review_md"}
    assert [c["id"] for c in s["candidates"]] == ["c02", "c03", "c05"]
    c = s["candidates"][1]
    assert CANDIDATE_EXTRA <= set(c)
    assert c["text"].startswith("I'm not huge on looking back.")
    plan = json.loads((job_dir / "reframe" / "c03.json").read_text(encoding="utf-8"))
    assert c["reframe"]["state"] == "done"
    assert c["reframe"]["layouts"] == list(dict.fromkeys(sh["layout"] for sh in plan["shots"]))
    assert c["reframe"]["url"] == f"/media/{JOB}/reframe/c03.json" and c["reframe"]["preview_url"] is None
    assert c["reframe"]["qa"] == plan["qa"]
    r = c["render"]
    assert r["state"] == "done" and r["video_url"] == f"/media/{JOB}/renders/c03.mp4"
    assert r["download_url"] == f"/media/{JOB}/renders/c03.mp4?download=1"
    assert r["poster_url"] == f"/api/jobs/{JOB}/clips/c03/poster"
    assert r["captions_url"] == f"/media/{JOB}/captions/c03.ass"
    assert r["report"]["checks"]["1080x1920"] is True
    rej = s["rejected_by_judge"]
    assert [x["id"] for x in rej] == ["c01", "c04"]
    assert set(rej[0]) == {"id", "title", "start_sentence", "end_sentence", "start", "end", "overall", "reason",
                           "source"}
    assert rej[0]["reason"] and rej[0]["start"] < rej[0]["end"]
    assert s["cost"]["total_usd"] == pytest.approx(0.0999)
    assert s["review_md"].startswith("#")


def test_selection_empty_job(client: TestClient, root: Path) -> None:
    (root / "data" / "jobs" / "bare").mkdir()
    s = client.get("/api/jobs/bare/selection").json()
    assert s == {"candidates": [], "rejected_by_judge": [], "cost": None, "review_md": None}


def test_reframe_plan(client: TestClient) -> None:
    p = client.get(f"/api/jobs/{JOB}/clips/c03/reframe").json()
    assert p["clip"] == "c03" and p["shots"][0]["layout"] == "TRACK"
    r = client.get(f"/api/jobs/{JOB}/clips/c99/reframe")
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    assert client.get(f"/api/jobs/{JOB}/clips/C99/reframe").json()["error"] == "bad_id"


def test_captions(client: TestClient) -> None:
    c = client.get(f"/api/jobs/{JOB}/clips/c03/captions").json()
    assert c["url"] == f"/media/{JOB}/captions/c03.ass"
    assert c["events"][0] == {"start": 0.0, "end": 3.0, "text": "SHE DOESN'T REMEMBER HER MOST FAMOUS MOVIE",
                              "active": None, "kind": "hook"}
    assert c["events"][1] == {"start": 0.02, "end": 0.37, "text": "I'M NOT HUGE", "active": 0, "kind": "caption"}
    assert c["events"][3]["active"] == 2
    assert all(e["kind"] == "caption" for e in c["events"][1:])
    assert client.get(f"/api/jobs/{JOB}/clips/c99/captions").status_code == 404


def test_files(client: TestClient, job_dir: Path) -> None:
    (job_dir / "ui").mkdir()
    (job_dir / "ui" / "thumb.jpg").write_bytes(b"x")
    f = client.get(f"/api/jobs/{JOB}/files").json()
    paths = [e["path"] for e in f]
    assert paths == sorted(paths)
    assert "renders/c03.mp4" in paths and "captions/c03.ass" in paths and "meta.json" in paths
    assert not any(p.startswith("ui/") for p in paths)
    kinds = {e["path"]: e["kind"] for e in f}
    assert kinds["renders/c03.mp4"] == "video" and kinds["captions/c03.ass"] == "subtitle"
    assert kinds["review.md"] == "text" and kinds["meta.json"] == "json"
    e = next(e for e in f if e["path"] == "renders/c03.mp4")
    assert e["url"] == f"/media/{JOB}/renders/c03.mp4" and e["size"] > 0 and e["mtime"].endswith("Z")


def test_thumbnail_and_cache(client: TestClient, job_dir: Path) -> None:
    r = client.get(f"/api/jobs/{JOB}/thumbnail")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg" and r.content[:2] == b"\xff\xd8"
    thumb = job_dir / "ui" / "thumb.jpg"
    first = thumb.stat().st_mtime_ns
    assert client.get(f"/api/jobs/{JOB}/thumbnail").status_code == 200
    assert thumb.stat().st_mtime_ns == first                  # cached
    future = time.time() + 5
    os.utime(job_dir / "source.mp4", (future, future))
    assert client.get(f"/api/jobs/{JOB}/thumbnail").status_code == 200
    assert thumb.stat().st_mtime_ns != first                  # source newer -> regenerated


def test_thumbnail_404_before_ingest(client: TestClient, root: Path) -> None:
    (root / "data" / "jobs" / "fresh").mkdir()
    r = client.get("/api/jobs/fresh/thumbnail")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_poster_regenerated_when_render_newer(client: TestClient, job_dir: Path) -> None:
    r = client.get(f"/api/jobs/{JOB}/clips/c03/poster")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    poster = job_dir / "ui" / "posters" / "c03.jpg"
    first = poster.stat().st_mtime_ns
    client.get(f"/api/jobs/{JOB}/clips/c03/poster")
    assert poster.stat().st_mtime_ns == first
    future = time.time() + 5
    os.utime(job_dir / "renders" / "c03.mp4", (future, future))
    client.get(f"/api/jobs/{JOB}/clips/c03/poster")
    assert poster.stat().st_mtime_ns != first
    assert client.get(f"/api/jobs/{JOB}/clips/c99/poster").status_code == 404


def test_export_zip_default_and_subset(client: TestClient) -> None:
    r = client.get(f"/api/jobs/{JOB}/export.zip")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert f'filename="{JOB}-clips.zip"' in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert z.testzip() is None
    names = set(z.namelist())
    assert {"renders/c02.mp4", "renders/c03.report.json", "captions/c05.ass", "candidates.json",
            "review.md"} <= names
    assert json.loads(z.read("candidates.json"))[0]["id"] == "c02"
    r = client.get(f"/api/jobs/{JOB}/export.zip?clips=c03")
    names = set(zipfile.ZipFile(io.BytesIO(r.content)).namelist())
    assert names == {"renders/c03.mp4", "renders/c03.report.json", "captions/c03.ass", "candidates.json",
                     "review.md"}
    assert client.get(f"/api/jobs/{JOB}/export.zip?clips=../x").status_code == 400
