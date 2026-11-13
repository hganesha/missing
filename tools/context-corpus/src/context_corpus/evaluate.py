"""Evaluation of production slice 1's skills (docs/implementation/production-slice-1.md section 6).

Runs every slice skill through the skill library's own executor, chained as the slice workflow binds
them, over the corpus parties, under the slice's candidate policy (domains/kyb-screening/policy), and
compares each result with the expected outcome. Expectations come from this module's reference
implementations over the scenario facts, never from the library under test, so a library defect
cannot hide in its own answer key.

Splits: `dev` is the committed heroes the slice covers; `heldout` is generated from
`CORPUS_HELDOUT_SALT` (heldout.py) and never written to the repository.

The report carries, per skill, metrics, control cases and an `evidence` block in the shape of
`skill.qualification.v1.evidence` (packages/contracts). Thresholds are placeholders until the policy
owner sets them (`thresholdSource: placeholder`); a placeholder never makes evidence acceptable.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from . import watchlists as wl
from .world import canonical_json

REPO = Path(__file__).resolve().parents[4]
SLICE = "kyb-screening-ownership-us"
POLICY_PATH = REPO / "domains/kyb-screening/policy/slice-policy.json"
AT = datetime(2026, 9, 30, tzinfo=timezone.utc)
DEV_PARTIES = ("H01", "H02", "H03", "H04", "H05", "H06", "H07", "H10", "H12")
SKILLS = (
    "decision.policy.resolve", "entity.resolve", "registry.company.verify", "ownership.graph.build",
    "ownership.interest.calculate", "ownership.ubo.resolve", "ownership.ubo.verify", "screening.name.normalize",
    "screening.sanctions.execute", "screening.pep.execute", "screening.match.disambiguate",
    "screening.sanctions.ownership.evaluate",
)
POLICY_METADATA = {"id", "status", "owner_role", "approved_by", "basis"}
# Domain policy fields whose absence must never produce a favorable result (control cases).
CONTROL_FIELDS = {
    "registry.company.verify": "active_registry_statuses",
    "ownership.ubo.resolve": "ownership_threshold",
    "ownership.ubo.verify": "verification_methods",
    "screening.sanctions.execute": "screening_threshold",
    "screening.pep.execute": "screening_threshold",
    "screening.sanctions.ownership.evaluate": "sanctions_ownership",
}
# Placeholder thresholds: every check must pass on every applicable case, no clearing control may fail.
PLACEHOLDER_THRESHOLD = 1.0


def _library():
    src = REPO / "apps/fincrime-host/src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))
    try:
        import financial_crime.synthetic as fixtures
        from financial_crime.context_types import data_schema
        from financial_crime.contracts import Principal, Record
        from financial_crime.execution import Executor
        from financial_crime.store import Store
    except ImportError as error:  # pragma: no cover - environment
        raise SystemExit(f"the skill library is not importable ({error}); install apps/fincrime-host's locked dependencies") from error
    return fixtures, data_schema, Principal, Record, Executor, Store


def slice_policy() -> tuple[dict[str, Any], str]:
    raw = POLICY_PATH.read_bytes()
    return {k: v for k, v in json.loads(raw).items() if k not in POLICY_METADATA}, hashlib.sha256(raw).hexdigest()


def _ts(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------------------------
# Running the library


def run_party(dossier, policy: dict[str, Any], *, skills: tuple[str, ...] = SKILLS, drop_types: frozenset[str] = frozenset()) -> dict[str, Any]:
    """Skill id -> SkillResult, run in slice order with the slice's bindings."""
    fixtures, data_schema, Principal, Record, Executor, Store = _library()

    def known(object_type: str) -> bool:
        try:
            data_schema(object_type)
            return True
        except ValueError:  # platform-only types (NegativeSearchEvidence, BankingRelationship, ...)
            return False

    async def go():
        store = Store()
        store.put(Record(id="slice-policy", tenant_id="tenant-synthetic", object_type="Policy", data=policy,
                         observed_at=_ts("2026-01-01T00:00:00Z"), recorded_at=_ts("2026-01-01T00:00:00Z"), version_id="v1", synthetic=True, subject_ids=[]))
        for r in dossier.records:
            if r["object_type"] in drop_types or not known(r["object_type"]):
                continue
            store.put(Record(id=r["id"], tenant_id=r["tenant_id"], object_type=r["object_type"],
                             data={k: v for k, v in r["data"].items() if k != "extensions"}, subject_ids=r["subject_ids"],
                             observed_at=_ts(r["observed_at"]), recorded_at=_ts(r["recorded_at"]), version_id="v1", synthetic=True,
                             valid_from=_ts(r["valid_from"]) if r["valid_from"] else None))
        store.set_state("tenant-synthetic", "case", "case-eval", 0, {"state": "OPEN", "case_type": "KYB"})
        profile = fixtures.profile().model_copy(update={"max_objects": 10_000})
        principal = Principal(tenant_id="tenant-synthetic", actor_id="analyst",  # the fixture invocation's actor
                               permissions=set(policy.get("permissions", [])),
                              purposes=set(profile.purposes), subject_ids={r["id"] for r in dossier.records if r["object_type"] == "Entity"})
        executor = Executor(store, [profile], fixtures.router())
        customer = dossier.case["customer_entity_id"]
        name = next(r["data"]["name"] for r in dossier.records if r["id"] == customer)
        out: dict[str, Any] = {}
        for skill in skills:
            params = fixtures.parameters(skill)
            sanctions = out.get("screening.sanctions.execute")
            # The slice's bindings: target from the ownership acquisition, name from the case, and the
            # OFAC designated set from the sanctions skill's hits (payload.hits[*].entity_id).
            bound = {"target": customer, "name": name, "identifiers": [],
                     "blocked_ids": list(dict.fromkeys(h["entity_id"] for h in ((sanctions.payload or {}).get("hits", []) if sanctions else [])))}
            params.update({k: v for k, v in bound.items() if k in params})
            invocation = fixtures.invocation(skill, subject_ids=[s["entity_id"] for s in dossier.case["subjects"]], parameters=params,
                                             as_of_time=AT, knowledge_cutoff=AT, policy_snapshot_ref="slice-policy",
                                             idempotency_key=f"{skill}-{dossier.party_id}", purpose="onboarding")
            out[skill] = await executor.run(invocation, principal)
        store.close()
        return out
    return asyncio.run(go())


# ---------------------------------------------------------------------------------------------
# Reference implementations over the scenario facts


def _eid(spec: dict[str, Any], ref: str) -> str:
    return f"{spec['id'].lower()}.entity.{ref.replace('_', '-')}"


@dataclass
class Reference:
    interests: dict[str, Decimal]
    ubos: set[str]
    unresolved: set[str]
    ownership_applicable: bool
    sanctions_hits: set[str]
    pep_hits: set[str]
    provider_candidates: bool
    screened: bool
    disambiguation: dict[str, str]
    ofac_blocked: bool
    registry_verified: dict[str, bool]
    bo_verified: dict[str, bool]
    name: str
    normalized: str
    customer_id: str = ""
    hit_subjects: dict[str, str] | None = None  # ScreeningHit record id -> screened entity id


def reference(spec: dict[str, Any], policy: dict[str, Any]) -> Reference:
    entities = {e["ref"]: e for e in spec["entities"]}
    customer = spec["customer"]
    exact = [x for x in spec.get("ownership", []) if "interest" in x]
    ranged = [x for x in spec.get("ownership", []) if "range" in x]
    owners_of: dict[str, list[tuple[str, Decimal]]] = {}
    for x in exact:
        owners_of.setdefault(x["owned"], []).append((x["owner"], Decimal(str(x["interest"]))))

    interests: dict[str, Decimal] = {}
    unresolved: set[str] = set()
    reachable: set[str] = set()

    def walk(node: str, factor: Decimal, path: tuple[str, ...]) -> None:
        reachable.add(node)
        incoming = owners_of.get(node, [])
        if not incoming:
            interests[node] = interests.get(node, Decimal(0)) + factor
            return
        if sum(share for _, share in incoming) < 1:
            unresolved.add("UNACCOUNTED_INTEREST")
        for owner, share in incoming:
            if owner in path:
                unresolved.add("CYCLE")
                continue
            walk(owner, factor * share, (*path, owner))

    if owners_of.get(customer):
        walk(customer, Decimal(1), (customer,))
    if any(x["owned"] in reachable for x in ranged):
        unresolved.add("OWNERSHIP_RANGE_REQUIRES_RESOLUTION")
    threshold = Decimal(str(policy["ownership_threshold"]))
    ubos = {_eid(spec, r) for r, v in interests.items() if v >= threshold and entities[r]["kind"] == "individual"}
    for x in spec.get("control", []):
        if x["controlled"] == customer and x.get("verified", True) and x["basis"] in policy.get("control_bases", []) and entities[x["controller"]]["kind"] == "individual":
            ubos.add(_eid(spec, x["controller"]))

    lists = wl.load()
    scr = spec.get("screening") or {}
    in_scope = [k for k in scr.get("lists", [])]
    designated: dict[str, set[str]] = {"sanctions": set(), "pep": set()}
    for ref, e in entities.items():
        ids = [i["value"] for i in e.get("identifiers", [])]
        for key in in_scope:
            meta = lists[key]
            if meta["list_type"] not in designated:
                continue
            if any(wl.match({"name": e["name"], "identifiers": ids}, entry)["verified_match"] for entry in meta["entries"]):
                designated[meta["list_type"]].add(ref)
    disambiguation = {}
    for hit in scr.get("hits", []):
        list_key, entry = wl.entry(hit["entry"])
        if list_key not in in_scope:
            continue
        e = entities[hit["subject"]]
        m = wl.match({"name": e["name"], "identifiers": [i["value"] for i in e.get("identifiers", [])]}, entry)
        disambiguation[hit["subject"]] = "FALSE_MATCH_CANDIDATE" if m["identifier_conflict"] else "REVIEW"
    for ref in designated["sanctions"] | designated["pep"]:
        disambiguation.setdefault(ref, "REVIEW")

    # OFAC 50 percent rule: least fixed point over direct exact interests of blocked owners.
    blocked = set(designated["sanctions"])
    changed = True
    while changed:
        changed = False
        for owned, owners in owners_of.items():
            if owned not in blocked and sum(share for owner, share in owners if owner in blocked) >= Decimal(str(policy["sanctions_ownership"]["threshold"])):
                blocked.add(owned)
                changed = True

    statuses = {str(s).upper() for s in policy.get("active_registry_statuses", [])}
    registry = {e["registration"]["registration_id"]: str(e["registration"].get("status", "active")).upper() in statuses
                for e in entities.values() if e.get("registration")}
    methods = set(policy.get("verification_methods", []))
    bo_refs = {x["entity"] for x in spec["beneficial_owners"]} if "beneficial_owners" in spec else \
        {r for r, v in _all_effective(owners_of, customer).items() if entities[r]["kind"] == "individual" and v >= Decimal("0.25")}
    bo_verified = {_eid(spec, r): entities[r].get("verification", "document_check") in methods for r in bo_refs}

    name = entities[customer]["name"]
    return Reference(
        interests={_eid(spec, r): v for r, v in interests.items()}, ubos=ubos, unresolved=unresolved,
        ownership_applicable=bool(owners_of.get(customer)),
        sanctions_hits={_eid(spec, r) for r in designated["sanctions"]}, pep_hits={_eid(spec, r) for r in designated["pep"]},
        provider_candidates=bool(scr.get("hits")), screened=bool(scr),
        disambiguation={_eid(spec, r): v for r, v in disambiguation.items()},
        ofac_blocked=customer in blocked, registry_verified=registry, bo_verified=bo_verified,
        name=name, normalized=wl.normalize(name), customer_id=_eid(spec, customer),
    )


def _all_effective(owners_of: dict[str, list[tuple[str, Decimal]]], target: str) -> dict[str, Decimal]:
    """Effective interest of every entity above the target (the corpus's own BO rule, gen.effective_ownership)."""
    totals: dict[str, Decimal] = {}

    def walk(node: str, weight: Decimal, path: frozenset[str]) -> None:
        for owner, share in owners_of.get(node, []):
            if owner in path:
                continue
            totals[owner] = totals.get(owner, Decimal(0)) + weight * share
            walk(owner, weight * share, path | {owner})
    walk(target, Decimal(1), frozenset({target}))
    return totals


# ---------------------------------------------------------------------------------------------
# Checks: (skill, applicable(ref), check(result, ref) -> list of failure strings)


def _status(result) -> str:
    return str(result.status).split(".")[-1]


def _payload(result) -> dict[str, Any]:
    return result.payload or {}


def _decimal_map(values: dict[str, Any]) -> dict[str, Decimal]:
    return {k: Decimal(str(v)) for k, v in values.items()}


def _check_interests(r, ref: Reference) -> list[str]:
    got = _decimal_map(_payload(r).get("interests", {}))
    out = [] if got == ref.interests else [f"interests {sorted(got.items())} != {sorted(ref.interests.items())}"]
    reasons = {u["reason"] for u in _payload(r).get("unresolved", [])}
    if reasons != ref.unresolved:
        out.append(f"unresolved {sorted(reasons)} != {sorted(ref.unresolved)}")
    if (_status(r) == "PARTIAL") != bool(ref.unresolved):
        out.append(f"status {_status(r)} with unresolved {sorted(ref.unresolved)}")
    return out


def _check_ubo(r, ref: Reference) -> list[str]:
    got = {c["entity_id"] for c in _payload(r).get("candidates", [])}
    out = [] if got == ref.ubos else [f"ubos {sorted(got)} != {sorted(ref.ubos)}"]
    if any(c.get("verified") for c in _payload(r).get("candidates", [])):
        out.append("resolve marked a candidate verified")
    return out


def _check_screen(kind: str):
    def check(r, ref: Reference) -> list[str]:
        want = ref.sanctions_hits if kind == "sanctions" else ref.pep_hits
        got = {h["entity_id"] for h in _payload(r).get("hits", [])}
        out = []
        if want - got:
            out.append(f"missed designated {sorted(want - got)}")
        if got - want:
            out.append(f"false hits {sorted(got - want)}")
        # No search on record is missing evidence, never a clear result.
        expected = "NEEDS_REVIEW" if want or (kind == "sanctions" and ref.provider_candidates) else "COMPLETED" if ref.screened else "NEEDS_EVIDENCE"
        if _status(r) != expected:
            out.append(f"status {_status(r)} != {expected}")
        if _payload(r).get("universal_clearance") is not False:
            out.append("claimed universal clearance")
        return out
    return check


def _check_disambiguate(r, ref: Reference) -> list[str]:
    out = []
    got: dict[str, set[str]] = {}
    for d in _payload(r).get("dispositions", []):
        if d.get("final") is not False:
            out.append(f"{d['id']} marked final")
        got.setdefault((ref.hit_subjects or {}).get(d["id"], d["id"]), set()).add(d["recommendation"])
    for entity_id, want in ref.disambiguation.items():
        recs = got.get(entity_id, set())
        if want not in recs:
            out.append(f"{entity_id}: {sorted(recs) or 'no disposition'} lacks {want}")
        if want == "REVIEW" and "FALSE_MATCH_CANDIDATE" in recs:
            out.append(f"{entity_id}: a true designation proposed as a false match")
    return out


def _check_ofac(r, ref: Reference) -> list[str]:
    got = _payload(r).get("threshold_met")
    return [] if got is ref.ofac_blocked else [f"threshold_met {got} != {ref.ofac_blocked}"]


def _check_registry(r, ref: Reference) -> list[str]:
    got = {v["id"]: v["verified"] for v in _payload(r).get("verifications", [])}
    return [] if got == ref.registry_verified else [f"registry {got} != {ref.registry_verified}"]


def _check_bo_verify(r, ref: Reference) -> list[str]:
    got = {v["entity_id"]: v["verified"] for v in _payload(r).get("owners", [])}
    return [] if got == ref.bo_verified else [f"owners {got} != {ref.bo_verified}"]


def _check_entity_resolve(r, ref: Reference) -> list[str]:
    candidates = _payload(r).get("candidates", [])
    top = candidates[0]["entity_id"] if candidates else None
    out = [] if top == ref.customer_id else [f"top candidate {top} != {ref.customer_id}"]
    # A name alone must not resolve an entity: resolution needs a verified identifier match.
    if _payload(r).get("entity_id") is not None and not any(c.get("verified_match") for c in candidates):
        out.append("resolved an entity without a verified match")
    return out


def _check_normalize(r, ref: Reference) -> list[str]:
    return [] if _payload(r).get("normalized") == ref.normalized and _payload(r).get("original") == ref.name else [f"normalized {_payload(r).get('normalized')!r} != {ref.normalized!r}"]


def _check_graph(r, ref: Reference) -> list[str]:
    cyclic = bool(_payload(r).get("cycles"))
    return [] if cyclic == ("CYCLE" in ref.unresolved) else [f"cycles detected {cyclic} != {'CYCLE' in ref.unresolved}"]


def _check_policy_resolve(r, ref: Reference) -> list[str]:
    return [] if _status(r) == "COMPLETED" and _payload(r).get("policy_id") == "slice-policy" else [f"status {_status(r)}"]


CHECKS: dict[str, tuple[Callable[[Reference], bool], Callable[[Any, Reference], list[str]]]] = {
    "decision.policy.resolve": (lambda ref: True, _check_policy_resolve),
    "entity.resolve": (lambda ref: True, _check_entity_resolve),
    "registry.company.verify": (lambda ref: bool(ref.registry_verified), _check_registry),
    "ownership.graph.build": (lambda ref: ref.ownership_applicable, _check_graph),
    "ownership.interest.calculate": (lambda ref: ref.ownership_applicable, _check_interests),
    "ownership.ubo.resolve": (lambda ref: ref.ownership_applicable, _check_ubo),
    "ownership.ubo.verify": (lambda ref: bool(ref.bo_verified), _check_bo_verify),
    "screening.name.normalize": (lambda ref: True, _check_normalize),
    "screening.sanctions.execute": (lambda ref: True, _check_screen("sanctions")),
    "screening.pep.execute": (lambda ref: True, _check_screen("pep")),
    "screening.match.disambiguate": (lambda ref: bool(ref.disambiguation), _check_disambiguate),
    "screening.sanctions.ownership.evaluate": (lambda ref: ref.ownership_applicable, _check_ofac),
}

# A favorable result is one that would let a case proceed as clear.
FAVORABLE: dict[str, Callable[[Any], bool]] = {
    "registry.company.verify": lambda r: any(v.get("verified") for v in _payload(r).get("verifications", [])),
    "ownership.ubo.resolve": lambda r: _status(r) == "COMPLETED",
    "ownership.ubo.verify": lambda r: any(v.get("verified") for v in _payload(r).get("owners", [])),
    "screening.sanctions.execute": lambda r: _status(r) == "COMPLETED" and not _payload(r).get("hits"),
    "screening.pep.execute": lambda r: _status(r) == "COMPLETED" and not _payload(r).get("hits"),
    "screening.sanctions.ownership.evaluate": lambda r: _status(r) == "COMPLETED" and _payload(r).get("threshold_met") is False,
}
# Records whose absence must never read as clear, per skill.
MISSING_CONTEXT = {
    "screening.sanctions.execute": frozenset({"ScreeningExecution", "WatchlistEntry"}),
    "screening.pep.execute": frozenset({"ScreeningExecution", "WatchlistEntry"}),
    "registry.company.verify": frozenset({"RegistryRecord"}),
    "ownership.ubo.resolve": frozenset({"OwnershipInterest"}),
    "ownership.ubo.verify": frozenset({"VerificationRecord"}),
    "screening.sanctions.ownership.evaluate": frozenset({"OwnershipInterest"}),
}


# ---------------------------------------------------------------------------------------------
# The evaluation


def evaluate(specs: list[dict[str, Any]], dossiers: list[Any], split: str, *, controls: bool = True) -> dict[str, Any]:
    policy, policy_digest = slice_policy()
    per_skill: dict[str, dict[str, Any]] = {s: {"applicable": 0, "passed": 0, "failures": [], "controls": {"run": 0, "passed": 0, "failures": []}} for s in SKILLS}
    mix = {"ofac_blocked": 0, "ofac_clear": 0, "cycle": 0, "range": 0, "unaccounted": 0, "designated_owner": 0,
           "near_miss": 0, "pep": 0, "no_ownership": 0, "incomplete_coverage": 0}
    extra = {"designated_expected": 0, "designated_found": 0, "false_hits": 0, "ofac_cases": 0, "ofac_correct": 0,
             "ubo_cases": 0, "ubo_exact": 0, "interest_cases": 0, "interest_exact": 0, "disambiguation_cases": 0, "disambiguation_correct": 0}
    cases = []
    for spec, dossier in zip(specs, dossiers):
        ref = reference(spec, policy)
        ref.hit_subjects = {x["id"]: x["data"]["entity_id"] for x in dossier.records if x["object_type"] == "ScreeningHit"}
        # Coverage: a clean screen is complete only when every entity the case can see was searched.
        case_subjects = {s["entity_id"] for s in dossier.case["subjects"]}
        searched = {x["data"]["subject"] for x in dossier.records if x["object_type"] == "ScreeningExecution" and x["data"]["status"] == "COMPLETED"}
        visible = {x["id"] for x in dossier.records if x["object_type"] == "Entity" and set(x["subject_ids"]) & case_subjects}
        ref.screened = ref.screened and visible <= searched
        results = run_party(dossier, policy)
        if ref.ownership_applicable:
            mix["ofac_blocked" if ref.ofac_blocked else "ofac_clear"] += 1
        else:
            mix["no_ownership"] += 1
        mix["cycle"] += "CYCLE" in ref.unresolved
        mix["range"] += "OWNERSHIP_RANGE_REQUIRES_RESOLUTION" in ref.unresolved
        mix["unaccounted"] += "UNACCOUNTED_INTEREST" in ref.unresolved
        mix["designated_owner"] += bool(ref.sanctions_hits)
        mix["near_miss"] += "FALSE_MATCH_CANDIDATE" in ref.disambiguation.values()
        mix["pep"] += bool(ref.pep_hits)
        mix["incomplete_coverage"] += not ref.screened
        case = {"party": dossier.party_id, "skills": {}}
        for skill in SKILLS:
            applicable, check = CHECKS[skill]
            if not applicable(ref):
                case["skills"][skill] = "not_applicable"
                continue
            failures = check(results[skill], ref)
            per_skill[skill]["applicable"] += 1
            per_skill[skill]["passed"] += not failures
            per_skill[skill]["failures"] += [f"{dossier.party_id}: {f}" for f in failures]
            case["skills"][skill] = {"status": _status(results[skill]), "passed": not failures, **({"failures": failures} if failures else {})}
        # Family metrics.
        for kind, want in (("sanctions", ref.sanctions_hits), ("pep", ref.pep_hits)):
            got = {h["entity_id"] for h in _payload(results[f"screening.{kind}.execute"]).get("hits", [])}
            extra["designated_expected"] += len(want)
            extra["designated_found"] += len(want & got)
            extra["false_hits"] += len(got - want)
        if ref.ownership_applicable:
            extra["ofac_cases"] += 1
            extra["ofac_correct"] += not _check_ofac(results["screening.sanctions.ownership.evaluate"], ref)
            extra["ubo_cases"] += 1
            extra["ubo_exact"] += not _check_ubo(results["ownership.ubo.resolve"], ref)
            extra["interest_cases"] += 1
            extra["interest_exact"] += _decimal_map(_payload(results["ownership.interest.calculate"]).get("interests", {})) == ref.interests
        if ref.disambiguation:
            extra["disambiguation_cases"] += 1
            extra["disambiguation_correct"] += not _check_disambiguate(results["screening.match.disambiguate"], ref)
        if controls:
            for skill, field in CONTROL_FIELDS.items():
                for label, run in (
                    (f"policy field {field} absent", lambda: run_party(dossier, {k: v for k, v in policy.items() if k != field}, skills=_upto(skill))[skill]),
                    (f"records {sorted(MISSING_CONTEXT[skill])} absent", lambda: run_party(dossier, policy, skills=_upto(skill), drop_types=MISSING_CONTEXT[skill])[skill]),
                ):
                    result = run()
                    favorable = FAVORABLE[skill](result)
                    per_skill[skill]["controls"]["run"] += 1
                    per_skill[skill]["controls"]["passed"] += not favorable
                    if favorable:
                        per_skill[skill]["controls"]["failures"].append(f"{dossier.party_id}: {label} gave a favorable {_status(result)} result")
        cases.append(case)

    dataset = {"split": split, "parties": [{"id": s["id"], "spec": hashlib.sha256(canonical_json(s).encode()).hexdigest(),
                                             "records": hashlib.sha256(canonical_json(d.records).encode()).hexdigest()} for s, d in zip(specs, dossiers)]}
    dataset_digest = hashlib.sha256(canonical_json(dataset).encode()).hexdigest()
    rate = lambda a, b: round(a / b, 6) if b else None  # noqa: E731
    family = {
        "screening.designated_recall": rate(extra["designated_found"], extra["designated_expected"]),
        "screening.false_hits": extra["false_hits"],
        "ownership.interest_exact_rate": rate(extra["interest_exact"], extra["interest_cases"]),
        "ownership.ubo_exact_rate": rate(extra["ubo_exact"], extra["ubo_cases"]),
        "ofac.blocked_accuracy": rate(extra["ofac_correct"], extra["ofac_cases"]),
        "screening.disambiguation_accuracy": rate(extra["disambiguation_correct"], extra["disambiguation_cases"]),
    }
    skills_out = {}
    for skill, s in per_skill.items():
        controls_ok = s["controls"]["passed"] == s["controls"]["run"]
        metrics = [{"name": "case_pass_rate", "value": rate(s["passed"], s["applicable"]) or 0.0, "comparison": "at_least",
                    "threshold": PLACEHOLDER_THRESHOLD, "thresholdSource": "placeholder"}]
        skills_out[skill] = {
            "applicableCases": s["applicable"], "passedCases": s["passed"], "failures": s["failures"],
            "controls": s["controls"], "metrics": metrics,
            "meetsPlaceholderThresholds": s["applicable"] > 0 and all(m["value"] >= m["threshold"] for m in metrics) and controls_ok,
            "evidence": {"datasetDigest": dataset_digest, "sampleCount": s["applicable"], "controlsPassed": controls_ok,
                         "scopeDescription": f"{SLICE} skill {skill}, {split} split, {s['applicable']} applicable corpus parties, slice policy {policy_digest[:12]}; synthetic data, not representative of production traffic.",
                         "metrics": [{k: m[k] for k in ("name", "value", "comparison", "threshold")} for m in metrics]},
        }
    report = {
        "schemaVersion": "corpus.slice-evaluation.v1", "slice": SLICE, "split": split, "asOf": AT.isoformat(),
        "policy": {"path": str(POLICY_PATH.relative_to(REPO)), "sha256": policy_digest},
        "libraryBundle": _bundle_hash(), "dataset": {"digest": dataset_digest, "parties": len(specs)},
        "familyMetrics": family, "caseMix": mix, "skills": skills_out, "cases": cases,
        "notes": ["Thresholds are placeholders (every check on every applicable case) until the policy owner sets them.",
                  "Expectations come from evaluate.py's reference implementations over the scenario facts, not from the library."],
    }
    report["reportDigest"] = hashlib.sha256(canonical_json(report).encode()).hexdigest()
    return report


def _upto(skill: str) -> tuple[str, ...]:
    """The slice skills up to and including `skill` (later skills cannot affect it)."""
    return SKILLS[: SKILLS.index(skill) + 1]


def _bundle_hash() -> str | None:
    try:
        return json.loads((REPO / "config/skill-library/catalog.json").read_text())["bundle_code_hash"]
    except (OSError, KeyError, ValueError):
        return None
