"""The corpus's synthetic customer documents (documents.py) and the skill bridge (skill_bridge.py)."""
import asyncio
import importlib.util
import json
from pathlib import Path

import pytest
import yaml

from context_corpus import documents
from context_corpus.cli import REPO

CORPUS = REPO / "fixtures/context-corpus"
LIBRARY = importlib.util.find_spec("networkx") is not None and importlib.util.find_spec("pydantic") is not None


def test_documents_render_as_committed():
    for path, content in documents.render().items():
        assert (CORPUS / path).read_text(encoding="utf-8") == content, path


def test_answer_key_matches_the_pages_and_the_records():
    for party in documents.DOCUMENTS:
        key = yaml.safe_load((CORPUS / f"parties/{party}/documents.expected.yaml").read_text(encoding="utf-8"))
        rows = [json.loads(line) for line in (CORPUS / f"parties/{party}/documents.jsonl").read_text(encoding="utf-8").splitlines()]
        records = (CORPUS / f"parties/{party}/records.jsonl").read_text(encoding="utf-8")
        pages = {r["data"]["document_version"]: r["data"]["text"] for r in rows if r["object_type"] == "DocumentPage"}
        for doc in key["documents"]:
            text = pages[doc["document_version"]]
            # Every stated key field is on the page, and every document is about an entity in the records.
            for field, value in doc["fields"].items():
                for scalar in (value if isinstance(value, list) else [value]):
                    for part in (scalar.values() if isinstance(scalar, dict) else [scalar]):
                        assert str(part) in text or field == "formation_jurisdiction", (party, doc["file"], field, part)
            assert f'"{doc["subject"]}"' in records, doc["subject"]
            # A planted defect states one thing on the page and the records (or the date) another.
            for defect in doc["defects"]:
                assert defect["stated"] in text and defect["stated"] != defect["record"]
                if defect["against"] not in ("as_of",):
                    assert defect["record"] in records, defect


def test_only_planted_defects_disagree_with_the_records():
    # A name on a document that is not in the hero's records would be an unplanted conflict.
    for party, specs in documents.DOCUMENTS.items():
        records = (CORPUS / f"parties/{party}/records.jsonl").read_text(encoding="utf-8")
        for spec in specs:
            names = [line.split(": ", 1)[1].split(";")[0] for line in spec["text"].splitlines() if line.startswith(("Full name:", "Member:", "Director:", "Account holder:", "Name:"))]
            for name in names:
                assert json.dumps(name, ensure_ascii=False)[1:-1] in records or name in records, (party, spec["file"], name)


@pytest.mark.skipif(not LIBRARY, reason="the skill library's dependencies (apps/fincrime-host requirements-runtime.lock) are not installed")
def test_the_library_classifies_every_document_as_the_key_says():
    from context_corpus.skill_bridge import run
    for party, specs in documents.DOCUMENTS.items():
        key = yaml.safe_load((CORPUS / f"parties/{party}/documents.expected.yaml").read_text(encoding="utf-8"))
        result = asyncio.run(run({"id": "t", "party": party, "skill": "document.classify.catalog", "parameters": {},
                                  "customer_type": "individual" if party != "H04" else "corporate"}))["result"]
        assert result["status"] == "COMPLETED"
        got = {c["document_version"]: (c["document_type"], c["basis"]) for c in result["payload"]["classifications"]}
        assert got == {d["document_version"]: (d["document_type"], "title") for d in key["documents"]}


@pytest.mark.skipif(not LIBRARY, reason="the skill library's dependencies are not installed")
def test_a_provider_request_is_captured_for_the_callers_connector_and_answered_only_by_its_recording():
    from context_corpus.skill_bridge import run
    classify = asyncio.run(run({"id": "c", "party": "H03", "skill": "document.classify.catalog", "parameters": {}, "customer_type": "individual"}))
    classifications = classify["result"]["payload"]["classifications"]
    first = asyncio.run(run({"id": "e", "party": "H03", "skill": "document.fields.contract_extract", "customer_type": "individual",
                             "parameters": {"classifications": classifications, "subject": "h03.entity.adaeze"}}))
    assert first["result"]["status"] == "NEEDS_EVIDENCE"
    [request] = first["provider_requests"]
    assert request["capability"] == "document.fields" and request["request"]["pages"]
    # A recording for some other request answers nothing: the skill asks again.
    stale = {"capability": "document.fields", "request": {**request["request"], "source_digest": "0" * 64}, "payload": {}}
    again = asyncio.run(run({"id": "e2", "party": "H03", "skill": "document.fields.contract_extract", "customer_type": "individual",
                             "parameters": {"classifications": classifications, "subject": "h03.entity.adaeze"}, "recordings": [stale]}))
    assert again["provider_requests"] == first["provider_requests"]
