"""Pure helpers: id/path validation, ASS parsing, job-id derivation, estimate parsing, UTF-8 chunking."""
from __future__ import annotations

from pathlib import Path

import pytest

from server.ass import parse_ass, parse_time
from server.errors import ApiError
from server.estimate import parse_estimate
from server.paths import (
    check_clip_id,
    check_job_id,
    check_run_id,
    safe_join,
    write_json_atomic,
)
from server.routes.runs import _complete_utf8, _display_line, _sse
from server.sources import default_job_id, normalize_source, slug, youtube_id


@pytest.mark.parametrize("good", ["a", "test_fallon", "0abc-def_1", "a" * 64])
def test_job_id_ok(good: str) -> None:
    assert check_job_id(good) == good


@pytest.mark.parametrize("bad", ["", "_certs", ".x", "-a", "A", "a/b", "a..b/..", "a" * 65, "a b", "ü"])
def test_job_id_bad(bad: str) -> None:
    with pytest.raises(ApiError) as e:
        check_job_id(bad)
    assert e.value.status == 400 and e.value.code == "bad_id"


def test_clip_and_run_ids() -> None:
    assert check_clip_id("c02") == "c02"
    assert check_run_id("r20261117-101500-ab12") == "r20261117-101500-ab12"
    for bad in ("", "C02", "../x", "c" * 33):
        with pytest.raises(ApiError):
            check_clip_id(bad)
    for bad in ("r2026-1-1", "r20261117-101500-AB12", "x20261117-101500-ab12"):
        with pytest.raises(ApiError):
            check_run_id(bad)


@pytest.mark.parametrize("rel", ["../x", "a/../../x", "/etc/passwd", "C:/Windows/win.ini", "a\\..\\b", "", "a//b",
                                 "./a", "a/.", "x\x00y"])
def test_safe_join_rejects(tmp_path: Path, rel: str) -> None:
    with pytest.raises(ApiError) as e:
        safe_join(tmp_path, rel)
    assert e.value.code == "bad_path"


def test_safe_join_ok(tmp_path: Path) -> None:
    assert safe_join(tmp_path, "renders/c02.mp4") == (tmp_path / "renders" / "c02.mp4").resolve()


def test_safe_join_symlink_out(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("x")
    base = tmp_path / "job"
    base.mkdir()
    try:
        (base / "link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks not permitted on this machine")
    with pytest.raises(ApiError):
        safe_join(base, "link/secret.txt")


def test_write_json_atomic_leaves_no_temp(tmp_path: Path) -> None:
    target = tmp_path / "x.json"
    write_json_atomic(target, {"a": "ü"})
    write_json_atomic(target, [1, 2])
    assert target.read_text(encoding="utf-8") == "[\n 1,\n 2\n]"
    assert [p.name for p in tmp_path.iterdir()] == ["x.json"]


def test_parse_ass_events() -> None:
    content = (
        "[Script Info]\nPlayResX: 1080\n\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        "Dialogue: 1,0:00:00.00,0:00:03.00,Hook,,0,0,0,,{\\an5\\pos(540,290)\\fad(120,250)}SHE DOESN'T\\NKNOW, OK\n"
        "Dialogue: 0,0:00:00.02,0:00:00.37,Cap,,0,0,0,,{\\an5\\pos(540,1150)\\fscx82}{\\1c&H00E5FF&}I'M"
        "{\\1c&H00FFFFFF&} NOT HUGE\n"
        "Dialogue: 0,0:00:00.57,0:00:01.82,Cap,,0,0,0,,{\\an5}I'M NOT {\\1c&H00E5FF&}HUGE,{\\1c&H00FFFFFF&}\n"
        "Comment: 0,0:00:00.00,0:00:01.00,Cap,,0,0,0,,ignored\n")
    ev = parse_ass(content)
    assert ev == [
        {"start": 0.0, "end": 3.0, "text": "SHE DOESN'T KNOW, OK", "active": None, "kind": "hook"},
        {"start": 0.02, "end": 0.37, "text": "I'M NOT HUGE", "active": 0, "kind": "caption"},
        {"start": 0.57, "end": 1.82, "text": "I'M NOT HUGE,", "active": 2, "kind": "caption"},
    ]
    assert parse_time("1:02:03.45") == pytest.approx(3723.45)


def test_youtube_ids_and_slugs() -> None:
    assert youtube_id("https://www.youtube.com/watch?v=ocGJWc2F1Yk") == "ocGJWc2F1Yk"
    assert youtube_id("https://youtu.be/ocGJWc2F1Yk?t=3") == "ocGJWc2F1Yk"
    assert youtube_id("https://www.youtube.com/shorts/ocGJWc2F1Yk") == "ocGJWc2F1Yk"
    assert youtube_id("https://example.com/watch?v=ocGJWc2F1Yk") is None
    assert default_job_id("https://www.youtube.com/watch?v=ocGJWc2F1Yk", True) == "ocgjwc2f1yk"
    assert default_job_id("https://youtu.be/-bcdefghijk", True) == "yt--bcdefghijk"
    assert default_job_id("https://youtu.be/_bcdefghijk", True) == "yt-_bcdefghijk"
    assert default_job_id("https://cdn.example.com/media/My Talk.mp4", True) == "my-talk"
    assert default_job_id("C:/videos/Ünïcode Talk (final).mkv", False) == "unicode-talk-final"
    assert slug("日本") == "job"


def test_normalize_source(tmp_path: Path) -> None:
    f = tmp_path / "a b ü.mp4"
    f.write_bytes(b"x")
    assert normalize_source(f"  {f}  ") == (str(f.resolve()), False)
    assert normalize_source("https://youtu.be/ocGJWc2F1Yk") == ("https://youtu.be/ocGJWc2F1Yk", True)
    for bad in ("ftp://x/y", "https://", str(tmp_path / "missing.mp4"), "file:///c:/x.mp4", str(tmp_path)):
        with pytest.raises(ApiError) as e:
            normalize_source(bad)
        assert e.value.code == "bad_source"


def test_parse_estimate() -> None:
    raw = ("2 proposal calls (12,345 input tokens), ~8 judge calls, 3 rerank calls.\n"
           "Estimated cost: ~$0.12 (PAID; rough - thinking tokens vary). Prompts written to x")
    assert parse_estimate(raw, "opus") == {"usd": 0.12, "proposal_calls": 2, "judge_calls": 8,
                                           "input_tokens": 12345, "judge_model": "opus", "raw": raw}
    empty = parse_estimate("run clipper/sentences.py first", "sonnet")
    assert empty["usd"] is None and empty["proposal_calls"] is None and empty["raw"]


def test_complete_utf8_and_sse_framing() -> None:
    data = "aü€😀".encode()
    for cut in range(1, len(data) + 1):
        part = _complete_utf8(data[:cut])
        part.decode("utf-8")                       # never splits a character
        assert data.startswith(part)
    assert _complete_utf8(data) == data
    assert _display_line(b"progress 10%\rprogress 100%\r") == "progress 100%"
    assert _sse("log", "a\nb") == "event: log\ndata: a\ndata: b\n\n"
