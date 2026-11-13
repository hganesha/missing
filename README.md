# Integral Flow: Agentic FC platform

Canonical financial-crime integration is available through the [integration guide](docs/fincrime-integration.md): 229 executable skill contracts (222 canonical plus seven extensions), Postgres task execution and an authenticated Python bridge. The [catalog foundation](docs/implementation/skill-catalog-implementation.md) adds editable business procedures, explicit policy contracts, immutable versions and production qualification controls. Skills remain synthetic until independently qualified.

A domain author writes a `DomainPackage` plus a Graph workflow. The plan compiler `harnessc` (`packages/compiler`, TypeScript) validates the workflow against the pinned Graph IR rules, resolves capability and model-profile bindings, and emits an immutable, content-addressed `HarnessPlan`. The runtime lowers that plan into LangGraph.js without giving LangGraph authority over permissions or credentials.

The same images run locally under Docker Compose and on any Kubernetes cluster or container
platform, on any cloud or on-premises; the difference is configuration, and the services refuse
to boot when a mechanism and its configuration disagree. Nothing in the repository depends on a
specific cloud: identity is OpenID Connect, service identity is a projected workload token,
signing keys are mounted files, secrets are files or environment variables, and telemetry is OTLP.
The [UI gap closure](docs/implementation/ui-gap-closure.md) records source-backed overview,
ownership, screening, lineage and recorder views, an authority-checked trace reader and
version-bound document extraction reruns. The optional Compose `web` profile serves the HTTP
UI and BFF together. Health reporting and runtime admission controls retain their upstream
service authority; the unowned generated-presentation API proposal has been retired.

Remaining work is tracked in the [component notes](docs/implementation/README.md),
[production delivery plan](docs/implementation/production-delivery-plan.md) and
[UI contract boundaries](apps/web/CONTRACT-GAPS.md). Provider transports, document extraction,
scoped retrieval, scheduled context refresh and evidence-governance mechanisms exist;
provider coverage, production qualification, broader business scheduling, complete replay
qualification and operational sign-off remain incomplete. Unreported metrics, missing evidence
and unconfigured readers stay explicit.

## Repository layout

| Path | What it holds |
| --- | --- |
| `apps/control-api`, `case-api`, `capability-gateway`, `runtime-host`, `runtime-worker`, `integration-worker` | The platform services (TypeScript, one bundled image each) |
| `apps/web`, `apps/experience-bff` | The web UI (Vite + React SPA) and its backend-for-frontend (fastify) |
| `apps/fincrime-host`, `evidence-pipeline`, `kyc-wiring` | Python services: the financial-crime skill library, the document evidence pipeline, KYC provider wiring |
| `apps/skill-host-reference` | Synthetic `skill.execution.v1` host for the conformance suite |
| `packages/*` | Shared libraries: contracts, compiler, runtime, persistence, case store, policy engine, identity, telemetry, adapters |
| `packages/ui-*`, `packages/fincrime-views` | UI contracts, client, contract mock, design tokens, component kit, shell and the shared FinCrime projections |
| `domains/kyb-screening`, `domains/kyc/policy`, `domains/archive` | Production slice 1, the KYC policy-as-code, and the archived deterministic KYC and KYB packages ([why](domains/archive/README.md)); plans in `artifacts/` |
| `config`, `tools`, `scripts`, `deploy`, `e2e/ui` | Seeds and catalogs, the provider atlas, build/sync/check scripts, the Kubernetes reference manifest, UI end-to-end tests |

## What is implemented

- [Intelligence switchboard](docs/implementation/intelligence-control-plane.md): canonical reasoning tiers, runtimes, ML inference, Document Intelligence, System 1 Decisions and MCP servers/tools with versioned proposals, common adapter contracts and offline readiness checks.
- [Jurisdiction source authorization](docs/implementation/jurisdiction-source-policy.md): independently approved source/access/policy/context artifacts, plan and run pins, gateway acquisition and evidence-use enforcement, signed wiring scope, runtime reuse checks and a Policy Studio Sources surface. Catalog readiness does not grant institutional permission.
- a [catalog experience](docs/implementation/catalog-experience.md) in the web UI (`/catalogs`): one discovery surface for Context, Skills, Agents, External capabilities, Policies and Documents, with shared search, filters, sorting, board/table views and URL-held state. Documents and External capabilities browse by classified groups (38 document families, 20 capability domains), and provider bindings can be edited per tenant ([provider switchboard](docs/implementation/external-provider-switchboard.md))
- [document intelligence](docs/implementation/document-intelligence.md): case document uploads, the evidence pipeline's full-text records, document wrapper skills over the field catalog, the A03 agent, and a case documents page that shows source spans beside extracted assertions
- a [canonical context ontology and authorized case relationship explorer](docs/implementation/context-ontology.md), with exact-version traversal, scoped pagination and current source-access checks
- a [test context corpus](docs/implementation/test-context-corpus.md) (`packages/context-corpus`; `pnpm corpus:seed`, `pnpm corpus:validate`) and a [context plane](docs/implementation/context-plane.md) that gives agents bounded, recorded context
- one monorepo for the platform and its Python services: the financial-crime skill library and
  document field contracts (`apps/fincrime-host`), the document evidence pipeline and its HTTP
  server (`apps/evidence-pipeline`), the KYC provider wiring service (`apps/kyc-wiring`) and the
  provider atlas it vendors (`tools/kyc-provider-atlas`). `scripts/python-check.sh <service>`
  installs each from its lock and runs its checks; the `sync-*` scripts derive every vendored
  catalog from these directories
- TypeScript source-to-plan compiler (`@ehf/compiler`, command `harnessc`) implementing the Ladder Graph IR rules of `lgir-core` revision `fec01bf...`; plans are byte-for-byte deterministic
- [production slice 1](docs/implementation/production-slice-1.md) (`domains/kyb-screening`): US corporate screening and ownership as a separately qualifiable plan, with every skill node running as an agent profile, two advisory review loops, a candidate slice policy, a corpus evaluation harness with a salted held-out split, and the `agent.qualification.v1` evidence contract. Not yet production-qualified
- archived deterministic KYC (individual CDD, `domains/archive/kyc-v2-deterministic`) and KYB (`domains/archive/kyb-deterministic`) packages, kept as the regression baseline for the [agentic flows](docs/implementation/agentic-kyc-kyb-plan.md), that run financial-crime skill library workflows over canonical records, with OPA policy gates and policy context for KYC. Both are `harness.factory/domain-package-v2`, compiled to `harness.factory/plan-v2`. The v1 plan pipeline was removed: `harnessc` refuses a `domain-package-v1` with `package.v1_removed`, and admission refuses a v1 plan with `plan.v1_removed`.
- compiler primitives beyond a linear graph: subgraphs and fan-out, whose bodies execute
  locally unless `SUBGRAPH_EXECUTOR_URL` or `FANOUT_EXECUTOR_URL` binds an authenticated
  remote executor, which a package containing fan-out nodes requires before admission
- provider-neutral runtime invocation contract with a lease-owning dispatcher and a separately authenticated HTTP runtime host
- local HTTP, hosted HTTP (the runtime host deployed as its own HTTPS service) and Databricks runtime adapters; the provider binding is configuration-derived and recorded by digest
- LangGraph.js plan adapter in the isolated host with Postgres checkpoints (`thread_id = runId`; the run ledger binds that globally unique run to its immutable plan digest)
- Postgres run ledger, node attempts, events, leases, and fencing epochs
- capability gateway requiring both a workload credential and a short-lived execution envelope, with plan/permission verification, transactionally reserved budgets, and idempotent receipts
- an execution-envelope broker in the control plane: the dispatcher issues a run-scoped grant, the runtime exchanges it per node, and the broker re-reads the lease and fence before signing. The runtime holds no signing key.
- identity and authorization across every service: a principal resolver (local headers for development, any OpenID Connect issuer for people and projected workload-identity tokens for services in production; each service has exactly one identity), an explicit role-to-action table, per-tenant scoping, separation of duties between author and approver, and bounded authorization decision records
- administered platform configuration in the `harness_admin` schema: revisioned model profiles, provider bindings, operational settings, and an append-only change log, edited by a `Platform.Admin` from the web UI's Administration surface
- OpenRouter model-profile tiers plus deterministic recorded mode when no API key is configured
- an authenticated OpenSanctions matching adapter for sanctions and PEP; KYC vendor HTTP
  transports, document evidence/field extraction, PostgreSQL vector search and scoped lexical
  document search. Coverage and qualification vary by binding; offline simulators remain
  available and do not establish a live provider connection
- control API for plan admission, run commands, run queries, and event queries
- a web UI (`apps/web`) built to the [UI build spec](apps/fincrime-host/docs/ui/README.md) on a generated Experience API contract (`packages/ui-contracts`): the platform surfaces PLT-01 to PLT-15 (overview, drafts and the draft workspace, Policy Studio, plans, runs, traces, cases, human work, releases, health, administration, integrations and Intelligence) and the FinCrime experiences (Workspace, Agent Studio, Contextboard, Assurance). It runs against a contract-generated mock by default, or against its BFF (`apps/experience-bff`) in http mode
- author plane for importing or creating domain sources, graph and node inspection, YAML editing, validation, evaluation, approval, publication, capability registration, and auditable lifecycle transitions. Plan emission is delegated to the plan compiler (`@ehf/compiler`), which is the only thing that emits a plan: the author plane resolves and validates the authoring surface and then compiles the sources in-process.
- Docker Compose stack: Postgres, the migration job, control API, capability gateway, case API, runtime host, runtime dispatcher, integration worker and Jaeger, plus the KYC connector services (profile `kyc-adapters`, on by default in `make up`) and the opt-in `web`, `skills` and `fincrime` profiles
- one application image (`Dockerfile.platform`) for every service and job, in production and in the Compose stack: `SERVICE_NAME` selects the entrypoint, each a single compiled `server.mjs` with no development dependencies (the control API's bundle includes the plan compiler). The image carries the OPA binary with the policy rego from a separate stage and runs as a non-root user. `scripts/publish-images.sh` publishes it, and the Python service images, multi-arch with provenance and an SBOM
- end-to-end OpenTelemetry traces exported over OTLP to the local Jaeger UI
- canonical KYC case store with configurable PostgreSQL schemas for current state, append-only ledger, and evidence
- strict policy-as-code compilation from reviewed YAML to digest-bound OPA/Rego v1 bundles, with candidate/production release gates and a KYC golden-decision corpus
- manifest-pinned OPA execution of the emitted Rego/data bundle on the production case-gate path; the TypeScript evaluator remains an independent corpus oracle
- release governance and human-work operations, including lifecycle transitions, per-artifact registry revocation, reviewer claims, escalation visibility, dual control, and independent conflict resolution
- purpose-bound, strongly consistent case snapshots for opted-in runtime nodes; raw evidence bytes and unrelated upstream values do not enter agent context
- transactional BusinessCommands with sequence preconditions, semantic idempotency, hash-chained events, lineage, and outbox records
- content-addressed local evidence artifacts behind a replaceable storage boundary
- an artifact registry (`harness_control.artifact_registry`) as the single trust anchor for policy bundles, release manifests and skill-host bundles: no artifact is signed and no signing key exists; an artifact is executable only while its recomputed digest has an approved, unrevoked entry approved by someone other than its registrant ([design](docs/implementation/artifact-registry.md))

The OpenRouter credential is present only in the capability-gateway container. Plans and workers carry a model profile ID, never an API key. Without a credential the gateway answers with the deterministic recorded adapter under the development security profile and fails closed under production, so a deployment cannot report model calls it did not make.

### Trust boundaries

| Component | Holds | Does not hold |
| --- | --- | --- |
| `runtime-dispatcher` | lease, fence, runtime-grant signing key | envelope signing key, provider credentials |
| `control-api` | envelope signing key, run journal, plan admission | provider credentials |
| `runtime-host` | a per-invocation grant it cannot mint | signing keys, run journal credentials, provider credentials |
| `capability-gateway` | provider credentials, envelope verifier | plan authorship, case authority |
| `case-api` | case, ledger and evidence stores, envelope verifier | signing keys, provider credentials |

A runtime asks the control plane for authority per node and journals through it, so it needs no database credential of its own. Its remaining database handle is the LangGraph checkpoint store; `RUNTIME_CHECKPOINT_BACKEND=memory` removes that too, at the cost of resumability.

## Run it

Requirements: Docker, Node 24+, pnpm 11+, `curl`, and `jq`.

```bash
make check
make up
```

Without `OPENROUTER_API_KEY`, model calls use the deterministic recorded adapter, so the stack runs and tests offline. To exercise OpenRouter:

```bash
cp .env.local.example .env.local # only needed if .env.local is absent
# Edit .env.local and set OPENROUTER_API_KEY, then:
docker compose up -d --force-recreate capability-gateway
```

`.env.local` is git-ignored, excluded from Docker build contexts, and injected only into the capability-gateway container. Confirm configuration without revealing the key with `curl http://localhost:4101/v1/status`.

The same file holds the local OpenSanctions credential. Set `OPENSANCTIONS_API_KEY`
and optionally override `OPENSANCTIONS_API_URL`, `OPENSANCTIONS_DATASET`, or
`OPENSANCTIONS_MATCH_THRESHOLD`, then recreate `capability-gateway`. A sanctions
capability selects the live adapter with
`adapterBindingId: opensanctions:screening.sanctions.search`, or use
`adapterBindingId: opensanctions:pep` for the `role.pep` topic. The adapter uses the
matching API (`POST /match/<dataset>`) with binding-specific topic filters and normalizes
provider results before returning them to the runtime; the credential never enters a
plan, invocation, receipt, or browser response.

An authorized operator can verify the configured PEP path through the gateway boundary
with `POST /v1/opensanctions/test` and a body such as
`{"screeningType":"PEP","name":"Example Official"}`. The probe uses the same adapter
and `role.pep` topic filter as a runtime invocation, but returns only provider readiness
and aggregate match counts so screened subject details remain server-side.

The authoring catalog also seeds draft, provider-neutral placeholders for identity-document
verification, OCR extraction, adverse-media search, internal customer search, vector/document
search, and an allowlisted HTTP API operation. Their schemas and operational metadata can be
edited through the gateway's capability registry. `unconfigured:` bindings must remain in `draft`; only an
active contract bound to a workflow node is embedded into a compiled plan.

Domain runs use compiled v2 plans (`make compile` writes `artifacts/archive/kyc-v2.plan.json` and
`artifacts/archive/kyb.plan.json`); a v2 run needs its plan admitted and an active release for the
environment.

The compose stack carries no UI service: run the web app and BFF from source (see [The web UI](#the-web-ui)). Inspect the control API at `http://localhost:4100`, the gateway at `http://localhost:4101`, the case service at `http://localhost:4102`, and distributed traces in Jaeger at `http://localhost:16686`. Each run response contains its durable `traceId` and `rootSpanId`. Stop the stack with `make down`; add `-v` manually if you intentionally want to delete the local database volume.

Authoring (`/v1/authoring/**` on the control API) treats editable source and executable plans as different assets. A draft may be edited and validated repeatedly; compilation creates a content-addressed plan snapshot; evaluation, approval, and publication are explicit audited transitions. Published plans are admitted to the existing runtime control plane. Agent contracts are created directly or imported (manifests, prompts and `SKILL.md` files from GitHub, or the financial-crime catalog), and a registered agent can replace an eligible workflow node or be inserted after one; the change round-trips into canonical package/workflow YAML. Node `config.caseWrites` entries let authors declare canonical BusinessCommand types plus JSON Schema payload contracts, which remain JSONB-compatible without allowing direct database writes. The gateway manages a capability catalog; a capability is still usable by a run only after compilation places it in that plan's permission envelope. In the web UI these are the Drafts, Draft workspace and Policy Studio surfaces.

Administration (`/v1/admin/**` on the control API, the Administration surface in the web UI) holds the values that used to be baked into the images. A model profile is immutable and versioned, because `harnessc` digests it into every plan compiled against it: saving one mints a new revision and keeps the old, and an invocation resolves the revision whose digest its plan recorded rather than whatever is current. A provider binding — endpoint, credential reference, attribution, status — is not part of any plan digest, so repointing it takes effect on the next invocation without recompiling. Platform settings cover the agent runtime a run is dispatched to, observability, the case store's artifact boundary and connection pooling; each field carries the service that reads it and whether saving it is in force now or at that service's next restart. Every write is recorded in an append-only change log with actor, before/after digests and reason.

The admin store never holds a provider credential. A binding names the environment variable that holds one, and the capability gateway is still the only component that resolves that name to a value. `config/model-profiles.json` remains in the repository as the seed the migration loads and as the offline fallback; it is no longer the authority. The design, the full inventory of what moved and what deliberately did not, and the open items are in `docs/implementation/administered-configuration.md`.

The case store keeps the `case_core`, `case_ledger`, and `evidence` schemas in their own database (`CASE_DATABASE_URL`, `ehf_case` in the compose stack), separate from the control database (`DATABASE_URL`, `ehf_control`); case-api reaches the control database only to check an execution's lease (`EXECUTION_DATABASE_URL`). Every service connects as its own role; see [data-stores-plan.md](docs/implementation/data-stores-plan.md) §4.4. Without a separate `CASE_DATABASE_URL` the case store falls back to `DATABASE_URL`, which still works for development. `CASE_CORE_SCHEMA`, `CASE_LEDGER_SCHEMA`, and `EVIDENCE_SCHEMA` rename the schemas. Schema identifiers are validated before migration or query construction. Local evidence bytes use the `postgres` artifact adapter; the canonical object stores a digest-addressed opaque artifact reference so a later Blob adapter does not change case or command contracts.

The trace hierarchy follows the implementation standard: `harness.run` → `runtime.invoke` → `workflow.transition` → `capability.request` → `capability.invoke` → `authorization.evaluate` plus `model.inference` or `tool.execution`. W3C `traceparent` is propagated only between trusted runtime services. Spans contain approved operational identifiers, digest prefixes, bounded outcomes, timing, tokens, and cost—never case payloads, prompts, model responses, credentials, or execution-envelope claims. Durable run events and gateway receipts remain authoritative when telemetry is sampled or unavailable.

Verify an exported trace and its cross-service topology with `make trace RUN_ID=RUN-...`. The control API also exposes `GET /v1/runs/:runId/trace`, including a local Jaeger deep link. `make logs` tails every service.

`make check` compiles both domains, runs the scanner policy tests, and runs the workspace typecheck, tests and build.

### The web UI

The UI is a Vite + React single-page app (`apps/web`) that reaches the platform only through
the Experience API, a contract generated from the pack in
[`apps/fincrime-host/docs/ui/contracts`](apps/fincrime-host/docs/ui/contracts/README.md).
`pnpm ui:sync` regenerates `packages/ui-contracts` from that pack and `pnpm ui:contracts`
validates it against the EHF sources it was generated from; both run in CI. The spec, surface
acceptance criteria and milestones are in [BUILD-SPEC.md](apps/fincrime-host/docs/ui/BUILD-SPEC.md);
known contract gaps and their workarounds are in [CONTRACT-GAPS.md](apps/web/CONTRACT-GAPS.md).

```bash
pnpm install
pnpm dev:web        # http://localhost:5173 on the contract mock
```

Mock mode serves every operation from `packages/ui-mock`, with a toolbar to switch persona,
scenario, clock and injected faults. Other entry points:

| Command | What it does |
| --- | --- |
| `pnpm ui:test` | Unit tests for the UI packages, the web app and the BFF |
| `pnpm ui:test:e2e` | Playwright journeys, shell acceptance tests and axe checks against the mock |
| `pnpm storybook` | The `@ehf/ui-kit` component catalog on port 6010 |
| `pnpm ui:build` | Sync contracts, build the SPA in http mode (bundle checked by `scripts/check-bundle.mjs`) and the BFF |
| `pnpm --filter @ehf/web dev:http`, `pnpm dev:bff` | The SPA in http mode, proxying `/api` and `/auth` to the BFF on port 4200 (`BFF_URL` overrides) |

The BFF (`apps/experience-bff`) holds server-side sessions (`ehf_session` cookie) with CSRF and
origin checks, resolves the principal (explicit local sign-in in development, verified OIDC
sign-in or authenticated ingress in production) and calls the control and case APIs on the user's behalf. It serves
the catalogs, the external-provider and intelligence switchboards, and live plan, run, case and
document routes; `pnpm dev:bff` starts the BFF using the configured environment.
It also composes ownership, screening, assurance, recorder and operational views from upstream
records. Trace reads first check tenant ownership and then use the configured Jaeger query
service; document reruns require an admitted document-only plan and a case-ledger authorization
for the selected source version. It adds no decision authority: upstream services enforce every
read and mutation. See [UI gap closure](docs/implementation/ui-gap-closure.md) for configuration
and remaining source limitations.

To run the built UI against the local services:

```sh
docker compose --profile web up --build web
# Open http://localhost:4200
```

The local login defaults to `local.reader` with `Harness.Reader`. Set `BFF_LOCAL_SUBJECT`
and `BFF_LOCAL_ROLES` explicitly for a different development persona. These local sign-in
settings are disabled under the production security profile.

### Compiling a package

The plan compiler lives in `packages/compiler` (`@ehf/compiler`). Run its CLI from the
repository root with the workspace's `tsx`; `make compile` and `make fixtures` do this for
the committed packages:

```bash
node --import tsx packages/compiler/src/cli.ts compile domains/archive/kyc-v2-deterministic --out artifacts/archive/kyc-v2.plan.json
node --import tsx packages/compiler/src/cli.ts validate domains/archive/kyb-deterministic   # package rules + LGIR analysis
```

`compile` prints the plan digest; `--model-profiles <file>` overrides
`config/model-profiles.json`. In code, `compilePackage(dirOrFiles, { modelProfiles })` returns
the plan document and digest, and `validatePackage(dirOrFiles)` the LGIR analysis; every
refusal is a `CompilerError` whose message is the diagnostic (`package.policy_duplicate:<id>`).

## Production performance

The dispatcher supports bounded per-process concurrency, PostgreSQL queue notifications
with polling recovery, queue backpressure, Prometheus metrics, and KEDA-compatible
autoscaling. List APIs use stable keyset cursors, and service containers run compiled
bundles as a non-root user without development dependencies. Connection budgeting,
PgBouncer topology, load/soak gates, autoscaling, and digest/SBOM publishing are covered
in [the production performance guide](deploy/performance.md), and a KEDA
`ScaledObject` for the dispatcher is in [`deploy/kubernetes/`](deploy/kubernetes).

## Deployment settings

For the launchable Azure bootstrap and first-run setup console, see [Launching IntegralFlow](deploy/README.md). You can [install from GitHub Actions](deploy/github-actions.md) using a browser, without local Node, pnpm or Azure CLI. To build locally, use `pnpm onboarding:build`, then `pnpm onboarding:dev`. The unified application artifact is `Dockerfile.platform`; its bootstrap entrypoint serves the seven-step onboarding flow and persists a provider-neutral deployment profile. Review generates a resource and service-identity plan; model inference qualification is separate from discovery. The same image also checks database compatibility and applies migrations with `SERVICE_NAME=migrate`. The Azure adapter also applies reviewed runtime deployments through a scoped operator executor: migrations, distinct service logins, curated model configuration, seven service entrypoints and authenticated connectivity verification. Connector and schedule definitions remain disabled until bound to published process-flow contracts.

For Azure installation, [choose the Azure account, subscription and resource group](deploy/README.md#choose-the-azure-account-subscription-and-resource-group) before launching the browser wizard. Bootstrap uses the account signed in through `az login`, the selected `--subscription`, and `--resource-group`. Step 1 displays this fixed hosting target. The [application administrator](deploy/README.md#choose-the-application-administrator) is configured separately through the claim token and OIDC setup.

The same images run on a laptop, on any Kubernetes cluster or container platform, on Databricks
or elsewhere; no cloud is a mode of the platform and none is required. Two kinds of setting say
how a deployment behaves. `SECURITY_PROFILE` is the posture, and one explicit setting per concern
says which mechanism implements it. Every production mechanism is an open standard. Every setting
refuses an unknown value (including the removed cloud-specific ones), and services check them at
startup, failing to boot rather than serving traffic half-configured. `PLATFORM_MODE` is gone: a
service that still finds it set stops at startup and names the settings that replace it.

`SECURITY_PROFILE=production` refuses the development conveniences: disabled TLS verification
(`NODE_TLS_REJECT_UNAUTHORIZED=0`), a password-bearing or local-host database URL, shared HMAC
envelope secrets (`ENVELOPE_SIGNER`/`ENVELOPE_VERIFIER=hmac`, `*_ENVELOPE_SECRET`,
`RUNTIME_GRANT_SECRET`), static service tokens (`WORKLOAD_AUTH=static_token`, `*_SERVICE_TOKEN`),
header-trusting identity (`IDENTITY_PROVIDER=local_headers`), local default-tenant and default-role
settings (`LOCAL_DEFAULT_TENANT_ID`, `LOCAL_DEFAULT_ROLES`), the self-hosted runtime's local
endpoint (`RUNTIME_LOCAL_ENDPOINT`; production names `RUNTIME_HOSTED_ENDPOINT`), a static API key
as the only credential for HTTP operations, plain-http or loopback service endpoints, the reference
skill host, a runtime checkpoint database URL, an OTLP exporter without an explicit endpoint, and
the recorded model fallback (never honoured: `platform_default` denies,
`MODEL_RECORDED_FALLBACK=allow` stops the gateway at startup, and an administrator cannot store
`allow`). Refusals read `platform.production_forbids:<NAME>` or `platform.production_requires:<NAME>`.

| Setting | Values | Default | Production |
| --- | --- | --- | --- |
| `SECURITY_PROFILE` | `development`, `production` | `development` | `production` |
| `IDENTITY_PROVIDER` | `local_headers`, `oidc` | `local_headers`; production must set it and refuses `local_headers` | `oidc` against any OpenID Connect issuer |
| `WORKLOAD_AUTH` | `static_token`, `workload_identity` | `static_token`; production must set it and refuses `static_token` | `workload_identity`: one projected token per service (Kubernetes service account, SPIFFE JWT-SVID or any OIDC client-credentials issuer) |
| `ENVELOPE_SIGNER` | `hmac`, `private_key` | `hmac`; production must set it and refuses `hmac` | `private_key`: an RSA key mounted as a file per signer |
| `ENVELOPE_VERIFIER` | `hmac`, `public_key` | `hmac`; production must set it and refuses `hmac`; must agree with the signer | `public_key` |
| `DATABASE_AUTH` | `url` | `url` (production refuses password-bearing or local-host URLs) | `url` with `PGPASSFILE` or a TLS client certificate |
| `TELEMETRY_EXPORTER` | `otlp` | `otlp` (production requires an explicit endpoint) | `otlp` to any collector; vendor routing belongs in the collector |
| `RUNTIME_PROVIDER` | `local_http`, `hosted_http`, `databricks`, `<adapter>:<binding>` | `local_http` | `hosted_http` or `databricks` (production agent profiles require a hosted runtime) |
| `SKILL_HOST_AUTH` | `platform_token`, `databricks_app` | `platform_token` (the gateway's own service credential) | `platform_token` or `databricks_app` |
| `DATABRICKS_AUTH` | `oauth_m2m` | `oauth_m2m` | `oauth_m2m` |
| `RUNTIME_CHECKPOINT_BACKEND` | `postgres`, `memory` | `postgres` | `memory` for a runtime outside the platform's trust boundary |
| `MODEL_RECORDED_FALLBACK` | `allow`, `deny`, `platform_default` | `platform_default`: allow in development; production never allows it and refuses `allow` | `deny` |
| `CONNECTOR_COVERAGE_PATH` | file path | `config/connector-coverage.sandbox.json` locally | unset; the operator attests coverage per tenant (`gateway.connectorCoverage`), otherwise skill policies fail closed |

Mechanism settings are read at start and are not administered at run time. A selected mechanism
brings its own configuration: `oidc` needs `OIDC_ISSUER`, `OIDC_AUDIENCE` and `PLATFORM_TENANT_ID`
(JWKS is discovered from the issuer unless `OIDC_JWKS_URI` or `OIDC_JWKS_FILE` is set; roles come
from `OIDC_ROLES_CLAIM`, default `roles`); `workload_identity` needs `WORKLOAD_TOKEN_FILE` (the
service's projected token), `WORKLOAD_IDENTITY_ISSUER`, `WORKLOAD_IDENTITY_AUDIENCE` and
`WORKLOAD_IDENTITIES` (logical service name to token subject); `private_key` needs each signer's
`*_PRIVATE_KEY_FILE` and `*_KEY_ID`; `public_key` the `*_PUBLIC_KEY_PEM` values. Integration
secrets are `env:NAME` or `file:/path` references, so any secret manager that can mount a file
works; outbound integration deliveries authenticate with HMAC or OAuth 2.0 client credentials.

### Service identity

Each service has exactly one identity and presents it to every service it calls; the callee maps
it to a logical name and grants roles from its own code, never from the credential.

| Service | Logical identity | Calls | Accepted by |
| --- | --- | --- | --- |
| experience BFF | `control-surface-edge` | control API, case API, gateway (on a person's behalf) | all three, role `Edge.Delegate` |
| runtime host | `harness-runtime` | control API, gateway, case API | all three |
| runtime dispatcher | `runtime-dispatcher` | runtime host | runtime host |
| capability gateway | `capability-gateway` | skill hosts, HTTP operations | skill hosts |
| case API | `case-api` | control API (outbox, policy authority) | control API, roles `Case.Outbox.Publish`, `Policy.Authority.Read` |
| control API | `control-api` | case API (human-work actions on a person's behalf) | case API, role `Edge.Delegate` |
| integration worker | `integration-worker` | control API, case API | both, role `Integration.Dispatch` |
| skill host | `skill-host` | gateway (with a delegated envelope only) | gateway, role `Skill.Host` |

Signing is separate from identity: the dispatcher signs runtime grants, the control API signs
node envelopes, the integration worker signs integration envelopes, and the gateway signs the
delegated skill envelopes that only it verifies.

### Deployed services and their access

Every service and job runs from the one application image (`Dockerfile.platform`). `SERVICE_NAME`
selects the entrypoint. The runtime topology is defined once, in `RUNTIME_SERVICES`
(`packages/contracts/src/deployment-plan.ts`); the deployment plan, the Azure recipe and the
launch wrapper all read it.

| `SERVICE_NAME` | Workload identity | Port | Databases | Azure app | Exposure |
| --- | --- | --- | --- | --- | --- |
| `experience-bff` | `control-surface-edge` | 4200 | none | `…-web` | public (the only one) |
| `control-api` | `control-api` | 4100 | control, context | `…-control` | internal |
| `case-api` | `case-api` | 4102 | case, control | `…-case` | internal |
| `capability-gateway` | `capability-gateway` | 4101 | control, context | `…-gateway` | internal |
| `runtime-host` | `harness-runtime` | 8088 | none | `…-runtime` | internal |
| `runtime-worker` (dispatcher) | `runtime-dispatcher` | 9090 | control | `…-dispatch` | internal |
| `integration-worker` | `integration-worker` | 9091 | control | `…-integration` | internal |

Each service listens on its own port variable, or `PORT` if that is unset, and its health
probes target the port above. Sizes and replica ranges are in [Scaling](#scaling). If an
external runtime endpoint is configured, `runtime-host` is not deployed and its
`harness-runtime` identity binds to that endpoint.

**Workload identity.** Each service gets its own OAuth client-credentials client. Client IDs,
subjects and secrets must all be distinct. The image's launch wrapper (`runtime-launch`) fetches
and verifies the asymmetric JWT, refreshes it every 30 seconds and passes the service only the
token file (`WORKLOAD_TOKEN_FILE`), never the client secret. `WORKLOAD_IDENTITIES` tells every
service the expected subject of each logical identity. A platform that projects tokens itself
can skip the wrapper.

**Signing keys.** `control-api` signs execution envelopes, `runtime-worker` signs runtime grants,
`integration-worker` signs integration envelopes, and `capability-gateway` signs delegated skill
envelopes. All services receive the public keys. `runtime-host`, `case-api` and `experience-bff`
sign nothing.

**Database logins.** A deployment creates one login for each service that uses a database,
granted only these groups:

| Service | Control database | Case database | Context database |
| --- | --- | --- | --- |
| `control-api` | `ehf_svc_control_api` | – | `ehf_svc_context_writer` |
| `case-api` | `ehf_svc_case_execution` (lease checks only) | `ehf_svc_case_api`, `ehf_svc_case_outbox_relay` | – |
| `capability-gateway` | `ehf_svc_capability_gateway` | – | `ehf_svc_context_retrieval` (read) |
| `runtime-worker` | `ehf_svc_runtime_dispatcher` | – | – |
| `integration-worker` | `ehf_svc_integration_worker` | – | – |

The autoscaler gets one more login, in `ehf_svc_queue_metrics`. It may call two queue-depth
functions and read no table (see [Scaling](#scaling)).

`experience-bff` and `runtime-host` have no database credentials in production. The runtime host
uses in-memory checkpoints there.

**Outside credentials.** The model-provider key and the document-intelligence token go only to
`capability-gateway`. The evidence object-store key goes only to `case-api`. The human OIDC
client secret goes only to `experience-bff`.

**Jobs and other entrypoints**, run from the same image:

| `SERVICE_NAME` | Purpose | Runs as |
| --- | --- | --- |
| `migrate` | Production schema migrations, service logins, curated model profiles | The migration operator's database login, used only by this job; no workload token |
| `runtime-verify` | Connectivity checks after a deployment | The dispatcher's workload client |
| `launcher` | Onboarding console | Bootstrap claim token, then a verified OIDC administrator |
| `onboarding-recover` | Owner recovery | An operator with access to the console's state volume (not exposed over HTTP) |
| `dev-migrate` | Local stack only: create databases, migrate, create dev logins | Postgres superuser; refuses the production profile |
| `ledger-export` | Signed ledger segments | Group `ehf_svc_ledger_exporter` |
| `evidence-governance` | Evidence retention and legal holds | Group `ehf_svc_evidence_retention` |
| `context-release` | Release closed cases' working context | Groups `ehf_svc_context_release`, `ehf_svc_case_data_release`; its own token to `case-api` |
| `skill-host-reference` | Reference `skill.execution.v1` host | Development only; accepts the gateway's token |

The Compose stack keeps the same split: one `ehf_dev_*` password login per service and a static
token for each caller. Its runtime services are named `runtime-host-local` and
`runtime-dispatcher`.

### Scaling

The application tier holds no state, so every service except the setup console scales
horizontally. Durable state, the run queue and coordination live in PostgreSQL, which is
the first limit a growing deployment reaches; model-provider throughput is the second. All
defaults below come from `RUNTIME_SERVICES` and can be overridden per deployment. Set the
real values from the load and soak gates (`pnpm perf`, `PERF_MODE=soak pnpm perf`), not
from these defaults.

| Service | CPU / memory | Scales on | Replicas (minimal / resilient), max |
| --- | --- | --- | --- |
| `experience-bff` | 0.25 / 0.5 GiB | 50 concurrent requests per replica | 1 / 2, max 3 |
| `control-api` | 0.5 / 1 GiB | 30 concurrent requests per replica | 1 / 2, max 4 |
| `case-api` | 0.5 / 1 GiB | 20 concurrent requests per replica | 1 / 2, max 4 |
| `capability-gateway` | 0.5 / 1 GiB | 30 concurrent requests per replica | 1 / 2, max 4 |
| `runtime-host` | 0.5 / 1 GiB | 10 concurrent requests per replica (each is a node with model calls) | 1 / 2, max 6 |
| `runtime-worker` | 0.25 / 0.5 GiB | 4 claimable runs per replica | 1 / 1, max 6 |
| `integration-worker` | 0.25 / 0.5 GiB | 10 claimable deliveries or receipts per replica | 1 / 1, max 3 |

**HTTP services** scale on concurrent requests. The resilient posture keeps two warm
replicas of each.

**Workers** scale on queue depth. Their claims use `FOR UPDATE SKIP LOCKED` and fencing
epochs, so any number of replicas can run safely. They always keep one warm replica, which
also holds the dispatcher's `LISTEN` connection.

**How the autoscaler reads queue depth.** Migration `044_queue_metrics.sql` adds
`harness_runtime.ready_run_count()` and `integration.ready_work_count()`. Both count work
exactly the way the workers claim it, including expired leases. The Azure recipe creates a
login in `ehf_svc_queue_metrics` for the platform scaler; it can call those two functions
and read no table. Its connection string is a Container Apps secret referenced only by the
scale rule, never an environment variable in a container. The Kubernetes example
(`deploy/kubernetes/runtime-worker-scaledobject.yaml`) uses the same function. The scaler
can't load a private CA, so if `databaseCaPem` is set the workers stay at one replica and
the deployment says so.

**Database connections.** Each replica opens up to `DB_POOL_MAX` connections (default 5)
to each database it uses. The executor prints the peak per database at maximum replicas
before it deploys; keep that within the server's usable connections (`deploy/performance.md`
has the formula). For more headroom, put a transaction-mode pooler in front:

- Services then connect through the pooler.
- Migrations and the dispatcher's `LISTEN` keep a direct connection
  (`DATABASE_LISTEN_URL`), because `LISTEN` needs session state a transaction pooler
  doesn't keep.
- Tenant scoping uses transaction-local settings, so it's safe behind the pooler.

**Policy gates.** case-api evaluates policy gates on long-running OPA servers: one per
bundle digest, listening on a Unix socket in a private directory, up to
`POLICY_OPA_SERVERS` (default 4). Evaluation is about 13× faster than starting `opa eval`
per gate (2.5 ms against 34 ms on a development machine). The bundle digest is still
recomputed and checked on every evaluation, and receipts are identical to the per-process
path. `POLICY_OPA_SERVERS=0` restores one process per gate.

**Model throughput.** Every curated model profile a deployment publishes uses one set of
limits: `maxConcurrency` 2, `timeoutMs` 60000 and `maxOutputTokens` 2048 by default. Raise
`maxConcurrency` (up to 64) to your provider contract's rate limit; more workers won't help
past it. Changing the limits mints new model-profile revisions; runs already pinned to the
old revision keep it.

**Overrides** go in the private runtime input file
([example](deploy/runtime-inputs.example.json)):

```json
{
  "database": { "pooler": { "port": 6432 }, "servicePoolMax": 5 },
  "scaling": { "runtime-worker": { "maxReplicas": 10 } },
  "modelLimits": { "maxConcurrency": 16 }
}
```

- `pooler.host` defaults to the Foundation database host. Azure Flexible Server's built-in
  PgBouncer listens on 6432 once enabled.
- `scaling` accepts any runtime service.

**Not done yet:**

- time-partitioning and retention for run events, the case ledger, gateway receipts and
  the outbox;
- a shared session store for the web app (sessions are in memory with sticky routing);
- a batch admission path for bulk tenants (admission and the monthly budget reservation
  are serialized per tenant);
- moving the context store to its own server.

## Stable boundaries

The transferable seams are the `HarnessPlan` contract, compiler output, runtime adapter interface, execution envelope, capability request/result receipts, event vocabulary, and Postgres persistence model. A deployment can replace PostgreSQL queue signaling, the signer, and the deployment substrate without changing domain packages or bypassing the gateway.

The default local binding is `RUNTIME_PROVIDER=local_http`, with the dispatcher calling `runtime-host-local` over the internal Compose network. In production the same runtime-host image runs as its own HTTPS service (`RUNTIME_PROVIDER=hosted_http` with `RUNTIME_HOSTED_ENDPOINT`, or a named `hosted_http:<binding>`), and the dispatcher presents its workload identity to it. The runtime journals through a private control-plane surface that re-checks the grant, lease, and fence before recording anything; each node transition carries its journal event in the same write, and a node that reads the case receives its case-read envelope in the response to the write that starts it. Its only optional database handle is the LangGraph checkpoint store, selected by `RUNTIME_CHECKPOINT_BACKEND`; `memory` removes it entirely and makes the invocation non-resumable.

Work is signalled through PostgreSQL (`NOTIFY` with a bounded poll as the fallback), so no service calls another to wake it; a queue-depth autoscaler such as KEDA's PostgreSQL scaler ([`deploy/kubernetes/`](deploy/kubernetes)) scales the dispatcher.

The initial cloud bootstrap lives in [`deploy/azure/`](deploy/azure), alongside the portable Kubernetes reference manifest and performance notes under [`deploy/`](deploy). The initial Azure adapter deploys runtime targets through the in-app reviewed apply flow; additional cloud adapters remain extension points. External services (model providers, Databricks, vendor APIs, internal APIs) are reached through runtime and capability adapters and the per-concern settings above, so a deployment chooses them by configuration. Azure resource creation belongs to its bootstrap recipe and does not introduce an Azure mode into the application.

## Documentation

| Document | What it covers |
| --- | --- |
| [Implementation notes](docs/implementation/README.md) | How each component and contract is built today, one note per component |
| [Financial-crime integration](docs/fincrime-integration.md) | The skill library, profiles/TaskSpecs and the Python bridge |
| [UI spec and contracts](apps/fincrime-host/docs/ui/README.md) | Build spec, alignment, Experience API contract pack, style guide and mockups for the web UI |
| [UI contract gaps](apps/web/CONTRACT-GAPS.md) | Where the UI needs something the contracts do not yet provide, and the workaround |
| [Catalog experience](docs/implementation/catalog-experience.md) | The `/catalogs` discovery surface, routes, grouping and inspectors |
| [Jurisdiction source authorization](docs/implementation/jurisdiction-source-policy.md) | Source, access and policy artifacts and their enforcement |
| [Production delivery plan](docs/implementation/production-delivery-plan.md) | Locked decisions and the remaining roadmap |
| [Databricks deployment](docs/deploy/databricks-deployment.md) | A Databricks-native topology for the same contracts |
| [Governed integrations runbook](docs/deploy/governed-integrations-runbook.md) | Creating, verifying and activating integration deployment bindings |
| [Production performance](deploy/performance.md) | Connection budget, scaling and backpressure, performance gates, image supply chain |
