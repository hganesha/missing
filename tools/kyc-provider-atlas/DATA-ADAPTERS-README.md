# data-adapters — KYC / CDD / AML provider adapters

A provider-independent integration layer for identity, business-verification, screening and financial-data vendors. It has two parts:

| Directory | What it is | Runs? |
|---|---|---|
| [`kyc-provider-atlas/`](kyc-provider-atlas/README.md) | Research catalog of 376 provider records, the **canonical request/result JSON schemas**, 9 fixture-tested normalizers and 6 non-executable request planners. | Offline library + generators |
| [`api-wiring/`](api-wiring/README.md) | A **FastAPI service** built on that model: authenticated host API → durable job queue → worker → connector → normalized, encrypted result + event outbox. It also has a separate private layer of documented vendor clients (42 vendors, 732 operations) for credential testing. | Yes (demo and live modes) |

`api-wiring/vendor/atlas/` is a vendored copy of the atlas catalog, schemas, examples and normalizers, so the service runs without the atlas checkout.

## Status at a glance

These numbers are verified from the code and tests, not marketing.

| | Count |
|---|---|
| Catalog records (products, legacy families, registries; *not* distinct vendors) | 376 |
| Proposed provider×capability bindings | 824 (822 simulatable, 2 quarantined) |
| Host capability types / typed result families | 37 / 18 |
| Fixture-tested native normalizers | 9 |
| Native HTTP subsets in the host worker | 6 (Persona, Companies House, OpenCorporates, GLEIF, OpenSanctions, Plaid) |
| Documented vendor clients / operations (testing layer) | 42 / 732 |
| **Bindings live-ready out of the box** | **0**: every live route needs an operator-approved contract |
| **Calls tested against a real vendor sandbox** | **0**: all transport tests use `httpx.MockTransport` |
| Proposed v2 capability families / registered jurisdiction tokens | 56 / 44 ([design](docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md)) |
| v2 bindings backfilled from the 824 legacy bindings / enabled | 825 (one conditional split) / **0** |
| v2 native-operation mappings / blocked pending dispatch or source conflict | 732 / 16 |
| Automated tests | 843 (`api-wiring`) + 47 (`kyc-provider-atlas`), all passing (re-run on Python 3.13.18, November 2026) |

This is a well-tested **integration starter**, not a certified production deployment. See [Remaining work](#remaining-work).

## Architecture

```
 client ──► POST /v1/checks ──► validate (request schema, tenant, subject, idempotency)
                                   │
                                   ▼
                          Registry.resolve()  ── allowlist, quarantine, live-readiness gates
                                   │
                                   ▼
                    checks table (encrypted, tenant-scoped, CAS-leased)
                                   │
                         Worker.run_one()
                     ┌─────────────┴──────────────┐
               demo: simulation()          live: HTTPConnector
               (fixture normalizers or     (native subset or declarative
                capability examples)        JSON template; sync/poll/webhook)
                     └─────────────┬──────────────┘
                                   ▼
                host schema + semantic validation (fail closed)
                                   ▼
          result_history + CloudEvents outbox ──► signed delivery to approved destinations
```

Key design rules, enforced in code:

- **Fail closed.** Unknown or missing native fields become `unknown` or an error, never `clear` or `passed`. Schema drift produces a `failed` result with no partial findings.
- **No decisions.** Every result carries `bank_decision: not_evaluated`. A vendor "approved" status is recorded as provider-native data.
- **No guessed endpoints.** Live calls go only to exact operator-approved HTTPS bases. Redirects are refused, private IPs are rejected, and paths are percent-encoded.
- **No blind retries of paid calls.** An ambiguous timeout or lost lease moves the check to `reconciliation_required`.
- **Tenant isolation everywhere.** Covers API keys, idempotency, results, events, artifacts and the vendor-test allowlist.

## Quick start

Requires Python 3.13+. Use a virtual environment.

### Run the service in demo mode

```bash
cd api-wiring
python -m pip install -r requirements.txt -c requirements-tested.txt
uvicorn wiring.app:create_app --factory --port 8000
```

Open http://localhost:8000 for the console, or http://localhost:8000/docs for Swagger. The demo token is `demo-token-local-only`. Demo mode **never calls vendors**: it simulates every non-quarantined binding with synthetic data and writes it encrypted to `api-wiring/.local/wiring.db`.

```bash
curl -X POST http://localhost:8000/v1/demo/run \
  -H 'Authorization: Bearer demo-token-local-only' \
  -H 'Content-Type: application/json' \
  -d '{"operation_id":"sumsub:identity.person.verify"}'
```

Do not expose demo mode publicly. Its admin token is published above.

### Run the tests

```bash
cd api-wiring && python -m pytest tests -q
cd kyc-provider-atlas && python -m pip install -r requirements.txt && python -m unittest discover -s tests -v
```

### Normalize a native payload offline

```bash
cd kyc-provider-atlas
python adapters/runtime.py sumsub examples/native/sumsub.json --out normalized.json
```

The CLI validates its output against `schemas/host.schema.json` and exits non-zero if the output is invalid.

## API surface (`api-wiring`)

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /healthz` | none | Mode, catalog counts, live-ready count |
| `GET /v1/providers`, `/v1/providers/{id}`, `/v1/capabilities`, `/v1/connections`, `/v1/schemas/{name}` | reader | Registry and per-binding readiness with blockers |
| `POST /v1/checks`, `POST /v1/checks/batch` | operator | Submit canonical requests (an `Idempotency-Key` header is required for single submissions) |
| `GET /v1/checks`, `/v1/checks/{id}`, `/v1/checks/{id}/results` | reader | Status and versioned results |
| `GET /v1/checks/{id}/artifact` | admin | Restricted native evidence (access is audited) |
| `POST /v1/checks/{id}/retry` | admin | Requeue a failed or dead-letter job |
| `GET /v1/events`, `POST /v1/event-subscriptions`, `GET /v1/deliveries` | reader / admin | Event outbox and approved destinations |
| `POST /v1/webhooks/{check_id}` | HMAC-signed | Vendor callbacks (raw-body or timestamped HMAC) |
| `GET /v1/vendor-connections[...]`, `POST .../operations/{op}/invoke` | reader / admin | Documented vendor clients; `invoke` makes real calls only in live mode with `VENDOR_TEST_ENABLED=1` and an allowlisted tenant |
| `POST /v1/demo/run` | operator | Demo mode only |

The full contract is in [`api-wiring/docs/openapi.json`](api-wiring/docs/openapi.json).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `WIRING_MODE` | `demo` | Any other value means live mode. Live mode requires `ENCRYPTION_KEY` and `API_KEYS_JSON` |
| `ENCRYPTION_KEY` | auto in demo | Fernet key for every payload column |
| `API_KEYS_JSON` | demo token | `{"<token>":{"tenant_id":"…","role":"reader\|operator\|admin"}}` |
| `DATABASE_URL` | SQLite in `.local/` | `postgresql+psycopg://…` for deployments |
| `WORKER_ENABLED` | `1` | Set `0` and run `python -m wiring.worker` separately |
| `CONTRACTS_PATH`, `DESTINATIONS_PATH` | `config/*.json` | Operator-owned approved bindings and event destinations, shipped empty |
| `ENABLE_API_DOCS` | `0` | Swagger in live mode |
| `VENDOR_TEST_ENABLED`, `VENDOR_TEST_TENANTS_JSON` | `0`, `[]` | Gate for the vendor-testing layer. The tenant list must be a JSON array |
| `VENDOR_<PROVIDER>_<KEY>` | none | Vendor credentials, e.g. `VENDOR_SUMSUB_APP_TOKEN`. See `config/vendor-secrets.env.example` |

Deployment scaffolding (`Dockerfile`, `compose.yaml`) is included, but Docker and PostgreSQL have **not** been exercised. See [`api-wiring/docs/Operator_Guide.md`](api-wiring/docs/Operator_Guide.md).

## Documentation map

- [`kyc-provider-atlas/docs/Architecture_and_Integration_Guide.md`](kyc-provider-atlas/docs/Architecture_and_Integration_Guide.md): canonical model, mapping rules, governance
- [`docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md`](docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md): **proposed v2 capability model** (`<capability_path>.intelligence.<jurisdiction>`), 56-family dictionary, legacy crosswalk, and mapping of all 376 provider records, 824 bindings, 9 fixture adapters and 732 native vendor operations. Its machine-readable registries are in `kyc-provider-atlas/capability-model/registry/` and `api-wiring/vendor_connections/mappings/operation-mappings.json`. Vendor-test normalization uses the operation mappings; production `/v1/checks` routing still uses the v1 model
- [`api-wiring/docs/Operator_Guide.md`](api-wiring/docs/Operator_Guide.md): live bindings, declarative templates, async workflows, deployment
- [`api-wiring/docs/Vendor_Testing_Guide.md`](api-wiring/docs/Vendor_Testing_Guide.md): private credential testing against real vendors
- `Provider_Catalog.xlsx`, `Connection_Readiness.xlsx`, `Vendor_Connection_Coverage.xlsx`: spreadsheet views of the catalog, blockers and coverage

## Development notes

- **Code style.** The Python is written in a dense, minified style: 1-space indents and semicolon-joined statements. New code in this repo has matched that style for consistency. A formatter pass (e.g. `ruff format`) would make the signing and gating logic much easier to audit, but it would rewrite every file.
- **Vendored copy.** `api-wiring/vendor/atlas/normalizers.py` must stay byte-identical to `kyc-provider-atlas/adapters/runtime.py`. `test_vendored_normalizers_match_atlas_source` enforces this when both directories are present.
- **Generated files.** `kyc-provider-atlas/build_bundle.py` and its sibling generators **overwrite** `schemas/`, `catalog/`, `examples/`, `adapters/manifests/`, the HTML explorer and the Office documents. Schemas are defined as Python dicts inside `build_bundle.py`, so edit them there, not in the JSON. The rebuild is deterministic, except for Office-file timestamps.
- **Network scripts.** Scripts under `api-wiring/scripts/` (`discover_*`, `import_official_specs`, `capture_vendor_sources`, `browser_smoke`) hit the network and rewrite committed source/evidence files. None of them run during tests.
- **v2 capability model.** Reviewed decisions live in `kyc-provider-atlas/capability-model/source/*.json` and `api-wiring/vendor_connections/mappings/operation-review.json`. Edit those, then run `python build_capability_model.py` (atlas) and `python scripts/build_capability_mappings.py` (api-wiring). The second script vendors the atlas registries and schemas into `api-wiring/vendor/atlas/` and fails if any vendor definition changed since its operations were reviewed. Both accept `--check`, and tests fail when outputs are stale. These generators and their tests use conventional formatting rather than the dense style above.
- **Release zips.** `scripts/package_release.py` writes release zips to the repo root. The three `*.zip` files here are those snapshots and are git-ignored.

## Review notes (October 2026)

A review of the declared functionality against the code found the approach sound. The gates, idempotency, leasing, encryption and egress controls all do what the docs say, and the claimed counts are accurate. The following defects were fixed, each with a regression test that fails on the old code:

| Area | Defect | Fix |
|---|---|---|
| Host API | `routing.deadline_at` without a UTC offset, or malformed, crashed `POST /v1/checks` with a **500** | Strict RFC 3339 parsing, so it returns a 422. `rfc3339-validator` was added: without it, jsonschema silently skipped **all** `date-time` format checks |
| Normalizers | When a payload failed partway through mapping, `execution.status=failed` was set, but partial `checks`, `matches`, `entities`, `assertions` and `status_original` were kept, contrary to the fail-closed contract | The error path resets the result to its pristine shape |
| Normalizers | `applicantId: null`, non-list `rejectLabels`, LEI/id mismatch, Middesk envelope without `data.object`, duplicate or boolean OpenSanctions scores and non-numeric Plaid scores produced schema-invalid or misleading output | Each case now raises a contract mismatch |
| Normalizers | `plan_request` raised `StopIteration` on a missing subject and accepted non-ASCII "alphanumeric" company numbers | Both now raise `ValueError` |
| Normalizer CLI | Wrote schema-invalid output with exit code 0 | Validates first |
| Vendor testing | Veriff `PATCH /sessions/{id}` and `POST /sessions/{id}/media` were HMAC-signed over the session id instead of the body, so real calls would fail authentication | Body requests sign the payload |
| Vendor testing | A call that reached the vendor but failed host mapping returned 422, and a retry with the same key then returned **200 "success"** with `host: null` | Only `completed`/`upstream_error` invocations replay. Post-call failures return 502 with the invocation id |
| Vendor testing | Missing credentials, bad input shape or DNS failure used up the idempotency key and told the user to "reconcile" a call that was never sent | Endpoint, credentials, serialization and signing all run before the key is reserved |
| Vendor testing + worker | The shared `httpx.Client` kept a cookie jar, so vendor `Set-Cookie` values were replayed across tenants | The cookie jar now rejects all cookies |
| Vendor testing | `VENDOR_TEST_TENANTS_JSON='"a,b"'` became a substring check | Must be a JSON array |
| Event delivery | Every failure was recorded as `DESTINATION_NOT_APPROVED`, and permanent config denials were retried 5 times | Records the real code and dead-letters config denials immediately |
| Webhooks | A profile without `resource_id_pointer` caused a 500 | Treated as not configured (403) |

### Known issues not fixed

- `check_url`'s DNS check can be bypassed by DNS rebinding because httpx resolves again. Enforce egress at the network layer with a proxy or firewall.
- Veriff and Shufti response-signature checks run before status handling. An unsigned 4xx error is reported as `SIGNATURE_INVALID`, and the raw bytes are discarded.
- Vendor responses of up to 25–100 MB are held in memory several times (bytes, base64, parsed, encrypted).
- The rate limiter is per process and unbounded in key count. Use a gateway limiter in production.
- `import_official_specs.py` fetches unpinned `main`/`master` specs.
- `Catalog_Explorer.html`, the `.docx` and the `bundle-manifest.json` files still show the old test counts until the generators are re-run.

## Remaining work

Live production use still needs: vendor contracts, entitlements and pinned native schemas per binding; credentials from a secret manager; real sandbox acceptance; vendor-specific webhook verifiers; network-level egress control; PostgreSQL hardening, retention and key rotation; and security, privacy and compliance sign-off. 334 of the 376 catalog records have no vendor client yet.

## License / data rights

The schemas and starter code are proposed designs. Vendor documents, OpenAPI snapshots and datasets keep their own licenses. Nothing here grants access to vendor data, biometrics or restricted government records. All names and identifiers in fixtures are synthetic.
