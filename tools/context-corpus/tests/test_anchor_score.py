import json
from pathlib import Path

from context_corpus.anchor_score import claims, score

ANCHORS = Path(__file__).resolve().parents[3] / "fixtures" / "context-corpus" / "anchors"


def _facts_for(gold):
    return {"facts": [{"subject": "x", "object": " ".join(c["terms"])} for c in claims(gold)]}


def test_every_anchor_gold_is_scorable_and_perfect_extraction_scores_one():
    golds = sorted(ANCHORS.glob("*/gold.json"))
    assert len(golds) == 3
    for p in golds:
        g = json.loads(p.read_text())
        assert claims(g)
        assert score(g, _facts_for(g))["recall"] == 1.0
        assert score(g, {"facts": []})["recall"] == 0.0


def test_a4_labels_match_their_own_arithmetic():
    g = json.loads((ANCHORS / "A4-alphabet" / "gold.json").read_text())
    a, b = g["shares_outstanding"]["class_a"], g["shares_outstanding"]["class_b"]
    votes = a + 10 * b
    for h in g["holders"]:
        if "class_b_pct" in h:
            assert round(100 * h["class_b"] / b, 1) == h["class_b_pct"]
            assert round(100 * (h["class_a"] + 10 * h["class_b"]) / votes, 1) == h["voting_pct"]
