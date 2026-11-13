"""GLEIF Level 1/2 sample: structural templates for cross-border ownership chains (names are not kept)."""
from __future__ import annotations

import json
import random
from collections import Counter
from pathlib import Path
from typing import Any

from .http import fetch

API = "https://api.gleif.org/api/v1"
COUNTRIES = ["LU", "CY", "VG", "US", "GB", "NL", "IE", "KY"]
PAGE_SIZE = 200
MAX_DEPTH = 4
CHAINS_PER_COUNTRY = 14
PAGES_PER_COUNTRY = 2
INTERVAL = 1.2  # GLEIF allows 60 requests a minute


def _get(path: str) -> dict[str, Any]:
    body, _ = fetch(f"{API}{path}", min_interval=INTERVAL, timeout=60)
    return json.loads(body)


def _shape(record: dict[str, Any]) -> dict[str, Any]:
    e = record["attributes"]["entity"]
    return {"country": e["legalAddress"]["country"], "legal_form": (e.get("legalForm") or {}).get("id"),
            "category": e.get("category"), "jurisdiction": e.get("jurisdiction")}


def collect(out_dir: Path, seed: int = 424242) -> dict[str, Any]:
    rng = random.Random(f"gleif:{seed}")
    chains: list[list[dict[str, Any]]] = []
    requests = 0
    for country in COUNTRIES:
        first = _get(f"/lei-records?page%5Bsize%5D={PAGE_SIZE}&page%5Bnumber%5D=1&filter%5Bentity.legalAddress.country%5D={country}")
        last = min(first["meta"]["pagination"]["lastPage"], 50)  # GLEIF caps page x size at 10,000
        data = []
        for page in sorted({rng.randint(1, last) for _ in range(PAGES_PER_COUNTRY)}):
            data += _get(f"/lei-records?page%5Bsize%5D={PAGE_SIZE}&page%5Bnumber%5D={page}&filter%5Bentity.legalAddress.country%5D={country}")["data"]
            requests += 1
        requests += 1
        followed = 0
        for rec in data:
            if followed >= CHAINS_PER_COUNTRY:
                break
            link = ((rec["relationships"].get("direct-parent") or {}).get("links") or {}).get("lei-record")
            if not link:
                continue
            followed += 1
            chain, cur = [_shape(rec)], link
            for _ in range(MAX_DEPTH):
                try:
                    parent = json.loads(fetch(cur, min_interval=INTERVAL, timeout=60)[0])["data"]
                except Exception:  # noqa: BLE001 - a dangling parent ends the chain
                    break
                requests += 1
                chain.append(_shape(parent))
                cur = ((parent["relationships"].get("direct-parent") or {}).get("links") or {}).get("lei-record")
                if not cur:
                    break
            chains.append(chain)
    depth = Counter(len(c) for c in chains)
    steps = Counter(f"{c[i + 1]['country']}>{c[i]['country']}" for c in chains for i in range(len(c) - 1))  # parent>child
    shapes = Counter(">".join(n["country"] for n in reversed(c)) for c in chains if len(c) >= 3)
    doc = {"source": "GLEIF Level 1 + Level 2 (direct parent)", "sample_chains": len(chains), "requests": requests,
           "depth_histogram": dict(sorted(depth.items())), "parent_to_child_country_steps": dict(steps.most_common()),
           "ultimate_to_subject_shapes_depth_ge_3": dict(shapes.most_common(30)),
           "note": "Structure only; entity names and LEIs are deliberately not retained."}
    (out_dir / "gleif-templates.json").write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return doc
