"""World model primitives: tenant, clock, stable ids and digests."""
from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal
from typing import Any

TENANT_ID = "tenant-synthetic"
SCHEMA_VERSION = "2.0.0"
PURPOSES = ["fraud", "investigation", "monitoring", "onboarding", "reporting", "review"]
GENERATOR = "context-corpus@0.1.0"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def digest(value: Any) -> str:
    return sha256_hex(canonical_json(value))


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def timestamp(day: Any, *, end: bool = False) -> str:
    """ISO UTC timestamp for a date (or an already full timestamp)."""
    text = str(day)
    return text if "T" in text else f"{text}T{'23:59:59' if end else '00:00:00'}Z"


def fraction(value: Any) -> str:
    """Render a ratio as the ontology `Fraction` string (no exponent form)."""
    d = Decimal(str(value))
    if d < 0 or d > 1:
        raise ValueError(f"fraction out of range: {value}")
    text = format(d.quantize(Decimal("0.000001")).normalize(), "f")
    return text
