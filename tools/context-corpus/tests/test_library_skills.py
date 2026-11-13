"""Run the skill library's own transaction skills on the corpus (library-native path, plan §8.3).

Skipped when `financial_crime` (apps/fincrime-host) or its dependencies are not importable.
"""
import asyncio
import sys
from decimal import Decimal
from datetime import datetime, timezone
from pathlib import Path

import pytest

from context_corpus import detectors as det
from context_corpus.cli import build

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps/fincrime-host/src"))
pytest.importorskip("networkx")
pytest.importorskip("pydantic")
f = pytest.importorskip("financial_crime.synthetic")
from financial_crime.contracts import Principal, Record  # noqa: E402
from financial_crime.execution import Executor  # noqa: E402
from financial_crime.store import Store  # noqa: E402

TX_SKILLS = [
    "transaction.ingest", "transaction.enrich", "transaction.classify", "transaction.counterparty.resolve",
    "transaction.behavior.profile", "transaction.baseline.compare", "transaction.velocity.analyze",
    "transaction.flow.trace", "transaction.cashflow.analyze", "transaction.geography.analyze",
    "transaction.anomaly.detect", "transaction.exposure.aggregate", "aml.structuring.detect", "aml.layering.detect",
    "aml.roundtrip.detect", "aml.funnel.detect", "aml.smurfing.detect", "aml.pass_through.detect", "aml.mule.detect",
    "aml.velocity.detect", "aml.typology.match", "investigation.fundflow.reconstruct", "monitor.transaction.deviation",
    "regulatory.ctr.evaluate", "regulatory.ctr.prepare",
]
pytestmark = pytest.mark.slow  # ~3 minutes: 100 real skill executions over multi-thousand-record contexts

CONTEXT_TYPES = {"Transaction", "DatasetScope", "Account", "TradeRecord", "Invoice", "Shipment"}
AT = datetime(2026, 9, 30, tzinfo=timezone.utc)
SCEN = Path(__file__).resolve().parents[1] / "scenarios"


def ts(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


@pytest.fixture(scope="module")
def dossiers():
    specs, ds = build(SCEN)
    return {d.party_id: d for d in ds}


MAX_OBJECTS = 10_000  # the AgentProfile contract maximum


def run_skills(d, skills, max_objects=MAX_OBJECTS):
    async def go():
        store = Store()
        policy = {**f.policy(), **det.CORPUS_POLICY, "transaction_types": {"payroll": "salary", "rent": "housing"}}
        store.put(Record(id="corpus-policy", tenant_id="tenant-synthetic", object_type="Policy", data=policy,
                         observed_at=ts("2026-01-01T00:00:00Z"), recorded_at=ts("2026-01-01T00:00:00Z"), version_id="v1",
                         synthetic=True, subject_ids=[]))
        for r in d.records:
            if r["object_type"] in CONTEXT_TYPES:
                data = {k: v for k, v in r["data"].items() if k != "extensions"}
                store.put(Record(id=r["id"], tenant_id=r["tenant_id"], object_type=r["object_type"], data=data,
                                 subject_ids=r["subject_ids"], observed_at=ts(r["observed_at"]),
                                 recorded_at=ts(r["recorded_at"]), version_id="v1", synthetic=True))
        store.set_state("tenant-synthetic", "case", "case-demo", 0, {"state": "OPEN", "case_type": "KYB"})
        profile = f.profile().model_copy(update={"max_objects": max_objects})
        customer = d.case["customer_entity_id"]
        # The principal must be authorised for every entity a record names, counterparties included.
        principal = Principal(tenant_id="tenant-synthetic", actor_id="analyst", permissions=set(policy["permissions"]),
                              purposes=set(profile.purposes),
                              subject_ids={r["id"] for r in d.records if r["object_type"] == "Entity"})
        executor = Executor(store, [profile], f.router())
        txs = [r["data"] for r in d.records if r["object_type"] == "Transaction"]
        currency = txs[0]["currency"]
        overrides = dict(account=d.expectations["ledger"]["hero_accounts"][0], currency=currency,
                         expected_totals={currency: "1"}, mean="1000", standard_deviation="500", z_threshold="3",
                         window_seconds=86400, source=txs[0]["source"], target=txs[0]["target"], max_hops=3, dimension="source")
        out = {}
        for skill in skills:
            params = f.parameters(skill)
            params.update({k: v for k, v in overrides.items() if k in params})
            inv = f.invocation(skill, subject_ids=[customer], parameters=params, as_of_time=AT, knowledge_cutoff=AT,
                               policy_snapshot_ref="corpus-policy", idempotency_key=f"{skill}-{d.party_id}", purpose="monitoring")
            out[skill] = await executor.run(inv, principal)
        store.close()
        return out
    return asyncio.run(go())


@pytest.fixture(scope="module")
def results(dossiers):
    return {pid: run_skills(dossiers[pid], TX_SKILLS) for pid in ("H01", "H04", "H05", "H07", "H10")}


# Every skill runs; these leave a gap this run does not close, so they say so (payload kept) instead of
# COMPLETED:
# - enrich / counterparty.resolve: counterparty accounts belong to other subjects and are not admitted
#   for the customer's case, so they stay unresolved (NEEDS_EVIDENCE per account);
# - ctr.evaluate / ctr.prepare on H07: its cash comes in from a counterparty cash account whose holder,
#   for the same reason, is unknown, so that side is not aggregated for anyone (NEEDS_EVIDENCE); the
#   customer's own per-day cash totals are still evaluated and match the reference CTR days;
# - classify: the run's policy maps only payroll and rent (NEEDS_REVIEW, POLICY_UNRESOLVED per code);
# - velocity.analyze: the one-day windows of the first day's transactions begin before the dataset (PARTIAL);
# - cashflow.analyze: the hero account of H01, H05 and H10 appears in no transaction (NEEDS_EVIDENCE);
# - H04 holds EUR and USD but the run states a baseline for its first transaction's currency only:
#   USD has no expected total (baseline.compare, monitor.transaction.deviation) and is not scored
#   against the EUR amount baseline (anomaly.detect, PARTIAL).
# - the AML detectors: a detection window anchored near the dataset's start or end runs past the
#   scope, so finding nothing there is PARTIAL, not clear (H05's planted layering and round trip are
#   found, so those two complete on H05).
EVERY_HERO = {"transaction.enrich": "NEEDS_EVIDENCE", "transaction.counterparty.resolve": "NEEDS_EVIDENCE",
              "transaction.classify": "NEEDS_REVIEW", "transaction.velocity.analyze": "PARTIAL",
              **{f"aml.{name}": "PARTIAL" for name in ("funnel.detect", "smurfing.detect", "structuring.detect", "typology.match", "velocity.detect")}}
AML_EDGE_TRAVERSALS = {"aml.layering.detect": "PARTIAL", "aml.roundtrip.detect": "PARTIAL"}
NO_HERO_ACTIVITY = {"transaction.cashflow.analyze": "NEEDS_EVIDENCE"}
OPEN = {"H01": {**EVERY_HERO, **AML_EDGE_TRAVERSALS, **NO_HERO_ACTIVITY}, "H05": {**EVERY_HERO, **NO_HERO_ACTIVITY},
        "H07": {**EVERY_HERO, **AML_EDGE_TRAVERSALS, "regulatory.ctr.evaluate": "NEEDS_EVIDENCE", "regulatory.ctr.prepare": "NEEDS_EVIDENCE"}, "H10": {**EVERY_HERO, **AML_EDGE_TRAVERSALS, **NO_HERO_ACTIVITY},
        "H04": {**EVERY_HERO, **AML_EDGE_TRAVERSALS, "transaction.baseline.compare": "NEEDS_EVIDENCE", "monitor.transaction.deviation": "NEEDS_EVIDENCE",
                "transaction.anomaly.detect": "PARTIAL"}}


@pytest.mark.parametrize("pid", ["H01", "H04", "H05", "H07", "H10"])
def test_all_25_transaction_skills_run_and_name_their_gaps(results, pid):
    statuses = {s: str(r.status) for s, r in results[pid].items()}
    assert len(statuses) == 25
    assert {s: v for s, v in statuses.items() if v != "COMPLETED"} == OPEN[pid], (pid, statuses)
    for skill in OPEN[pid]:
        r = results[pid][skill]
        assert r.error is None and r.payload and r.unresolved_items, (pid, skill)


@pytest.mark.parametrize("pid", ["H01", "H04", "H10"])
def test_hard_negatives_raise_nothing_in_the_library(results, pid):
    for skill, r in results[pid].items():
        if skill.startswith("aml.") and skill.endswith(".detect"):
            assert r.payload["indicators"] == [], (pid, skill)
    assert all(t["indicators"] == [] for t in results[pid]["aml.typology.match"].payload["typologies"])


@pytest.mark.parametrize("pid", ["H05", "H07"])
def test_planted_signals_are_found_by_the_library_skills(results, dossiers, pid):
    d = dossiers[pid]
    for sig in d.expectations["signals"]:
        ids = set(sig.get("transaction_ids", []))
        for skill in sig["expect"]["detected_by"]:
            if skill.startswith("aml.") and skill.endswith(".detect") and skill != "aml.trade_based.detect":
                assert any(set(i["transaction_ids"]) & ids for i in results[pid][skill].payload["indicators"]), (sig["id"], skill)


@pytest.mark.parametrize("pid", ["H01", "H04", "H05", "H07", "H10"])
def test_library_ctr_days_match_the_reference(results, dossiers, pid):
    """The library's reportable customer-day cash totals cover exactly the corpus's reference CTR days."""
    d = dossiers[pid]
    reference = det.ctr_days(det.rows_from_records(d.records), set(d.expectations["ledger"]["hero_accounts"]))
    customer = d.case["customer_entity_id"]
    met = [x for x in results[pid]["regulatory.ctr.evaluate"].payload["evaluations"] if x["entity_id"] == customer and x["threshold_met"]]
    assert {i for x in met for i in x["transaction_ids"]} == {i for day in reference for i in day["transaction_ids"]}, pid


def test_library_finds_nothing_unplanted_on_h07_and_h05(results, dossiers):
    for pid, silent in (("H07", ("aml.layering.detect", "aml.roundtrip.detect")), ("H05", ("aml.structuring.detect", "aml.funnel.detect"))):
        for skill in silent:
            assert results[pid][skill].payload["indicators"] == [], (pid, skill)


def test_trade_based_skill_finds_exactly_the_planted_mismatches(dossiers):
    d = dossiers["H05"]
    out = run_skills(d, ["aml.trade_based.detect"])["aml.trade_based.detect"]
    trades = d.expectations["ledger"]["trades"].values()
    assert str(out.status) == "COMPLETED"
    assert {i["trade_id"] for i in out.payload["indicators"]} == {t["trade"] for t in trades if t["mismatch"]}


def test_default_profile_budget_refuses_a_ledger_that_is_too_large(dossiers):
    """Context budget is a property of the agent profile: the default 1,000-object profile cannot read H07."""
    n = sum(1 for r in dossiers["H07"].records if r["object_type"] == "Transaction")
    default = f.profile().max_objects
    assert n > default
    out = run_skills(dossiers["H07"], ["transaction.ingest"], max_objects=default)["transaction.ingest"]
    assert out.error["code"] == "CONTEXT_BUDGET_EXCEEDED"


# ---- fraud skills (H10 positive, H01 negative) ----
FRAUD_TYPES = CONTEXT_TYPES | {"Device", "Session", "AuthenticationEvent", "Payment", "FraudSignal", "Counterparty", "Entity", "Evidence"}
FRAUD_SKILLS = ["fraud.device.fingerprint", "fraud.behavior.anomaly", "fraud.payment.anomaly", "fraud.beneficiary.risk",
                "fraud.network.detect", "fraud.case.assess", "fraud.account_takeover.detect"]


def run_fraud(d):
    from financial_crime.contracts import digest
    from financial_crime.providers import ProviderResponse, RecordedProvider, Router

    async def go():
        store = Store()
        policy = {**f.policy(), **det.CORPUS_POLICY}
        store.put(Record(id="corpus-policy", tenant_id="tenant-synthetic", object_type="Policy", data=policy,
                         observed_at=ts("2026-01-01T00:00:00Z"), recorded_at=ts("2026-01-01T00:00:00Z"), version_id="v1",
                         synthetic=True, subject_ids=[]))
        events = []
        for r in d.records:
            if r["object_type"] in FRAUD_TYPES:
                rec = Record(id=r["id"], tenant_id=r["tenant_id"], object_type=r["object_type"], data={k: v for k, v in r["data"].items() if k != "extensions"},
                             subject_ids=r["subject_ids"], observed_at=ts(r["observed_at"]), recorded_at=ts(r["recorded_at"]), version_id="v1", synthetic=True)
                store.put(rec)
                if r["object_type"] == "AuthenticationEvent":
                    events.append((rec, r))
        store.set_state("tenant-synthetic", "case", "case-demo", 0, {"state": "OPEN", "case_type": "KYB"})
        # Recorded specialist: the provider's answer is the reference rule model's top score; no detector runs.
        from context_corpus.digital import ato_score
        request = {"records": [{"id": rec.id, "signals": raw["data"]["signals"], "session_id": raw["data"]["session_id"]} for rec, raw in events]}
        top = max((ato_score(raw["data"]["signals"]) for _, raw in events), key=float)
        recording = ProviderResponse(provider_id="synthetic-recording", capability="fraud.account_takeover", request_hash=digest(request),
                                     payload={"score": top, "assessment": "ELEVATED" if float(top) >= 0.6 else "LOW", "model_version": "corpus-fraud-rules-v1",
                                              "limitations": ["Recorded from the corpus reference rules; no real detector executed."]},
                                     evidence_refs=[rec.ref() for rec, _ in events], source_version="recording-v1", coverage={"complete": True})
        router = Router({"fraud.account_takeover": RecordedProvider([recording])})
        profile = f.profile().model_copy(update={"max_objects": MAX_OBJECTS})
        principal = Principal(tenant_id="tenant-synthetic", actor_id="analyst", permissions=set(policy["permissions"]), purposes=set(profile.purposes),
                              subject_ids={r["id"] for r in d.records if r["object_type"] == "Entity"})
        executor = Executor(store, [profile], router)
        out = {}
        for skill in FRAUD_SKILLS:
            inv = f.invocation(skill, subject_ids=[d.case["customer_entity_id"]], parameters=f.parameters(skill), as_of_time=AT, knowledge_cutoff=AT,
                               policy_snapshot_ref="corpus-policy", idempotency_key=f"{skill}-{d.party_id}", purpose="monitoring")
            out[skill] = await executor.run(inv, principal)
        store.close()
        return out
    return asyncio.run(go())


@pytest.fixture(scope="module")
def fraud_results(dossiers):
    return {pid: run_fraud(dossiers[pid]) for pid in ("H10", "H01")}


# The gaps each hero's data honestly leaves (the skills report them instead of a clean result):
# - fraud.beneficiary.risk: the corpus's Counterparty records cite no evidence admitted for the case,
#   so no beneficiary's indicators count as evidenced (the assessments are still returned);
# - fraud.network.detect on H01: only the customer carries a phone or email, so nothing is compared.
FRAUD_GAPS = {
    "H10": {"fraud.beneficiary.risk": "NEEDS_EVIDENCE"},
    "H01": {"fraud.beneficiary.risk": "NEEDS_EVIDENCE", "fraud.network.detect": "NEEDS_EVIDENCE"},
}


@pytest.mark.parametrize("pid", ["H10", "H01"])
def test_fraud_skills_run_and_name_their_gaps(fraud_results, pid):
    assert {s: str(r.status) for s, r in fraud_results[pid].items() if str(r.status) != "COMPLETED"} == FRAUD_GAPS[pid], pid
    for skill in FRAUD_GAPS[pid]:
        assert fraud_results[pid][skill].unresolved_items, (pid, skill)


def test_h10_fraud_findings_match_the_planted_episode(fraud_results, dossiers):
    d, r = dossiers["H10"], fraud_results["H10"]
    planted = d.expectations["signals"][0]["records"]
    assert {a["session_id"] for a in r["fraud.behavior.anomaly"].payload["anomalies"]} == set(planted["Session"])
    assert {a["payment_id"] for a in r["fraud.payment.anomaly"].payload["anomalies"]} == set(planted["Payment"])
    review = [a for a in r["fraud.beneficiary.risk"].payload["assessments"] if a["indicators"]]
    assert len(review) == 1 and "mule_account" in review[0]["indicators"] and review[0]["review_required"]
    groups = r["fraud.network.detect"].payload["candidate_groups"]
    assert len(groups) == 1 and groups[0]["attribute"] == "phone" and len(groups[0]["entities"]) == 3
    assert r["fraud.network.detect"].payload["collusion_proven"] is False
    assert r["fraud.case.assess"].payload["recommendation"] == "STEP_UP_OR_ESCALATE" and r["fraud.case.assess"].payload["final"] is False
    assert {x["device_id"] for x in r["fraud.device.fingerprint"].payload["fingerprints"]} == set(planted["Device"]) | {
        x["id"] for x in d.records if x["object_type"] == "Device"}
    assert r["fraud.account_takeover.detect"].payload["assessment"]["assessment"] == "ELEVATED"
    assert r["fraud.account_takeover.detect"].payload["final_decision"] is False


def test_h01_is_a_fraud_negative(fraud_results):
    r = fraud_results["H01"]
    assert r["fraud.behavior.anomaly"].payload["anomalies"] == [] and r["fraud.payment.anomaly"].payload["anomalies"] == []
    assert all(a["indicators"] == [] for a in r["fraud.beneficiary.risk"].payload["assessments"])
    assert r["fraud.network.detect"].payload["candidate_groups"] == []
    assert r["fraud.case.assess"].payload["recommendation"] == "REVIEW_FOR_CLEARANCE"
    assert r["fraud.account_takeover.detect"].payload["assessment"]["assessment"] == "LOW"


# ---- ownership, screening, party roles (Phase 3) ----
OWN_TYPES = {"Entity", "OwnershipInterest", "OwnershipRange", "ControlRight", "BeneficialOwner", "VerificationRecord", "Relationship",
             "WatchlistEntry", "ScreeningExecution", "ScreeningHit", "PEPRelationship", "OfficerRole", "Party"}


def run_with(d, jobs, *, policy_update=None, as_of=AT):
    """jobs: skill id -> parameter overrides. Returns skill id -> SkillResult."""
    async def go():
        store = Store()
        policy = {**f.policy(), **det.CORPUS_POLICY, **(policy_update or {})}
        store.put(Record(id="corpus-policy", tenant_id="tenant-synthetic", object_type="Policy", data=policy,
                         observed_at=ts("2026-01-01T00:00:00Z"), recorded_at=ts("2026-01-01T00:00:00Z"), version_id="v1",
                         synthetic=True, subject_ids=[]))
        for r in d.records:
            if r["object_type"] in OWN_TYPES:
                store.put(Record(id=r["id"], tenant_id=r["tenant_id"], object_type=r["object_type"], data={k: v for k, v in r["data"].items() if k != "extensions"},
                                 subject_ids=r["subject_ids"], observed_at=ts(r["observed_at"]), recorded_at=ts(r["recorded_at"]), version_id="v1",
                                 synthetic=True, valid_from=ts(r["valid_from"]) if r["valid_from"] else None))
        store.set_state("tenant-synthetic", "case", "case-demo", 0, {"state": "OPEN", "case_type": "KYB"})
        profile = f.profile().model_copy(update={"max_objects": MAX_OBJECTS})
        principal = Principal(tenant_id="tenant-synthetic", actor_id="analyst", permissions=set(policy["permissions"]), purposes=set(profile.purposes),
                              subject_ids={r["id"] for r in d.records if r["object_type"] == "Entity"})
        executor = Executor(store, [profile], f.router())
        out = {}
        for skill, over in jobs.items():
            params = f.parameters(skill)
            params.update({k: v for k, v in over.items() if k in params})
            # A KYB/KYC invocation names the case's subjects (customer, owners, directors), not only the customer.
            inv = f.invocation(skill, subject_ids=[x["entity_id"] for x in d.case["subjects"]], parameters=params, as_of_time=as_of, knowledge_cutoff=AT,
                               policy_snapshot_ref="corpus-policy", idempotency_key=f"{skill}-{d.party_id}-{as_of.isoformat()}", purpose="onboarding")
            out[skill] = await executor.run(inv, principal)
        store.close()
        return out
    return asyncio.run(go())


def ent(party, ref):
    return f"{party.lower()}.entity.{ref.replace('_', '-')}"


def test_h06_ownership_skills_match_the_answer_key(dossiers):
    d = dossiers["H06"]
    target = ent("H06", "bellmont_us")
    blocked = [ent("H06", "b1"), ent("H06", "b2")]
    jobs = {s: {"target": target, "blocked_ids": blocked} for s in (
        "ownership.graph.build", "ownership.interest.calculate", "ownership.ubo.resolve", "ownership.control.resolve", "ownership.circular.detect",
        "ownership.structure.complexity", "ownership.nominee.detect", "screening.sanctions.ownership.evaluate")}
    jobs["screening.sanctions.control.evaluate"] = {"blocked_ids": [ent("H06", "seabright")]}
    r = run_with(d, jobs)
    calc = r["ownership.interest.calculate"]
    assert str(calc.status) == "PARTIAL"
    assert {k: Decimal(v) for k, v in calc.payload["interests"].items()} == {ent("H06", "b1"): Decimal("0.18"), ent("H06", "b2"): Decimal("0.12"), ent("H06", "c"): Decimal("0.27")}
    assert {u["reason"] for u in calc.payload["unresolved"]} == {"CYCLE", "UNACCOUNTED_INTEREST", "OWNERSHIP_RANGE_REQUIRES_RESOLUTION"}
    ubo = r["ownership.ubo.resolve"]
    assert [c["entity_id"] for c in ubo.payload["candidates"]] == [ent("H06", "c")] and str(ubo.status) == "PARTIAL"
    assert r["ownership.circular.detect"].payload["cycles"]
    assert len(r["ownership.nominee.detect"].payload["indicators"]) == 3
    assert len(r["ownership.control.resolve"].payload["controls"]) == 1
    assert len(r["screening.sanctions.control.evaluate"].payload["restrictions"]) == 1
    # OFAC's 50% rule blocks the customer through the cascade even though path-product ownership is only 30%.
    ofac = r["screening.sanctions.ownership.evaluate"].payload
    assert ofac["threshold_met"] is True
    synthetic = run_with(d, {"screening.sanctions.ownership.evaluate": {"target": target, "blocked_ids": blocked}},
                         policy_update={"sanctions_ownership": {"rule": "synthetic_aggregate", "threshold": "0.5"}})
    assert synthetic["screening.sanctions.ownership.evaluate"].payload["threshold_met"] is False
    assert Decimal(synthetic["screening.sanctions.ownership.evaluate"].payload["aggregate_interest"]) == Decimal("0.30")


def test_h04_ubo_resolves_cleanly_and_verifies(dossiers):
    d = dossiers["H04"]
    r = run_with(d, {"ownership.ubo.resolve": {"target": ent("H04", "thistlewood_fab")}, "ownership.ubo.verify": {}})
    assert str(r["ownership.ubo.resolve"].status) == "COMPLETED"
    assert {c["entity_id"] for c in r["ownership.ubo.resolve"].payload["candidates"]} == {ent("H04", "gareth"), ent("H04", "priya")}
    assert all(o["verified"] for o in r["ownership.ubo.verify"].payload["owners"])


def test_screening_skills_on_h06_h02_h03(dossiers):
    for pid, want_status, want_hits in (("H06", "NEEDS_REVIEW", {"h06.entity.b1", "h06.entity.b2"}), ("H02", "NEEDS_REVIEW", set()), ("H03", "NEEDS_REVIEW", set())):
        r = run_with(dossiers[pid], {"screening.sanctions.execute": {}, "screening.pep.execute": {}, "screening.match.disambiguate": {},
                                     "screening.pep.relationship.resolve": {}})
        sanctions = r["screening.sanctions.execute"]
        local = {h["entity_id"] for h in sanctions.payload["hits"]}
        if pid == "H06":
            assert local == want_hits and str(sanctions.status) == want_status
        elif pid == "H02":
            # Local scorer sees conflicting identifiers (no local hit); the provider's candidate keeps it in review.
            assert local == set() and str(sanctions.status) == "NEEDS_REVIEW"
            assert [x["recommendation"] for x in r["screening.match.disambiguate"].payload["dispositions"]] == ["FALSE_MATCH_CANDIDATE"]
        else:
            assert str(sanctions.status) == "COMPLETED"   # nothing listed for the customer or her relative on a sanctions list
            assert {h["entity_id"] for h in r["screening.pep.execute"].payload["hits"]} == {"h03.entity.chidi"}
            assert [x["relation"] for x in r["screening.pep.relationship.resolve"].payload["relationships"]] == ["sibling"]


def test_h12_beneficiary_added_in_2025_is_not_visible_before_then(dossiers):
    d = dossiers["H12"]
    before = run_with(d, {"party.role.resolve": {}}, as_of=ts("2025-01-01T00:00:00Z"))["party.role.resolve"].payload["roles"]
    after = run_with(d, {"party.role.resolve": {}})["party.role.resolve"].payload["roles"]
    count = lambda roles: sum(1 for x in roles if x["role"] == "beneficiary")  # noqa: E731
    assert (count(before), count(after)) == (2, 3)
