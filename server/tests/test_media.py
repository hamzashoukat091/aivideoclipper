"""/media: HTTP Range, MIME types, downloads, the master source route, path traversal; web/dist SPA fallback;
local-only guards."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app import create_app

from .helpers import BASE_URL, JOB


def test_full_file(client: TestClient, job_dir: Path) -> None:
    data = (job_dir / "renders" / "c03.mp4").read_bytes()
    r = client.get(f"/media/{JOB}/renders/c03.mp4")
    assert r.status_code == 200 and r.content == data
    assert r.headers["content-type"] == "video/mp4" and r.headers["accept-ranges"] == "bytes"
    assert int(r.headers["content-length"]) == len(data)
    assert "content-disposition" not in r.headers


@pytest.mark.parametrize(("header", "lo", "hi"), [("bytes=0-99", 0, 99), ("bytes=100-", 100, None),
                                                 ("bytes=-50", None, None), ("bytes=10-10", 10, 10)])
def test_range(client: TestClient, job_dir: Path, header: str, lo: int | None, hi: int | None) -> None:
    data = (job_dir / "renders" / "c03.mp4").read_bytes()
    size = len(data)
    if header == "bytes=-50":
        lo, hi = size - 50, size - 1
    hi = size - 1 if hi is None else hi
    assert lo is not None
    r = client.get(f"/media/{JOB}/renders/c03.mp4", headers={"Range": header})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes {lo}-{hi}/{size}"
    assert r.headers["accept-ranges"] == "bytes"
    assert int(r.headers["content-length"]) == hi - lo + 1
    assert r.content == data[lo:hi + 1]


def test_range_not_satisfiable(client: TestClient, job_dir: Path) -> None:
    size = (job_dir / "renders" / "c03.mp4").stat().st_size
    r = client.get(f"/media/{JOB}/renders/c03.mp4", headers={"Range": f"bytes={size + 10}-"})
    assert r.status_code == 416 and r.headers["content-range"] == f"bytes */{size}"


def test_head(client: TestClient, job_dir: Path) -> None:
    r = client.head(f"/media/{JOB}/renders/c03.mp4")
    assert r.status_code == 200 and int(r.headers["content-length"]) == (job_dir / "renders" / "c03.mp4").stat().st_size


@pytest.mark.parametrize(("rel", "mime"), [("captions/c03.ass", "text/plain; charset=utf-8"),
                                           ("review.md", "text/markdown; charset=utf-8"),
                                           ("meta.json", "application/json"), ("source.mp4", "video/mp4")])
def test_mime(client: TestClient, rel: str, mime: str) -> None:
    r = client.get(f"/media/{JOB}/{rel}")
    assert r.status_code == 200 and r.headers["content-type"] == mime


def test_mkv_mime(client: TestClient, job_dir: Path) -> None:
    (job_dir / "x.mkv").write_bytes(b"\x1a\x45\xdf\xa3")
    assert client.get(f"/media/{JOB}/x.mkv").headers["content-type"] == "video/x-matroska"


def test_download_disposition(client: TestClient) -> None:
    r = client.get(f"/media/{JOB}/renders/c03.mp4?download=1")
    assert r.status_code == 200
    assert r.headers["content-disposition"] == f'attachment; filename="{JOB}-c03.mp4"'


def test_source_route(client: TestClient, job_dir: Path, tmp_path: Path) -> None:
    r = client.get(f"/media/{JOB}/source", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and r.content == (job_dir / "source.mp4").read_bytes()[:10]
    # local-file job: the master lives outside the job folder; only that exact path is served
    outside = tmp_path / "elsewhere ü" / "talk.mp4"
    outside.parent.mkdir()
    outside.write_bytes(b"0123456789")
    m = json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))
    m["media"] = str(outside)
    (job_dir / "meta.json").write_text(json.dumps(m), encoding="utf-8")
    r = client.get(f"/media/{JOB}/source?download=1")
    assert r.status_code == 200 and r.content == b"0123456789"
    assert r.headers["content-disposition"] == f'attachment; filename="{JOB}-talk.mp4"'
    outside.unlink()
    assert client.get(f"/media/{JOB}/source").status_code == 404


@pytest.mark.parametrize("rel", ["..%2F..%2Fsecret.txt", "renders%2F..%2F..%2F..%2Fsecret.txt", "%2E%2E/secret.txt",
                                 "a%5C..%5C..%5Csecret.txt", "C:%2Fwindows%2Fwin.ini"])
def test_traversal_rejected(client: TestClient, root: Path, rel: str) -> None:
    (root / "data" / "secret.txt").write_text("secret")
    r = client.get(f"/media/{JOB}/{rel}")
    assert (r.status_code, r.json()["error"]) in ((400, "bad_path"), (404, "not_found"))
    assert r.content != b"secret"


def test_traversal_raw_dotdot(client: TestClient, root: Path) -> None:
    (root / "data" / "secret.txt").write_text("secret")
    r = client.get(f"/media/{JOB}/..%2Fsecret.txt")
    assert r.status_code == 400 and r.json()["error"] == "bad_path"


def test_missing_file_and_bad_job(client: TestClient) -> None:
    assert client.get(f"/media/{JOB}/renders/c99.mp4").json()["error"] == "not_found"
    assert client.get(f"/media/{JOB}/renders").status_code == 404           # directories are not served
    assert client.get("/media/Bad!/x.json").json()["error"] == "bad_id"


def test_unknown_api_path_is_json_404(client: TestClient) -> None:
    r = client.get("/api/nope")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_web_dist_spa_fallback(root: Path) -> None:
    with TestClient(create_app(root), base_url=BASE_URL) as c:
        r = c.get("/jobs/demo")
        assert r.status_code == 404 and "web/dist" in r.json()["message"]
    dist = root / "web" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><div id=root></div>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    with TestClient(create_app(root), base_url=BASE_URL) as c:
        assert c.get("/").text.startswith("<!doctype html>")
        assert c.get("/jobs/demo/clips/c03").text.startswith("<!doctype html>")
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert c.get("/assets/../../secret").text.startswith("<!doctype html>")
        assert c.get("/api/jobs/zzz").json()["error"] == "not_found"


def test_rejects_foreign_origin_and_host(client: TestClient) -> None:
    r = client.post(f"/api/jobs/{JOB}/runs", json={"action": "sentences"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["error"] == "forbidden_origin"
    r = client.patch(f"/api/jobs/{JOB}/candidates/c03", json={"approved": True},
                     headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    r = client.get("/api/health", headers={"Host": "evil.example"})
    assert r.status_code == 400
    assert client.get("/api/health", headers={"Host": "localhost:8765"}).status_code == 200
