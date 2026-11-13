"""Deterministic fictional names. Release gate: checked against the pinned official lists (Phase 3)."""
from __future__ import annotations

import random

FIRST = ["Alder", "Bryn", "Calla", "Dorian", "Elin", "Fenn", "Garrick", "Hollis", "Isolde", "Jorah", "Kestrel",
         "Lowell", "Marit", "Niamh", "Orson", "Perrin", "Quill", "Rhea", "Soren", "Tamsin", "Ulric", "Vesper",
         "Wynn", "Yara", "Zeph"]
LAST = ["Ashdown", "Barrow", "Coldwell", "Dunmore", "Eastley", "Fairholm", "Garside", "Hartwell", "Ingram",
        "Jessop", "Kirkby", "Lindqvist", "Marlowe", "Northcott", "Oakden", "Pemberton", "Quayle", "Rastall",
        "Stannard", "Thorne", "Underhill", "Vance", "Wexcombe", "Yardley", "Zeller"]
BIZ_HEAD = ["Aldermoor", "Brightwater", "Calderbank", "Dunmere", "Eastgate", "Fernhill", "Greyfriars", "Harbourside",
            "Ironbridge", "Juniper", "Kingsmead", "Larkfield", "Millstone", "Northfield", "Overton", "Pennine",
            "Quarry", "Ridgeway", "Stonebridge", "Tidewell", "Upland", "Valebrook", "Westmere", "Yewtree"]
BIZ_TAIL = {
    "supplier": ["Steelworks", "Alloys", "Fasteners", "Coatings", "Castings", "Tooling", "Metals", "Components"],
    "customer": ["Engineering", "Plant Hire", "Construction", "Machinery", "Motors", "Fabrications", "Logistics", "Rail"],
    "merchant": ["Market", "Cafe", "Pharmacy", "Books", "Hardware", "Grocers", "Fuel", "Cinema"],
    "courier": ["Freight", "Parcels", "Haulage", "Distribution", "Dispatch", "Depot"],
    "trader": ["Trading", "Commodities", "Resources", "Industries", "Exports", "Supply"],
    "generic": ["Services", "Partners", "Group", "Holdings"],
}
SUFFIX = {"GB": "Ltd", "US": "LLC", "IE": "Ltd", "DE": "GmbH", "AE": "FZE", "MX": "S.A. de C.V.", "TR": "A.S.",
          "SG": "Pte Ltd", "HK": "Ltd", "PA": "S.A.", "CY": "Ltd", "EE": "OU"}


def person(rng: random.Random) -> str:
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


def business(rng: random.Random, style: str, country: str) -> str:
    return f"{rng.choice(BIZ_HEAD)} {rng.choice(BIZ_TAIL[style])} {SUFFIX.get(country, 'Ltd')}"


def unique_names(rng: random.Random, n: int, make) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    while len(out) < n:
        name = make()
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out
