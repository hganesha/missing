"""Production slice 1 evaluation (docs/implementation/production-slice-1.md section 6).

The fast tests check the harness's own ground truth: its reference implementations must agree with the
reviewed hero answer keys, and the held-out split must be deterministic per salt and contract-valid.
The slow tests (`pytest -m slow`) run the skill library and prove the harness can fail.
"""
import json
from decimal import Decimal
from pathlib import Path

import pytest

from context_corpus.cli import build, main
from context_corpus.evaluate import DEV_PARTIES, reference, slice_policy
from context_corpus.gen import generate
from context_corpus.heldout import heldout_specs
from context_corpus.spec import validate_spec
from context_corpus.validate import validate_real_names, validate_schema

SCEN = Path(__file__).resolve().parents[1] / "scenarios"
SALT = "unit-test-salt-not-a-secret-0001"


@pytest.fixture(scope="module")
def heroes():
    specs, dossiers = build(SCEN)
    return {s["id"]: (s, d) for s, d in zip(specs, dossiers)}


def eid(pid, ref):
    return f"{pid.lower()}.entity.{ref.replace('_', '-')}"


def test_reference_agrees_with_the_reviewed_answer_keys(heroes):
    policy, _ = slice_policy()
    for pid in ("H04", "H06"):
        spec, dossier = heroes[pid]
        ref = reference(spec, policy)
        key = dossier.expectations
        assert ref.ubos == {eid(pid, r) for r in key["beneficial_owners"]}
        leaves = {eid(pid, r): Decimal(v) for r, v in key["effective_ownership"].items() if eid(pid, r) in ref.interests}
        assert ref.interests == leaves
    h06 = reference(heroes["H06"][0], policy)
    ownership = heroes["H06"][1].expectations["ownership"]
    assert h06.ofac_blocked is True
    assert h06.unresolved == set(ownership["unresolved"])
    assert h06.sanctions_hits == {eid("H06", r) for r in ownership["blocked_owners"]}
    assert reference(heroes["H04"][0], policy).ofac_blocked is False
    h02 = reference(heroes["H02"][0], policy)
    assert h02.disambiguation == {eid("H02", "mateo"): heroes["H02"][1].expectations["screening"]["disposition"]}
    assert reference(heroes["H03"][0], policy).pep_hits == {eid("H03", heroes["H03"][1].expectations["screening"]["pep_relative_listed"])}


def test_slice_policy_is_a_candidate_with_a_stated_basis():
    raw = json.loads((Path(__file__).resolve().parents[3] / "domains/kyb-screening/policy/slice-policy.json").read_text())
    assert raw["status"] == "CANDIDATE" and raw["approved_by"] is None and raw["synthetic"] is False
    assert raw["ownership_threshold"] == "0.25" and raw["sanctions_ownership"] == {"rule": "ofac_50_percent", "threshold": "0.5"}
    assert set(raw["basis"]) >= {"ownership_threshold", "sanctions_ownership", "screening_threshold", "jurisdiction"}


def test_heldout_split_is_deterministic_per_salt_and_contract_valid():
    a, b, other = heldout_specs(SALT, 8), heldout_specs(SALT, 8), heldout_specs(SALT + "-x", 8)
    assert a == b and a != other
    for spec in a:
        validate_spec(spec, spec["id"])
        assert not validate_schema(generate(spec).records)
        # Exact direct interests never exceed 100% of any company.
        totals = {}
        for edge in spec["ownership"]:
            if "interest" in edge:
                totals[edge["owned"]] = totals.get(edge["owned"], Decimal(0)) + Decimal(edge["interest"])
        assert all(total <= 1 for total in totals.values())
    assert not validate_real_names(a)
    with pytest.raises(ValueError):
        heldout_specs("short", 1)


def test_heldout_needs_a_salt_and_never_writes_into_the_repository(tmp_path, monkeypatch):
    monkeypatch.delenv("CORPUS_HELDOUT_SALT", raising=False)
    assert main(["evaluate", "--split", "heldout"]) == 2
    monkeypatch.setenv("CORPUS_HELDOUT_SALT", SALT)
    inside = Path(__file__).resolve().parents[1] / "heldout-report.json"
    assert main(["evaluate", "--split", "heldout", "--count", "1", "--report", str(inside)]) == 2
    assert not inside.exists()


def needs_library():
    pytest.importorskip("networkx")
    pytest.importorskip("pydantic")


@pytest.mark.slow
def test_dev_split_meets_every_check_and_control(tmp_path):
    needs_library()
    report = tmp_path / "dev.json"
    assert main(["evaluate", "--split", "dev", "--report", str(report)]) == 0
    data = json.loads(report.read_text())
    assert data["dataset"]["parties"] == len(DEV_PARTIES)
    assert all(m == 1.0 or m == 0 for m in data["familyMetrics"].values())
    for skill, result in data["skills"].items():
        assert result["evidence"]["controlsPassed"] is True, skill
        assert result["evidence"]["sampleCount"] == result["applicableCases"]


@pytest.mark.slow
def test_heldout_split_runs_from_the_salt(tmp_path, monkeypatch):
    needs_library()
    monkeypatch.setenv("CORPUS_HELDOUT_SALT", SALT)
    report = tmp_path / "heldout.json"
    assert main(["evaluate", "--split", "heldout", "--count", "12", "--no-controls", "--report", str(report)]) == 0
    assert json.loads(report.read_text())["dataset"]["parties"] == 12


@pytest.mark.slow
def test_the_harness_fails_when_a_skill_behaves_differently(heroes, monkeypatch):
    """Under path-product aggregation the OFAC evaluation stops blocking H06: the harness must catch it."""
    needs_library()
    from context_corpus import evaluate as ev

    policy, digest = ev.slice_policy()
    monkeypatch.setattr(ev, "slice_policy", lambda: ({**policy, "sanctions_ownership": {"rule": "synthetic_aggregate", "threshold": "0.5"}}, digest))
    spec, dossier = heroes["H06"]
    report = ev.evaluate([spec], [dossier], "dev", controls=False)
    ofac = report["skills"]["screening.sanctions.ownership.evaluate"]
    assert ofac["passedCases"] == 0 and "threshold_met False != True" in ofac["failures"][0]
    assert report["familyMetrics"]["ofac.blocked_accuracy"] == 0.0
