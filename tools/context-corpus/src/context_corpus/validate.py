"""Corpus validators: contract schema, referential consistency, ownership and name checks."""
from __future__ import annotations

import json
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from .world import SCHEMA_VERSION, TENANT_ID

ONTOLOGY = Path(__file__).resolve().parents[4] / "packages/library-contracts/src/vendor/ontology.schema.json"
# Platform record types are not library context types; the TypeScript loader validates them
# against the platform's own closed schemas, so Python checks only their required keys.
PLATFORM_REQUIRED = {
    "BankingRelationship": {"relationshipId", "institutionId", "customerEntityId", "entities", "parties", "products", "riskTier"},
    "NegativeSearchEvidence": {"capability", "provider", "subject", "dataset_versions", "scope", "truncated",
                               "total_candidates", "coverage", "query_time", "limitations"},
}


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads(ONTOLOGY.read_text(encoding="utf-8")), format_checker=FormatChecker())


def validate_schema(records: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    validator = _validator()
    for record in records:
        rid, kind = record.get("id"), record.get("object_type")
        if kind in PLATFORM_REQUIRED:
            missing = PLATFORM_REQUIRED[kind] - set(record["data"])
            if missing:
                errors.append(f"{rid}: missing {sorted(missing)}")
            continue
        for err in validator.iter_errors(record):
            path = "/".join(str(p) for p in err.absolute_path)
            errors.append(f"{rid} ({kind}) {path}: {err.message[:200]}")
    return errors


def validate_consistency(dossier: Any, spec: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    records = dossier.records
    ids = [r["id"] for r in records]
    if len(ids) != len(set(ids)):
        errors.append("duplicate record ids")
    known = set(ids)
    entity_ids = {r["id"] for r in records if r["object_type"] == "Entity"}
    for r in records:
        if r["tenant_id"] != TENANT_ID or r["schema_version"] != SCHEMA_VERSION or not r["synthetic"]:
            errors.append(f"{r['id']}: envelope tenant/schema/synthetic")
        for sid in r["subject_ids"]:
            if sid not in entity_ids:
                errors.append(f"{r['id']}: subject {sid} is not an Entity")
        data = r["data"]
        for key in ("evidence_ids",):
            for ref in data.get(key, []) if isinstance(data.get(key), list) else []:
                if ref not in known:
                    errors.append(f"{r['id']}: dangling {key} {ref}")
        if r["object_type"] == "OwnershipInterest":
            for end in ("owner", "owned"):
                if data[end] not in entity_ids:
                    errors.append(f"{r['id']}: {end} {data[end]} is not an Entity")
    # Ownership: no entity may be more than fully owned by direct holders.
    held: dict[str, Decimal] = {}
    for r in records:
        if r["object_type"] == "OwnershipInterest":
            held[r["data"]["owned"]] = held.get(r["data"]["owned"], Decimal(0)) + Decimal(r["data"]["interest"])
    for owned, total in held.items():
        if total > 1:
            errors.append(f"{owned}: direct ownership sums to {total} (> 1)")
    # BeneficialOwner records must match the computed effective ownership at the threshold.
    stated = {r["data"]["entity_id"]: Decimal(r["data"]["interest"]) if "interest" in r["data"] else None
              for r in records if r["object_type"] == "BeneficialOwner"}
    for entity_id, share in stated.items():
        if share is not None and share < Decimal("0.25"):
            errors.append(f"{entity_id}: beneficial owner below 25% ({share})")
    from .world import slug
    expected_bo = {slug(x) for x in dossier.expectations["beneficial_owners"]}
    got_bo = {e.split(".entity.")[1] for e in stated}
    if expected_bo != got_bo:
        errors.append(f"beneficial owners {sorted(got_bo)} != answer key {sorted(expected_bo)}")
    for p in dossier.case["subjects"]:
        if p["entity_id"] not in entity_ids:
            errors.append(f"case subject {p['entity_id']} has no Entity record")
    return errors


def validate_names(specs: list[dict[str, Any]], blocklist: set[str]) -> list[str]:
    """Fictional names must not equal a pinned official-list name (Phase 3 supplies the lists)."""
    errors = []
    for spec in specs:
        for e in spec["entities"]:
            if e["name"].casefold() in blocklist:
                errors.append(f"{spec['id']}: name {e['name']!r} matches an official list entry")
    return errors


SKILL_DETECTOR = {f"aml.{k}.detect": k for k in
                  ("structuring", "smurfing", "funnel", "pass_through", "mule", "velocity", "roundtrip", "layering")}


def validate_ledger(dossier: Any, spec: dict[str, Any]) -> list[str]:
    """Scope, balance and detectability checks on a party's ledger."""
    from . import detectors as det

    errors: list[str] = []
    records = dossier.records
    txs = [r for r in records if r["object_type"] == "Transaction"]
    scopes = [r for r in records if r["object_type"] == "DatasetScope"]
    if "ledger" not in spec:
        return errors if not txs else [f"{dossier.party_id}: transactions without a ledger block"]
    if len(scopes) != 1:
        return [f"{dossier.party_id}: exactly one DatasetScope required, found {len(scopes)}"]
    scope = scopes[0]["data"]
    if scope["expected_count"] != len(txs) or not scope["complete"]:
        errors.append("DatasetScope count/complete does not match the ledger")
    if scope["watermark"] < scope["end"]:
        errors.append("DatasetScope watermark precedes window end")
    for t in txs:
        if not scope["start"] <= t["data"]["timestamp"] < scope["end"]:
            errors.append(f"{t['id']}: outside the scope window")
            break
    events = [t["data"]["event_id"] for t in txs]
    if len(events) != len(set(events)):
        errors.append("duplicate event ids in a complete ledger")
    # No overdraft on hero accounts that declare an opening balance.
    opening = {r["id"]: Decimal(r["data"]["extensions"]["ehf.corpus"]["value"]["opening_balance"])
               for r in records if r["object_type"] == "Account" and "extensions" in r["data"]}
    bal = dict(opening)
    for t in sorted(txs, key=lambda r: r["data"]["timestamp"]):
        d = t["data"]
        if d["status"] in {"cancelled", "reversed"}:
            continue
        for acct, sign in ((d["source"], -1), (d["target"], 1)):
            if acct in bal:
                bal[acct] += sign * Decimal(d["amount"])
                if bal[acct] < 0:
                    errors.append(f"{acct} overdrawn at {d['timestamp']}")
    rows = det.rows_from_records(records)
    hero_accounts = set(dossier.expectations["ledger"]["hero_accounts"])
    results = det.run_all(rows)
    ctr = det.ctr_days(rows, hero_accounts)
    signals = {s["id"]: set(s.get("transaction_ids", [])) for s in dossier.expectations["signals"]}
    planted = set().union(*signals.values()) if signals else set()
    hard_negative = bool(spec["expected"].get("hard_negative"))
    rules = set(dossier.expectations.get("alert_rules", []))
    want = spec["expected"].get("alerts", 0)
    if want == 0 and rules:
        errors.append(f"monitoring raised {sorted(rules)} but none expected")
    elif isinstance(want, list) and not set(want) <= rules:
        errors.append(f"expected alert rules {sorted(set(want) - rules)} were not raised")
    for r in records:
        if r["object_type"] == "Alert" and not set(r["data"]["event_ids"]) <= set(events):
            errors.append(f"{r['id']}: alert names events outside the ledger")
    for kind, indicators in results.items():
        for ind in indicators:
            if hard_negative or not set(ind["transaction_ids"]) & planted:
                errors.append(f"unexplained {kind} indicator ({len(ind['transaction_ids'])} tx) on {dossier.party_id}")
                break
    for day in ctr:
        if hard_negative or not set(day["transaction_ids"]) & planted:
            errors.append(f"unexplained CTR day {day['day']}")
    for sig in dossier.expectations["signals"]:
        ids = set(sig.get("transaction_ids", []))
        for skill in sig.get("expect", {}).get("detected_by", []):
            if skill in SKILL_DETECTOR:
                hit = any(set(i["transaction_ids"]) & ids for i in results[SKILL_DETECTOR[skill]])
            elif skill == "regulatory.ctr.evaluate":
                hit = any(set(d["transaction_ids"]) & ids for d in ctr)
            elif skill == "aml.trade_based.detect":
                flagged = {t["trade"] for t in dossier.expectations["ledger"]["trades"].values() if t["mismatch"]}
                hit = {m["trade_id"] for m in det.trade_mismatches(records)} == flagged and bool(flagged)
            else:
                continue
            if not hit:
                errors.append(f"signal {sig['id']} not detected by {skill}")
    return errors


def validate_crowd(crowd: dict[str, Any]) -> list[str]:
    """Base-rate bands for the background crowd (§7 'Base rates')."""
    errors = []
    if not 0.001 <= crowd["planted_rate"] <= 0.005:
        errors.append(f"crowd planted rate {crowd['planted_rate']} outside 0.1%-0.5%")
    d = crowd["detectors"]
    if d["planted_recall"] < 1.0 or d["indicator_precision"] < 0.99:
        errors.append(f"crowd reference detectors out of band: {d}")
    return errors


def validate_fraud(dossier: Any, spec: dict[str, Any]) -> list[str]:
    """Reference fraud detectors must find exactly the planted episode (and nothing on other parties)."""
    from . import detectors as det

    errors: list[str] = []
    recs = dossier.records
    planted: dict[str, set[str]] = {}
    for sig in dossier.expectations["signals"]:
        for kind, ids in sig.get("records", {}).items():
            planted.setdefault(kind, set()).update(ids)
    found = {
        "Session": {a["session"] for a in det.behavior_anomalies(recs)},
        "Payment": {a["payment"] for a in det.payment_anomalies(recs)},
        "FraudSignal": set(det.elevated_fraud_signals(recs)),
    }
    for kind, got in found.items():
        want = planted.get(kind, set())
        if got != want:
            errors.append(f"fraud {kind}: reference detector found {len(got)} ids, answer key has {len(want)}")
    groups = det.shared_attribute_groups(recs)
    ring = set(dossier.expectations.get("ledger", {}).get("ring_entities", []))
    if ring:
        mules = {r["data"]["entity_id"] for r in recs if r["object_type"] == "Counterparty" and "mule_account" in r["data"]["risk_indicators"]}
        if len(groups) != 1 or set(groups[0]["entities"]) != ring | mules:
            errors.append("shared-attribute group does not equal the mule plus its ring")
    elif groups:
        errors.append(f"unexplained shared-attribute groups {groups}")
    if planted.get("Session") and not det.beneficiary_flags(recs):
        errors.append("the planted episode has no flagged beneficiary")
    return errors


def _entity(party: str, ref: str) -> str:
    from .world import slug
    return f"{party.lower()}.entity.{slug(ref)}"


def validate_ownership(dossier: Any, spec: dict[str, Any]) -> list[str]:
    from . import detectors as det

    want = spec["expected"].get("ownership")
    if not want:
        return []
    errors: list[str] = []
    party = dossier.party_id
    recs = dossier.records
    customer = _entity(party, spec["customer"])
    result = det.ownership_analysis(recs, customer)
    reasons = {r for r, _ in result["unresolved"]}
    if reasons != set(want["unresolved"]):
        errors.append(f"unresolved reasons {sorted(reasons)} != answer key {sorted(want['unresolved'])}")
    hits = dossier.expectations.get("screening_result", {}).get("hits", [])
    blocked_ids = {_entity(party, h["subject"]) for h in hits if h["list_type"] == "sanctions" and h["verified_match"]}
    if blocked_ids != {_entity(party, r) for r in want["blocked_owners"]}:
        errors.append("blocked owners from screening do not match the answer key")
    blocked = det.ofac_blocked(recs, blocked_ids)
    chain = {_entity(party, r) for r in want["blocked_chain"]}
    if blocked - blocked_ids != chain:
        errors.append(f"OFAC 50% cascade blocked {sorted(blocked - blocked_ids)}, answer key {sorted(chain)}")
    total = sum((result["interests"].get(e, Decimal(0)) for e in blocked_ids), Decimal(0))
    if str(total.normalize()) != want["path_product_blocked_total"]:
        errors.append(f"path-product blocked total {total} != {want['path_product_blocked_total']}")
    if any(result["interests"].get(e, Decimal(0)) >= Decimal("0.5") for e in blocked_ids):
        errors.append("a designated owner alone reaches 50%: the aggregation scenario no longer holds")
    return errors


def validate_screening(dossier: Any, spec: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    scr = spec.get("screening")
    if not scr or not scr.get("lists"):
        return errors
    party = dossier.party_id
    hits = dossier.expectations.get("screening_result", {}).get("hits", [])
    want = spec["expected"].get("screening", {})
    verified = {h["subject"] for h in hits if h["verified_match"]}
    if "candidate" in want:
        cand = [h for h in hits if h["entry"] == want["candidate"]]
        if len(cand) != 1 or cand[0]["verified_match"] or not cand[0]["identifier_conflict"]:
            errors.append("near-miss candidate must be one hit with conflicting identifiers and no verified match")
        if verified:
            errors.append(f"unexpected verified matches {sorted(verified)} on the near-miss hero")
    if "pep_relative_listed" in want and verified != {want["pep_relative_listed"]}:
        errors.append(f"verified matches {sorted(verified)} != the PEP relative")
    if want.get("customer_listed") is False and spec["customer"] in verified:
        errors.append("customer must not be listed")
    if spec["expected"].get("ownership") is None and "candidate" not in want and "pep_relative_listed" not in want and hits:
        errors.append(f"unexplained screening hits {hits}")
    return errors


def validate_real_names(specs: list[dict[str, Any]]) -> list[str]:
    """Fictional names must not coincide with a pinned real designation (except intended near misses)."""
    from . import watchlists as wl

    real = {wl.normalize(e["name"]): (k, e["uid"]) for k, v in wl.load().items() if v["real"] for e in v["entries"]}
    errors = []
    for spec in specs:
        allowed = set(spec["expected"].get("intended_near_misses", []))
        for e in spec["entities"]:
            n = wl.normalize(e["name"])
            for rn, (lk, uid) in real.items():
                if f"{lk}:{uid}" in allowed:
                    continue
                if n == rn or n == " ".join(reversed(rn.split())) or wl.match({"name": e["name"]}, {"name": rn})["name_score"] >= 0.9:
                    errors.append(f"{spec['id']}: name {e['name']!r} matches real designation {lk}:{uid}")
    return errors
