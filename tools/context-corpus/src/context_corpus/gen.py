"""Derive the dossier (records, case bootstrap, answer key) from one scenario spec."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .iso20022 import camt053
from .ledger_emit import emit_ledger
from .monitoring import build_alerts
from .provider_payloads import ownership_host, screening_host
from . import watchlists as wl
from .world import PURPOSES, SCHEMA_VERSION, TENANT_ID, digest, fraction, sha256_hex, slug, timestamp

NATURAL = {"individual"}
BO_THRESHOLD = Decimal("0.25")
ENTITY_TYPE = {"individual": "individual", "company": "company", "trust": "trust", "fund": "fund",
               "partnership": "partnership", "organization": "organization"}
LEGAL_FORM = {"individual": "individual", "company": "corporation", "trust": "ordinary_trust",
              "fund": "fund", "partnership": "general_partnership", "organization": "association"}


@dataclass
class Dossier:
    party_id: str
    case: dict[str, Any]
    records: list[dict[str, Any]]
    expectations: dict[str, Any]
    effective_ownership: dict[str, str] = field(default_factory=dict)
    files: dict[str, str] = field(default_factory=dict)   # extra source-form files, relative to the party folder


class Builder:
    def __init__(self, party_id: str, as_of: str):
        self.party = party_id
        self.as_of = as_of
        self.records: list[dict[str, Any]] = []
        self.ids: set[str] = set()

    def rid(self, object_type: str, key: str) -> str:
        return f"{self.party.lower()}.{slug(object_type)}.{slug(key)}"

    def add(self, object_type: str, key: str, data: dict[str, Any], *, subjects: list[str],
            observed_at: str | None = None, valid_from: str | None = None, valid_to: str | None = None,
            source_refs: list[dict[str, Any]] | None = None) -> str:
        record_id = self.rid(object_type, key)
        if record_id in self.ids:
            raise ValueError(f"duplicate record id {record_id}")
        self.ids.add(record_id)
        when = observed_at or self.as_of
        self.records.append({
            "id": record_id, "tenant_id": TENANT_ID, "object_type": object_type,
            "schema_version": SCHEMA_VERSION, "version_id": "v1", "supersedes": None,
            "observed_at": when, "recorded_at": when, "valid_from": valid_from, "valid_to": valid_to,
            "classification": "internal", "purposes": PURPOSES, "synthetic": True,
            "subject_ids": subjects, "source_refs": source_refs or [], "data": data,
        })
        return record_id


def effective_ownership(spec: dict[str, Any]) -> dict[str, Decimal]:
    """Effective interest of each entity in the customer: product along paths, summed over paths."""
    edges = spec.get("ownership", [])
    target = spec["customer"]
    owners_of: dict[str, list[tuple[str, Decimal]]] = {}
    for edge in edges:
        if "interest" in edge:   # a range edge has no exact interest and is left unresolved
            owners_of.setdefault(edge["owned"], []).append((edge["owner"], Decimal(str(edge["interest"]))))
    totals: dict[str, Decimal] = {}

    def walk(entity: str, weight: Decimal, path: frozenset[str]) -> None:
        for owner, interest in owners_of.get(entity, []):
            if owner in path:  # circular holding: do not loop
                continue
            share = weight * interest
            totals[owner] = totals.get(owner, Decimal(0)) + share
            walk(owner, share, path | {owner})

    walk(target, Decimal(1), frozenset({target}))
    return totals


def generate(spec: dict[str, Any]) -> Dossier:
    party = spec["id"]
    as_of = timestamp(spec["as_of"])
    b = Builder(party, as_of)
    entities = {e["ref"]: e for e in spec["entities"]}
    eid = lambda ref: f"{party.lower()}.entity.{slug(ref)}"  # noqa: E731
    customer = spec["customer"]
    evidence_ids: dict[str, str] = {}

    for e in spec["entities"]:
        ref, entity_id = e["ref"], eid(e["ref"])
        subjects = [entity_id]
        addr = e.get("address")
        address_text = ", ".join(x for x in [*addr["lines"], addr.get("locality"), addr.get("postal_code"),
                                             addr["country"]] if x) if addr else None
        identifiers = [i["value"] for i in e.get("identifiers", [])]
        reg = e.get("registration")
        attrs: dict[str, Any] = {}
        for k in ("phone", "email"):
            if e.get(k):
                attrs[k] = e[k]
        if address_text:
            attrs["address"] = address_text
        if reg:
            attrs["registration_id"] = reg["registration_id"]
        # The Entity record id doubles as the entity id other records reference.
        b.add("Entity", ref, {"name": e["name"], "identifiers": identifiers or [f"{party}-{slug(ref)}"],
                              "entity_type": ENTITY_TYPE[e["kind"]], "attributes": attrs},
              subjects=subjects)
        if addr:
            b.add("Address", f"{ref}.primary", {**{k: v for k, v in addr.items()},
                  "normalized": address_text}, subjects=subjects)
        if e["kind"] in NATURAL:
            ident_attrs: dict[str, Any] = {"name": e["name"], "identifiers": identifiers, "synthetic": True}
            if e.get("dob"):
                ident_attrs["date_of_birth"] = str(e["dob"])
            b.add("Identity", ref, {"attributes": ident_attrs}, subjects=subjects)
        for n, ident in enumerate(e.get("identifiers", [])):
            b.add("IdentityIdentifier", f"{ref}.{n}", {
                "entity_id": entity_id, "issuer": ident["issuer"], "value": ident["value"],
                "identifier_type": ident["type"], "verified": bool(ident.get("verified", True))}, subjects=subjects)
        for n, alias in enumerate(e.get("aliases", [])):
            b.add("Alias", f"{ref}.{n}", {"name": alias["name"], "entity_id": entity_id,
                  **({"language": alias["language"]} if alias.get("language") else {}),
                  **({"script": alias["script"]} if alias.get("script") else {})}, subjects=subjects)
        content = f"SPECIMEN verification of {e['name']} by {e.get('verification', 'document_check')}"
        ev = b.add("Evidence", f"{ref}.verification", {
            "content": content, "content_hash": sha256_hex(content), "source_id": f"{party}-{slug(ref)}-verification",
            "requirement_ids": [], "verified": True}, subjects=subjects)
        evidence_ids[ref] = ev
        b.add("VerificationRecord", ref, {"subject": entity_id, "status": "VERIFIED",
              "method": e.get("verification", "document_check"), "evidence_ids": [ev]}, subjects=subjects)
        if reg:
            b.add("Registration", ref, {"jurisdiction": reg["jurisdiction"], "authority": reg["authority"],
                  "registration_id": reg["registration_id"]}, subjects=subjects,
                  valid_from=timestamp(reg["incorporated"]) if reg.get("incorporated") else None)
            b.add("RegistryRecord", ref, {
                # Upper case, as the platform's registry normalizer writes it (canonical-records.ts).
                "name": e["name"], "registration_id": reg["registration_id"], "status": str(reg.get("status", "active")).upper(),
                **({"address": address_text} if address_text else {}),
                "attributes": {"jurisdiction": reg["jurisdiction"], "name": e["name"],
                               "registration_id": reg["registration_id"], "status": str(reg.get("status", "active")).upper()},
                "coverage": {"complete": True, "as_of": as_of, "provider": "synthetic-registry",
                             "jurisdictions": [reg["jurisdiction"]], "limitations": []}},
                subjects=subjects)

    for n, o in enumerate(spec.get("officers", [])):
        b.add("OfficerRole", f"{o['person']}.{slug(o['role'])}.{n}", {
            "entity_id": eid(o["person"]), "organization_id": eid(o["org"]), "role": o["role"]},
            subjects=[eid(o["person"]), eid(o["org"])],
            valid_from=timestamp(o["appointed"]) if o.get("appointed") else None)

    ownership_evidence = None
    if spec.get("ownership"):
        text = "SPECIMEN ownership declaration: " + "; ".join(
            f"{entities[x['owner']]['name']} holds {x.get('interest') or 'between ' + ' and '.join(map(str, x['range']))} of {entities[x['owned']]['name']}"
            for x in spec["ownership"])
        ownership_evidence = b.add("Evidence", "ownership-declaration", {
            "content": text, "content_hash": sha256_hex(text), "source_id": f"{party}-ownership-declaration",
            "requirement_ids": [], "verified": True}, subjects=[eid(customer)])
    for x in spec.get("ownership", []):
        if "range" in x:
            b.add("OwnershipRange", f"{x['owner']}.{x['owned']}", {
                "owner": eid(x["owner"]), "owned": eid(x["owned"]), "lower": fraction(x["range"][0]), "upper": fraction(x["range"][1]),
                "lower_inclusive": True, "upper_inclusive": True}, subjects=[eid(x["owner"]), eid(x["owned"])],
                valid_from=timestamp(x["since"]) if x.get("since") else None)
            continue
        b.add("OwnershipInterest", f"{x['owner']}.{x['owned']}", {
            "owner": eid(x["owner"]), "owned": eid(x["owned"]), "interest": fraction(x["interest"]),
            **({"share_class": x["share_class"]} if x.get("share_class") else {}),
            **({"voting_interest": fraction(x["voting_interest"])} if x.get("voting_interest") else {})},
            subjects=[eid(x["owner"]), eid(x["owned"])],
            valid_from=timestamp(x["since"]) if x.get("since") else None)
    for x in spec.get("control", []):
        b.add("ControlRight", f"{x['controller']}.{x['controlled']}", {
            "controller": eid(x["controller"]), "controlled": eid(x["controlled"]),
            "basis": x["basis"], "verified": bool(x.get("verified", True))}, subjects=[eid(x["controller"]), eid(x["controlled"])])

    effective = effective_ownership(spec)
    beneficial = {r: v for r, v in effective.items() if entities[r]["kind"] in NATURAL and v >= BO_THRESHOLD}
    if "beneficial_owners" in spec:   # e.g. a trust: every party with a defined role, no percentage threshold
        beneficial = {x["entity"]: None for x in spec["beneficial_owners"]}
    bo_evidence = ownership_evidence or evidence_ids[customer]
    for ref, share in sorted(beneficial.items()):
        b.add("BeneficialOwner", ref, {"entity_id": eid(ref), **({"interest": fraction(share)} if share is not None else {}),
              "evidence_ids": [bo_evidence]}, subjects=[eid(ref), eid(customer)])
    for n, x in enumerate(spec.get("relationships", [])):
        b.add("Relationship", f"{x['source']}.{x['target']}.{x['relation']}", {
            "source": eid(x["source"]), "target": eid(x["target"]), "relation": x["relation"], "verified": bool(x["verified"])},
            subjects=[eid(x["source"]), eid(x["target"])])
    for x in spec.get("pep_relationships", []):
        b.add("PEPRelationship", f"{x['source']}.{x['target']}", {
            "source": eid(x["source"]), "target": eid(x["target"]), "relation": x["relation"], "verified": bool(x["verified"])},
            subjects=[eid(x["source"]), eid(x["target"]), eid(customer)])
    for n, x in enumerate(spec.get("timeline", [])):
        b.add("TimelineEvent", f"{n + 1:02d}-{slug(x['event'])}", {
            "timestamp": timestamp(x["at"]), "subject": eid(x["subject"]), "change": {"event": x["event"], **x.get("change", {})}},
            subjects=[eid(customer)], observed_at=timestamp(x["at"]))
    for n, x in enumerate(spec.get("review_triggers", [])):
        b.add("ReviewTrigger", f"{n + 1:02d}", {"requirement_ids": x["requirements"], "reason": x["reason"]},
              subjects=[eid(customer)], observed_at=timestamp(x["at"]))

    rel = spec["relationship"]
    cust = entities[customer]
    b.add("Party", customer, {
        "entity_id": eid(customer), "role": "customer", "customer_type": rel.get("customer_type", cust["kind"]),
        "profile": {"legal_name": cust["name"], **({"business_purpose": cust["business_purpose"]}
                    if cust.get("business_purpose") else {}),
                    **({"employees": cust["employees"]} if "employees" in cust else {})},
        **({"industry": cust["industry"]} if cust.get("industry") else {})}, subjects=[eid(customer)])
    b.add("CustomerRelationship", customer, {
        "party_id": b.rid("Party", customer), "institution_id": rel["institution"],
        "relationship_type": "customer", "status": "active", "started_at": timestamp(rel["started"])},
        subjects=[eid(customer)])

    accounts: dict[str, str] = {}
    for product in rel["products"]:
        ptype = product["type"]
        b.add("Product", ptype, {"product_type": ptype, "channel": product["channels"][0], "active": True},
              subjects=[eid(customer)])
        if ptype in {"deposit", "payments", "card", "lending", "merchant_acquiring", "trade_finance"}:
            accounts[ptype] = b.rid("Account", ptype)
            b.add("Account", ptype, {"entity_id": eid(customer), "account_type": ptype,
                  "currency": product["currencies"][0], "status": "open"}, subjects=[eid(customer)])
        ea = product.get("expected_activity")
        if ea and ptype in {"deposit", "payments"}:
            start = timestamp(rel["started"])
            b.add("ExpectedActivity", ptype, {
                "declared": {"currency": ea["currency"], "monthly_amount": str(ea["monthly_inflow"]),
                             **({"count": ea["transaction_count"]} if ea.get("transaction_count") is not None else {})},
                "window": {"start": start, "end": as_of}, "behavior_category": ea.get("behavior", "baseline")},
                subjects=[eid(customer)])
    for g in rel.get("geography", []):
        b.add("GeographyExposure", g["country"], {"country": g["country"], "basis": g["basis"],
              "value": str(g["value"])}, subjects=[eid(customer)])
    for kind, key in (("SourceOfFunds", "source_of_funds"), ("SourceOfWealth", "source_of_wealth")):
        for n, item in enumerate(spec.get(key, [])):
            b.add(kind, f"{customer}.{n}", {"claim": item["claim"], "evidence_ids": [evidence_ids[customer]],
                  "verified": bool(item.get("verified", True))}, subjects=[eid(customer)])

    for factor in spec.get("risk_factors", []):
        b.add("RiskFactor", f"{customer}.{slug(factor['name'])}", {"name": factor["name"], "score": str(factor["score"])},
              subjects=[eid(customer)])

    scr = spec.get("screening")
    screening_info: dict[str, Any] = {}
    if scr:
        subjects_screened = scr.get("subjects") or [customer]
        list_keys = scr.get("lists", [])
        lists = wl.load()
        entry_ids: dict[str, str] = {}
        for lk in list_keys:
            meta = lists[lk]
            for e in meta["entries"]:
                entry_ids[f"{lk}:{e['uid']}"] = b.add("WatchlistEntry", f"{lk}-{e['uid']}", {
                    "name": e["name"], "identifiers": e["identifiers"], "list_type": meta["list_type"], "list_version": meta["version"],
                    "coverage": {"complete": meta["complete"], "as_of": as_of, "provider": lk, "limitations": [meta["notice"]]},
                    "extensions": {"ehf.corpus": {"schema_version": "1.0.0", "value": {
                        "uid": e["uid"], "programs": e["programs"], "real_designation": e["real"], "dob": e["dob"]}}}},
                    subjects=[eid(customer)])
        planned = {(h["subject"], h["entry"]) for h in scr.get("hits", [])}
        hits: list[dict[str, Any]] = []
        for ref in subjects_screened:
            ent = {"name": entities[ref]["name"], "identifiers": [i["value"] for i in entities[ref].get("identifiers", [])]}
            for key, rid in entry_ids.items():
                lk, uid = key.split(":", 1)
                m = wl.match(ent, next(x for x in lists[lk]["entries"] if x["uid"] == uid))
                if m["verified_match"] or (ref, key) in planned:
                    hits.append({"subject": ref, "key": key, "list_type": lists[lk]["list_type"], "features": m})
        for h in hits:
            h["record"] = b.add("ScreeningHit", f"{h['subject']}.{slug(h['key'])}", {
                "entity_id": eid(h["subject"]), "entry_id": entry_ids[h["key"]], "features": h["features"]},
                subjects=[eid(h["subject"]), eid(customer)])
        screening_info = {"hits": [{"subject": h["subject"], "entry": h["key"], "list_type": h["list_type"],
                                    "verified_match": h["features"]["verified_match"], "identifier_conflict": h["features"]["identifier_conflict"],
                                    "record": h["record"]} for h in hits]}
        for ref in subjects_screened:
            for stype in scr["types"]:
                key = f"{ref}.{stype}"
                found = [h for h in hits if h["subject"] == ref and h["list_type"] == stype]
                versions = [lists[lk]["version"] for lk in list_keys if lists[lk]["list_type"] == stype] or scr["dataset_versions"]
                b.add("ScreeningExecution", key, {
                    "subject": eid(ref), "screening_type": stype, "provider": scr["provider"],
                    "query": entities[ref]["name"], "query_time": as_of, "status": "COMPLETED",
                    "dataset_versions": versions, "scope": scr["scope"],
                    "list_published_at": timestamp(scr["list_published"]), "candidate_count": len(found),
                    "truncated": False, "limitations": ["Pinned list subset; not universal clearance."] if list_keys else []},
                    subjects=[eid(ref)])
                if not found:
                    b.add("NegativeSearchEvidence", key, {
                        # An adverse-media search is its own capability; the list searches share the scenario's.
                        "capability": "screening.adverse_media.v1" if stype == "adverse_media" else scr.get("capability", "screening.sanctions.v1"), "provider": scr["provider"],
                        "subject": eid(ref), "dataset_versions": versions, "scope": scr["scope"],
                        "truncated": False, "total_candidates": 0, "query_time": as_of, "limitations": [],
                        "coverage": {"complete": True, "as_of": as_of, "provider": scr["provider"]}},
                        subjects=[eid(ref)])

    ledger_info = emit_ledger(b, spec, eid(customer), accounts) if "ledger" in spec else None

    parties = [{"entityId": eid(p["entity"]), "role": p["role"], "validFrom": None, "validTo": None,
                "authorityEvidenceRefs": [], "authorityScope": []} for p in rel["parties"]]
    relationship = {
        "relationshipId": f"{party.lower()}.relationship", "institutionId": rel["institution"],
        "bookingJurisdiction": rel["booking_jurisdiction"], "policyJurisdiction": rel["policy_jurisdiction"],
        "customerEntityId": eid(customer), "event": rel.get("event", "onboarding"), "asOf": as_of,
        "entities": [{"entityId": eid(e["ref"]), "name": e["name"], "legalForm": e.get("legal_form", LEGAL_FORM[e["kind"]]),
                      "legalEntityCustomer": e["kind"] != "individual" if e["ref"] == customer else None,
                      "formationJurisdiction": (e.get("registration") or {}).get("jurisdiction")}
                     for e in spec["entities"]],
        "parties": parties,
        "products": [{"productId": f"{party.lower()}.product.{p['type']}", "productType": p["type"],
                      "currencies": p["currencies"], "countries": p["countries"], "channels": p["channels"],
                      "expectedActivity": ({"monthlyInflow": str(p["expected_activity"]["monthly_inflow"]),
                                            "monthlyOutflow": str(p["expected_activity"]["monthly_outflow"]),
                                            "currency": p["expected_activity"]["currency"],
                                            "transactionCount": p["expected_activity"].get("transaction_count"),
                                            "cashExposure": p["expected_activity"].get("cash_exposure"),
                                            "counterpartyCountries": p["expected_activity"].get("counterparty_countries", []),
                                            "counterpartyTypes": p["expected_activity"].get("counterparty_types", []),
                                            "paymentRails": p["expected_activity"].get("rails", [])}
                                           if p.get("expected_activity") else None)}
                     for p in rel["products"]],
        "riskTier": rel["risk_tier"], "ownershipComplete": rel.get("ownership_complete"),
        "boTreatment": None, "priorBo": None,
    }
    b.add("BankingRelationship", "relationship", relationship, subjects=[eid(customer)])

    case = {
        "party_id": party, "external_ref": f"corpus-{party}", "tenant_id": TENANT_ID, "case_type": "kyc_onboarding",
        "as_of": as_of, "customer_entity_id": eid(customer),
        "subjects": [{"ref": e["ref"], "entity_id": eid(e["ref"]), "name": e["name"],
                      "subject_type": "individual" if e["kind"] == "individual" else "legal_entity",
                      "role": next((p["role"] for p in rel["parties"] if p["entity"] == e["ref"]), None),
                      "identifiers": [{"identifier_type": i["type"], "value": i["value"], "source": i["issuer"]}
                                      for i in e.get("identifiers", [])]} for e in spec["entities"]],
        "relationship_record_id": b.rid("BankingRelationship", "relationship"),
        "record_count": len(b.records),
    }
    expectations = {
        "party_id": party, "seed": spec["seed"], "as_of": as_of, "spec_digest": digest(spec),
        "signals": [{**sig, **({"transaction_ids": sorted(ledger_info["signals"].get(sig["id"], [])),
                                    **({"records": ledger_info["signal_records"][sig["id"]]}
                                       if sig["id"] in ledger_info["signal_records"] else {})}
                                if ledger_info else {})} for sig in spec.get("signals", [])],
        **({"ledger": {k: v for k, v in ledger_info.items() if k not in ("signals", "signal_records")}} if ledger_info else {}),
        **({"screening_result": screening_info} if screening_info else {}),
        "effective_ownership": {r: fraction(v) for r, v in sorted(effective.items())},
        "beneficial_owners": sorted(beneficial), **{k: v for k, v in spec["expected"].items()},
    }
    files = {}
    alerts: list[dict[str, Any]] = []
    if ledger_info:
        alerts = build_alerts(party, eid(customer), b.records, set(ledger_info["hero_accounts"]))
        for a in alerts:
            b.add("Alert", a["alert_id"], {"source_id": a["alert_id"], "rule_id": a["rule_id"], "subject": a["subject"],
                  "severity": a["severity"], "event_ids": a["event_ids"]}, subjects=[eid(customer)], observed_at=a["raised_at"])
        files["provider/transaction.monitor.v1/alerts.json"] = json.dumps(
            {"schema": "transaction.monitor.v1/alerts", "monitor": "synthetic-rules-v1", "subject": eid(customer),
             "as_of": as_of, "alerts": alerts}, indent=2, sort_keys=True) + "\n"
        expectations["alert_rules"] = sorted({a["rule_id"] for a in alerts})
    if ledger_info:
        files["iso20022/camt.053.xml"] = camt053(party, b.records, set(ledger_info["hero_accounts"]), as_of)
    case["record_count"] = len(b.records)
    if scr and scr.get("lists"):
        for ref in scr.get("subjects") or [customer]:
            for stype in scr["types"]:
                if any(wl.load()[lk]["list_type"] == stype for lk in scr["lists"]):
                    files[f"provider/screening.{stype}.v1/{slug(ref)}.json"] = screening_host(
                        spec, as_of, eid, ref, stype, screening_info["hits"], wl.load())
    host = ownership_host(spec, as_of, eid)
    if host:
        files["provider/business.ownership.discover.v1/host.json"] = host
    return Dossier(party, case, b.records, expectations, {r: fraction(v) for r, v in effective.items()}, files)
