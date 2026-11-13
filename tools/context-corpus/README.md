# context-corpus

Generator for the test context corpus described in
[docs/implementation/test-context-corpus.md](../../docs/implementation/test-context-corpus.md).
Phase 1: scenario spec format, world model, records emitter, schema validator, manifest, and
heroes H01 and H04 (no transactions yet).

```bash
python -m venv .venv && .venv/bin/pip install -e '.[test]'
.venv/bin/context-corpus generate            # writes ../../fixtures/context-corpus
.venv/bin/context-corpus generate --check    # fails if committed output has drifted
.venv/bin/context-corpus validate            # schema + consistency checks only
```

Everything is derived from `scenarios/*.yaml`; output is byte-for-byte deterministic. Loaders
live in `packages/context-corpus` (`pnpm corpus:seed`).

Tests: `pytest` runs the fast suite. `pytest -m slow` also runs the skill library's own 25
transaction skills on H01, H04, H05 and H07 (needs `networkx` and `pydantic`; about 3 minutes).

## Production slice 1 evaluation

`context-corpus evaluate` runs the twelve skills of the KYB screening-and-ownership slice
([production-slice-1.md](../../docs/implementation/production-slice-1.md)) through the skill
library's executor, chained as the slice workflow binds them, under the slice's candidate policy,
and checks each result against reference implementations over the scenario facts. It needs the
library importable (install `apps/fincrime-host`'s locked dependencies into the same environment).

```bash
.venv/bin/context-corpus evaluate --split dev --report /tmp/slice-dev.json
CORPUS_HELDOUT_SALT=<kept outside the repository> \
  .venv/bin/context-corpus evaluate --split heldout --count 40 --report /tmp/slice-heldout.json
```

The held-out split (`heldout.py`) is generated from the salt and never written to the repository;
the command refuses a held-out report path inside it. Each skill's report entry carries an
`evidence` block in the shape of `skill.qualification.v1.evidence`; thresholds are placeholders
until the policy owner sets them. `pytest -m slow tests/test_slice_evaluation.py` runs both splits
and a negative test proving the harness fails when a skill's behavior changes.
