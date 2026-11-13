"""Score an extractor's evidence package against an anchor's gold labels.

    python -m context_corpus.anchor_score fixtures/context-corpus/anchors/A4-alphabet/gold.json report.json

A gold claim is a list of terms. It counts as found when one extracted fact contains every term, after
lower-casing and removing thousands separators. This is deliberately loose about field names, so it works
for any extractor that emits facts with subject/predicate/object/value, and it is strict about numbers.
Gold labels are assistant-authored from the filings and not independently adjudicated.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def norm(s: str) -> str:
    s = re.sub(r"(?<=\d),(?=\d)", "", s.lower())
    return re.sub(r"\s+", " ", s)


def _fmt(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


def claims(gold: dict) -> list[dict]:
    out: list[dict] = []
    for s in gold.get("subsidiaries_ex21", []):
        out.append({"id": f"sub:{s['name']}", "terms": [s["name"], s["jurisdiction"]]})
    for h in gold.get("holders", []):
        key = h["name"].replace(",", "").split()
        key = "group" if h["name"].lower().startswith("all executive") else (key[-1] if key[-1] not in ("Jr.", "Inc.") else key[-2])
        for cls in ("class_a", "class_b"):
            if h.get(cls):
                out.append({"id": f"{h['name']}:{cls}", "terms": [key, _fmt(h[cls])]})
        if isinstance(h.get("voting_pct"), (int, float)):
            out.append({"id": f"{h['name']}:voting_pct", "terms": [key, _fmt(h["voting_pct"])]})
    for f in gold.get("facts", []):
        terms = [f["object"]] if f.get("object") else []
        if f.get("value") is not None:
            terms.append(_fmt(f["value"]))
        out.append({"id": f["id"], "terms": terms or [f["id"]]})
    return out


def score(gold: dict, report: dict) -> dict:
    blobs = [norm(json.dumps(f, ensure_ascii=False)) for f in report.get("facts", [])]
    rows = []
    for c in claims(gold):
        terms = [norm(t) for t in c["terms"]]
        rows.append({**c, "found": any(all(t in b for t in terms) for b in blobs)})
    found = sum(r["found"] for r in rows)
    return {"anchor": gold.get("anchor"), "claims": len(rows), "found": found,
            "recall": round(found / len(rows), 3) if rows else None,
            "extracted_facts": len(blobs), "missing": [r["id"] for r in rows if not r["found"]]}


def main(argv: list[str] | None = None) -> int:
    a = argv if argv is not None else sys.argv[1:]
    if len(a) != 2:
        print(__doc__)
        return 2
    res = score(json.loads(Path(a[0]).read_text()), json.loads(Path(a[1]).read_text()))
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
