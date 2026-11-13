"""Monitoring-system view of a ledger: alerts raised by rule over the committed transactions.

Alerts come from the reference detectors (never from the answer key), clustered so one burst is one
alert. They are emitted twice from the same list: as `Alert` records (history, L9) and as the
provider-shaped `transaction.monitor.v1` payload a replay connector serves.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from . import detectors as det

RULES = {  # detector -> (rule id, severity)
    "structuring": ("STRUCT-01", "HIGH"), "smurfing": ("SMURF-01", "MEDIUM"), "funnel": ("FUNNEL-01", "HIGH"),
    "pass_through": ("PASSTHRU-01", "HIGH"), "mule": ("MULE-01", "MEDIUM"), "roundtrip": ("ROUNDTRIP-01", "HIGH"),
    "layering": ("LAYER-01", "HIGH"), "velocity": ("VELOCITY-01", "LOW"),
}


def _clusters(indicators: list[dict[str, Any]]) -> list[set[str]]:
    groups: list[set[str]] = []
    for ind in indicators:
        ids = set(ind["transaction_ids"])
        merged = [g for g in groups if g & ids]
        for g in merged:
            groups.remove(g)
            ids |= g
        groups.append(ids)
    return groups


def build_alerts(party: str, subject: str, records: list[dict[str, Any]], hero_accounts: set[str]) -> list[dict[str, Any]]:
    rows = det.rows_from_records(records)
    by_id = {r["id"]: r for r in rows}
    event = {r["id"]: r["data"]["event_id"] for r in records if r["object_type"] == "Transaction"}
    found = det.run_all(rows)
    ctr = det.ctr_days(rows, hero_accounts)
    alerts = []
    for kind, indicators in found.items():
        rule, severity = RULES[kind]
        for ids in _clusters(indicators):
            alerts.append((rule, severity, ids))
    for day in ctr:
        alerts.append(("CTR-01", "MEDIUM", set(day["transaction_ids"])))
    out = []
    for rule, severity, ids in alerts:
        last = max(by_id[i]["ts"] for i in ids)
        raised = (last + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        events = sorted(event[i] for i in ids)
        out.append({"rule_id": rule, "severity": severity, "subject": subject, "raised_at": raised, "event_ids": events})
    out.sort(key=lambda a: (a["raised_at"], a["rule_id"], a["event_ids"][0]))
    for n, a in enumerate(out, 1):
        a["alert_id"] = f"{party.lower()}-alert-{n:03d}"
    return out
