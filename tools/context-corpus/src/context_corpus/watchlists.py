"""List data for screening: pinned real subsets (as published) plus clearly fictional lists."""
from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

SOURCES = Path(__file__).resolve().parents[2] / "sources"
REAL = {"ofac-sdn": "sanctions", "un-consolidated": "sanctions", "uk-sanctions": "sanctions"}


def normalize(value: Any) -> str:
    """Same normalisation the skill library applies to names before comparing them."""
    value = unicodedata.normalize("NFKD", str(value)).casefold()
    return " ".join(re.findall(r"[^\W_]+", "".join(c for c in value if not unicodedata.combining(c)), re.UNICODE))


def match(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    ia, ib = set(a.get("identifiers", [])), set(b.get("identifiers", []))
    shared = sorted(ia & ib)
    conflict = bool(ia and ib and not shared)
    name = SequenceMatcher(None, normalize(a["name"]), normalize(b["name"])).ratio() if a.get("name") and b.get("name") else 0.0
    return {"score": 1.0 if shared else (0.0 if conflict else round(name * 0.7, 6)), "shared_identifiers": shared,
            "identifier_conflict": conflict, "name_score": round(name, 6), "verified_match": bool(shared) and not conflict}


@lru_cache(maxsize=1)
def load() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    pinned = json.loads((SOURCES / "pinned/lists.json").read_text(encoding="utf-8"))
    when = {s["id"]: s.get("retrieved_at", "")[:10] for s in pinned["sources"]}
    for key, list_type in REAL.items():
        entries = [{"uid": e["uid"], "name": e["name"], "identifiers": e["identifiers"], "type": e["type"], "dob": e["dob"],
                    "programs": e["programs"], "real": True, "raw_sha256": e["raw_sha256"]} for e in pinned["entries"] if e["list"] == key]
        out[key] = {"list_type": list_type, "version": f"{key}@{when.get(key, 'unknown')}", "complete": False, "real": True,
                    "notice": "Pinned subset of the published list, as published.", "entries": entries}
    for key, spec in yaml.safe_load((SOURCES / "synthetic-lists.yaml").read_text(encoding="utf-8")).items():
        out[key] = {"list_type": spec["list_type"], "version": spec["version"], "complete": True, "real": False, "notice": spec["notice"],
                    "entries": [{**e, "dob": [str(e["dob"])] if e.get("dob") else [], "real": False} for e in spec["entries"]]}
    return out


def entry(key: str) -> tuple[str, dict[str, Any]]:
    """`list:uid` -> (list key, entry)."""
    list_key, uid = key.split(":", 1)
    return list_key, next(e for e in load()[list_key]["entries"] if e["uid"] == uid)


def real_names() -> set[str]:
    return {normalize(e["name"]) for k, v in load().items() if v["real"] for e in v["entries"]}
