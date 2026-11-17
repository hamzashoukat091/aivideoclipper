"""Clip editing (docs/UI_SPEC.md 5b): clipper/edits.py rules, caption options in build_ass, and the
GET/PUT/DELETE /api/jobs/{id}/clips/{cid}/edits endpoints on a temp copy of test_fallon."""
from __future__ import annotations

import copy
import json
import re
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from clipper import edits as E

from .helpers import JOB

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clipper"))
import itertools

from captions import build_ass

W, H = 1920, 1080
CW = E.crop_width(H)                      # 608


# ---------------------------------------------------------------- synthetic plan

def make_plan() -> dict[str, Any]:
    """10 s at 30 fps from 100 s: start-edge held sliver, TRACK with a hard cut, SPLIT, GROUP, end-edge held FIT."""
    return {
        "clip": "c01", "cut_in": 100.0, "cut_out": 110.0, "duration": 10.0, "fps": "30/1", "frames": 300,
        "src_w": W, "src_h": H, "out_w": 1080, "out_h": 1920, "speaker_evidence": "test",
        "qa": {"layouts": {"TRACK": 2, "GROUP": 1, "SPLIT": 1, "FIT": 1}, "face_inside_min": 1.0},
        "shots": [
            {"f0": 0, "f1": 10, "faces": 1, "layout": "TRACK", "w": CW, "h": H, "x": [500] * 10,
             "speaker_track": [0] * 10, "hard_cuts": [], "face_inside": 1.0, "hold_frame": 10},
            {"f0": 10, "f1": 100, "faces": 1, "layout": "TRACK", "w": CW, "h": H, "x": list(range(90)),
             "speaker_track": [0] * 45 + [1] * 45, "hard_cuts": [55], "face_inside": 1.0, "talk_share": [1.0]},
            {"f0": 100, "f1": 200, "faces": 2, "layout": "SPLIT", "talk_share": [0.3, 0.7],
             "top": {"x": 100, "y": 0, "w": 600, "h": 534}, "bottom": {"x": 1200, "y": 0, "w": 600, "h": 534}},
            {"f0": 200, "f1": 290, "faces": 2, "layout": "GROUP", "crop": {"x": 400, "y": 0, "w": CW, "h": H}},
            {"f0": 290, "f1": 300, "faces": 0, "layout": "FIT", "hold_frame": 289},
        ]}


def at(frame: int, plan: dict[str, Any] | None = None) -> float:
    """Source time in the middle of `frame`."""
    p = plan or make_plan()
    return p["cut_in"] + (frame + 0.5) / 30


def check_consistent(plan: dict[str, Any]) -> None:
    """Shots tile [0, frames), per-frame arrays match shot lengths, hard cuts/hold frames in range."""
    for key in ("shots", "auto_shots"):
        shots = plan.get(key)
        if shots is None:
            continue
        assert shots[0]["f0"] == 0 and shots[-1]["f1"] == plan["frames"]
        for a, b in itertools.pairwise(shots):
            assert a["f1"] == b["f0"]
        for s in shots:
            n = s["f1"] - s["f0"]
            assert n > 0
            for arr in ("x", "speaker_track"):
                if arr in s:
                    assert len(s[arr]) == n
            assert all(s["f0"] < c < s["f1"] for c in s.get("hard_cuts", []))
            if "hold_frame" in s:
                assert 0 <= s["hold_frame"] < plan["frames"]


# ---------------------------------------------------------------- slice_plan

def test_slice_drops_and_trims_shots() -> None:
    p = make_plan()
    s = E.slice_plan(p, 100 + 10 / 30, 108.0)                 # starts exactly at shot 1, ends inside GROUP
    check_consistent(s)
    assert (s["cut_in"], s["cut_out"], s["duration"], s["frames"]) == (100.333, 108.0, 7.667, 230)
    assert [(x["layout"], x["f0"], x["f1"]) for x in s["shots"]] == [("TRACK", 0, 90), ("SPLIT", 90, 190),
                                                                     ("GROUP", 190, 230)]
    assert s["shots"][0]["x"] == list(range(90)) and s["shots"][0]["hard_cuts"] == [45]
    assert s["qa"]["layouts"] == {"TRACK": 1, "GROUP": 1, "SPLIT": 1, "FIT": 0}
    assert p == make_plan()                                   # input untouched


def test_slice_inside_a_track_shot_shifts_arrays_and_cuts() -> None:
    s = E.slice_plan(make_plan(), 100.5, 103.0)               # frames 15..90 of shot 1
    check_consistent(s)
    assert len(s["shots"]) == 1 and s["frames"] == 75
    sh = s["shots"][0]
    assert sh["x"] == list(range(5, 80)) and sh["speaker_track"] == [0] * 40 + [1] * 35
    assert sh["hard_cuts"] == [40]


def test_slice_keeps_held_frames_shifted() -> None:
    s = E.slice_plan(make_plan(), 100 + 5 / 30, 110.0)        # keeps both held edges
    check_consistent(s)
    assert s["shots"][0]["hold_frame"] == 5 and s["shots"][-1]["hold_frame"] == 284


def test_slice_drops_unreachable_hold() -> None:
    s = E.slice_plan(make_plan(), 100.0, 100.2)                # only part of the start sliver remains
    check_consistent(s)
    assert s["frames"] == 6 and "hold_frame" not in s["shots"][0]


def test_slice_auto_shots_too_and_rejects_outside() -> None:
    p = make_plan()
    E.apply_shot_edits(p, {"shots": [{"at": at(150), "layout": "FIT"}]})
    s = E.slice_plan(p, 103.0, 107.0)
    check_consistent(s)
    assert [x["layout"] for x in s["auto_shots"]] == ["TRACK", "SPLIT", "GROUP"]
    assert [x["layout"] for x in s["shots"]] == ["TRACK", "FIT", "GROUP"]
    for bad in ((99.0, 105.0), (105.0, 111.0), (105.0, 105.0)):
        with pytest.raises(ValueError):
            E.slice_plan(p, *bad)


# ---------------------------------------------------------------- apply_shot_edits

def test_apply_each_layout_and_auto_restore() -> None:
    p = make_plan()
    edits = {"shots": [{"at": at(50), "layout": "FIXED", "x": 700},
                       {"at": at(150), "layout": "GROUP", "crop": {"x": 10, "y": 20, "w": 540, "h": 960}},
                       {"at": at(250), "layout": "FIT"},
                       {"at": at(5), "layout": "FIXED", "x": 9999}]}
    assert E.apply_shot_edits(p, edits) == []
    check_consistent(p)
    fixed = p["shots"][1]
    assert fixed["layout"] == "TRACK" and fixed["x"] == [700] * 90 and fixed["w"] == CW
    assert fixed["speaker_track"] == make_plan()["shots"][1]["speaker_track"] and fixed["hard_cuts"] == []
    assert p["shots"][2] == {"f0": 100, "f1": 200, "faces": 2, "talk_share": [0.3, 0.7], "layout": "GROUP",
                             "crop": {"x": 10, "y": 20, "w": 540, "h": 960}, "reason": "edited: group crop"}
    assert p["shots"][3]["layout"] == "FIT"
    assert p["shots"][0]["hold_frame"] == 10 and p["shots"][0]["x"] == [W - CW] * 10   # held edge keeps its hold
    assert p["auto_shots"] == make_plan()["shots"]
    E.apply_shot_edits(p, {"shots": [{"at": at(50), "layout": "AUTO"}]})
    assert p["shots"] == make_plan()["shots"]                  # AUTO / no edit restores the automatic plan
    E.apply_shot_edits(p, None)
    assert p["shots"] == p["auto_shots"]


def test_apply_track_split_rules() -> None:
    p = make_plan()
    warns = E.apply_shot_edits(p, {"shots": [{"at": at(50), "layout": "SPLIT"}, {"at": at(150), "layout": "SPLIT"},
                                             {"at": at(250), "layout": "TRACK"}, {"at": at(20), "layout": "TRACK"}]})
    assert len(warns) == 1 and "Split unavailable" in warns[0]
    assert p["shots"][1] == make_plan()["shots"][1]            # SPLIT refused on a TRACK shot: stays automatic
    assert p["shots"][2] == make_plan()["shots"][2]            # SPLIT where the automatic shot was SPLIT
    g = p["shots"][3]                                          # follow on a GROUP shot: centred on the group
    assert g["layout"] == "TRACK" and g["x"] == [400] * 90
    assert p["shots"][1]["layout"] == "TRACK"


def test_apply_ignores_edits_outside_the_plan_and_last_wins() -> None:
    p = make_plan()
    E.apply_shot_edits(p, {"shots": [{"at": 50.0, "layout": "FIT"}, {"at": at(50), "layout": "FIT"},
                                     {"at": at(60), "layout": "FIXED", "x": 3}]})
    assert p["shots"][1]["x"] == [3] * 90


# ---------------------------------------------------------------- validation

def valid(**over: Any) -> dict[str, Any]:
    e = E.default_edits({"on_screen_hook": "Hook!"})
    e.update(over)
    return e


def run_validate(e: Any, plan: dict[str, Any] | None = None) -> dict[str, Any]:
    return E.validate_edits(e, base_cut=(100.0, 110.0), source_duration=600.0, src_w=W, src_h=H, word_count=1000,
                            plan=plan if plan is not None else make_plan())


@pytest.mark.parametrize(("edits", "code"), [
    ({"trim": {"cut_in": 100, "cut_out": 102}}, "bad_trim"),               # < 3 s
    ({"trim": {"cut_in": 100, "cut_out": 290}}, "bad_trim"),               # > 180 s
    ({"trim": {"cut_in": 105, "cut_out": 104}}, "bad_trim"),
    ({"trim": {"cut_in": -1, "cut_out": 10}}, "bad_trim"),
    ({"trim": {"cut_in": 590, "cut_out": 601}}, "bad_trim"),               # past the source end
    ({"trim": {"cut_in": "1", "cut_out": 10}}, "bad_trim"),
    ({"shots": [{"at": 120.0, "layout": "FIT"}]}, "bad_shot"),            # outside the clip
    ({"shots": [{"at": 101.0, "layout": "ZOOM"}]}, "bad_shot"),
    ({"shots": [{"at": 101.0, "layout": "FIXED", "x": W - CW + 1}]}, "bad_shot"),
    ({"shots": [{"at": 101.0, "layout": "FIXED"}]}, "bad_shot"),
    ({"shots": [{"at": 101.0, "layout": "GROUP", "crop": {"x": 0, "y": 0, "w": 600, "h": 900}}]}, "bad_shot"),
    ({"shots": [{"at": 101.0, "layout": "GROUP", "crop": {"x": 1500, "y": 0, "w": 608, "h": 1080}}]}, "bad_shot"),
    ({"shots": [{"at": 101.0, "layout": "SPLIT"}]}, "split_unavailable"),
    ({"shots": [{"at": 101.0, "layout": "FIT", "zoom": 2}]}, "bad_shot"),
    ({"words": {"1000": "x"}}, "bad_word"),
    ({"words": {"-1": "x"}}, "bad_word"),
    ({"words": {"3": "a\nb"}}, "bad_word"),
    ({"hook": {"text": "x", "enabled": True, "seconds": 0.1}}, "bad_hook"),
    ({"hook": {"text": "x", "enabled": "yes", "seconds": 3}}, "bad_hook"),
    ({"hook": {"text": "x" * 121, "enabled": True, "seconds": 3}}, "bad_hook"),
    ({"captions": {"enabled": True, "position": "top", "size": 84}}, "bad_captions"),
    ({"captions": {"enabled": True, "position": "auto", "size": 120}}, "bad_captions"),
    ({"captions": {"enabled": True, "position": "auto"}}, "bad_captions"),
    ({"title": "   "}, "bad_title"),
    ({"version": 2}, "invalid_edits"),
    ({"extra": 1}, "invalid_edits"),
])
def test_validation_errors(edits: dict[str, Any], code: str) -> None:
    with pytest.raises(E.EditError) as exc:
        run_validate(valid(**edits))
    assert exc.value.code == code and exc.value.message


def test_validation_normalises() -> None:
    clean = run_validate(valid(trim={"cut_in": 99.12345, "cut_out": 109.5}, title="  New title ",
                               shots=[{"at": at(150), "layout": "SPLIT"},
                                      {"at": at(250), "layout": "GROUP",
                                       "crop": {"x": 10.4, "y": 0, "w": 607.6, "h": 1080}}],
                               words={"7": " fixed "}, captions={"enabled": False, "position": "upper", "size": 99.6}))
    assert clean["trim"] == {"cut_in": 99.123, "cut_out": 109.5} and clean["title"] == "New title"
    assert clean["shots"][1]["crop"] == {"x": 10, "y": 0, "w": 608, "h": 1080}
    assert clean["words"] == {"7": "fixed"} and clean["captions"]["size"] == 100
    with pytest.raises(E.EditError):                          # without a plan, Split cannot be checked -> refused
        E.validate_edits(valid(shots=[{"at": at(150), "layout": "SPLIT"}]), base_cut=(100.0, 110.0),
                         source_duration=600.0, src_w=W, src_h=H, word_count=10, plan=None)


# ---------------------------------------------------------------- captions / hook in the render

def events(ass: str) -> list[tuple[float, float, str, str]]:
    out = []
    for line in ass.splitlines():
        if line.startswith("Dialogue:"):
            f = line.split(",", 9)
            t = [sum(float(x) * m for x, m in zip(v.split(":"), (3600, 60, 1))) for v in (f[1], f[2])]
            out.append((t[0], t[1], f[3], f[9]))
    return out


WORDS = [{"w": w, "start": i * 0.4, "end": i * 0.4 + 0.3} for i, w in
         enumerate(["so", "this", "is", "the", "story", "of", "how", "I", "met", "a", "raccoon", "on", "stage", "tonight"])]


def test_build_ass_defaults_unchanged() -> None:
    ass = build_ass(WORDS, 6.0, lambda t: "TRACK", "Hook!")
    ev = events(ass)
    assert "Style: Cap,Montserrat Black,84," in ass
    assert ev[0][2] == "Hook" and ev[0][1] == 3.0
    caps = [e for e in ev if e[2] == "Cap"]
    assert caps and all("\\pos(540,1150)" in e[3] for e in caps)
    assert all(a[1] <= b[0] for a, b in itertools.pairwise(caps))  # never two captions at once
    assert ",7,0,5," in ass                                     # outline 7, shadow 0


def test_build_ass_options() -> None:
    ass = build_ass(WORDS, 6.0, lambda t: "TRACK", "Hook!", hook_s=5.5, position="upper", size=110)
    ev = events(ass)
    assert ev[0][1] == 5.5 and "Style: Cap,Montserrat Black,110," in ass
    caps = [e for e in ev if e[2] == "Cap"]
    assert all("\\pos(540,520)" in e[3] for e in caps)
    assert all(len(re.sub(r"\{[^}]*\}", "", e[3])) <= 11 + 4 for e in caps)   # narrower chunks at bigger size
    assert all(a[1] <= b[0] for a, b in itertools.pairwise(caps))
    off = events(build_ass(WORDS, 6.0, lambda t: "TRACK", "Hook!", captions=False))
    assert [e[2] for e in off] == ["Hook"]
    none = events(build_ass(WORDS, 6.0, lambda t: "SPLIT", None, position="auto"))
    assert none and all(e[2] == "Cap" and "\\pos(540,960)" in e[3] for e in none)
    assert all("\\pos(540,960)" in e[3] for e in events(build_ass(WORDS, 6.0, lambda t: "FIT", None,
                                                                  position="middle")))


def test_clip_words_and_hook_spec() -> None:
    words = [{"w": "Hello", "start": 9.0, "end": 9.5}, {"w": "umm", "start": 10.1, "end": 10.3},
             {"w": "wrold", "start": 10.4, "end": 10.9}, {"w": "after", "start": 20.0, "end": 20.5}]
    out = E.clip_words(words, 10.0, 15.0, {"1": "", "2": "world"})
    assert out == [{"w": "world", "start": pytest.approx(0.4), "end": pytest.approx(0.9)}]
    cand = {"on_screen_hook": "Auto hook"}
    assert E.hook_spec(None, cand) == ("Auto hook", 3.0)
    assert E.hook_spec(None, cand, enabled=False) == (None, 3.0)
    e = E.default_edits(cand)
    e["hook"] = {"text": "Mine", "enabled": True, "seconds": 4.5}
    assert E.hook_spec(e, cand) == ("Mine", 4.5)
    e["hook"]["enabled"] = False
    assert E.hook_spec(e, cand) == (None, 4.5)
    assert E.caption_spec(None) == {"enabled": True, "position": "auto", "size": 84}


def test_load_edits_fills_defaults(tmp_path: Path) -> None:
    p = tmp_path / "c01.json"
    assert E.load_edits(p, {}) is None
    p.write_text(json.dumps({"version": 1, "captions": {"size": 90}, "original": {"cut_in": 1}}))
    e = E.load_edits(p, {"on_screen_hook": "H"})
    assert e["captions"] == {"enabled": True, "position": "auto", "size": 90} and e["hook"]["text"] == "H"
    assert "original" not in E.public(e)


# ---------------------------------------------------------------- API

URL = f"/api/jobs/{JOB}/clips/c03/edits"
SOURCE_S = 622.805


@pytest.fixture(autouse=True)
def full_length_source(request: pytest.FixtureRequest) -> None:
    """The fixture's tiny media is 2 s, but the clips live at 100-160 s: give probe.json the real length."""
    if "job_dir" in request.fixturenames:
        job_dir: Path = request.getfixturevalue("job_dir")
        probe = json.loads((job_dir / "probe.json").read_text(encoding="utf-8"))
        probe["duration"] = SOURCE_S
        (job_dir / "probe.json").write_text(json.dumps(probe), encoding="utf-8")
CTX_KEYS = {"edits", "original", "words", "limits", "plan_range", "needs"}


def read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def cand(job_dir: Path, cid: str = "c03") -> dict[str, Any]:
    return next(c for c in read(job_dir / "candidates.json") if c["id"] == cid)


def test_get_defaults(client: TestClient, job_dir: Path) -> None:
    r = client.get(URL)
    assert r.status_code == 200
    ctx = r.json()
    assert set(ctx) == CTX_KEYS
    c = cand(job_dir)
    assert ctx["edits"] == E.default_edits(c)
    assert ctx["original"] == {"cut_in": c["cut_in"], "cut_out": c["cut_out"], "title": c["title"],
                               "hook": c["on_screen_hook"]}
    assert ctx["limits"] == {"min_s": 3.0, "max_s": 180.0, "source_duration": SOURCE_S}
    plan = read(job_dir / "reframe" / "c03.json")
    assert ctx["plan_range"] == {"cut_in": plan["cut_in"], "cut_out": plan["cut_out"]}
    assert ctx["needs"] == []
    ws = ctx["words"]
    assert ws and set(ws[0]) == {"i", "w", "start", "end"}
    assert ws[0]["start"] < c["cut_in"] and ws[-1]["end"] > c["cut_out"]
    assert all(w["end"] > c["cut_in"] - 10 and w["start"] < c["cut_out"] + 10 for w in ws)
    assert [w["i"] for w in ws] == list(range(ws[0]["i"], ws[0]["i"] + len(ws)))
    assert not (job_dir / "edits").exists()                   # GET never writes


def test_get_errors(client: TestClient, root: Path) -> None:
    assert client.get(f"/api/jobs/{JOB}/clips/c99/edits").status_code == 404
    assert client.get(f"/api/jobs/{JOB}/clips/C!/edits").json()["error"] == "bad_id"
    (root / "data" / "jobs" / "bare").mkdir()
    assert client.get("/api/jobs/bare/clips/c01/edits").status_code == 404


def put(client: TestClient, edits: dict[str, Any], url: str = URL) -> Any:
    return client.put(url, json=edits)


def test_put_trim_inside_plan_slices_and_round_trips(client: TestClient, job_dir: Path) -> None:
    c0 = cand(job_dir)
    full = read(job_dir / "reframe" / "c03.json")
    edits = client.get(URL).json()["edits"]
    edits.update(trim={"cut_in": c0["cut_in"] + 2.0, "cut_out": c0["cut_out"] - 3.0}, title="Shorter")
    edits["hook"] = {"text": "New hook", "enabled": False, "seconds": 2.5}
    edits["captions"] = {"enabled": True, "position": "lower", "size": 96}
    ctx = put(client, edits).json()
    assert ctx["edits"] == {**edits, "trim": {"cut_in": round(c0["cut_in"] + 2, 3),
                                              "cut_out": round(c0["cut_out"] - 3, 3)}}
    assert ctx["needs"] == ["render"]                          # sliced: no re-analysis
    assert ctx["original"]["cut_in"] == c0["cut_in"] and ctx["original"]["title"] == c0["title"]
    assert ctx["plan_range"] == {"cut_in": full["cut_in"], "cut_out": full["cut_out"]}
    c1 = cand(job_dir)
    assert c1["cut_in"] == ctx["edits"]["trim"]["cut_in"] and c1["title"] == "Shorter"
    assert c1["duration"] == round(c1["cut_out"] - c1["cut_in"], 2)
    plan = read(job_dir / "reframe" / "c03.json")
    assert (plan["cut_in"], plan["cut_out"]) == (c1["cut_in"], c1["cut_out"])
    assert plan["sliced_from"] == [full["cut_in"], full["cut_out"]] and plan["frames"] < full["frames"]
    check_consistent(plan)
    saved = read(job_dir / "edits" / "c03.json")
    assert saved["original"] == {"cut_in": c0["cut_in"], "cut_out": c0["cut_out"], "title": c0["title"]}
    assert client.get(URL).json() == ctx                       # round trip
    sel = {c["id"]: c for c in client.get(f"/api/jobs/{JOB}/selection").json()["candidates"]}
    assert sel["c03"]["reframe"]["state"] == "done" and sel["c03"]["render"]["state"] == "stale"
    assert [c["id"] for c in sel.values()] == ["c02", "c03", "c05"]
    assert not list((job_dir / "edits").glob("*.tmp")) and not list(job_dir.glob(".*tmp"))


def test_second_trim_reslices_from_the_full_plan(client: TestClient, job_dir: Path) -> None:
    c0 = cand(job_dir)
    full = read(job_dir / "reframe" / "c03.json")
    edits = client.get(URL).json()["edits"]
    edits["trim"] = {"cut_in": c0["cut_in"] + 5, "cut_out": c0["cut_out"] - 5}
    put(client, edits)
    edits["trim"] = {"cut_in": c0["cut_in"] + 1, "cut_out": c0["cut_out"] - 1}   # wider again, still inside
    ctx = put(client, edits).json()
    assert ctx["needs"] == ["render"]
    plan = read(job_dir / "reframe" / "c03.json")
    assert plan["frames"] == E.slice_plan(full, c0["cut_in"] + 1, c0["cut_out"] - 1)["frames"]
    edits["trim"] = None                                                         # back to the full range
    put(client, edits)
    plan = read(job_dir / "reframe" / "c03.json")
    assert "sliced_from" not in plan and plan["frames"] == full["frames"]
    assert not (job_dir / "edits" / "c03.plan.json").exists()


def test_trim_outside_plan_needs_reframe(client: TestClient, job_dir: Path) -> None:
    c0 = cand(job_dir)
    before = read(job_dir / "reframe" / "c03.json")
    edits = client.get(URL).json()["edits"]
    edits["trim"] = {"cut_in": c0["cut_in"] - 4, "cut_out": c0["cut_out"]}
    ctx = put(client, edits).json()
    assert ctx["needs"] == ["reframe", "render"]
    after = read(job_dir / "reframe" / "c03.json")
    assert (after["cut_in"], after["cut_out"], after["frames"]) == (before["cut_in"], before["cut_out"],
                                                                   before["frames"])
    stages = {s["key"]: s["state"] for s in client.get(f"/api/jobs/{JOB}").json()["stages"]}
    assert stages["reframe"] == "stale"


def test_shot_edits_applied_to_plan_and_auto_restores(client: TestClient, job_dir: Path) -> None:
    plan0 = read(job_dir / "reframe" / "c03.json")
    auto0 = plan0.get("auto_shots") or plan0["shots"]
    k = next(i for i, s in enumerate(auto0) if s["layout"] != "SPLIT")
    t = plan0["cut_in"] + (auto0[k]["f0"] + 1) / float(Fraction(plan0["fps"]))
    cw = E.crop_width(plan0["src_h"])
    edits = client.get(URL).json()["edits"]
    edits["shots"] = [{"at": t, "layout": "FIXED", "x": 100}]
    put(client, edits)
    plan = read(job_dir / "reframe" / "c03.json")
    sh = plan["shots"][k]
    assert sh["layout"] == "TRACK" and set(sh["x"]) == {100} and sh["w"] == cw
    assert plan["auto_shots"] == auto0
    split = [s for s in auto0 if s["layout"] == "SPLIT"]
    non_split_t = t
    edits["shots"] = [{"at": non_split_t, "layout": "SPLIT"}]
    r = put(client, edits)
    assert r.status_code == 400 and r.json()["error"] == "split_unavailable"
    if split:
        ts = plan0["cut_in"] + (split[0]["f0"] + 1) / float(Fraction(plan0["fps"]))
        edits["shots"] = [{"at": ts, "layout": "SPLIT"}]
        assert put(client, edits).status_code == 200
    edits["shots"] = [{"at": t, "layout": "AUTO"}]
    put(client, edits)
    assert read(job_dir / "reframe" / "c03.json")["shots"] == auto0


def test_delete_restores_automatic(client: TestClient, job_dir: Path) -> None:
    c0 = cand(job_dir)
    full = read(job_dir / "reframe" / "c03.json")
    edits = client.get(URL).json()["edits"]
    edits.update(trim={"cut_in": c0["cut_in"] + 3, "cut_out": c0["cut_out"] - 2}, title="Edited",
                 words={"1": ""})
    put(client, edits)
    r = client.delete(URL)
    assert r.status_code == 200
    ctx = r.json()
    assert ctx["edits"] == E.default_edits(c0)
    c1 = cand(job_dir)
    assert (c1["cut_in"], c1["cut_out"], c1["title"], c1["duration"]) == (c0["cut_in"], c0["cut_out"], c0["title"],
                                                                         c0["duration"])
    assert not (job_dir / "edits" / "c03.json").exists() and not (job_dir / "edits" / "c03.plan.json").exists()
    plan = read(job_dir / "reframe" / "c03.json")
    assert plan["frames"] == full["frames"] and plan["shots"] == (full.get("auto_shots") or full["shots"])
    assert ctx["needs"] == ["render"]                          # plan rewritten after the render
    assert client.delete(URL).json()["edits"] == E.default_edits(c0)    # idempotent


def test_put_validation_is_400_with_codes(client: TestClient, job_dir: Path) -> None:
    edits = client.get(URL).json()["edits"]
    before = (job_dir / "candidates.json").read_bytes()
    for change, code in ((("trim", {"cut_in": 10, "cut_out": 11}), "bad_trim"),
                         (("trim", {"cut_in": 600, "cut_out": 650}), "bad_trim"),    # past the source end
                         (("captions", {"enabled": True, "position": "x", "size": 84}), "bad_captions"),
                         (("version", 3), "invalid_edits")):
        bad = copy.deepcopy(edits)
        bad[change[0]] = change[1]
        r = put(client, bad)
        assert r.status_code == 400 and r.json()["error"] == code, r.text
    assert put(client, [1, 2]).json()["error"] == "invalid_edits"
    assert (job_dir / "candidates.json").read_bytes() == before and not (job_dir / "edits").exists()


def test_put_busy_while_clip_run_active(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    runner = client.app.state.clipper.runner                  # type: ignore[attr-defined]
    active = {"id": "r1", "action": "render", "state": "running",
              "steps": [{"name": "render", "state": "running", "command": ["py", "--clip", "c03"]}]}
    monkeypatch.setattr(runner, "active_for", lambda job_id: active)
    edits = client.get(URL).json()["edits"]
    r = put(client, edits)
    assert r.status_code == 409 and r.json()["error"] == "busy"
    assert client.delete(URL).status_code == 409
    active["steps"][0]["command"] = ["py", "--clip", "c02"]   # another clip's render: free to edit c03
    assert put(client, edits).status_code == 200
    active.update(action="produce")
    assert put(client, edits).status_code == 409


def test_edits_mark_render_stale(client: TestClient, job_dir: Path) -> None:
    edits = client.get(URL).json()["edits"]
    edits["words"] = {str(client.get(URL).json()["words"][20]["i"]): "FIXED"}
    ctx = put(client, edits).json()
    assert ctx["needs"] == ["render"]
    sel = {c["id"]: c for c in client.get(f"/api/jobs/{JOB}/selection").json()["candidates"]}
    assert sel["c03"]["render"]["state"] == "stale" and sel["c02"]["render"]["state"] == "done"
    assert sel["c03"]["reframe"]["preview_url"] is None
