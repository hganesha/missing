"""Provider-form payloads (what a connector returns), derived from the same spec as the records."""
from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any

from .world import slug


def ownership_host(spec: dict[str, Any], as_of: str, eid) -> str | None:
    """`CanonicalHostResult` (kind `ownership`) for `business.ownership.discover.v1`."""
    edges, controls = spec.get("ownership", []), spec.get("control", [])
    if not edges and not controls:
        return None
    entities = {e["ref"]: e for e in spec["entities"]}
    used = {r for x in edges for r in (x["owner"], x["owned"])} | {r for x in controls for r in (x["controller"], x["controlled"])}
    out_entities = []
    for ref in sorted(used):
        e = entities[ref]
        idents = [{"scheme": "corpus_entity", "value": eid(ref)}]
        if e.get("registration"):
            idents.append({"scheme": "company_registration", "value": e["registration"]["registration_id"],
                           "jurisdiction": e["registration"]["jurisdiction"]})
        out_entities.append({
            "entity_id": f"e-{slug(ref)}", "entity_type": "person" if e["kind"] == "individual" else "organization",
            "names": [{"kind": "legal", "full": e["name"]}], "identifiers": idents, "source_record_ids": [eid(ref)],
            **({"jurisdiction": e["registration"]["jurisdiction"]} if e.get("registration") else {}),
        })
    rels = []
    for n, x in enumerate(edges, 1):
        rels.append({"relationship_id": f"own-{n:02d}", "type": "owns", "from_entity_id": f"e-{slug(x['owner'])}",
                     "to_entity_id": f"e-{slug(x['owned'])}", "assertion_status": "confirmed",
                     **({"valid_from": str(x["since"])} if x.get("since") else {}),
                     "ownership": ({"kind": "equity", "exact_percent": float(Decimal(str(x["interest"])) * 100), "directness": "direct"}
                                   if "interest" in x else
                                   {"kind": "equity", "lower_percent": float(Decimal(str(x["range"][0])) * 100),
                                    "upper_percent": float(Decimal(str(x["range"][1])) * 100), "lower_inclusive": True,
                                    "upper_inclusive": True, "directness": "direct"})})
    for n, x in enumerate(controls, 1):
        rels.append({"relationship_id": f"ctl-{n:02d}", "type": "controls", "from_entity_id": f"e-{slug(x['controller'])}",
                     "to_entity_id": f"e-{slug(x['controlled'])}", "assertion_status": "confirmed", "ownership": {"kind": "control", "directness": "direct"}})
    complete = spec["relationship"].get("ownership_complete")
    host = {
        "result_id": f"corpus-ownership-{spec['id'].lower()}", "subject_entity_id": f"e-{slug(spec['customer'])}",
        "execution": {"status": "completed", "provider_observed_at": as_of, "received_at": as_of},
        "coverage": {"status": "complete_for_requested_scope" if complete else "partial", "checked_scope": ["corpus"]},
        "result": {"kind": "ownership", "root_entity_id": f"e-{slug(spec['customer'])}", "completeness": "complete" if complete else "unknown"},
        "entities": out_entities, "relationships": rels, "evidence": [],
    }
    return json.dumps(host, indent=2, sort_keys=True) + "\n"


_MONTHS = {m: n for n, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}


def birth_date(values: list[str]) -> dict[str, str] | None:
    """A provider-style `{value, precision}` birth date from list or spec text, as a screening connector
    reports it. Only one stated date is used (several list dates are ambiguous); `1969` is year precision,
    `04 Dec 1969` and `1969-12-04` are day precision, anything else is omitted."""
    if len(values) != 1:
        return None
    text = values[0].strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return {"value": text, "precision": "day"}
    parts = text.split()
    if len(parts) == 3 and parts[0].isdigit() and parts[1][:3].lower() in _MONTHS and parts[2].isdigit():
        return {"value": f"{int(parts[2]):04d}-{_MONTHS[parts[1][:3].lower()]:02d}-{int(parts[0]):02d}", "precision": "day"}
    if re.fullmatch(r"\d{4}", text):
        return {"value": text, "precision": "year"}
    return None


def screening_host(spec: dict[str, Any], as_of: str, eid, subject: str, stype: str, hits: list[dict[str, Any]], lists: dict[str, Any]) -> str:
    """`CanonicalHostResult` (kind `screening`) for one subject and list type, as a screening connector returns it."""
    from . import watchlists as wl

    entities = {e["ref"]: e for e in spec["entities"]}
    subj = entities[subject]
    subj_id = f"e-{slug(subject)}"
    subj_birth = birth_date([str(subj["dob"])] if subj.get("dob") else [])
    out_entities = [{"entity_id": subj_id, "entity_type": "person" if subj["kind"] == "individual" else "organization",
                     "names": [{"kind": "legal", "full": subj["name"]}],
                     "identifiers": [{"scheme": i["type"], "value": i["value"]} for i in subj.get("identifiers", [])],
                     "source_record_ids": [eid(subject)], **({"birth_date": subj_birth} if subj_birth else {})}]
    matches = []
    for n, h in enumerate(h for h in hits if h["subject"] == subject and h["list_type"] == stype):
        lk, uid = h["entry"].split(":", 1)
        e = next(x for x in lists[lk]["entries"] if x["uid"] == uid)
        cid = f"c-{n + 1}"
        listed_birth = birth_date(e.get("dob") or [])
        out_entities.append({"entity_id": cid, "entity_type": "person" if e["type"] == "individual" else "organization",
                             "names": [{"kind": "legal", "full": e["name"]}],
                             "identifiers": [{"scheme": "list_document", "value": v} for v in e["identifiers"]], "source_record_ids": [uid],
                             **({"birth_date": listed_birth} if listed_birth else {})})
        feats = wl.match({"name": subj["name"], "identifiers": [i["value"] for i in subj.get("identifiers", [])]}, e)
        matches.append({"match_id": f"m-{n + 1}", "candidate_entity_id": cid, "list_ids": [lk], "programs": e["programs"],
                        "matched_fields": ["name", "identifier"] if feats["verified_match"] else ["name"],
                        "scores": [{"kind": "name", "value": feats["name_score"]}], "disposition": "unresolved", "categories": []})
    versions = sorted({lists[lk]["version"] for lk in spec["screening"].get("lists", []) if lists[lk]["list_type"] == stype})
    host = {
        "result_id": f"corpus-screening-{spec['id'].lower()}-{slug(subject)}-{stype}", "subject_entity_id": subj_id,
        "execution": {"status": "completed", "provider_observed_at": as_of, "received_at": as_of},
        "coverage": {"status": "complete_for_requested_scope", "checked_scope": spec["screening"]["scope"]},
        "result": {"kind": "screening", "matches": matches, "dataset_versions": versions, "scope": spec["screening"]["scope"],
                   "total_candidates": len(matches), "truncated": False, "list_published_at": f"{spec['screening']['list_published']}T00:00:00Z"},
        "entities": out_entities, "relationships": [], "evidence": [],
    }
    return json.dumps(host, indent=2, sort_keys=True) + "\n"
