# KYC / CDD / AML Provider Atlas — implementation bundle
**Research date: 2026-10-15 · Version 1.0 · Offline starter, not live integrations**

## Start here
- **Catalog_Explorer.html** — self-contained searchable catalog and architecture overview.
- **Provider_Catalog.xlsx** — filterable catalog, proposed provider/capability bindings, evidence, reference checks and data dictionary.
- **Architecture_and_Integration_Guide.docx** — architecture, schema semantics, mapping rules, governance and production-readiness requirements.
- **docs/Architecture_and_Integration_Guide.md** — same technical guide as editable Markdown.

## What's included
376 catalog records (including products, legacy families, registries and networks; **not 376 distinct active vendors**), 824 proposed provider-capability contracts, 37 host capability types, 18 typed result families, 9 representative fixture-tested normalizers, 6 non-executable request planners and examples for every capability.

18 catalog records have separately reviewed public material. 358 detailed records remain candidate/unverified. A separate batch attempted 368 reference URLs and recorded HTTP status, redirects and page metadata (322 HTTP 2xx). Metadata retrieval does **not** verify an API or capability. No provider adoption census, live vendor calls or production certification is claimed.

**The inventory is broad, not provably exhaustive.** Many local registries, private bank feeds, subnational sources and restricted services require a defined jurisdiction-level completion project. See the guide's maintenance plan.

## Common model
- `schemas/request.schema.json` — canonical provider-independent input.
- `schemas/host.schema.json` — strict output envelope, entities, relationships, assertions, evidence, scores, checks and typed result union.
- `schemas/adapter.schema.json` — mapping contract and promotion gates.
- `schemas/event.schema.json` — host result-change event.
- `schemas/openapi.yaml` — proposed asynchronous host API (design only).
- `docs/storage.sql` — illustrative PostgreSQL storage / tenant isolation (not deployed/tested).

## Run offline tests and an example
Requires Python 3.10+.
```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python adapters/runtime.py sumsub examples/native/sumsub.json --out normalized.json
```
47 tests validate fixtures, examples, schemas, fail-closed interpretation and the proposed v2 capability registries. Tests are not vendor sandbox certification. All synthetic names, account IDs, registration IDs, LEIs and watchlist entries are examples, not real subjects or real screening findings.

## Proposed v2 capability model
`build_capability_model.py` turns the reviewed decisions in `capability-model/source/` and the catalog into versioned registries and schemas. It writes:
- `capability-model/registry/capability-definitions.json`: 56 capability definitions.
- `capability-model/registry/jurisdictions.json`: registered jurisdiction tokens.
- `capability-model/registry/capability-bindings.json`: 825 v2 bindings backfilled from the 824 legacy bindings.
- `capability-model/registry/legacy-crosswalk.json`: the crosswalk from legacy bindings to v2 bindings.
- `schemas/v2/`: record and request/result envelope schemas.

Nothing is enabled. Coverage, entitlements and country scopes stay empty, quarantine is kept, and fixture evidence is not carried over to corrected semantics. The design is `../docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md`. The v1 schemas and catalog above are unchanged and still drive the runtime.

## Extension seam
Each catalog provider/capability pair resolves to a host result family. Only nine bindings have example normalizers; all others have native fields **null** and maturity `proposed_contract_only`. Do not mistake these for ready-made vendor APIs. `adapters/manifests/` contains explicit source/target rules for the nine implemented subsets. All bindings are disabled. Empty country lists mean deny.

To add a production adapter: obtain authorized vendor-native schemas and contract entitlements; pin versions and regional endpoints; map requests and responses; implement secure transport and verified webhooks; test error/partial/empty/change cases; validate in vendor sandbox; pass privacy, legal, security, model and compliance gates; then enable a controlled canary.

## Safe semantics
- HTTP success != completed verification != approved customer.
- Vendor check result != bank decision.
- Screening candidate != confirmed match.
- Missing/null != clear/zero/false.
- Matching names/shared addresses/shared devices != same identity/ownership.
- LEI parents/PSC records != universal natural-person UBO evidence.
- Scores are provider-native and must not be averaged across vendors.
- Raw payload hashes in the offline examples are over **canonical JSON**, not original signed HTTP bytes. Production signature verification must use original bytes.
- All examples keep `bank_decision=not_evaluated` and coverage unknown unless explicitly illustrative.

## Reference warning
The historical Finantier domain returned unrelated gambling content during reference checks. Its catalog record is quarantined and must not be used as a live provider connection. Catalog URLs are discovery data, not trusted API base URLs. Restrict egress and protect against SSRF.

## Rebuild
```bash
python build_bundle.py
python create_examples.py
python create_api.py
python create_presentations.py
python build_capability_model.py
python -m unittest discover -s tests -v
```
`research/check_references.py` performs network metadata retrieval and is optional; it is not run by normal tests or normalization. The included retrieval snapshot is already available. Build scripts use only the workspace source catalog and do not install credentials or contact vendors.

## License / data rights
Bank-owned schemas and starter code are proposed designs. Vendor source documents and datasets retain their own licenses. No entitlement to vendor data, scraping, resale, biometrics or restricted government records is granted. Obtain relevant permissions independently.
