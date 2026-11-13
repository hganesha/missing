"""Typology injectors: each writes extra transactions (and trade records) and tags them with the signal id."""
from __future__ import annotations

import random
from datetime import timedelta
from decimal import Decimal
from typing import Any

from . import names
from .ledger import Tx, World, is_business, money, parse_date, utc
from .world import sha256_hex


def opaque(sig_id: str, role: str, i: int) -> str:
    """Counterparty ref that does not reveal the signal or its typology (refs become record ids)."""
    return "ext-" + sha256_hex(f"{sig_id}:{role}:{i}")[:8]



def structuring(world: World, hero: str, sig: dict[str, Any], accounts: dict[str, str]) -> tuple[list[Tx], list[dict]]:
    """Cash split into sub-threshold deposits across branches on the same day, repeated weekly."""
    p, rng = sig["params"], random.Random(f"{sig['id']}")
    cash = world.cps.get("cash-in") or world.add("cash-in", "Cash deposits (teller)", "company", "US")
    start, end = parse_date(sig["window"][0]), parse_date(sig["window"][1])
    lo, hi = float(p["band"][0]), float(p["band"][1])
    txs, day = [], start
    while day <= end:
        week = [d for d in (day + timedelta(days=i) for i in range(7)) if is_business(d) and start <= d <= end]
        for d in sorted(rng.sample(week, min(p.get("days_per_week", 1), len(week)))):
            for k in range(p["splits"]):
                txs.append(Tx(utc(d, 9 * 3600 + 1800 * k + rng.randint(0, 600)), cash.account_id,
                              accounts[p.get("account", "deposit")], money(rng.uniform(lo, hi)), p.get("currency", "USD"),
                              "cash", "cash_deposit", cash.country, flow=sig["id"], parties=["cash-in"], signal=sig["id"],
                              meta={"branch": f"branch-{k % p['branches'] + 1}"}))
        day += timedelta(days=7)
    return txs, []


def funnel(world: World, hero: str, sig: dict[str, Any], accounts: dict[str, str]) -> tuple[list[Tx], list[dict]]:
    p, rng = sig["params"], random.Random(f"{sig['id']}")
    mine = accounts[p.get("account", "deposit")]
    feeders = []
    for i, name in enumerate(names.unique_names(rng, p["feeders"], lambda: names.person(rng))):
        feeders.append(world.add(opaque(sig["id"], "feeder", i), name, "individual", "US", ["mule_profile"]))
    outs = [world.add(opaque(sig["id"], "beneficiary", i), names.business(rng, "trader", p["out"]["country"]),
                      "company", p["out"]["country"], ["high_risk_geography"]) for i in range(p["out"].get("beneficiaries", 2))]
    txs: list[Tx] = []
    out_signal = p.get("out_signal", sig["id"] + "-OUT")
    for d in map(parse_date, p["days"]):
        total = Decimal(0)
        for f in feeders:
            amt = money(rng.uniform(float(p["amount"][0]), float(p["amount"][1])))
            total += amt
            txs.append(Tx(utc(d, rng.randint(9 * 3600, 11 * 3600)), f.account_id, mine, amt, "USD", "ach",
                          "transfer", f.country, flow=sig["id"], parties=[f.ref], signal=sig["id"]))
        out_total, k = money(total * Decimal(p["out"].get("ratio", "0.97"))), p["out"].get("wires", 4)
        shares = [out_total / k] * k
        for j in range(k):
            b = outs[j % len(outs)]
            txs.append(Tx(utc(d, 11 * 3600 + 1800 + 300 * j + rng.randint(0, 120)), mine, b.account_id,
                          money(shares[j]), "USD", "wire", "wire_out", b.country, flow=out_signal,
                          parties=[b.ref], signal=out_signal))
    return txs, []


def layering(world: World, hero: str, sig: dict[str, Any], accounts: dict[str, str]) -> tuple[list[Tx], list[dict]]:
    """Hero -> X1 -> X2 -> X3 -> hero within days: a round trip with intermediate layering hops."""
    p, rng = sig["params"], random.Random(f"{sig['id']}")
    mine, cur = accounts[p.get("account", "deposit")], p.get("currency", "USD")
    chain = [world.add(opaque(sig["id"], "hop", i), names.business(rng, "trader", p["country"]), "company",
                       p["country"], ["shell_indicator", "high_risk_geography"]) for i in range(p["hops"])]
    txs: list[Tx] = []
    for start in map(parse_date, p["starts"]):
        amt, ts = money(p["amount"]), utc(start, 10 * 3600)
        hops = [(mine, chain[0].account_id, "wire_out", chain[0])]
        hops += [(chain[i].account_id, chain[i + 1].account_id, "wire_out", chain[i + 1]) for i in range(len(chain) - 1)]
        hops += [(chain[-1].account_id, mine, "wire_in", chain[-1])]
        for src, dst, ttype, cp in hops:
            txs.append(Tx(ts, src, dst, amt, cur, "wire", ttype, cp.country, flow=sig["id"], parties=[cp.ref],
                          signal=sig["id"]))
            amt, ts = money(amt * Decimal("0.985")), ts + timedelta(hours=p.get("hop_hours", 20))
    return txs, []


def trade_based(world: World, hero: str, sig: dict[str, Any], accounts: dict[str, str]) -> tuple[list[Tx], list[dict]]:
    """Trade payments plus linked Invoice/Shipment/TradeRecord facts; flagged trades mismatch or over-price."""
    p, rng = sig["params"], random.Random(f"{sig['id']}")
    mine, cur = accounts[p.get("account", "trade_finance")], p.get("currency", "USD")
    buyers = [r for pool in p["buyers"] for r in world.pools[pool]]
    suppliers = [r for pool in p["suppliers"] for r in world.pools[pool]]
    start, end = parse_date(sig["window"][0]), parse_date(sig["window"][1])
    span = (end - start).days
    flagged_mismatch = set(rng.sample(range(p["trades"]), p["mismatch"]))
    flagged_price = set(rng.sample([i for i in range(p["trades"]) if i not in flagged_mismatch], p["overpriced"]))
    txs: list[Tx] = []
    trades: list[dict] = []
    for i in range(p["trades"]):
        day = start + timedelta(days=int(span * i / p["trades"]) + rng.randint(0, 5))
        while not is_business(day):
            day += timedelta(days=1)
        good = rng.choice(p["goods"])
        qty = Decimal(rng.randint(p["quantity"][0], p["quantity"][1]))
        bench = Decimal(str(good["benchmark_unit_price"]))
        price = money(bench * (Decimal("1.45") if i in flagged_price else Decimal(str(rng.uniform(0.96, 1.04)))))
        ship_qty = qty - Decimal(rng.randint(int(qty) // 6, int(qty) // 3)) if i in flagged_mismatch else qty
        buyer, supplier = world.cps[rng.choice(buyers)], world.cps[rng.choice(suppliers)]
        flagged = i in flagged_mismatch or i in flagged_price
        route = [p["origin"], rng.choice(p["transship"]), buyer.country] if flagged else [p["origin"], buyer.country]
        value = money(price * qty)
        signal = sig["id"] if flagged else ""
        txs.append(Tx(utc(day, 11 * 3600), buyer.account_id, mine, value, cur, "swift", "trade_receipt", buyer.country,
                      flow="trade", parties=[buyer.ref], signal=signal))
        cost = money(bench * qty * Decimal("0.92"))
        txs.append(Tx(utc(day - timedelta(days=3), 14 * 3600), mine, supplier.account_id, cost, cur, "swift",
                      "trade_payment", supplier.country, flow="trade", parties=[supplier.ref], signal=signal))
        trades.append({"n": i + 1, "good": good["name"], "unit_price": price, "quantity": qty, "shipped": ship_qty,
                       "currency": cur, "benchmark": bench, "route": route, "buyer": buyer.ref, "supplier": supplier.ref,
                       "flagged": flagged, "mismatch": i in flagged_mismatch, "overpriced": i in flagged_price,
                       "date": day.isoformat()})
    return txs, trades


INJECTORS = {"structuring": structuring, "funnel": funnel, "layering": layering, "trade_based": trade_based}


def cash_day(world: World, hero: str, sig: dict[str, Any], accounts: dict[str, str]) -> tuple[list[Tx], list[dict]]:
    """Legitimate high-cash days (e.g. a courier's peak day): above the CTR threshold, with no structuring."""
    p, rng = sig["params"], random.Random(f"{sig['id']}")
    cash = world.cps.get("cash-in") or world.add("cash-in", "Cash deposits (teller)", "company", "US")
    txs = []
    for d in map(parse_date, p["days"]):
        total = float(p["total"])
        parts = [rng.uniform(0.8, 1.2) for _ in range(p["deposits"])]
        for i, share in enumerate(parts):
            txs.append(Tx(utc(d, 9 * 3600 + 1800 * i), cash.account_id, accounts[p.get("account", "deposit")],
                          money(total * share / sum(parts)), "USD", "cash", "cash_deposit", cash.country,
                          flow=sig["id"], parties=["cash-in"], signal=sig["id"], meta={"branch": "branch-1"}))
    return txs, []


INJECTORS["cash_day"] = cash_day


from .digital import account_takeover  # noqa: E402

INJECTORS["account_takeover"] = account_takeover
