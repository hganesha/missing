from copy import deepcopy
from pathlib import Path

import pytest

from context_corpus.cli import build
from context_corpus.gen import effective_ownership, generate
from context_corpus.manifest import drift, render, write
from context_corpus.spec import SpecError, validate_spec
from context_corpus.validate import validate_consistency, validate_schema

SCEN = Path(__file__).resolve().parents[1] / "scenarios"


@pytest.fixture(scope="module")
def built():
    return build(SCEN)


def test_all_records_pass_contract_schema(built):
    _, dossiers = built
    for d in dossiers:
        assert validate_schema(d.records) == []


def test_validator_rejects_bad_record(built):
    _, dossiers = built
    bad = deepcopy(dossiers[0].records)
    next(r for r in bad if r["object_type"] == "Entity")["data"]["entity_type"] = "nonsense"
    next(r for r in bad if r["object_type"] == "OwnershipInterest" or True)["tenant_id"] = ""
    assert len(validate_schema(bad)) >= 2


def test_consistency_clean_and_catches_dangling(built):
    specs, dossiers = built
    for s, d in zip(specs, dossiers):
        assert validate_consistency(d, s) == []
    h04_spec, h04 = party(built, "H04")
    d = deepcopy(h04)
    next(r for r in d.records if r["object_type"] == "BeneficialOwner")["data"]["evidence_ids"] = ["nope"]
    assert any("dangling" in e for e in validate_consistency(d, h04_spec))


def test_h04_effective_ownership_and_bos(built):
    specs, dossiers = built
    h04 = next(d for d in dossiers if d.party_id == "H04")
    assert h04.effective_ownership["gareth"] == "0.6"
    assert h04.effective_ownership["priya"] == "0.4"
    assert h04.expectations["beneficial_owners"] == ["gareth", "priya"]
    # Helen is a director only; she must not be a beneficial owner.
    assert "helen" not in h04.expectations["beneficial_owners"]


def test_circular_holding_does_not_loop():
    spec = {"customer": "a", "ownership": [
        {"owner": "b", "owned": "a", "interest": "0.5"}, {"owner": "a", "owned": "b", "interest": "0.5"}]}
    assert effective_ownership(spec)["b"] == 0.5


def test_spec_rejects_unknown_reference():
    with pytest.raises(SpecError):
        validate_spec({"id": "X", "seed": 1, "as_of": "2026-01-01", "customer": "a",
                       "entities": [{"ref": "a", "kind": "company", "name": "A"}],
                       "ownership": [{"owner": "zz", "owned": "a", "interest": "0.5"}],
                       "relationship": {"parties": []}, "expected": {"workflow": {}}})


def test_generation_is_deterministic_and_drift_checked(built, tmp_path):
    specs, _ = built
    first = render([generate(s) for s in specs])
    second = render([generate(s) for s in specs])
    assert first == second
    write(first, tmp_path)
    assert drift(first, tmp_path) == []
    (tmp_path / "parties/H01/records.jsonl").write_text("x")
    (tmp_path / "stray.txt").write_text("x")
    assert sorted(drift(first, tmp_path)) == ["changed parties/H01/records.jsonl", "stale stray.txt"]


def test_no_case_subject_without_entity(built):
    _, dossiers = built
    for d in dossiers:
        entities = {r["id"] for r in d.records if r["object_type"] == "Entity"}
        assert {s["entity_id"] for s in d.case["subjects"]} <= entities


# Required record selectors of the shipped workflow plans that Phase 1 cannot satisfy, with why.
# Anything not listed here must be satisfied by the corpus (type, fields, min count).
PLAN_GAPS = {
    "DocumentPage": "Phase 4 (documents)",
    "ExtractedAssertion": "Phase 4 (documents)",
    "ScreeningHit": "clean heroes have no hit to disambiguate; first positive is H02 (Phase 3)",
    "Control": "decision output of the workflow itself, not an input record",
    "Finding": "skill output of the workflow itself, not an input record",
    "WorkflowDefinition": "case task plan produced inside the workflow",
}
REPO = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("plan,party", [("kyc-v2", "H01"), ("kyb", "H04")])
def test_workflow_plan_context_has_no_unexplained_gaps(built, plan, party):
    import json
    _, dossiers = built
    records = next(d for d in dossiers if d.party_id == party).records
    # The deterministic KYC and KYB plans are archived (domains/archive/README.md) and still checked here.
    selectors = json.loads((REPO / f"artifacts/archive/{plan}.plan.json").read_text())["contextSelectors"]
    gaps = []
    for s in selectors:
        req = s.get("record")
        if not req or not s.get("required"):
            continue
        ok = [r for r in records if r["object_type"] == req["objectType"] and all(f in r["data"] for f in req["fields"])]
        if len(ok) < max(req.get("minCount", 1), 1):
            gaps.append(req["objectType"])
    unexplained = sorted({g for g in gaps if g not in PLAN_GAPS})
    assert unexplained == [], f"{plan} on {party}: no records for {unexplained}"


# ---- Phase 2: ledgers, typologies, source form, crowd ----
from context_corpus import detectors as det
from context_corpus.crowd import build_crowd
from context_corpus.iso20022 import parse_camt053
from context_corpus.validate import validate_crowd, validate_ledger


def party(built, pid):
    specs, dossiers = built
    i = next(i for i, d in enumerate(dossiers) if d.party_id == pid)
    return specs[i], dossiers[i]


def test_ledgers_are_scoped_complete_and_detectable(built):
    for spec, d in zip(*built):
        assert validate_ledger(d, spec) == [], d.party_id


@pytest.mark.parametrize("pid", ["H01", "H04"])
def test_hard_negatives_raise_nothing(built, pid):
    spec, d = party(built, pid)
    rows = det.rows_from_records(d.records)
    assert rows and spec["expected"]["hard_negative"]
    assert all(v == [] for v in det.run_all(rows).values())
    assert det.ctr_days(rows, set(d.expectations["ledger"]["hero_accounts"])) == []


def test_h07_signals_are_detected_and_separate(built):
    spec, d = party(built, "H07")
    rows = det.rows_from_records(d.records)
    out = det.run_all(rows)
    sig = {s["id"]: set(s["transaction_ids"]) for s in d.expectations["signals"]}
    assert len(sig["SIG-H07-FUNNEL"]) == 8 * 4
    assert any(set(i["transaction_ids"]) & sig["SIG-H07-STRUCT"] for i in out["structuring"])
    assert any(set(i["transaction_ids"]) & sig["SIG-H07-FUNNEL"] for i in out["funnel"])
    assert out["layering"] == [] and out["roundtrip"] == []
    # Structuring stays under the per-transaction threshold; CTR days still aggregate above it.
    assert all(r["amount"] < 10000 for r in rows if r["id"] in sig["SIG-H07-STRUCT"])
    assert len(det.ctr_days(rows, set(d.expectations["ledger"]["hero_accounts"]))) == 8 + 2


def test_h05_trade_facts_and_layering(built):
    spec, d = party(built, "H05")
    trades = d.expectations["ledger"]["trades"]
    assert len(trades) == 80
    assert sum(t["mismatch"] for t in trades.values()) == 10 and sum(t["overpriced"] for t in trades.values()) == 6
    assert {m["trade_id"] for m in det.trade_mismatches(d.records)} == {t["trade"] for t in trades.values() if t["mismatch"]}
    out = det.run_all(det.rows_from_records(d.records))
    assert len(out["roundtrip"]) == 3 and out["structuring"] == [] and out["funnel"] == []


def test_signal_ids_do_not_leak_into_records(built):
    for d in built[1]:
        blob = "\n".join(str(r["id"]) + str(r["subject_ids"]) + str(r["data"]) for r in d.records)
        assert "SIG-" not in blob
        assert not any("SIG-" in text for text in d.files.values())


def test_iso20022_matches_transaction_records(built):
    for d in built[1]:
        if "iso20022/camt.053.xml" not in d.files:
            continue
        parsed = {e["event_id"]: e for e in parse_camt053(d.files["iso20022/camt.053.xml"])}
        txs = [r["data"] for r in d.records if r["object_type"] == "Transaction"]
        assert len(parsed) == len(txs)
        for t in txs:
            e = parsed[t["event_id"]]
            assert all(e[k] == t[k] for k in ("amount", "currency", "timestamp", "source", "target", "status", "country"))
            assert e["transaction_type"] == t["transaction_type"]


def test_validate_ledger_catches_scope_and_overdraft(built):
    spec, d = party(built, "H01")
    bad = deepcopy(d)
    next(r for r in bad.records if r["object_type"] == "DatasetScope")["data"]["expected_count"] += 1
    assert any("DatasetScope" in e for e in validate_ledger(bad, spec))
    bad = deepcopy(d)
    next(r for r in bad.records if r["object_type"] == "Account" and "extensions" in r["data"])["data"]["extensions"][
        "ehf.corpus"]["value"]["opening_balance"] = "0.00"
    assert any("overdrawn" in e for e in validate_ledger(bad, spec))


def test_crowd_is_deterministic_and_in_band():
    path = Path(__file__).resolve().parents[1] / "crowd/crowd.yaml"
    a, b = build_crowd(path), build_crowd(path)
    assert a == b and a["transactions"] > 200_000 and a["parties"] == 1500
    assert validate_crowd(a) == []
    assert validate_crowd({**a, "planted_rate": 0.02}) != []


def test_reference_detectors_agree_with_library_when_importable(built):
    """Cross-check against the skill library's own detector on the same rows and policy."""
    import sys
    sys.path.insert(0, str(REPO / "apps/fincrime-host/src"))
    pytest.importorskip("networkx")
    lib = pytest.importorskip("financial_crime.skills.aml")
    for pid in ("H07", "H04"):
        _, d = party(built, pid)
        rows = [{"id": r["id"], **{k: r["data"][k] for k in ("source", "target", "amount", "currency", "timestamp", "status")}}
                for r in d.records if r["object_type"] == "Transaction"]
        mine = det.rows_from_records(d.records)
        scope = next(r["data"] for r in d.records if r["object_type"] == "DatasetScope")
        for kind in ("structuring", "funnel", "pass_through"):
            cfg = det.CORPUS_POLICY["aml_detectors"][kind]
            theirs, _, _ = lib.detector(kind, rows, cfg, scope)
            assert {tuple(sorted(i["transaction_ids"])) for i in theirs} == \
                   {tuple(sorted(i["transaction_ids"])) for i in det.DETECTORS[kind](mine, cfg)}, (pid, kind)


def test_alerts_come_from_detectors_and_match_provider_payload(built):
    import json
    for spec, d in zip(*built):
        if "provider/transaction.monitor.v1/alerts.json" not in d.files:
            continue
        payload = json.loads(d.files["provider/transaction.monitor.v1/alerts.json"])
        recs = {r["data"]["source_id"]: r["data"] for r in d.records if r["object_type"] == "Alert"}
        assert {a["alert_id"] for a in payload["alerts"]} == set(recs)
        for a in payload["alerts"]:
            assert recs[a["alert_id"]]["event_ids"] == a["event_ids"] and recs[a["alert_id"]]["rule_id"] == a["rule_id"]
        want = spec["expected"]["alerts"]
        assert (d.expectations["alert_rules"] == []) if want == 0 else set(want) <= set(d.expectations["alert_rules"])
        assert "SIG-" not in d.files["provider/transaction.monitor.v1/alerts.json"]


# ---- fraud layer ----
from context_corpus.digital import ato_score, payment_score  # noqa: E402
from context_corpus.validate import validate_fraud  # noqa: E402


def test_fraud_reference_detectors_find_exactly_the_episode(built):
    for spec, d in zip(*built):
        assert validate_fraud(d, spec) == [], d.party_id


def test_h10_episode_shape_and_negative_h01(built):
    spec, h10 = party(built, "H10")
    sig = h10.expectations["signals"][0]
    assert {k: len(v) for k, v in sig["records"].items()} == {"Session": 1, "AuthenticationEvent": 1, "FraudSignal": 2, "Device": 1, "Payment": 1}
    held = [r["data"] for r in h10.records if r["object_type"] == "Transaction" and r["id"] in set(sig["transaction_ids"])]
    assert sorted(t["status"] for t in held) == ["pending", "settled"] and sorted(t["amount"] for t in held) == ["1.00", "4800.00"]
    _, h01 = party(built, "H01")
    assert det.behavior_anomalies(h01.records) == [] and det.payment_anomalies(h01.records) == []
    assert det.elevated_fraud_signals(h01.records) == [] and any(r["object_type"] == "Session" for r in h01.records)


def test_fraud_scores_are_transparent():
    assert ato_score({"credential_reset": True, "new_device": True, "impossible_travel": True, "failed_attempts": 4}) == "1"
    assert ato_score({"failed_attempts": 1}) == "0.05"
    assert payment_score(__import__("decimal").Decimal("4800"), __import__("decimal").Decimal("1500")) == "1"
    assert payment_score(__import__("decimal").Decimal("600"), __import__("decimal").Decimal("1500")) == "0"


def test_validate_fraud_catches_a_missed_episode(built):
    spec, d = party(built, "H10")
    bad = deepcopy(d)
    next(r for r in bad.records if r["object_type"] == "Session" and r["data"]["features"]["typing_speed"] == "118.0")["data"]["features"] = {
        "typing_speed": "60.0", "session_seconds": "300.0", "pages_per_session": "5.0"}
    assert any("Session" in e for e in validate_fraud(bad, spec))


# ---- Phase 3: ownership, screening, real-source handling ----
import json as _json  # noqa: E402
from decimal import Decimal  # noqa: E402

from context_corpus import watchlists as wl  # noqa: E402
from context_corpus.validate import validate_ownership, validate_real_names, validate_screening  # noqa: E402


def test_ownership_and_screening_reference_checks_pass(built):
    for spec, d in zip(*built):
        assert validate_ownership(d, spec) == [] and validate_screening(d, spec) == [], d.party_id


def test_h06_ofac_cascade_versus_path_product(built):
    spec, d = party(built, "H06")
    e = lambda ref: f"h06.entity.{ref.replace('_', '-')}"  # noqa: E731
    blocked_ids = {e("b1"), e("b2")}
    blocked = det.ofac_blocked(d.records, blocked_ids)
    assert blocked - blocked_ids == {e("atlantic_meridian"), e("bellmont_lux"), e("bellmont_us")}
    result = det.ownership_analysis(d.records, e("bellmont_us"))
    # Path-product ownership says the designated owners hold 30% of the customer: below any 50% test.
    assert sum(result["interests"][x] for x in blocked_ids) == Decimal("0.30")
    assert {r for r, _ in result["unresolved"]} == {"CYCLE", "UNACCOUNTED_INTEREST", "OWNERSHIP_RANGE_REQUIRES_RESOLUTION"}
    assert d.expectations["beneficial_owners"] == ["c"] and d.expectations["effective_ownership"]["c"] == "0.27"


def test_h06_cascade_check_fails_when_a_blocked_owner_drops_below_the_aggregate(built):
    spec, d = party(built, "H06")
    bad = deepcopy(d)
    next(r for r in bad.records if r["object_type"] == "OwnershipInterest" and r["id"].endswith("b2-atlantic-meridian"))["data"]["interest"] = "0.19"
    assert any("cascade" in e for e in validate_ownership(bad, spec))


def test_h02_candidate_is_a_published_near_miss_with_conflicting_identifiers(built):
    spec, d = party(built, "H02")
    hits = d.expectations["screening_result"]["hits"]
    assert [(h["entry"], h["verified_match"], h["identifier_conflict"]) for h in hits] == [("ofac-sdn:38296", False, True)]
    entry = next(r for r in d.records if r["object_type"] == "WatchlistEntry" and r["id"].endswith("ofac-sdn-38296"))
    assert entry["data"]["name"] == "CALDERON RIJO, Jose" and entry["data"]["extensions"]["ehf.corpus"]["value"]["real_designation"] is True
    assert next(r for r in d.records if r["object_type"] == "ScreeningExecution" and r["data"]["screening_type"] == "sanctions")["data"]["candidate_count"] == 1


def test_h03_relative_is_listed_customer_is_not(built):
    spec, d = party(built, "H03")
    assert [(h["subject"], h["list_type"]) for h in d.expectations["screening_result"]["hits"]] == [("chidi", "pep")]
    assert any(r["object_type"] == "PEPRelationship" and r["data"]["relation"] == "sibling" for r in d.records)
    assert [r["data"]["verified"] for r in d.records if r["object_type"] == "SourceOfWealth"] == [True, False]


def test_h12_trust_is_bitemporal(built):
    spec, d = party(built, "H12")
    ben3 = next(r for r in d.records if r["object_type"] == "OfficerRole" and r["data"]["entity_id"].endswith("ben3"))
    assert ben3["valid_from"] == "2025-03-14T00:00:00Z"
    assert sorted(d.expectations["beneficial_owners"]) == ["ben1", "ben2", "ben3", "protector", "settlor", "trustee_ind"]
    assert not any(r["object_type"] == "OwnershipInterest" for r in d.records)
    assert any(r["object_type"] == "ReviewTrigger" for r in d.records) and any(r["object_type"] == "TimelineEvent" for r in d.records)


def test_real_designations_appear_only_as_list_data(built):
    real = {wl.normalize(e["name"]) for k, v in wl.load().items() if v["real"] for e in v["entries"]}
    for spec, d in zip(*built):
        for r in d.records:
            if r["object_type"] not in {"WatchlistEntry"}:
                name = r["data"].get("name") or r["data"].get("legal_name")
                assert not name or wl.normalize(name) not in real, r["id"]
    assert validate_real_names([s for s in built[0]]) == []


def test_fictional_name_matching_a_real_designation_is_rejected():
    bad = {"id": "HX", "expected": {}, "entities": [{"ref": "x", "name": "Calderon Rijo Jose"}]}
    assert validate_real_names([bad])


def test_sources_record_provenance_and_the_eu_gap():
    sources = _json.loads((Path(__file__).resolve().parents[1] / "sources/pinned/lists.json").read_text())["sources"]
    by = {s["id"]: s for s in sources}
    assert by["eu-consolidated"]["status"] == "unavailable"
    for k in ("ofac-sdn", "un-consolidated", "uk-sanctions"):
        assert by[k]["status"] == "collected" and len(by[k]["sha256"]) == 64 and by[k]["entries_pinned"] > 0


def test_screening_provider_payload_for_a_listed_subject(built):
    spec, d = party(built, "H06")
    host = _json.loads(d.files["provider/screening.sanctions.v1/b1.json"])
    assert host["result"]["total_candidates"] == 1 and host["result"]["matches"][0]["list_ids"] == ["synthetic-designations"]
    clean = _json.loads(d.files["provider/screening.sanctions.v1/c.json"])
    assert clean["result"]["matches"] == []
