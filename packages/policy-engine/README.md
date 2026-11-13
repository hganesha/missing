# Policy engine

This package strictly parses reviewed policy YAML, compiles it into deterministic OPA/Rego v1 bundle files, blocks production promotion while declared settings remain unresolved, evaluates the same source in the reference engine, and emits digest-bound policy evaluation receipts.

## Two authoring forms, one bundle contract

- **Assertion trees** (`compilePolicySource`) suit a policy written as nested assertions, and
  are what the control-api authoring surface compiles when a user submits policy source.
- **Decision tables** (`compileDecisionTablePolicy`) suit a policy a policy owner reviews as
  rows: conditions that each resolve to one token from a closed set, matched in an authored
  order, against a catalog of rules, reason codes, evidence obligations and cohorts.

Both produce the same `PolicyBundle` manifest and the same `PolicyEvaluation` receipts, and
neither knows anything about a particular domain: where a case keeps its risk rating, where
its provider results live and what evidence an obligation needs all arrive as data.

A decision-table bundle is emitted as a pinned Rego interpreter plus the policy as data,
rather than as one generated Rego rule per row. Per-rule Rego reads better in isolation but
turns every policy change into a diff of generated code that nobody reviews; this way the
interpreter is a small fixed artifact checked by OPA on every build, and a policy change is a
diff of rows. Both halves are pinned by digest in the manifest.

## Diligence levels

A business policy may carry a `diligence` block: ordered levels (SDD < CDD < EDD), party types
mapped from canonical legal forms, a party type × product matrix of base levels, risk overlays that
can only escalate, and the evidence obligations of each level (`src/diligence/schema.ts`). It
compiles to a `diligence-level` gate served by a fixed Rego interpreter (`src/diligence/rego.ts`)
with the block as data; only the overlay conditions are generated. The result's
`outputs.diligence` names the level and every contributor. `src/diligence/evaluate.ts` is the
browser-safe reference evaluation (`@ehf/policy-engine/diligence`), held equal to OPA by
`src/diligence.test.ts`.

Compile the KYC candidate with:

```sh
pnpm --filter @ehf/policy-engine compile:kyc
```

The command writes the interpreter modules, canonical `data.json`, and an unsigned manifest under `artifacts/policy/kyc`. Signing and activation are deliberately separate control-plane duties. Set `OPA_VERSION` to the exact deployed OPA version; the default compatibility target is `1.9.0`.

When `opa` (or `OPA_PATH`) is available, the compiler checks the generated module with that exact version. Candidate builds warn when OPA is absent; production builds fail closed.

Production compilation fails until every declared blocker is resolved — `deploymentReadiness.blockers` for an assertion tree, the owner-input register for a decision-table catalog. An unsigned or merely candidate bundle is never runtime authority.
