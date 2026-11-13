# Global KYC / CDD / AML Provider Atlas
## Catalog, canonical host model and adapter architecture
**Version 1.0 • Research date: 15 October 2026 • Design proposal and offline implementation starter**

## 1. Executive summary
This bundle separates three things that are frequently conflated: (1) a market/discovery catalog of providers, products and authoritative sources; (2) a bank-owned capability and payload model; and (3) adapter implementations that can eventually connect vendor-specific APIs to that model.

The catalog contains **376 records across 14 categories**, with **824 proposed provider–capability contracts**, **37 canonical capabilities** and **18 typed result families**. It includes commercial data vendors, identity specialists, registries, official lists, networks, orchestration platforms and adjacent investigation services. These are **not 376 distinct, active, API-enabled vendors**. Product-family and historical records are explicitly retained for legacy integration discovery.

**Evidence boundary:** 18 catalog records have separately reviewed public documentation or product material (10 documentation-level; 8 other public material). The other 358 remain candidate records whose detailed capabilities, legal entities, current products and bank usage have not been individually verified. Separately, 368 distinct reference URLs were attempted: 322 returned HTTP 2xx. Those checks capture title, description, redirect and status only; a responding homepage does not verify a capability or API. The workbook exposes both evidence tracks rather than inflating verification counts.

**Implementation boundary:** nine representative inbound normalizers and six non-executable outbound request planners are supplied. All examples use synthetic data. No vendor API credentials, sandbox calls, authentication implementations, webhook signature implementations or production integrations are included. All adapter manifests and catalog routing records are disabled pending validation.

The catalog is a broad global starting point, **not a certified exhaustive universe**. No defensible exhaustive worldwide list exists without a jurisdiction-by-jurisdiction source inventory, a defined institution/product scope, contracted-feed disclosure and a continuing maintenance process. Coverage and API claims in this bundle must not be used as procurement certification or regulatory assurance.

## 2. Deliverables and intended consumers
| Artifact | Consumer | Purpose |
|---|---|---|
| `Provider_Catalog.xlsx` | Compliance, procurement, architecture | Filterable catalog, normalized capability inventory, evidence and reference checks |
| `catalog/providers.json` / `.csv` | Catalog service | Organization/service/product records and evidence levels |
| `catalog/provider-capabilities.json` / `.csv` | Connection registry | Proposed capability bindings; not enabled routes |
| `catalog/capabilities.json` | Product/engineering | Bank-owned capability vocabulary |
| `schemas/request.schema.json` | Host API producer | Provider-independent request contract |
| `schemas/host.schema.json` | All downstream consumers | Strict common output envelope, entity graph and result union |
| `schemas/adapter.schema.json` | Adapter developers | Versioned mapping-manifest contract |
| `schemas/event.schema.json` | Event platform | Tenant-bound result-change event |
| `schemas/openapi.yaml` | Host API implementers | Proposed asynchronous host API surface |
| `adapters/runtime.py` | Engineering | Offline representative normalization and request planning |
| `adapters/manifests/*.json` | Engineering/governance | Source paths, target paths, transformations, limitations |
| `examples/` | QA, data platform | Native subset fixtures, host results, requests, plans, every capability family, ownership graph |
| `tests/` | QA/engineering | Contract tests and fail-closed regression cases |
| `docs/storage.sql` | Data platform | Illustrative tenant-isolated storage design |
| `Catalog_Explorer.html` | All reviewers | Self-contained searchable catalog and schema overview |

## 3. Coverage taxonomy
| Category | Records | What it contributes |
|---|---:|---|
| Identity verification and biometrics | 94 | Document, database, liveness, digital identity and regional onboarding specialists |
| Screening / risk intelligence | 26 | Sanctions, PEP, adverse media, enforcement, screening engines and intelligence components |
| KYB and corporate data | 31 | Registration, entity identity, corporate structures, officers and ownership discovery |
| Bureaus and identity networks | 13 | Identity corroboration, synthetic identity and account/consumer reporting signals |
| Fraud enrichment | 20 | Device, IP, phone, email and behavioral indicators; not substitutes for AML |
| Account and open-finance data | 26 | Account-holder comparison and permissioned financial evidence |
| Monitoring / CLM / investigations | 33 | Transaction surveillance, customer risk, cases, reporting and entity resolution |
| Orchestration | 7 | Workflow and data-provider routing; not necessarily proprietary risk data |
| Blockchain intelligence | 15 | Wallet and transaction exposure, attribution and investigations |
| Travel Rule | 7 | Counterparty discovery and originator/beneficiary information exchange |
| EDD and adjacent intelligence | 17 | Investigation reports, news, maritime/trade and third-party intelligence |
| Registries and digital identity sources | 66 | Government, national ID and company source systems; many restricted |
| Official lists / jurisdiction risk | 15 | Sanctions, debarment, export-control and country-risk publications |
| KYC/reference networks and standards | 6 | Financial-institution KYC exchange, identifiers, questionnaires and ownership standards |

The primary category is for navigation. `proposed_capabilities` is a routing hypothesis, not proof that every listed provider natively supplies every category capability. A biometric SDK is not assumed to perform full KYC; an orchestration platform is not assumed to own its upstream data. Official registries and networks may use portals, bulk files, XML, SOAP or restricted channels instead of public REST APIs.

### 3.1 Provider identity, products and history
Store a commercial contracting entity separately from its product and dataset. The catalog keeps legacy names because banks often still have contracts, credentials or logs using them. `family_id` is a deduplication aid, not a legal ownership registry. Entries such as Onfido/Entrust, Moody's/Orbis/kompany, LexisNexis/ThreatMetrix and Coinfirm/Lukka must not inflate unique-vendor counts.

Reference checks surfaced current-brand changes that need migration review: AuthenticID's homepage describes Incode; NorthRow's homepage describes ID-Pal; CAF presents Certta; Invoid redirects to Bureau; Intix presents Vyntra. Historical Acuris references now present KYC6 in metadata, so current product and ownership lineage require investigation rather than a guessed parent.

**Quarantine:** the historical Finantier reference returned unrelated gambling content. It is retained only as a historical inventory record, marked quarantined, and must not be used to connect to a provider. Reference failures or HTTP blocks elsewhere are not proof that a business has ceased operations.

### 3.2 Restricted and confidential sources
FinCEN BOI, Section 314(a), SSA eCBSV, UIDAI, CKYCR, BVN/NIN, driver-license verification networks, national digital identities and private consumer-reporting databases are not ordinary public lookup APIs. Access, consent, eligibility, secrecy, permitted use, country transfer rules and retention must be evaluated for the actual customer and institution. Do not scrape or route around access restrictions. Do not expose SAR/STR narratives, 314(a) information or vendor-private investigator comments to customers.

## 4. Target architecture
```text
Channels / onboarding / core banking / payments
                     |
            Canonical Host Request
                     |
        Policy + purpose + consent gateway
                     |
          Capability / connection resolver
   (entitlements, country, residency, version, health)
                     |
        Versioned provider-specific adapter
   request mapper -> secure transport -> response mapper
                     |
         Canonical Host Result + evidence refs
            /              |              \
    Entity graph      Evidence vault      Event stream
            \              |              /
        Bank policy decision / analyst disposition
                     |
      CLM | case tools | monitoring | audit | reporting
```
A **connection resolver** selects the provider adapter. An **entity resolver** evaluates whether two source records refer to the same real-world subject. These are different services. The design supports both; neither is allowed to infer legal clearance from a technical API success.

### 4.1 Connection resolution algorithm
1. Validate request schema, tenant and purpose; establish lawful basis and consent where necessary.
2. Resolve the requested capability against the provider–capability registry.
3. Filter for enabled maturity, approved country/document/company-type scope, contracted datasets, residency, permitted use and required freshness. Empty allowlists mean **deny**, not global support.
4. Pin provider product/API version, adapter version, host version and policy version. Verify the selected credentials belong to the same tenant and environment.
5. Apply institution-approved routing priorities: authority, coverage, latency, availability and price. Do not choose a fallback that changes the legal check or sends PII to a prohibited region.
6. Generate an idempotent operation keyed to tenant, subject, purpose and request. Reuse must require an identical request digest; reject conflicting reuse.
7. Build the native request, retrieve secrets just in time, and submit through controlled egress. Do not log tokens, national IDs, biometrics or signed URLs.
8. Handle synchronous, polling, webhook, batch and managed-service results through separate transport plugins. A 200 or 201 response only proves the API operation succeeded.
9. Validate provider shape, normalize supported fields, validate the host schema and semantic references, persist evidence and publish a result event through an outbox.
10. Run the bank's decision policy separately. Escalate missing coverage, inconclusive results, unresolved matches and changed risk; never silently treat them as passed.

**Supplied implementation:** steps involving live connection selection, transport, secrets, queues, policy enforcement and events are architecture requirements, not implemented services. The fixture adapters demonstrate the mapping seam only.

## 5. Canonical host schema
The host is a bank-owned proposed model, not an asserted industry-wide standard. JSON Schema Draft 2020-12 is used. Identifiers and money amounts are strings. Full timestamps are RFC 3339; uncertain dates carry precision rather than fabricated days. Objects reject undeclared fields except explicit `extensions` and `entity.attributes` escape hatches.

### 5.1 Envelope fields
| Field | Meaning |
|---|---|
| `schema_version` | Semantic version of the bank-owned contract |
| `result_id`, `request_id`, `tenant_id` | Result identity, correlation and isolation boundary |
| `subject_entity_id`, `capability` | What was checked and which capability the result addresses |
| `provider` | Source, product/API version, adapter version, opaque IDs, original status and decision origin |
| `execution` | Technical lifecycle: pending, completed, partial, failed, cancelled or unknown |
| `assessment` | Canonical check outcome and reason codes; separate bank decision and policy provenance |
| `coverage` | Requested, checked and not-checked scope, unknown/partial status and missing fields |
| `entities` | Typed source entities, names, namespaced identifiers and observed attributes |
| `relationships` | Evidenced, temporal ownership, officer, association, shared-signal and identity edges |
| `assertions` | Field-level facts with verification status and evidence references |
| `evidence` | Source records, pointers, authority, retrieval time, license/retention refs and classifications |
| `result` | Capability-specific typed result union |
| `errors`, `warnings` | Operational failure, drift, coverage and interpretation caveats |
| `raw_payload` | Restricted encrypted-vault locator and digest, not raw PII inline |
| `extensions` | Namespaced provider-specific remnants without changing bank semantics |

### 5.2 Capabilities and typed result families
| Result kind | Capabilities / intended payload |
|---|---|
| `verification` | Person, document, biometric, address, digital-ID, tax-ID and credential verification; checks and assertions |
| `business` | Business verification and registry lookup; entity reference, checks and assertions |
| `ownership` | Ownership discovery and officer lookup; root entity, relationship IDs, completeness and legal-test policy |
| `screening` | Sanctions, PEP, media, enforcement and payment screening; unresolved candidates, categories, lists and scores |
| `risk` | Device, email, phone, network, jurisdiction and customer risk; signals and provider-native scores |
| `account` | Account ownership verification; per-field match scores and bank-policy-dependent outcome |
| `financial` | Financial evidence retrieval; document references, periods and extracted facts |
| `monitoring` | Fiat transaction monitoring; scenarios, alerts, time windows and transactions |
| `case` | Investigation case state, assignment, alerts and decision history |
| `report` | Regulatory report draft/submission/acknowledgement state; never confuse submitted with accepted |
| `crypto` | Wallet screening and blockchain monitoring; chain, exposure, hop distance, amounts and risk scores |
| `travel_rule` | Message/protocol/counterparty state; originator and beneficiary PII stays in a restricted vault |
| `edd` | Investigation findings and internal summaries, with allegation/charge/conviction distinctions |
| `resolution` | Same/different/possible identity candidates, matched evidence and contradictions |
| `subscription` | Ongoing monitoring subscription and renewal/review state |
| `reference` | LEI, BIC, bank identifiers and ingested reference/list versions |
| `workflow` | Orchestration workflow version, step run IDs and lifecycle |
| `questionnaire` | Versioned questionnaires and evidenced answers, including financial-institution CDD forms |

All 37 capabilities have illustrative schema-valid examples under `examples/capabilities/`. These examples represent the **host contract**, not 37 vendor implementations. Some result families permit sparse records for asynchronous or unavailable results; production capability profiles should add conditional required fields for each lifecycle and jurisdiction.

### 5.3 Meaning must survive normalization
- `execution.status=completed` does not imply `assessment.outcome=passed`.
- `assessment.outcome=passed` refers to that capability/check only. It does not grant a banking relationship.
- `bank_decision=not_evaluated` is emitted by every sample adapter. A real bank decision requires actor, policy ID and policy version.
- `coverage.status=unknown` is deliberate where contracted scope cannot be proven. A matching response is not evidence of every required dataset being checked.
- Missing, unknown, not checked, not applicable, mismatch, failure and technical error are distinct. Never convert null into zero, false or a clean screening result.
- A match score is not a money-laundering probability. Preserve scale, direction, model, taxonomy and calibration reference; do not average vendor scores.
- Article mentions, allegations, charges and convictions remain distinct. PEP classification is not itself wrongdoing or an automatic rejection.
- Keep official source authority distinct from a vendor's curation and a customer assertion. Preserve contradicting observations rather than overwriting them.

## 6. Representative mappings and evidence
| Adapter | Native subset | Canonical behavior | Documentation |
|---|---|---|---|
| Sumsub | `applicantReviewed`, `reviewResult.reviewAnswer`, `reviewRejectType` | GREEN→passed; RED+RETRY→resubmit; RED+FINAL→failed; missing rejection type→inconclusive | S01 |
| Veriff | `verification.status`, ID, names | approved→passed; declined→failed; review→review; expiry/abandonment→inconclusive | S02 |
| Persona | Inquiry JSON API resource or event wrapper | completed→inconclusive; approved/declined retain client-workflow origin; no bank decision | S03–S05 |
| Middesk | Business object / event `data.object`, review tasks | in_review→review; task success applies only to task; approved/rejected are client-workflow states | S06–S08 |
| Companies House | company profile | Namespaced registry ID, legal name, original company status; no applicant KYC approval | S09 |
| OpenCorporates | `results.company` | Registry number paired with jurisdiction; `inactive=false` does not prove active | S10 |
| GLEIF | Single `lei-records` JSON API resource | LEI, name and original entity status; LEI registration state is separate; parent data is not UBO proof | S11–S12 |
| OpenSanctions | One query's `/match` response | Separate candidate entities and unresolved screening matches; retain list/taxonomy and raw score | S13–S15 |
| Plaid | `/identity/match` response | Per-account field scores; null omitted, not zero; no account-holder graph edge from score alone | S17–S18 |

ComplyAdvantage's classic API documentation was inspected (S16), including regional endpoints, Token authentication and `/searches`. It is cataloged but does **not** have an implemented adapter in this bundle. Do not assume classic and Mesh contracts are interchangeable. Similarly LSEG, LexisNexis and Moody's API/product materials establish relevant product families, not implemented mappings here (S20–S22).

Every implemented adapter has a source-to-target mapping manifest. Wildcards and named placeholders in mapping paths are documentation notation rather than literal RFC 6901 pointers; an adapter must use concrete pointers for field-level evidence in production. Unmapped native fields remain accessible only through the restricted raw artifact. Round-tripping is not promised: canonical output intentionally excludes vendor-private comments, arbitrary free text and raw biometrics.

### 6.1 Example: Sumsub review result
Native synthetic subset:
```json
{"applicantId":"synthetic-applicant-1","type":"applicantReviewed","reviewResult":{"reviewAnswer":"RED","reviewRejectType":"RETRY","rejectLabels":["BAD_PROOF_OF_IDENTITY"]}}
```
Selected host fields:
```json
{"capability":"identity.person.verify","execution":{"status":"completed","received_at":"2026-10-15T12:00:00Z"},"assessment":{"outcome":"resubmit","reason_codes":["BAD_PROOF_OF_IDENTITY"],"bank_decision":"not_evaluated"}}
```
This is a recoverable verification result, not a final bank rejection. The full schema-valid result is in `examples/host/sumsub.json`. Sumsub's `clientComment` is explicitly excluded from normalized customer-facing facts.

### 6.2 Native contracts for the remaining inventory
Each of the 824 catalog capability bindings points to the same canonical request and host response schemas and identifies its expected result family. **Only nine bindings are fixture-tested.** The others are `proposed_contract_only`: native method/path/schema are null, country and residency allowlists are empty, and routing is disabled. These are intentional unknowns, not missing endpoints to be guessed from vendor naming.

The 37-capability vocabulary above is a v1 discovery model. Its definitions share one generic caveat, conflate country with jurisdiction and have no per-capability input/output contract. The proposed replacement, with jurisdiction-scoped capability IDs, typed definitions, bindings and native-operation mappings, and a crosswalk for every catalog binding and vendor operation, is in [CANONICAL_EXTERNAL_CAPABILITY_MODEL.md](../../docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md). It is a proposal: no binding is enabled by it.

To promote a binding: obtain vendor-authorized OpenAPI/WSDL/file specifications and sample contracts; identify the exact product/version; collect positive, negative, partial, empty, error and monitoring-change examples; confirm data lineage and entitlement; implement both directions and the actual transport; validate in sandbox; obtain security/compliance approval; then canary production with rollback.

## 7. Connection and ownership resolution
### 7.1 Entity resolution model
Keep a source record ID distinct from a bank master entity ID. A provider's applicant ID, LEI record ID, account ID or watchlist ID is not automatically a master identity. Entity names alone never cause a merge. For identifiers use scheme + issuer/jurisdiction + value; preserve leading zeros. Normalize with scheme-specific rules rather than generic punctuation stripping. LEIs need format and checksum checks; the synthetic LEI fixture is deliberately not a real checksum-validated entity.

The included `resolve_identifier_connections` function produces **possible connections only**, using exact namespaced identifiers. It does not perform fuzzy identity resolution, resolve contradictions, identify fraud rings, compute UBOs or merge entities. Equal identifiers can still reflect reassignment, copied inputs, shared accounts or bad source records.

A production entity-resolution service should retain original scripts and transliterations, aliases, date precision, address periods, source quality and contradictory strong identifiers. It must be explainable, versioned and reversible. Name/DOB/address similarity is a feature set, not a legal finding. A shared device/address is an association signal, not proof of ownership, control, identity or wrongdoing.

### 7.2 Graph semantics
Nodes include persons, organizations, trusts, legal arrangements, accounts, wallets, vessels, aircraft, addresses and devices. Edges distinguish `owns`, `controls`, `director_of`, `beneficial_owner_of`, `parent_of`, `same_as`, `possible_same_as`, shared signals and transaction/association relationships. Each edge records assertion status, evidence and validity periods. Only a confirmed identity finding may become `same_as`; candidates remain separate nodes.

Ownership edges preserve equity/voting/economic/control basis, direct versus indirect holdings and ranges versus exact percentages. A source reporting “more than 25% up to 50%” must not become an invented 37.5% holding. Company PSC reporting, accounting consolidation parentage and a natural person's UBO status are different facts.

### 7.3 UBO and sanctions ownership rules
A production policy must specify jurisdiction, legal definition, direct/indirect calculation, aggregation across owners/paths, threshold inclusivity, control without ownership, trust roles, listed-company exemptions and data completeness. Avoid a hard-coded universal 25% rule. Likewise OFAC's ownership rule is not a generic worldwide UBO or sanctions-control rule. Applicable legal tests require institution counsel and policy approval.

Do not sum overlapping ownership paths without considering cross-holdings and double counting. Detect cycles and incomplete layers; handle nominee, trustee, settlor, protector and beneficiary roles separately. A 60% corporate shareholder and an individual holding 25–50% of that shareholder imply an uncertain indirect economic interval, not an automatically established UBO conclusion. The sample graph illustrates this and intentionally remains `completeness=partial`.

### 7.4 Time and contradiction
Persist immutable observations with source-effective and retrieval times. Store later corrections as superseding facts rather than destructive overwrites. When a legal name, owner, list entry or risk disposition changes, emit a versioned event and retain the prior decision evidence. A late webhook must not revert a newer decision merely because it arrived last.

## 8. Host API and operating controls
The proposed OpenAPI surface is asynchronous: create a check, retrieve its state, retrieve paginated results and subscribe to result-change events. Host authentication and tenant isolation are required. Public vendor callbacks terminate at a separate vendor-specific ingress, not the host create-check endpoint.

**Webhook ingress:** verify the signature against the exact raw bytes using the correct vendor/version algorithm and rotated secret; enforce timestamp/replay rules where supported; bind resource and tenant to a previously registered check; persist to a durable inbox before acknowledgement. Do not trust an external user ID or tenant ID supplied solely in an untrusted webhook. Acknowledge promptly after durable persistence, normalize asynchronously, deduplicate by vendor event identity and digest, and reconcile periodically using polling.

**Failures:** distinguish authentication/authorization, rate limit, timeout, upstream outage, unsupported country, not-found, invalid input, drift and partial data. Retry only eligible failures with bounded jitter and a deadline. Use Retry-After when documented. Creating a new application/check after a timeout can duplicate work and charges; use provider idempotency where available and reconcile ambiguous outcomes before retrying. Missing data must not trigger silent “fail open.”

**Data and privacy:** minimize transmitted attributes; use consent records and purpose-based access; tokenize account and national IDs; segregate biometrics and SAR/STR data; encrypt at rest and in transit; apply jurisdiction-specific retention and legal holds. Do not use arbitrary internet source URLs in a fetcher: allowlist domains, block private/link-local addresses and prevent SSRF. Catalog URLs are discovery pointers, never trusted executable base URLs.

**Licensing:** check caching, derived data, redistribution, list downloads, monitoring, graph persistence and audit retention rights. An orchestrator or reseller may call the same upstream database as another provider; record upstream source IDs so two wrappers are not mistaken for independent corroboration. Open source or public availability does not necessarily authorize commercial or unrestricted use.

**Decisions:** keep bank policy decisions, screening match disposition and provider results separate. Capture analyst identity, rationale, evidence, policy version and approval controls. Do not forward vendor-private findings or restricted law-enforcement requests to the customer. SAR/STR filing and tipping-off controls require separate authorization.

**Observability:** measure latency, availability, timeouts, rate limits, schema drift, missing data, source freshness, match volumes, false-positive dispositions, country/document coverage and cost. Never publish PII in metrics. Treat vendor numeric coverage, uptime and pricing claims as product-specific until contractually confirmed.

## 9. Storage, consumption and schema evolution
Use relational tables for catalog, check/run lifecycle, per-provider bindings, assertions, evidence and audit/outbox events; optionally project canonical entities/relationships into a graph engine. Do not make the graph the sole audit record. `docs/storage.sql` illustrates composite tenant keys and row-level isolation; it is a starter, not a deployed migration.

Consumers should validate schema version, capability, execution and coverage before reading result fields; understand their specific result kind; refuse undeclared bank approvals; and retain the result/evidence IDs underlying a decision. Events are at-least-once. A consumer ledger should track event ID and resource version, handle reordering, and fetch current state when gaps occur.

Version changes are reviewed: additive fields still require consumer compatibility tests because this schema is intentionally strict; new enum members and result kinds require deployment coordination; semantic changes require a new major version. Pin vendor API and adapter versions. Use dual-read/write and replay from encrypted evidence when migrating, subject to licensing and retention rules. Consumer examples are illustrative, not a promise of compatibility with every existing bank data model.

## 10. Tests and readiness assessment
The bundle runs 28 offline tests covering schema metaschemas, all host examples, all canonical requests, all nine manifests, catalog/source integrity, all 37 capability examples, false-approval traps, unknown status, null scores, malformed input, result-kind mismatch, partial results, identity-namespace separation, request planning, consent prerequisites and quarantined routing.

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python adapters/runtime.py sumsub examples/native/sumsub.json --out normalized.json
```

**Not tested or implemented:** actual authentication, HTTP semantics against vendors, webhook signatures, replay defense, all native product variants, pagination retrieval, multi-query OpenSanctions normalization, per-country mapping, live data freshness, bank policy execution, exact UBO calculation, production RLS deployment, concurrency, queue durability, security penetration testing, bank adoption claims, vendor legal lineage or a commercially exhaustive provider census.

### Production acceptance gates
1. Agree on jurisdictions, customer types, products, banking channels and control requirements.
2. Confirm the exact vendor/product/legal entity and remove duplicate or historical bindings from procurement counts.
3. Obtain contracts, legal basis, permitted datasets, residency, caching/retention rights and source lineage.
4. Retrieve authoritative native schemas and pin versions; build positive/negative/partial/error and change-event tests.
5. Implement secure transport and authenticated ingress with idempotency, retries, reconciliation and observability.
6. Add capability/jurisdiction profiles and bank decision/UBO policies reviewed by compliance and counsel.
7. Run vendor sandbox and adversarial tests, privacy/security assessments and model/matching validation.
8. Operate a limited production canary; document failover equivalence, rollback and analyst escalation.
9. Revalidate catalog references, products and entitlements periodically and on vendor-change events.

## 11. Exhaustiveness and maintenance plan
To turn this broad inventory into a defensible institutional source register, establish a coverage matrix of **jurisdiction × customer/entity type × capability × channel × authoritative source**. Enumerate every in-scope corporate registry (including US states and Canadian provinces), local national-ID ecosystem, bureau, licensed sanctions feed, beneficial-ownership access regime and consortium. Record a reason for every gap: unavailable, legally inaccessible, no API, vendor not contracted, not applicable or unresolved.

Reconcile the matrix against existing procurement contracts, bank architecture diagrams, network egress, data-processing agreements, case systems and vendor invoices. Capture reseller/upstream dependencies. Assign business and technical owners, last-reviewed timestamps and expiry dates; require reapproval on parent/product/API changes. A quarterly discovery review plus event-driven vendor-change tracking is a starting operating cadence, not a legal requirement.

This work deliberately leaves unsupported facts unknown. That is essential to an adapter framework that can be audited and safely extended.

## 12. Source index
The full index of inspected documentation and search excerpts is in `research/sources.json` and the workbook's **Evidence sources** tab. IDs S01–S26 support specific mappings or product notes; S27–S29 are vendor-written discovery comparisons only, not independent ratings. The separate **Reference checks** tab records HTTP/metadata retrieval, not detailed verification. Each provider record links to its relevant source IDs; absence of a source ID means its detailed capability claims remain unverified.
