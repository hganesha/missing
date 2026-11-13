"""Write dossiers deterministically, build the manifest, and check for drift."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from .gen import Dossier
from .world import GENERATOR, canonical_json, digest, sha256_hex

MANIFEST_SCHEMA = "harness.factory/context-corpus-v1"


def _dump_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def render(dossiers: list[Dossier], crowd: dict[str, Any] | None = None, sources: dict[str, Any] | None = None,
           copied: dict[str, str] | None = None) -> dict[str, str]:
    """Relative path -> file text, for every generated file including the manifest."""
    files: dict[str, str] = {}
    parties = []
    for d in sorted(dossiers, key=lambda x: x.party_id):
        base = f"parties/{d.party_id}"
        files[f"{base}/case.json"] = _dump_json(d.case)
        files[f"{base}/records.jsonl"] = "".join(canonical_json(r) + "\n" for r in sorted(d.records, key=lambda r: r["id"]))
        files[f"{base}/expectations.yaml"] = yaml.safe_dump(d.expectations, sort_keys=True, allow_unicode=True)
        for rel, text in sorted(d.files.items()):
            files[f"{base}/{rel}"] = text
        by_type: dict[str, int] = {}
        for r in d.records:
            by_type[r["object_type"]] = by_type.get(r["object_type"], 0) + 1
        parties.append({
            "id": d.party_id, "seed": d.expectations["seed"], "spec_digest": d.expectations["spec_digest"],
            "record_count": len(d.records), "record_types": dict(sorted(by_type.items())),
            "records_digest": sha256_hex(files[f"{base}/records.jsonl"]),
            "expectations_digest": sha256_hex(files[f"{base}/expectations.yaml"]),
            "split": "dev",
            "source_files": {rel: sha256_hex(text) for rel, text in sorted(d.files.items())}})
    for rel, text in sorted((copied or {}).items()):
        files[rel] = text
    files["SOURCES.json"] = _dump_json({
        "schema": "harness.factory/context-corpus-sources-v1", **(sources or {"sources": []}),
        "committed_inputs": {rel: sha256_hex(text) for rel, text in sorted((copied or {}).items())}})
    manifest = {"schema": MANIFEST_SCHEMA, "generator": GENERATOR, "parties": parties,
                "corpus_digest": digest([parties, crowd]),
                "crowd": crowd, "reviewers": {}}
    files["manifest.json"] = _dump_json(manifest)
    return files


def write(files: dict[str, str], out: Path) -> None:
    for rel, text in files.items():
        path = out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def drift(files: dict[str, str], out: Path) -> list[str]:
    problems = []
    for rel, text in files.items():
        path = out / rel
        if not path.exists():
            problems.append(f"missing {rel}")
        elif path.read_text(encoding="utf-8") != text:
            problems.append(f"changed {rel}")
    if out.exists():
        # anchors/ holds hand-labelled gold files and real-document excerpts, not generated output.
        on_disk = {str(p.relative_to(out)) for p in out.rglob("*") if p.is_file()
                   and p.relative_to(out).parts[0] != "anchors"}
        problems += [f"stale {extra}" for extra in sorted(on_disk - set(files))]
    return problems
