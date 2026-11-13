"""Synthetic customer documents for corpus heroes, for the document agent and the identity agent.

Each hero listed in DOCUMENTS gets the documents a customer would submit at onboarding, written
as plain-text pages the way the evidence pipeline admits a parsed document: a `DocumentVersion`
(the file) and one `DocumentPage` per page with the page's full text (`text_basis: full_text`).
Nothing here is a real document or a real identity; every identifier is a SPECIMEN value from
the hero's own records.

The documents agree with the hero's canonical records except where a planted defect says
otherwise, and every planted defect is written to the answer key (`documents.expected.yaml`):
which catalog type each document is, what each key field states, and which findings a correct
review reports. A defect is planted only where the key says so; the rest must reconcile.

Outputs, per hero, beside `records.jsonl`, written by `context-corpus generate` with the rest of
the corpus (and checked by `generate --check`):
  documents.jsonl         DocumentVersion and DocumentPage records (the corpus record envelope)
  documents.expected.yaml the answer key
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

import yaml

AS_OF = "2026-09-30T00:00:00Z"
TENANT = "tenant-synthetic"

# One entry per document: catalog type, file name, the subject it is about (an entity ref in the
# hero's records), the page text, the key fields the page states, and any planted defect.
DOCUMENTS: dict[str, list[dict[str, Any]]] = {
    "H02": [
        {
            "type": "national_identity_card", "file": "rios-national-identity-card.txt", "subject": "h02.entity.mateo",
            "text": (
                "NATIONAL IDENTITY CARD\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT - NOT VALID FOR TRAVEL OR IDENTIFICATION\n"
                "Issuing state: Kingdom of Spain (ES-SPECIMEN)\n"
                "Surname: RIOS CALDERON\nGiven names: MATEO\n"
                "Full name: Mateo Ríos Calderón\n"
                "Date of birth: 1983-06-21\n"
                "Document number: SPECIMEN-H02-DNI-0001\n"
                "Date of issue: 2021-03-15\nDate of expiry: 2031-03-15\n"
            ),
            "fields": {"person_name": "Mateo Ríos Calderón", "identity_number": "SPECIMEN-H02-DNI-0001", "date_of_birth": "1983-06-21", "expiry_date": "2031-03-15"},
        },
        {
            "type": "utility_bill", "file": "rios-utility-bill-2026-08.txt", "subject": "h02.entity.mateo",
            "text": (
                "UTILITY BILL\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT\n"
                "Supplier: Synthetic Energía Madrid S.A.\n"
                "Account holder: Mateo Ríos Calderón\n"
                "Supply address: Calle de Alcalá 112, 4B, Madrid, 28009, ES\n"
                "Billing period: 2026-07-01 to 2026-07-31\nIssue date: 2026-08-04\n"
                "Amount due: EUR 64.20\n"
            ),
            "fields": {"subject_name": "Mateo Ríos Calderón", "subject_address": "Calle de Alcalá 112, 4B, Madrid, 28009, ES", "issue_date": "2026-08-04"},
        },
    ],
    "H03": [
        {
            "type": "passport", "file": "okonkwo-bell-passport.txt", "subject": "h03.entity.adaeze",
            "text": (
                "PASSPORT\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT - NOT VALID FOR TRAVEL OR IDENTIFICATION\n"
                "Issuing state: United Kingdom (GB-SPECIMEN)\n"
                "Surname: OKONKWO-BELL\nGiven names: ADAEZE\n"
                "Full name: Adaeze Okonkwo-Bell\n"
                "Nationality: British\n"
                "Date of birth: 1984-11-02\n"
                "Passport number: SPECIMEN-H03-PP-0001\n"
                "Date of issue: 2019-05-20\nDate of expiry: 2029-05-20\n"
            ),
            "fields": {"person_name": "Adaeze Okonkwo-Bell", "identity_number": "SPECIMEN-H03-PP-0001", "date_of_birth": "1984-11-02", "expiry_date": "2029-05-20"},
            # Day and month transposed against the identity record (1984-02-11).
            "defects": [{"finding": "DATE_OF_BIRTH_CONFLICT", "field": "date_of_birth", "stated": "1984-11-02", "record": "1984-02-11", "against": "Identity"}],
        },
        {
            "type": "driving_licence", "file": "okonkwo-bell-driving-licence.txt", "subject": "h03.entity.adaeze",
            "text": (
                "DRIVING LICENCE\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT - NOT VALID FOR DRIVING OR IDENTIFICATION\n"
                "Issuing authority: Synthetic Driver and Vehicle Agency (GB-SPECIMEN)\n"
                "Name: Adaeze Okonkwo-Bell\n"
                "Date of birth: 1984-02-11\n"
                "Licence number: SPECIMEN-H03-DL-0001\n"
                "Address: 17 Pemberton Square, London, W1K 2ZZ, GB\n"
                "Valid from: 2016-03-31\nValid to: 2026-03-31\n"
            ),
            "fields": {"person_name": "Adaeze Okonkwo-Bell", "identity_number": "SPECIMEN-H03-DL-0001", "date_of_birth": "1984-02-11", "expiry_date": "2026-03-31"},
            # Expired six months before the case's as-of date.
            "defects": [{"finding": "DOCUMENT_EXPIRED", "field": "expiry_date", "stated": "2026-03-31", "record": AS_OF[:10], "against": "as_of"}],
        },
        {
            "type": "utility_bill", "file": "okonkwo-bell-utility-bill-2026-09.txt", "subject": "h03.entity.adaeze",
            "text": (
                "UTILITY BILL\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT\n"
                "Supplier: Synthetic Water London Ltd\n"
                "Account holder: Adaeze Okonkwo-Bell\n"
                "Supply address: 17 Pemberton Square, London, W1K 2ZZ, GB\n"
                "Billing period: 2026-06-01 to 2026-08-31\nIssue date: 2026-09-05\n"
                "Amount due: GBP 112.85\n"
            ),
            "fields": {"subject_name": "Adaeze Okonkwo-Bell", "subject_address": "17 Pemberton Square, London, W1K 2ZZ, GB", "issue_date": "2026-09-05"},
        },
    ],
    "H04": [
        {
            "type": "certificate_of_incorporation", "file": "thistlewood-certificate-of-incorporation.txt", "subject": "h04.entity.thistlewood-fab",
            "text": (
                "CERTIFICATE OF INCORPORATION\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT - ISSUED BY A FICTIONAL REGISTRY\n"
                "Synthetic Companies Registry (GB)\n"
                "Company name: Thistlewood Fabrication Ltd\n"
                "Company number: SYN-GB-00041042\n"
                "Company type: Private company limited by shares\n"
                "Jurisdiction of incorporation: England and Wales (GB)\n"
                "Date of incorporation: 2011-04-05\n"
                "Registered office: Unit 9, Calder Works, Foundry Lane, Sheffield, S9 9ZZ, GB\n"
            ),
            "fields": {"entity_name": "Thistlewood Fabrication Ltd", "registration_number": "SYN-GB-00041042", "formation_date": "2011-04-05", "formation_jurisdiction": "GB"},
            # The registry extract gives Unit 7; the certificate states Unit 9.
            "defects": [{"finding": "REGISTERED_ADDRESS_CONFLICT", "field": "registered_address", "stated": "Unit 9, Calder Works, Foundry Lane, Sheffield, S9 9ZZ, GB",
                         "record": "Unit 7, Calder Works, Foundry Lane, Sheffield, S9 9ZZ, GB", "against": "RegistryRecord"}],
        },
        {
            "type": "director_officer_register", "file": "thistlewood-register-of-directors.txt", "subject": "h04.entity.thistlewood-fab",
            "text": (
                "DIRECTOR OR OFFICER REGISTER\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT\n"
                "Company: Thistlewood Fabrication Ltd (SYN-GB-00041042)\n"
                "Director: Gareth Thistlewood; appointed 2011-04-05; date of birth 1971-11\n"
                "Director: Helen Marsh; appointed 2019-01-14; date of birth 1983-07\n"
                "Register made up to: 2026-09-01\n"
            ),
            "fields": {"entity_name": "Thistlewood Fabrication Ltd", "parties": ["Gareth Thistlewood", "Helen Marsh"]},
        },
        {
            "type": "shareholder_register", "file": "thistlewood-holdings-register-of-members.txt", "subject": "h04.entity.thistlewood-holdings",
            "text": (
                "SHAREHOLDER OR MEMBER REGISTER\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT\n"
                "Company: Thistlewood Holdings Ltd (SYN-GB-00041077)\n"
                "Member: Gareth Thistlewood; 600 ordinary shares of GBP 1; 60%; held directly\n"
                "Member: Priya Nair-Calloway; 400 ordinary shares of GBP 1; 40%; held directly\n"
                "Issued share capital: 1,000 ordinary shares of GBP 1\n"
                "Register made up to: 2026-09-01\n"
            ),
            "fields": {"entity_name": "Thistlewood Holdings Ltd", "ownership_interests": [{"owner": "Gareth Thistlewood", "interest": "60%"}, {"owner": "Priya Nair-Calloway", "interest": "40%"}]},
        },
        {
            "type": "passport", "file": "marsh-passport.txt", "subject": "h04.entity.helen",
            "text": (
                "PASSPORT\n"
                "SPECIMEN - SYNTHETIC TEST DOCUMENT - NOT VALID FOR TRAVEL OR IDENTIFICATION\n"
                "Issuing state: United Kingdom (GB-SPECIMEN)\n"
                "Surname: MARSH\nGiven names: HELEN\n"
                "Full name: Helen Marsh\n"
                "Date of birth: 1983-07-30\n"
                "Passport number: SPECIMEN-H04-PP-0003\n"
                "Date of issue: 2022-02-01\nDate of expiry: 2032-02-01\n"
            ),
            "fields": {"person_name": "Helen Marsh", "identity_number": "SPECIMEN-H04-PP-0003", "date_of_birth": "1983-07-30", "expiry_date": "2032-02-01"},
        },
    ],
}

# What a complete set would also contain and the hero did not supply: a correct review requests it.
MISSING: dict[str, list[dict[str, str]]] = {
    "H04": [{"type": "passport", "subject": "h04.entity.gareth", "reason": "No identity document for director Gareth Thistlewood."},
            {"type": "utility_bill", "subject": "h04.entity.helen", "reason": "No proof of address for director Helen Marsh."}],
}


def _envelope(record_id: str, object_type: str, subject: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "classification": "internal", "data": data, "id": record_id, "object_type": object_type, "observed_at": AS_OF,
        "purposes": ["investigation", "onboarding", "review"], "recorded_at": AS_OF, "schema_version": "2.0.0",
        "source_refs": [], "subject_ids": [subject], "supersedes": None, "synthetic": True, "tenant_id": TENANT,
        "valid_from": None, "valid_to": None, "version_id": "v1",
    }


def build(party: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    records: list[dict[str, Any]] = []
    key: dict[str, Any] = {"party_id": party, "as_of": AS_OF, "documents": [], "missing": MISSING.get(party, [])}
    for spec in DOCUMENTS[party]:
        text = spec["text"]
        sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        document_id = f"doc_{sha[:24]}"
        records.append(_envelope(document_id, "DocumentVersion", spec["subject"], {
            "document_id": document_id, "artifact_hash": sha, "media_type": "text/plain",
            "artifact_ref": f"kyc-evidence-pipeline:{document_id}", "page_count": 1,
            "extensions": {"ehf.connector": {"schema_version": "1.0.0", "value": {"filename": spec["file"], "format": "txt", "page_count_basis": "decoded_pages"}}},
        }))
        records.append(_envelope(f"page:{document_id}:1", "DocumentPage", spec["subject"], {
            "text": text, "page": 1, "document_version": sha,
            "extensions": {"ehf.connector": {"schema_version": "1.0.0", "value": {"text_basis": "full_text", "document_id": document_id}}},
        }))
        key["documents"].append({"document_id": document_id, "document_version": sha, "file": spec["file"], "subject": spec["subject"],
                                 "document_type": spec["type"], "fields": spec["fields"], "defects": spec.get("defects", [])})
    return records, key


def render() -> dict[str, str]:
    """Every hero's document files, by path under the corpus root (written with the rest of the corpus)."""
    files: dict[str, str] = {}
    for party in sorted(DOCUMENTS):
        records, key = build(party)
        files[f"parties/{party}/documents.jsonl"] = "".join(json.dumps(r, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n" for r in records)
        files[f"parties/{party}/documents.expected.yaml"] = yaml.safe_dump(key, sort_keys=False, allow_unicode=True)
    return files
