"""Scenario spec loading and structural validation (facts and signals, never records)."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ENTITY_KINDS = {"individual", "company", "trust", "fund", "partnership", "organization"}
TOP_KEYS = {"id", "seed", "as_of", "customer", "entities", "officers", "ownership", "control",
            "relationship", "source_of_funds", "source_of_wealth", "risk_factors", "ledger", "digital", "relationships", "pep_relationships", "timeline", "review_triggers", "beneficial_owners", "screening", "expected", "signals"}


class SpecError(ValueError):
    pass


class _Loader(yaml.SafeLoader):
    """SafeLoader that keeps ISO dates as strings, so specs digest and render identically."""


_Loader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if tag != "tag:yaml.org,2002:timestamp"]
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def load_spec(path: Path) -> dict[str, Any]:
    spec = yaml.load(path.read_text(encoding="utf-8"), Loader=_Loader)  # noqa: S506
    validate_spec(spec, path.name)
    return spec


def validate_spec(spec: Any, name: str = "spec") -> None:
    def fail(message: str) -> None:
        raise SpecError(f"{name}: {message}")

    if not isinstance(spec, dict):
        fail("must be a mapping")
    unknown = set(spec) - TOP_KEYS
    if unknown:
        fail(f"unknown keys {sorted(unknown)}")
    for key in ("id", "seed", "as_of", "customer", "entities", "relationship", "expected"):
        if key not in spec:
            fail(f"missing '{key}'")
    refs = [e.get("ref") for e in spec["entities"]]
    if len(set(refs)) != len(refs) or not all(refs):
        fail("entity refs must be unique and non-empty")
    if spec["customer"] not in refs:
        fail("customer must name an entity")
    for entity in spec["entities"]:
        if entity.get("kind") not in ENTITY_KINDS:
            fail(f"entity {entity.get('ref')}: bad kind")
        if not entity.get("name"):
            fail(f"entity {entity['ref']}: name required")
    known = set(refs)
    for edge in spec.get("ownership", []):
        if edge["owner"] not in known or edge["owned"] not in known:
            fail(f"ownership edge {edge} references an unknown entity")
        if "range" in edge:
            lo, hi = (float(x) for x in edge["range"])
            if not 0 <= lo < hi <= 1 or "interest" in edge:
                fail(f"ownership range invalid (a range edge has no exact interest): {edge}")
        elif not 0 < float(edge["interest"]) <= 1:
            fail(f"ownership interest out of range: {edge}")
    for officer in spec.get("officers", []):
        if officer["person"] not in known or officer["org"] not in known:
            fail(f"officer {officer} references an unknown entity")
    for party in spec["relationship"].get("parties", []):
        if party["entity"] not in known:
            fail(f"relationship party {party} references an unknown entity")
    for signal in spec.get("signals", []):
        for key in ("id", "type", "expect"):
            if key not in signal:
                fail(f"signal missing '{key}'")
    expected = spec["expected"]
    if not isinstance(expected.get("workflow"), dict):
        fail("expected.workflow is required")
