"""Runs skill-library skills over a corpus hero for an out-of-process caller (the live agent run).

One JSON request per stdin line, one JSON response per stdout line:

  request  {"id", "party", "skill", "parameters", "subject_ids", "customer_type",
            "extra_records": [record...], "recordings": [{"capability", "request", "payload"}]}
  response {"id", "result": SkillResult, "provider_requests": [{"capability", "request"}]}
         | {"id", "error": "..."}

The skill reads the hero's committed records (records.jsonl and documents.jsonl) plus
`extra_records` (what earlier skills in the same run proposed, such as extracted assertions).

A provider capability (`document.fields`, ...) is never answered here. The first time a skill
asks for one, the request is captured and the skill reports the source unavailable; the caller
answers the captured request through its own connector and runs the skill again with the answer
as a recording, which the library's RecordedProvider serves only for that exact request. So a
model's answer reaches a skill only through the platform connector, and is bound to the request
it answers.
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .evaluate import REPO, _library

AT = datetime(2026, 9, 30, tzinfo=timezone.utc)
CONNECTOR = "ehf-connector"
CORPUS = REPO / "fixtures/context-corpus/parties"

# Documentary requirements by customer type: any-of groups over catalog types, in the
# `ehf.document` policy extension document.requirements.resolve reads.
REQUIREMENTS = {
    "individual": [
        {"id": "identity", "any_of": ["passport", "national_identity_card", "driving_licence"], "description": "Government-issued identity document"},
        {"id": "address", "any_of": ["utility_bill", "bank_statement"], "description": "Proof of residential address"},
    ],
    "corporate": [
        {"id": "legal-existence", "any_of": ["certificate_of_incorporation", "company_registry_extract"], "description": "Evidence of legal existence"},
        {"id": "control", "any_of": ["director_officer_register"], "description": "Directors and officers"},
        {"id": "ownership", "any_of": ["shareholder_register", "beneficial_ownership_declaration"], "description": "Evidence of ownership"},
        {"id": "director-identity", "any_of": ["passport", "national_identity_card", "driving_licence"], "description": "Identity document for each director"},
    ],
}


def _ts(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _records(party: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for name in ("records.jsonl", "documents.jsonl"):
        path = CORPUS / party / name
        if path.exists():
            out += [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return out


class _Capture:
    """A provider that answers nothing and remembers what it was asked."""
    provider_id = CONNECTOR

    def __init__(self, recordings: dict[tuple[str, str], Any], ProviderResponse, digest, evidence_for):
        self.recordings, self.ProviderResponse, self.digest, self.evidence_for = recordings, ProviderResponse, digest, evidence_for
        self.requests: list[dict[str, Any]] = []

    async def invoke(self, capability: str, request: dict) -> Any:
        from financial_crime.contracts import SkillError, Status
        answer = self.recordings.get((capability, self.digest(request)))
        if answer is None:
            self.requests.append({"capability": capability, "request": request})
            raise SkillError("SOURCE_UNAVAILABLE", "the provider answer is fetched by the caller's connector", Status.NEEDS_EVIDENCE)
        # As the platform's skill host does, the answer's evidence is the admitted context the request
        # was built from: here the page records the request carried.
        return self.ProviderResponse(provider_id=CONNECTOR, capability=capability, request_hash=self.digest(request), payload=answer,
                                     evidence_refs=self.evidence_for(request), source_version="ehf-connector-v1", coverage={"complete": True}, synthetic=True)


async def run(request: dict[str, Any]) -> dict[str, Any]:
    fixtures, data_schema, Principal, Record, Executor, Store = _library()
    from financial_crime.contracts import digest
    from financial_crime.providers import ProviderResponse, Router

    def known(object_type: str) -> bool:
        try:
            data_schema(object_type)
            return True
        except ValueError:
            return False

    store = Store()
    policy = fixtures.policy()
    customer_type = request.get("customer_type", "corporate")
    policy["extensions"] = {"ehf.document": {"schema_version": "1.0.0", "value": {"document_requirements": REQUIREMENTS[customer_type]}}}
    policy["required_document_types"] = []
    capabilities = sorted({c for spec in fixtures.load_registry().values() for c in spec.capabilities})
    policy["permitted_providers"] = {c: [CONNECTOR] for c in capabilities}
    store.put(Record(id="bridge-policy", tenant_id="tenant-synthetic", object_type="Policy", data=policy,
                     observed_at=_ts("2026-01-01T00:00:00Z"), recorded_at=_ts("2026-01-01T00:00:00Z"), version_id="v1", synthetic=True, subject_ids=[]))
    rows = _records(request["party"]) + list(request.get("extra_records", []))
    for r in rows:
        if not known(r["object_type"]):
            continue
        store.put(Record(id=r["id"], tenant_id=r.get("tenant_id", "tenant-synthetic"), object_type=r["object_type"],
                         data={k: v for k, v in r["data"].items() if k != "extensions" or r["object_type"] in {"DocumentPage", "DocumentVersion", "ExtractedAssertion"}},
                         subject_ids=r.get("subject_ids", []), observed_at=_ts(r.get("observed_at", "2026-09-30T00:00:00Z")),
                         recorded_at=_ts(r.get("recorded_at", "2026-09-30T00:00:00Z")), version_id=r.get("version_id", "v1"), synthetic=True,
                         valid_from=_ts(r["valid_from"]) if r.get("valid_from") else None))
    store.set_state("tenant-synthetic", "case", f"case-{request['party']}", 0, {"state": "OPEN", "case_type": "KYB" if customer_type == "corporate" else "KYC"})
    recordings = {(x["capability"], digest(x["request"])): x["payload"] for x in request.get("recordings", [])}
    def evidence_for(provider_request: dict) -> list:
        # The pages a request names: by page id (document.fields), by record id (the tamper
        # detector) or by text digest (the forensics detector).
        ids = {page.get("page_id") for page in provider_request.get("pages", []) if isinstance(page, dict)}
        ids |= {row.get("id") for row in provider_request.get("records", []) if isinstance(row, dict)}
        hashes = set(provider_request.get("document_hashes", []))
        return [record.ref() for record in store.records("tenant-synthetic", "DocumentPage")
                if record.id in ids or (hashes and digest(record.data.get("text", "")) in hashes)]

    capture = _Capture(recordings, ProviderResponse, digest, evidence_for)
    profile = fixtures.profile().model_copy(update={"max_objects": 10_000})
    subjects = request.get("subject_ids") or [r["id"] for r in rows if r["object_type"] == "Entity"]
    principal = Principal(tenant_id="tenant-synthetic", actor_id="analyst", permissions=set(policy["permissions"]),
                          purposes=set(profile.purposes), subject_ids=set(subjects) | {r["id"] for r in rows if r["object_type"] == "Entity"})
    executor = Executor(store, [profile], Router({c: capture for c in capabilities}))
    invocation = fixtures.invocation(request["skill"], subject_ids=subjects, parameters=request.get("parameters", {}),
                                     as_of_time=AT, knowledge_cutoff=AT, policy_snapshot_ref="bridge-policy",
                                     case_id=f"case-{request['party']}", idempotency_key=f"{request['skill']}-{request.get('id', '0')}", purpose="onboarding")
    result = await executor.run(invocation, principal)
    store.close()
    return {"result": json.loads(result.model_dump_json()), "provider_requests": capture.requests}


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            response = asyncio.run(run(request))
        except Exception as error:  # reported to the caller, which fails the step
            response = {"error": f"{type(error).__name__}: {error}"}
        sys.stdout.write(json.dumps({"id": request.get("id"), **response}, default=str) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
