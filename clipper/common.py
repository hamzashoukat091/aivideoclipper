"""Shared helpers for the clip pipeline: job folders, JSON I/O, subprocess runner, TLS setup.

Every stage reads and writes plain files in data/jobs/<job_id>/ so stages can be inspected and re-run alone.
"""
from __future__ import annotations

import json
import os
import ssl
import subprocess
import sys
import time
from pathlib import Path

# This machine has a TLS-inspecting root in the Windows cert store; verify against the OS store
# (still full verification) instead of certifi's bundle.
try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

for _s in (sys.stdout, sys.stderr):   # Windows consoles default to cp1252
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
JOBS = ROOT / "data" / "jobs"


def job_dir(job_id: str) -> Path:
    d = JOBS / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_json(path: Path, data) -> Path:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)          # atomic: a crashed stage never leaves a half-written output
    return path


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_env() -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        pass


def windows_ca_bundle() -> str | None:
    """Export the Windows trusted roots to a PEM so every yt-dlp HTTP backend (incl. curl_cffi, which ships its
    own bundle) verifies TLS against the same store as the OS."""
    if not hasattr(ssl, "enum_certificates"):
        return None
    d = ROOT / "data" / "_certs"
    d.mkdir(parents=True, exist_ok=True)
    pem = d / "windows-roots.pem"
    blobs = {c for store in ("ROOT", "CA") for c, enc, trust in ssl.enum_certificates(store)
             if enc == "x509_asn" and (trust is True or "1.3.6.1.5.5.7.3.1" in trust)}
    pem.write_text("".join(ssl.DER_cert_to_PEM_cert(b) for b in blobs), encoding="ascii")
    return str(pem)


def tls_env() -> dict:
    env = dict(os.environ)
    ca = windows_ca_bundle()
    if ca:
        env.update(CURL_CA_BUNDLE=ca, SSL_CERT_FILE=ca, REQUESTS_CA_BUNDLE=ca)
    return env


def run(cmd: list[str], env: dict | None = None, attempts: int = 1, capture: bool = False) -> str:
    print("+", " ".join(cmd), flush=True)
    for i in range(attempts):
        p = subprocess.run(cmd, env=env, capture_output=capture, text=capture, encoding="utf-8" if capture else None)
        if p.returncode == 0:
            return p.stdout if capture else ""
        if capture and p.stderr:
            print(p.stderr[-2000:], file=sys.stderr)
        if i + 1 < attempts:
            print(f"attempt {i + 1} failed; retrying in {10 * (i + 1)}s (YouTube 403s are often transient)")
            time.sleep(10 * (i + 1))
    raise SystemExit(f"command failed after {attempts} attempt(s): {cmd[0]}")


def stage_banner(name: str, job_id: str) -> float:
    print(f"\n=== {name} [{job_id}] ===", flush=True)
    return time.perf_counter()
