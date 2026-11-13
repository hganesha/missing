"""Turn a spec's ledger block into records: counterparties, accounts, transactions, scope, trade facts."""
from __future__ import annotations

import random
from decimal import Decimal
from typing import Any

from . import digital as dg
from . import ledger as L
from .typologies import INJECTORS
from .world import slug

EXT = "ehf.corpus"


def ext(value: dict[str, Any]) -> dict[str, Any]:
    return {EXT: {"schema_version": "1.0.0", "value": value}}


def emit_ledger(b, spec: dict[str, Any], customer_eid: str, accounts: dict[str, str]) -> dict[str, Any]:
    party = spec["id"]
    led = spec["ledger"]
    rng = random.Random(f"{spec['seed']}:world")
    world = L.World(party, spec, rng)
    opening = {accounts[k]: Decimal(v) for k, v in led.get("opening_balance", {}).items()}
    txs = L.apply_balance_guard(L.baseline(world, spec, accounts, spec["customer"]), opening)
    trades: list[dict] = []
    dg.baseline(world, spec)
    for sig in spec.get("signals", []):
        inject = INJECTORS.get(sig["type"])
        if inject:
            new_txs, new_trades = inject(world, party, sig, accounts)
            txs += new_txs
            trades += new_trades
    txs.sort(key=lambda t: (t.ts, t.source, t.target, t.amount, t.flow))
    for i, tx in enumerate(txs, 1):
        tx.seq, tx.event_id = i, f"evt-{party.lower()}-{i:06d}"
    low = L.min_running_balance(txs, opening)
    negative = {a: str(v) for a, v in low.items() if v < 0}
    if negative:
        raise ValueError(f"{party}: ledger overdraws hero accounts {negative}")

    used = {r for t in txs for r in t.parties}
    cp_entity = lambda ref: f"{party.lower()}.entity.cp-{slug(ref)}"  # noqa: E731
    for ref in sorted(used):
        cp = world.cps[ref]
        eid = b.add("Entity", f"cp-{ref}", {"name": cp.name, "identifiers": [f"{party}-cp-{slug(ref)}"],
                    "entity_type": "company" if cp.kind == "company" else "individual",
                    "attributes": dict(cp.attrs)},
                    subjects=[customer_eid, cp_entity(ref)] if cp.attrs else [cp_entity(ref)])
        b.add("Account", f"cp-{ref}", {"entity_id": eid, "account_type": "external", "currency": "USD", "status": "open"},
              subjects=[eid])
        b.add("Counterparty", ref, {"entity_id": eid, "risk_indicators": cp.risk_indicators, "evidence_ids": []},
              subjects=[customer_eid, eid])
        b.add("Relationship", f"{spec['customer']}.{ref}", {"source": customer_eid, "target": eid,
              "relation": "transacts_with", "verified": True}, subjects=[customer_eid, eid])

    for r in world.ring:   # entities that share attributes with a counterparty but never transact
        b.add("Entity", f"cp-{r.ref}", {"name": r.name, "identifiers": [f"{party}-cp-{slug(r.ref)}"], "entity_type": "individual",
              "attributes": dict(r.attrs)}, subjects=[customer_eid, cp_entity(r.ref)])
    by_account = {world.cps[r].account_id: r for r in used}
    ids: dict[int, str] = {}
    for tx in txs:
        data = {"source": tx.source, "target": tx.target, "amount": str(tx.amount), "currency": tx.currency,
                "timestamp": L.iso(tx.ts), "event_id": tx.event_id, "status": tx.status,
                "transaction_type": tx.ttype, "country": tx.country,
                "extensions": ext({"rail": tx.rail, **({"flow": tx.flow} if not tx.signal and tx.flow else {}), **tx.meta})}
        ids[tx.seq] = b.add("Transaction", f"{tx.seq:06d}", data, subjects=[customer_eid, *(cp_entity(by_account[a]) for a in (tx.source, tx.target) if a in by_account)],
                            observed_at=L.iso(tx.ts))

    fraud = dg.emit(b, spec, world, customer_eid, txs, ids, set(accounts.values()), ext)
    scope_end = L.utc(world.end)
    b.add("DatasetScope", "ledger", {"start": L.iso(L.utc(world.start)), "end": L.iso(scope_end), "complete": True,
          "expected_count": len(txs), "watermark": b.as_of}, subjects=[customer_eid])

    trade_ids: dict[int, dict[str, str]] = {}
    for t in trades:
        n = t["n"]
        inv = b.add("Invoice", f"trade-{n:03d}", {"unit_price": str(t["unit_price"]), "quantity": str(t["quantity"]),
                    "currency": t["currency"], "extensions": ext({"good": t["good"], "benchmark_unit_price": str(t["benchmark"])})},
                    subjects=[customer_eid], observed_at=L.iso(L.utc(L.parse_date(t["date"]))))
        shp = b.add("Shipment", f"trade-{n:03d}", {"quantity": str(t["shipped"]), "extensions": ext({"route": t["route"]})},
                    subjects=[customer_eid], observed_at=L.iso(L.utc(L.parse_date(t["date"]))))
        rec = b.add("TradeRecord", f"trade-{n:03d}", {"invoice_id": inv, "shipment_id": shp}, subjects=[customer_eid])
        trade_ids[n] = {"trade": rec, "flagged": t["flagged"], "mismatch": t["mismatch"], "overpriced": t["overpriced"]}

    # Hero accounts carry their opening balance so the balance invariant can be checked from the records.
    for ptype, rid in accounts.items():
        rec = next(r for r in b.records if r["id"] == rid)
        if rid in {a for a in opening}:
            rec["data"]["extensions"] = ext({"opening_balance": str(opening[rid])})

    by_signal: dict[str, list[str]] = {}
    for tx in txs:
        if tx.signal:
            by_signal.setdefault(tx.signal, []).append(ids[tx.seq])
    ring_ids = [cp_entity(r.ref) for r in world.ring]
    return {"signals": by_signal, "signal_records": fraud, "ring_entities": ring_ids, "tx_count": len(txs), "trades": trade_ids,
            "window": [L.iso(L.utc(world.start)), L.iso(scope_end)],
            "hero_accounts": sorted(accounts.values())}
