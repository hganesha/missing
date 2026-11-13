from __future__ import annotations

import hashlib
import os
import time
import subprocess
from datetime import datetime, timezone

_last = 0.0


def user_agent() -> str:
    contact = os.environ.get("CORPUS_CONTACT", "").strip()
    return "ehf-concept-corpus-collector" + (f" ({contact})" if contact else "")


def fetch(url: str, *, min_interval: float = 0.0, timeout: int = 120) -> tuple[bytes, str]:
    """GET `url`; returns (body, retrieved_at). `min_interval` spaces requests to the same host politely."""
    global _last
    wait = _last + min_interval - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    # curl, not urllib: it uses the system trust store (python.org builds on macOS ship without one),
    # and certificate verification stays on.
    proc = subprocess.run(["curl", "-sSL", "--fail", "--max-time", str(timeout), "-A", user_agent(), url],
                          capture_output=True, check=False)
    if proc.returncode != 0:
        raise OSError(f"curl exit {proc.returncode}: {proc.stderr.decode('utf-8', 'replace')[:160]}")
    body = proc.stdout
    _last = time.monotonic()
    return body, datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()
