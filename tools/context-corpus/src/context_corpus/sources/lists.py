"""Official sanctions lists (OFAC SDN, UN, UK): download, parse, and pin a small deterministic subset.

Entries are kept as published (name, dates, identifiers, programme); nothing is added. Real designations
appear only as list data. The EU consolidated list is recorded as unavailable when its endpoint refuses.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .http import fetch, sha256

URLS = {
    "ofac-sdn": "https://www.treasury.gov/ofac/downloads/sdn.csv",
    "un-consolidated": "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
    "uk-sanctions": "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml",
    "eu-consolidated": "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw",
}
LICENCE = {
    "ofac-sdn": "US government work; public domain",
    "un-consolidated": "UN Security Council public data; free to use with attribution",
    "uk-sanctions": "Open Government Licence v3.0 (FCDO)",
    "eu-consolidated": "EU open data (Commission reuse policy)",
}
# H02 near-miss design: the three published entries whose names score closest to the fictional hero.
NEAR_MISS = {("ofac-sdn", "38296"), ("ofac-sdn", "27724"), ("uk-sanctions", "VEN0021")}
BACKGROUND_PER_LIST = 4

_DOC = re.compile(r"(?:Passport|National ID No\.|Cedula No\.|C\.U\.R\.P\.|R\.F\.C\.|Tax ID No\.|Document No\.)\s*([A-Z0-9][A-Z0-9\-/]{4,})", re.I)
_DOB = re.compile(r"DOB\s+(\d{1,2} \w{3} \d{4}|\d{4})")


def _stable(list_id: str, uid: str) -> str:
    return hashlib.sha256(f"pin:{list_id}:{uid}".encode()).hexdigest()


def parse_ofac(body: bytes) -> list[dict[str, Any]]:
    out = []
    for row in csv.reader(io.StringIO(body.decode("latin-1"))):
        if len(row) < 12 or row[2].strip() not in {"individual", "-0-"}:
            continue
        kind = "individual" if row[2].strip() == "individual" else "entity"
        remarks = row[11]
        out.append({"list": "ofac-sdn", "uid": row[0], "name": row[1], "type": kind, "programs": [p.strip(" []") for p in row[3].split("]") if p.strip(" []")],
                    "dob": _DOB.findall(remarks)[:1], "identifiers": sorted(set(_DOC.findall(remarks))), "remarks": remarks,
                    "raw_sha256": hashlib.sha256(",".join(row).encode()).hexdigest()})
    return out


def parse_un(body: bytes) -> list[dict[str, Any]]:
    root, out = ET.fromstring(body), []
    for tag, kind in (("INDIVIDUAL", "individual"), ("ENTITY", "entity")):
        for el in root.iter(tag):
            name = " ".join(filter(None, (el.findtext(k) or "" for k in ("FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME")))).strip()
            years = [d.findtext("YEAR") or (d.findtext("DATE") or "") for d in el.iter("INDIVIDUAL_DATE_OF_BIRTH")]
            docs = [d.findtext("NUMBER") for d in el.iter("INDIVIDUAL_DOCUMENT")]
            out.append({"list": "un-consolidated", "uid": el.findtext("DATAID") or "", "name": name, "type": kind,
                        "programs": [el.findtext("UN_LIST_TYPE") or ""], "dob": [y for y in years if y][:1],
                        "identifiers": sorted({d for d in docs if d}), "remarks": el.findtext("COMMENTS1") or "",
                        "raw_sha256": hashlib.sha256(ET.tostring(el)).hexdigest()})
    return [e for e in out if e["uid"] and e["name"]]


def parse_uk(body: bytes) -> list[dict[str, Any]]:
    root, out = ET.fromstring(body), []
    for d in root.iter("Designation"):
        primary = next((n for n in d.iter("Name") if (n.findtext("NameType") or "").lower().startswith("primary")), None)
        if primary is None:
            continue
        name = " ".join(filter(None, (primary.findtext(f"Name{k}") or "" for k in range(1, 7)))).strip()
        ids = [x.text for x in d.iter("NationalIdentifierNumber") if x.text] + [x.text for x in d.iter("PassportNumber") if x.text]
        out.append({"list": "uk-sanctions", "uid": d.findtext("UniqueID") or "", "name": name,
                    "type": "individual" if (d.findtext("IndividualEntityShip") or "").lower() == "individual" else "entity",
                    "programs": [d.findtext("RegimeName") or ""], "dob": [], "identifiers": sorted(set(ids)),
                    "remarks": (d.findtext("OtherInformation") or "")[:300], "raw_sha256": hashlib.sha256(ET.tostring(d)).hexdigest()})
    return [e for e in out if e["uid"] and e["name"]]


PARSERS = {"ofac-sdn": parse_ofac, "un-consolidated": parse_un, "uk-sanctions": parse_uk}


def pin(entries: list[dict[str, Any]], list_id: str) -> list[dict[str, Any]]:
    eligible = [e for e in entries if e["identifiers"] or e["dob"]]
    chosen = [e for e in entries if (list_id, e["uid"]) in NEAR_MISS]
    for kind in ("individual", "entity"):
        pool = sorted((e for e in eligible if e["type"] == kind and (list_id, e["uid"]) not in NEAR_MISS),
                      key=lambda e: _stable(list_id, e["uid"]))
        chosen += pool[: BACKGROUND_PER_LIST if kind == "individual" else 1]
    return sorted(chosen, key=lambda e: (e["list"], e["uid"]))


def collect(out_dir: Path) -> dict[str, Any]:
    pinned, sources = [], []
    for list_id, url in URLS.items():
        entry = {"id": list_id, "url": url, "licence": LICENCE[list_id]}
        try:
            body, at = fetch(url, min_interval=1.0)
            if body[:1] == b"{":  # an error document, not a list
                raise OSError(body[:120].decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001 - recorded, not fatal: a missing list is a stated gap
            sources.append({**entry, "status": "unavailable", "reason": str(exc)[:200]})
            continue
        parsed = PARSERS[list_id](body)
        chosen = pin(parsed, list_id)
        pinned += chosen
        sources.append({**entry, "status": "collected", "retrieved_at": at, "sha256": sha256(body), "bytes": len(body),
                        "entries_in_list": len(parsed), "entries_pinned": len(chosen)})
    missing = NEAR_MISS - {(e["list"], e["uid"]) for e in pinned}
    if missing:
        raise SystemExit(f"near-miss entries not found in the downloaded lists: {sorted(missing)}")
    (out_dir / "lists.json").write_text(json.dumps({"entries": pinned, "sources": sources}, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"pinned": len(pinned), "sources": sources}
