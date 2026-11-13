"""Background crowd: ordinary parties and transactions with a small planted laundering base rate."""
from __future__ import annotations

import random
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from . import detectors as det
from .ledger import is_business, money, parse_date, utc
from .world import canonical_json, sha256_hex


def _stream(cfg: dict[str, Any]):
    """Yield (row, planted) for every crowd transaction, deterministically."""
    rng = random.Random(f"crowd:{cfg['seed']}")
    start, end = parse_date(cfg["start"]), parse_date(cfg["end"])
    days = [start + timedelta(days=i) for i in range((end - start).days)]
    biz = [d for d in days if is_business(d)]
    months = sorted({(d.year, d.month) for d in days})
    by_month = {m: [d for d in biz if (d.year, d.month) == m] for m in months}
    months = [m for m in months if len(by_month[m]) >= 15]  # skip the partial edge months
    n = 0

    def row(day, sec, src, dst, amt, rail, typ, planted=False):
        nonlocal n
        n += 1
        return ({"id": f"c-{n:07d}", "source": src, "target": dst, "amount": amt, "currency": "USD", "ts": utc(day, sec),
                 "status": "settled", "type": typ, "rail": rail}, planted)

    for i in range(cfg["individuals"]):
        me, employer, landlord = f"crowd:i{i:04d}", f"crowd:emp{rng.randrange(cfg['employers']):03d}", f"crowd:ll{rng.randrange(cfg['landlords']):03d}"
        pay, rent = money(rng.uniform(1800, 5200)), money(rng.uniform(600, 2200))
        for m in months:
            ds = by_month[m]
            for d in rng.sample(ds, 2):
                yield row(d, rng.randint(28800, 61200), employer, me, pay, "ach", "payroll")
            yield row(ds[0], rng.randint(28800, 61200), me, landlord, rent, "ach", "rent")
            for _ in range(rng.randint(2, 4)):
                yield row(rng.choice(ds), rng.randint(28800, 72000), me, f"crowd:m{rng.randrange(cfg['merchants']):03d}",
                          money(min(rng.lognormvariate(3.6, 0.7), 400)), "card", "card_purchase")
    for i in range(cfg["smes"]):
        me = f"crowd:s{i:04d}"
        customers = [f"crowd:sc{rng.randrange(cfg['smes'] * 2):04d}" for _ in range(8)]
        suppliers = [f"crowd:sp{rng.randrange(cfg['suppliers']):03d}" for _ in range(5)]
        for m in months:
            ds = by_month[m]
            for d in rng.sample(ds, 5):
                yield row(d, rng.randint(28800, 61200), rng.choice(customers), me, money(min(rng.lognormvariate(7.4, 0.8), 40000)), "ach", "customer_payment")
            for d in rng.sample(ds, 3):
                yield row(d, rng.randint(28800, 61200), me, rng.choice(suppliers), money(min(rng.lognormvariate(7.2, 0.7), 30000)), "ach", "supplier_payment")
            yield row(ds[-3], 36000, me, f"crowd:ll{rng.randrange(cfg['landlords']):03d}", money(rng.uniform(1500, 6000)), "ach", "rent")
    window = biz[30:-30]
    for k in range(cfg["planted"]["structuring_clusters"]):
        me, day = f"crowd:i{rng.randrange(cfg['individuals']):04d}", rng.choice(window)
        for j in range(5):
            yield row(day, 32400 + 1800 * j, me, f"crowd:x{k:03d}-{j}", money(rng.uniform(8200, 9900)), "cash", "cash_withdrawal", True)
    for k in range(cfg["planted"]["funnel_clusters"]):
        hub, day = f"crowd:s{rng.randrange(cfg['smes']):04d}", rng.choice(window)
        feeders = [f"crowd:i{rng.randrange(cfg['individuals']):04d}" for _ in range(8)]
        total = Decimal(0)
        for j, f in enumerate(feeders):
            amt = money(rng.uniform(900, 1800))
            total += amt
            yield row(day, 32400 + 600 * j, f, hub, amt, "ach", "transfer", True)
        for j in range(6):
            yield row(day, 41400 + 300 * j, hub, f"crowd:w{k:03d}-{j % 3}", money(total * Decimal("0.97") / 6), "wire", "wire_out", True)


def build_crowd(path: Path) -> dict[str, Any]:
    cfg = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.SafeLoader)
    cfg = {**cfg, "start": str(cfg["start"]), "end": str(cfg["end"])}
    rows, planted = [], set()
    digest_parts: list[str] = []
    for r, is_planted in _stream(cfg):
        rows.append(r)
        if is_planted:
            planted.add(r["id"])
        digest_parts.append(canonical_json({**r, "ts": r["ts"].isoformat(), "amount": str(r["amount"])}))
    digest = sha256_hex("\n".join(digest_parts))
    cfg_p = det.CORPUS_POLICY["aml_detectors"]
    # Rules apply to monitored customer accounts only; employers and landlords are external payers
    # that legitimately fan out or fan in (payroll runs, rent day).
    monitored = ("crowd:i", "crowd:s")
    found = {k: [h for h in det.DETECTORS[k](rows, cfg_p[k]) if h["account"].startswith(monitored)]
             for k in ("structuring", "funnel", "pass_through", "velocity")}
    flagged = {i for ind in found.values() for h in ind for i in h["transaction_ids"]}
    flagged_planted = flagged & planted
    hit_clusters = {  # a planted cluster is recalled when any indicator touches it
        "structuring": sum(1 for h in found["structuring"] if set(h["transaction_ids"]) & planted),
        "funnel": sum(1 for h in found["funnel"] if set(h["transaction_ids"]) & planted),
    }
    false_indicators = sum(1 for ind in found.values() for h in ind if not set(h["transaction_ids"]) & planted)
    total = sum(len(v) for v in found.values())
    return {
        "seed": cfg["seed"], "parties": cfg["individuals"] + cfg["smes"], "transactions": len(rows),
        "planted_transactions": len(planted), "planted_rate": round(len(planted) / len(rows), 5), "digest": digest,
        "detectors": {"indicators": total, "false_indicators": false_indicators,
                      "planted_recall": round(len(flagged_planted) / len(planted), 4),
                      "indicator_precision": round(1 - false_indicators / total, 4) if total else 1.0,
                      "clusters_hit": hit_clusters},
    }
