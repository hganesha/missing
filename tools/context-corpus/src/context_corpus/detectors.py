"""Reference detectors for the planted signals.

These are written independently of the skill library and run on the committed Transaction records.
They prove a signal is present at the corpus policy thresholds (and absent on hard negatives); they
do not prove a skill works. Semantics mirror the library's documented typology definitions so a
cross-check test (when `financial_crime` is importable) can compare them.
"""
from __future__ import annotations

from bisect import bisect_left
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

D = Decimal
SKIP = {"cancelled", "reversed"}

# Corpus detection policy (`policy.corpus-v1`): the thresholds the answer keys are written against.
CORPUS_POLICY: dict[str, Any] = {
    "ctr_thresholds": {"USD": "10000", "GBP": "8000", "EUR": "10000", "AED": "36000"}, "ctr_time_zone": "UTC",
    "ctr_business_day": {"cutoff": "00:00", "roll_non_working_days": False}, "ctr_transaction_types": ["cash_deposit", "cash_withdrawal"],
    "aml_detectors": {
        "structuring": {"amount_threshold": "10000", "currency": "USD", "minimum_count": 5, "window_seconds": 86400, "max_hops": 5, "throughput_ratio": "0.8"},
        "smurfing": {"amount_threshold": "10000", "currency": "USD", "minimum_count": 8, "window_seconds": 86400, "max_hops": 5, "throughput_ratio": "0.8"},
        "funnel": {"amount_threshold": "10000", "currency": "USD", "minimum_count": 8, "window_seconds": 86400, "max_hops": 5, "throughput_ratio": "0.8"},
        "pass_through": {"amount_threshold": "10000", "currency": "USD", "minimum_count": 6, "window_seconds": 10800, "max_hops": 5, "throughput_ratio": "0.9"},
        "mule": {"amount_threshold": "10000", "currency": "USD", "minimum_count": 6, "window_seconds": 10800, "max_hops": 5, "throughput_ratio": "0.9"},
        "layering": {"amount_threshold": "10000", "currency": "USD", "minimum_count": 3, "window_seconds": 5 * 86400, "max_hops": 5, "throughput_ratio": "0.8"},
        "roundtrip": {"amount_threshold": "10000", "currency": "USD", "minimum_count": 2, "window_seconds": 5 * 86400, "max_hops": 5, "throughput_ratio": "0.8"},
        "velocity": {"amount_threshold": "10000", "currency": "USD", "minimum_count": 40, "window_seconds": 86400, "max_hops": 5, "throughput_ratio": "0.8"},
    },
    "fraud_thresholds": {"account_takeover": "0.6", "payment_anomaly": "0.6"},
    "screening_threshold": 0.5, "sanctions_ownership": {"rule": "ofac_50_percent", "threshold": "0.5"},
    "ownership_threshold": "0.25", "control_bases": ["voting_majority", "appoint_board", "protector_veto"],
    "sanctions_control_bases": ["voting_majority"], "verification_methods": ["government_id_document", "registry_extract", "trust_deed"],
    "device_fields": ["os", "browser"], "link_attributes": ["phone", "email"],
    "synthetic_fingerprint_key": "corpus-test-key-not-for-production",
}


def rows_from_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for r in records:
        if r["object_type"] != "Transaction":
            continue
        d = r["data"]
        out.append({"id": r["id"], "source": d["source"], "target": d["target"], "amount": D(d["amount"]),
                    "currency": d["currency"], "ts": datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")),
                    "status": d["status"], "type": d.get("transaction_type"), "rail": (d.get("extensions", {}).get("ehf.corpus", {}).get("value", {}) or {}).get("rail")})
    return out


def _live(rows):
    return [r for r in rows if r["status"] not in SKIP]


def _windows(events, win, anchor_filter=None):
    """Yield (anchor, selected) over events sorted by ts; selected = events in [t - win, t]."""
    events = sorted(events, key=lambda x: (x["ts"], x["id"]))
    times = [e["ts"] for e in events]
    for i, anchor in enumerate(events):
        lo = bisect_left(times, anchor["ts"] - timedelta(seconds=win) + timedelta(microseconds=1))
        j = i
        while j + 1 < len(events) and times[j + 1] == anchor["ts"]:
            j += 1
        yield anchor, events[lo:j + 1]


def _grouped(rows, key):
    g = defaultdict(list)
    for r in _live(rows):
        g[(r[key], r["currency"])].append(r)
    return g


def structuring(rows, cfg, kind="structuring"):
    thr, minimum, win = D(cfg["amount_threshold"]), cfg["minimum_count"], cfg["window_seconds"]
    out, seen = [], set()
    dim = "target" if kind == "smurfing" else "source"
    for (acct, cur), events in sorted(_grouped(rows, dim).items()):
        if cur != cfg["currency"]:   # the threshold is stated in one currency; no rate is assumed
            continue
        for anchor, sel in _windows(events, win):
            sel = [x for x in sel if x["amount"] < thr]
            total = sum((x["amount"] for x in sel), D(0))
            if len(sel) < minimum or total < thr:
                continue
            if kind == "smurfing" and len({x["source"] for x in sel}) < minimum:
                continue
            key = tuple(sorted(x["id"] for x in sel))
            if key not in seen:
                seen.add(key)
                out.append({"account": acct, "currency": cur, "transaction_ids": list(key), "total": str(total)})
    return out


def smurfing(rows, cfg):
    return structuring(rows, cfg, "smurfing")


def funnel(rows, cfg):
    minimum, win = cfg["minimum_count"], cfg["window_seconds"]
    out, seen = [], set()
    for (acct, cur), events in sorted(_grouped(rows, "target").items()):
        for anchor, sel in _windows(events, win):
            if len(sel) >= minimum and len({x["source"] for x in sel}) >= minimum:
                key = tuple(sorted(x["id"] for x in sel))
                if key not in seen:
                    seen.add(key)
                    out.append({"account": acct, "currency": cur, "transaction_ids": list(key)})
    return out


def pass_through(rows, cfg):
    minimum, win, ratio = cfg["minimum_count"], cfg["window_seconds"], D(cfg["throughput_ratio"])
    live = _live(rows)
    incoming, outgoing = defaultdict(list), defaultdict(list)
    for r in live:
        incoming[(r["target"], r["currency"])].append(r)
        outgoing[(r["source"], r["currency"])].append(r)
    for v in outgoing.values():
        v.sort(key=lambda x: (x["ts"], x["id"]))
    out = []
    for (acct, cur), ins in sorted(incoming.items()):
        outs = outgoing.get((acct, cur), [])
        times = [o["ts"] for o in outs]
        for a in ins:
            lo = bisect_left(times, a["ts"])
            hi = bisect_left(times, a["ts"] + timedelta(seconds=win))
            sel = outs[lo:hi]
            if a["amount"] > 0 and len(sel) >= minimum and sum((x["amount"] for x in sel), D(0)) >= a["amount"] * ratio:
                out.append({"account": acct, "currency": cur, "transaction_ids": [a["id"]] + [x["id"] for x in sel]})
    return out


def mule(rows, cfg):
    return pass_through(rows, cfg)


def velocity(rows, cfg):
    minimum, win = cfg["minimum_count"], cfg["window_seconds"]
    out, seen = [], set()
    for (acct, cur), events in sorted(_grouped(rows, "source").items()):
        for anchor, sel in _windows(events, win):
            if len(sel) >= minimum:
                key = tuple(sorted(x["id"] for x in sel))
                if key not in seen:
                    seen.add(key)
                    out.append({"account": acct, "currency": cur, "transaction_ids": list(key)})
    return out


def _paths(rows, cfg, kind):
    """Increasing-time, same-currency paths: round trips (return to start) or layering (>= minimum hops)."""
    minimum, win, hops = cfg["minimum_count"], cfg["window_seconds"], cfg.get("max_hops", 5)
    out_edges = defaultdict(list)
    for r in _live(rows):
        out_edges[r["source"]].append(r)
    for v in out_edges.values():
        v.sort(key=lambda x: x["id"])
    found, states = [], 0
    for start in sorted(out_edges):
        stack = [(start, [], {start})]
        while stack:
            node, edges, visited = stack.pop()
            states += 1
            if states > 200000:
                raise RuntimeError("typology traversal budget exceeded")
            if len(edges) >= hops:
                continue
            for e in out_edges.get(node, []):
                if edges and (e["currency"] != edges[0]["currency"] or e["ts"] <= edges[-1]["ts"]):
                    continue
                path = edges + [e]
                if (path[-1]["ts"] - path[0]["ts"]).total_seconds() >= win:
                    continue
                if (kind == "roundtrip" and e["target"] == start and len(path) >= 2) or (kind == "layering" and len(path) >= minimum):
                    found.append({"transaction_ids": [x["id"] for x in path], "currency": e["currency"]})
                if e["target"] not in visited:
                    stack.append((e["target"], path, visited | {e["target"]}))
    return found


def roundtrip(rows, cfg):
    return _paths(rows, cfg, "roundtrip")


def layering(rows, cfg):
    return _paths(rows, cfg, "layering")


DETECTORS = {"structuring": structuring, "smurfing": smurfing, "funnel": funnel, "pass_through": pass_through,
             "mule": mule, "velocity": velocity, "roundtrip": roundtrip, "layering": layering}


def run_all(rows: list[dict[str, Any]], policy: dict[str, Any] = CORPUS_POLICY, only=None) -> dict[str, list]:
    return {k: fn(rows, policy["aml_detectors"][k]) for k, fn in DETECTORS.items() if only is None or k in only}


def ctr_days(rows, hero_accounts, policy=CORPUS_POLICY):
    """Currency transaction report days: cash into/out of a hero account above the daily threshold."""
    per_day = defaultdict(list)
    for r in _live(rows):
        if r["rail"] == "cash":
            acct = r["target"] if r["target"] in hero_accounts else r["source"] if r["source"] in hero_accounts else None
            if acct:
                per_day[(acct, r["currency"], r["ts"].date().isoformat())].append(r)
    out = []
    for (acct, cur, day), evs in sorted(per_day.items()):
        total = sum((x["amount"] for x in evs), D(0))
        thr = policy["ctr_thresholds"].get(cur)
        if thr and total > D(thr):
            out.append({"account": acct, "day": day, "total": str(total), "transaction_ids": sorted(x["id"] for x in evs)})
    return out


def trade_mismatches(records):
    inv = {r["id"]: r["data"] for r in records if r["object_type"] == "Invoice"}
    shp = {r["id"]: r["data"] for r in records if r["object_type"] == "Shipment"}
    return [{"trade_id": r["id"]} for r in records if r["object_type"] == "TradeRecord"
            and D(inv[r["data"]["invoice_id"]]["quantity"]) != D(shp[r["data"]["shipment_id"]]["quantity"])]


# ---- fraud reference detectors (independent of the library's skills) ----

def behavior_anomalies(records):
    out = []
    for r in records:
        if r["object_type"] == "Session":
            d = r["data"]
            bad = [k for k, v in d["features"].items() if k in d["baseline"]
                   and not D(d["baseline"][k]["minimum"]) <= D(v) <= D(d["baseline"][k]["maximum"])]
            if bad:
                out.append({"session": r["id"], "features": sorted(bad)})
    return out


def payment_anomalies(records):
    return [{"payment": r["id"]} for r in records if r["object_type"] == "Payment"
            and D(r["data"]["amount"]) > D(r["data"]["baseline_maximum"])]


def beneficiary_flags(records):
    return [{"entity_id": r["data"]["entity_id"], "counterparty": r["id"]} for r in records
            if r["object_type"] == "Counterparty" and (r["data"]["risk_indicators"] or not r["data"]["evidence_ids"]) and r["data"]["risk_indicators"]]


def shared_attribute_groups(records, policy=CORPUS_POLICY):
    groups = defaultdict(list)
    for r in records:
        if r["object_type"] == "Entity":
            for k in policy["link_attributes"]:
                v = r["data"].get("attributes", {}).get(k)
                if v is not None:
                    groups[(k, str(v))].append(r["id"])
    return [{"attribute": k[0], "value": k[1], "entities": sorted(v)} for k, v in sorted(groups.items()) if len(v) > 1]


def elevated_fraud_signals(records, policy=CORPUS_POLICY):
    return [r["id"] for r in records if r["object_type"] == "FraudSignal"
            and D(r["data"]["score"]) >= D(policy["fraud_thresholds"][r["data"]["kind"]])]


# ---- ownership and screening reference implementations (independent of the library's skills) ----

def ownership_analysis(records, target):
    """Terminal-owner path products, cycles and unresolved items, from the committed ownership records."""
    owners_of = defaultdict(list)
    for r in records:
        if r["object_type"] == "OwnershipInterest":
            d = r["data"]
            owners_of[d["owned"]].append((d["owner"], D(d["interest"])))
    ranges = {r["data"]["owned"] for r in records if r["object_type"] == "OwnershipRange"}
    interests, unresolved = defaultdict(D), set()

    def walk(node, factor, path):
        incoming = owners_of.get(node, [])
        if not incoming:
            interests[node] += factor
            return
        total = D(0)
        for parent, share in incoming:
            total += share
            if parent in path:
                unresolved.add(("CYCLE", parent))
                continue
            walk(parent, factor * share, path + [parent])
        if total < 1:
            unresolved.add(("UNACCOUNTED_INTEREST", node))
    walk(target, D(1), [target])
    for node in ranges:
        unresolved.add(("OWNERSHIP_RANGE_REQUIRES_RESOLUTION", node))
    return {"interests": dict(interests), "unresolved": unresolved}


def ofac_blocked(records, blocked_ids):
    """Least fixed point of the 50% rule: a node is blocked when blocked owners hold >= 50% of it directly."""
    held = defaultdict(lambda: defaultdict(D))
    for r in records:
        if r["object_type"] == "OwnershipInterest":
            held[r["data"]["owned"]][r["data"]["owner"]] += D(r["data"]["interest"])
    blocked = set(blocked_ids)
    while True:
        new = {n for n, owners in held.items() if n not in blocked and sum((v for o, v in owners.items() if o in blocked), D(0)) >= D("0.5")}
        if not new:
            return blocked
        blocked |= new
