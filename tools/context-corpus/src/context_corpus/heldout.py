"""Held-out split for production slice 1 (docs/implementation/production-slice-1.md section 3).

Procedural corporate parties for the screening-and-ownership slice, generated from a salt that never
enters the repository (`CORPUS_HELDOUT_SALT`). The same salt always yields the same parties; without
it there is no held-out split, so developer fixtures cannot be passed off as held-out evidence.

Each party is a scenario spec in the hero format (facts, never records), run through the same
`generate` as the heroes, so the records are contract-valid by construction. What varies:

- ownership: one to three holding layers, exact interests in 5% steps, optionally an ownership
  range, a circular holding and interest left unaccounted for;
- sanctions: the fictional designated persons (synthetic-designations) placed as owners at random
  depths and interests, so the OFAC 50 percent outcome differs from party to party;
- near misses: a person sharing a designated person's name but not their passport or birth date,
  with a provider candidate planted, so the hit must be proposed as a false match;
- PEP: the fictional PEP placed as an owner or director.

Limits: the designated and PEP identities are the corpus's fixed fictional list entries; the held-out
split varies where and how they appear, not the lists. Expected outcomes come from the evaluator's
reference implementations (evaluate.py), never from the library under test.
"""
from __future__ import annotations

import hashlib
import random
from decimal import Decimal
from typing import Any

from . import names
from . import watchlists as wl

AS_OF = "2026-09-30"
STEP = Decimal("0.05")
JURISDICTIONS = [("US-DE", "US"), ("US-NY", "US"), ("GB", "GB"), ("IE", "IE"), ("LU", "LU"), ("CY", "CY"), ("NL", "NL")]


def _rng(salt: str, index: int) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(f"{salt}:{index}".encode()).digest()[:8], "big"))


def _split(rng: random.Random, parts: int, total: Decimal) -> list[Decimal]:
    """`total` split into `parts` positive multiples of 5%."""
    units = int(total / STEP)
    if parts > units:
        parts = units
    cuts = sorted(rng.sample(range(1, units), parts - 1)) if parts > 1 else []
    bounds = [0, *cuts, units]
    return [STEP * (b - a) for a, b in zip(bounds, bounds[1:])]


def _designated() -> list[dict[str, Any]]:
    return wl.load()["synthetic-designations"]["entries"]


def _pep() -> dict[str, Any]:
    return wl.load()["synthetic-peps"]["entries"][0]


def heldout_specs(salt: str, count: int = 24) -> list[dict[str, Any]]:
    if not salt or len(salt) < 16:
        raise ValueError("CORPUS_HELDOUT_SALT must be at least 16 characters")
    return [_party(salt, index) for index in range(count)]


def _party(salt: str, index: int) -> dict[str, Any]:
    rng = _rng(salt, index)
    pid = f"X{index:03d}"
    entities: list[dict[str, Any]] = []
    ownership: list[dict[str, Any]] = []
    officers: list[dict[str, Any]] = []
    planned_hits: list[dict[str, Any]] = []
    people = iter(names.unique_names(rng, 12, lambda: names.person(rng)))
    companies = iter(names.unique_names(rng, 8, lambda: names.business(rng, "generic", "GB")))
    serial = iter(range(1, 100))

    def company(ref: str, name: str) -> dict[str, Any]:
        jurisdiction, country = rng.choice(JURISDICTIONS)
        entity = {"ref": ref, "kind": "company", "name": name, "legal_form": "corporation", "verification": "registry_extract",
                  "address": {"lines": [f"{rng.randint(1, 400)} Commerce Street"], "locality": "Synthetic City", "country": country},
                  "registration": {"jurisdiction": jurisdiction, "authority": "synthetic-registry",
                                   "registration_id": f"SYN-{country}-{pid}-{next(serial):03d}", "incorporated": f"{rng.randint(2001, 2020)}-0{rng.randint(1, 9)}-1{rng.randint(0, 9)}",
                                   "status": "active"}}
        entities.append(entity)
        return entity

    def person(ref: str, *, name: str | None = None, dob: str | None = None, identifier: str | None = None) -> dict[str, Any]:
        entity = {"ref": ref, "kind": "individual", "name": name or next(people),
                  "dob": dob or f"{rng.randint(1950, 1995)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
                  "nationality": rng.choice(["GB", "US", "IE", "DE", "NL"]), "verification": "government_id_document",
                  "identifiers": [{"type": "passport", "issuer": "XX-SPECIMEN", "value": identifier or f"SPECIMEN-{pid}-PP-{next(serial):03d}", "verified": True}],
                  "address": {"lines": [f"{rng.randint(1, 90)} Elm Row"], "locality": "Synthetic Town", "country": "GB"}}
        entities.append(entity)
        return entity

    customer = company("customer", next(companies))
    # Holding layers above the customer: a chain of 0-3 companies, each owned by people and/or the next layer.
    layers = [customer]
    for depth in range(rng.choice([0, 1, 1, 2, 2, 3])):
        layers.append(company(f"hold{depth + 1}", next(companies)))
    individuals: list[dict[str, Any]] = []
    for level, owned in enumerate(layers):
        upper = layers[level + 1] if level + 1 < len(layers) else None
        unaccounted = STEP * rng.randint(1, 6) if rng.random() < 0.2 else Decimal(0)
        ranged = upper is None and level > 0 and rng.random() < 0.2
        total = Decimal(1) - unaccounted - (Decimal("0.30") if ranged else 0)
        owners: list[dict[str, Any]] = []
        if upper is not None:
            owners.append(upper)
        owners += [person(f"p{level}_{n}") for n in range(rng.randint(1 if upper is None else 0, 3))]
        if not owners:
            owners.append(person(f"p{level}_0"))
        for owner, share in zip(owners, _split(rng, len(owners), total)):
            ownership.append({"owner": owner["ref"], "owned": owned["ref"], "interest": str(share), "since": "2020-01-01"})
            if owner["kind"] == "individual":
                individuals.append(owner)
        if ranged:
            nominee = company(f"nominee{level}", next(companies))
            ownership.append({"owner": nominee["ref"], "owned": owned["ref"], "range": ["0.10", "0.30"], "since": "2020-01-01"})
    # Designated persons: replace up to two individuals' identities with the fictional designations.
    if rng.random() < 0.4 and individuals:
        for entry, target in zip(_designated(), rng.sample(individuals, min(len(individuals), rng.choice([1, 2])))):
            target.update({"name": entry["name"], "dob": str(entry["dob"][0]) if entry.get("dob") else target["dob"],
                           "identifiers": [{"type": "passport", "issuer": "XX-SPECIMEN", "value": entry["identifiers"][0], "verified": True}]})
    # A near miss: a designated person's name with a different passport and birth date, and a provider candidate.
    if rng.random() < 0.3:
        entry = rng.choice(_designated())
        near = person("nearmiss", name=entry["name"], dob=f"{rng.randint(1970, 1999)}-0{rng.randint(1, 9)}-1{rng.randint(0, 9)}")
        officers.append({"person": near["ref"], "org": customer["ref"], "role": "director", "appointed": "2021-01-01"})
        planned_hits.append({"subject": near["ref"], "entry": f"synthetic-designations:{entry['uid']}"})
    # The fictional PEP as a director.
    if rng.random() < 0.25:
        pep = _pep()
        person("pep", name=pep["name"], dob=str(pep["dob"][0]) if pep.get("dob") else None, identifier=pep["identifiers"][0])
        officers.append({"person": "pep", "org": customer["ref"], "role": "director", "appointed": "2022-01-01"})
    # A circular holding: the customer holds 5% back in its direct parent.
    # The parent's direct owners give up 5% so its exact interests never exceed 100%.
    if len(layers) > 1 and rng.random() < 0.15:
        parent = layers[1]["ref"]
        edges = [x for x in ownership if x["owned"] == parent and "interest" in x]
        if sum(Decimal(x["interest"]) for x in edges) + STEP > 1:
            largest = max(edges, key=lambda x: Decimal(x["interest"]))
            if Decimal(largest["interest"]) > STEP:
                largest["interest"] = str(Decimal(largest["interest"]) - STEP)
        if sum(Decimal(x["interest"]) for x in edges) + STEP <= 1:
            ownership.append({"owner": customer["ref"], "owned": parent, "interest": str(STEP), "since": "2022-01-01"})
    for owner in [e for e in entities if e["kind"] == "individual"][:1]:
        if not any(o["person"] == owner["ref"] for o in officers):
            officers.append({"person": owner["ref"], "org": customer["ref"], "role": "director", "appointed": "2020-01-01"})

    refs = [e["ref"] for e in entities]
    return {
        "id": pid, "seed": int.from_bytes(hashlib.sha256(f"{salt}:{index}:seed".encode()).digest()[:4], "big"), "as_of": AS_OF,
        "customer": customer["ref"], "entities": entities, "officers": officers, "ownership": ownership,
        "relationship": {"institution": "bank.synthetic", "booking_jurisdiction": "US", "policy_jurisdiction": "US", "customer_type": "corporate",
                         "started": "2026-08-01", "risk_tier": "MEDIUM", "ownership_complete": None,
                         "parties": [{"entity": customer["ref"], "role": "customer"}],
                         "products": [{"type": "deposit", "currencies": ["USD"], "countries": ["US"], "channels": ["online"]}],
                         "geography": [{"country": "US", "basis": "operations", "value": "1"}]},
        "screening": {"provider": "synthetic-lists", "capability": "screening.sanctions.v1", "subjects": refs, "types": ["sanctions", "pep"],
                      "lists": ["synthetic-designations", "synthetic-peps"], "hits": planned_hits,
                      "dataset_versions": ["synthetic-lists-2026-09-29"], "scope": ["synthetic-designations", "synthetic-peps"], "list_published": "2026-09-29"},
        "expected": {"workflow": {"kyb": "HELDOUT"}},
    }
