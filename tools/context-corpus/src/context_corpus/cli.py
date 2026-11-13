from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import documents
from .crowd import build_crowd
from .gen import generate
from .manifest import drift, render, write
from .spec import load_spec
from .validate import validate_consistency, validate_crowd, validate_fraud, validate_ledger, validate_ownership, validate_real_names, validate_screening, validate_names, validate_schema

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.parents[1]


def build(scenarios: Path):
    specs = [load_spec(p) for p in sorted(scenarios.glob("*.yaml"))]
    return specs, [generate(s) for s in specs]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="context-corpus")
    parser.add_argument("command", choices=["generate", "validate", "collect", "evaluate"])
    parser.add_argument("--scenarios", type=Path, default=ROOT / "scenarios")
    parser.add_argument("--out", type=Path, default=REPO / "fixtures/context-corpus")
    parser.add_argument("--skip-gleif", action="store_true")
    parser.add_argument("--check", action="store_true", help="fail if committed output differs")
    parser.add_argument("--split", choices=["dev", "heldout"], default="dev", help="evaluate: corpus heroes, or the salted held-out split")
    parser.add_argument("--count", type=int, default=24, help="evaluate --split heldout: number of generated parties")
    parser.add_argument("--report", type=Path, help="evaluate: write the JSON report here (default: stdout summary only)")
    parser.add_argument("--no-controls", action="store_true", help="evaluate: skip the control cases")
    args = parser.parse_args(argv)

    if args.command == "evaluate":
        return _evaluate(args)

    if args.command == "collect":
        from .sources import gleif, lists
        pinned = args.scenarios.parent / "sources/pinned"
        pinned.mkdir(parents=True, exist_ok=True)
        print(json.dumps(lists.collect(pinned), indent=1)[:2000])
        if not args.skip_gleif:
            g = gleif.collect(pinned)
            print("gleif chains:", g["sample_chains"], g["depth_histogram"])
        return 0
    specs, dossiers = build(args.scenarios)
    errors: list[str] = validate_names(specs, set()) + validate_real_names(specs)
    for spec, dossier in zip(specs, dossiers):
        errors += [f"{dossier.party_id}: {e}" for e in validate_schema(dossier.records)]
        errors += [f"{dossier.party_id}: {e}" for e in validate_consistency(dossier, spec)]
        errors += [f"{dossier.party_id}: {e}" for e in validate_ledger(dossier, spec)]
        errors += [f"{dossier.party_id}: {e}" for e in validate_fraud(dossier, spec)]
        errors += [f"{dossier.party_id}: {e}" for e in validate_ownership(dossier, spec)]
        errors += [f"{dossier.party_id}: {e}" for e in validate_screening(dossier, spec)]
    crowd = build_crowd(args.scenarios.parent / "crowd/crowd.yaml")
    errors += validate_crowd(crowd)
    if errors:
        print("\n".join(errors[:50]), file=sys.stderr)
        return 1
    if args.command == "validate":
        print(f"ok: {len(dossiers)} parties, {sum(len(d.records) for d in dossiers)} records, "
              f"crowd {crowd['transactions']} tx ({crowd['planted_rate']:.3%} planted)")
        return 0
    pinned = args.scenarios.parent / "sources"
    lists_doc = json.loads((pinned / "pinned/lists.json").read_text(encoding="utf-8"))
    gleif_doc = json.loads((pinned / "pinned/gleif-templates.json").read_text(encoding="utf-8"))
    chain_steps = gleif_doc["parent_to_child_country_steps"]
    h06 = next((s for s in specs if s["id"] == "H06"), None)
    support = {}
    if h06:   # does the GLEIF sample show each parent>child country step of the layered hero?
        ents = {e["ref"]: e for e in h06["entities"]}
        for x in h06["ownership"]:
            if "range" in x or ents[x["owner"]]["kind"] == "individual":
                continue
            step = f"{ents[x['owner']]['registration']['jurisdiction'][:2]}>{ents[x['owned']]['registration']['jurisdiction'][:2]}"
            support[step] = chain_steps.get(step, 0)
    sources = {"sources": [*lists_doc["sources"], {"id": "gleif", "url": "https://api.gleif.org/api/v1", "licence": "CC0 (GLEIF terms to confirm)",
               "status": "collected", "use": "structural templates only", "sample_chains": gleif_doc["sample_chains"],
               "template_support_for_H06_steps": support,
               "note": "Steps with 0 are plausible but not evidenced by this small sample."},
               {"id": "synthetic-lists", "status": "authored", "licence": "generated for this corpus", "file": "sources/synthetic-lists.yaml"}]}
    copied = {"sources/lists.json": (pinned / "pinned/lists.json").read_text(encoding="utf-8"),
              "sources/gleif-templates.json": (pinned / "pinned/gleif-templates.json").read_text(encoding="utf-8"),
              "sources/synthetic-lists.yaml": (pinned / "synthetic-lists.yaml").read_text(encoding="utf-8")}
    # A hero's synthetic documents are among its source files, so the manifest digests them and
    # the TypeScript loader verifies them (readSourceFile).
    rendered_documents = documents.render()
    for d in dossiers:
        prefix = f"parties/{d.party_id}/"
        d.files.update({path[len(prefix):]: text for path, text in rendered_documents.items() if path.startswith(prefix)})
    files = render(dossiers, crowd, sources, copied)
    if args.check:
        problems = drift(files, args.out)
        if problems:
            print("drift:\n  " + "\n  ".join(problems), file=sys.stderr)
            return 1
        print("no drift")
        return 0
    write(files, args.out)
    print(f"wrote {len(files)} files to {args.out}")
    return 0


def _evaluate(args) -> int:
    """Production slice 1 evaluation (evaluate.py). A held-out report needs CORPUS_HELDOUT_SALT and is
    never written inside the repository, so held-out data cannot leak into committed fixtures."""
    import os

    from .evaluate import DEV_PARTIES, evaluate
    from .gen import generate
    from .heldout import heldout_specs

    if args.split == "heldout":
        salt = os.environ.get("CORPUS_HELDOUT_SALT", "")
        if not salt:
            print("evaluate --split heldout needs CORPUS_HELDOUT_SALT (kept outside the repository)", file=sys.stderr)
            return 2
        specs = heldout_specs(salt, args.count)
        problems = validate_real_names(specs)
        if problems:
            print("\n".join(problems), file=sys.stderr)
            return 1
        dossiers = [generate(s) for s in specs]
    else:
        all_specs, all_dossiers = build(args.scenarios)
        pairs = [(s, d) for s, d in zip(all_specs, all_dossiers) if s["id"] in DEV_PARTIES]
        specs, dossiers = [p[0] for p in pairs], [p[1] for p in pairs]
    if args.report and args.split == "heldout" and args.report.resolve().is_relative_to(REPO):
        print("refusing to write a held-out report inside the repository", file=sys.stderr)
        return 2
    report = evaluate(specs, dossiers, args.split, controls=not args.no_controls)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    width = max(len(s) for s in report["skills"])
    print(f"{report['slice']} {report['split']}: {report['dataset']['parties']} parties, dataset {report['dataset']['digest'][:12]}, report {report['reportDigest'][:12]}")
    for skill, s in report["skills"].items():
        c = s["controls"]
        print(f"  {skill:{width}}  {s['passedCases']:>3}/{s['applicableCases']:<3} cases  controls {c['passed']}/{c['run']}  {'meets placeholder' if s['meetsPlaceholderThresholds'] else 'BELOW'}")
        for failure in (s["failures"] + c["failures"])[:4]:
            print(f"      - {failure}")
    print("  case mix: " + ", ".join(f"{k} {v}" for k, v in report["caseMix"].items()))
    for name, value in report["familyMetrics"].items():
        print(f"  {name}: {value}")
    return 0 if all(s["meetsPlaceholderThresholds"] or s["applicableCases"] == 0 for s in report["skills"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
