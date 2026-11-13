"""Ledger engine: baseline behaviour flows over a business calendar, with a balance guard."""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any

from . import names
from .world import slug

CENT = Decimal("0.01")


def money(value: Any) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_EVEN)


def parse_date(text: Any) -> date:
    return date.fromisoformat(str(text)[:10])


def utc(day: date, seconds: int = 0) -> datetime:
    return datetime.combine(day, time(0), tzinfo=timezone.utc) + timedelta(seconds=seconds)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_business(day: date) -> bool:
    return day.weekday() < 5


def next_business(day: date) -> date:
    while not is_business(day):
        day += timedelta(days=1)
    return day


@dataclass
class Counterparty:
    ref: str
    name: str
    kind: str          # individual | company
    country: str
    risk_indicators: list[str] = field(default_factory=list)
    account_id: str = ""
    attrs: dict[str, str] = field(default_factory=dict)   # phone / email / address (shared-attribute linking)


@dataclass
class Tx:
    ts: datetime
    source: str
    target: str
    amount: Decimal
    currency: str
    rail: str
    ttype: str
    country: str
    status: str = "settled"
    flow: str = ""
    parties: list[str] = field(default_factory=list)   # counterparty refs touched (besides the customer)
    meta: dict[str, Any] = field(default_factory=dict)
    seq: int = 0
    event_id: str = ""
    signal: str = ""          # planted-signal id; kept out of emitted records (answer key only)


class World:
    """Counterparties and accounts for one party; account ids are stable and ref-derived."""

    def __init__(self, party: str, spec: dict[str, Any], rng: random.Random):
        self.party = party.lower()
        self.rng = rng
        self.cps: dict[str, Counterparty] = {}
        self.digital: dict[str, list[dict[str, Any]]] = {"devices": [], "sessions": [], "auth": []}
        self.ring: list[Counterparty] = []   # entities that share attributes but never transact
        self.pools: dict[str, list[str]] = {}
        led = spec["ledger"]
        self.start = parse_date(led["start"])
        self.end = parse_date(led["end"])
        for c in led.get("counterparties", []):
            self.add(c["ref"], c["name"], c["kind"], c["country"], c.get("risk_indicators", []), c.get("attrs"))
        for pool in led.get("pools", []):
            made = names.unique_names(rng, pool["size"], (lambda p=pool: names.business(rng, p["style"], p["country"])
                                      if p["kind"] == "company" else names.person(rng)))
            self.pools[pool["ref"]] = []
            for i, name in enumerate(made):
                ref = f"{pool['ref']}-{i + 1:02d}"
                self.add(ref, name, pool["kind"], pool["country"], pool.get("risk_indicators", []))
                self.pools[pool["ref"]].append(ref)

    def add(self, ref: str, name: str, kind: str, country: str, risk: list[str] | None = None,
            attrs: dict[str, str] | None = None) -> Counterparty:
        cp = Counterparty(ref, name, kind, country, list(risk or []), f"{self.party}.account.cp-{slug(ref)}", dict(attrs or {}))
        self.cps[ref] = cp
        return cp

    def acct(self, ref: str) -> str:
        return self.cps[ref].account_id


def _months(start: date, end: date):
    cur = date(start.year, start.month, 1)
    while cur < end:
        nxt = date(cur.year + (cur.month == 12), cur.month % 12 + 1, 1)
        yield cur, nxt
        cur = nxt


def _amount(rng: random.Random, spec: dict[str, Any]) -> Decimal:
    if "value" in spec:
        base = float(spec["value"]) * (1 + rng.uniform(-spec.get("jitter", 0), spec.get("jitter", 0)))
    else:
        base = rng.lognormvariate(__import__("math").log(float(spec["median"])), float(spec.get("sigma", 0.5)))
    lo, hi = float(spec.get("floor", 0.01)), float(spec.get("cap", 1e12))
    return money(min(max(base, lo), hi))


def baseline(world: World, spec: dict[str, Any], accounts: dict[str, str], customer_ref: str) -> list[Tx]:
    """Generate baseline flows. `accounts` maps product type -> hero account id."""
    txs: list[Tx] = []
    for flow in spec["ledger"].get("flows", []):
        rng = random.Random(f"{spec['seed']}:{flow['id']}")
        mine = accounts[flow.get("account", "deposit")]
        inbound = flow["direction"] == "in"
        counterparties = flow.get("counterparties") or ([flow["counterparty"]] if flow.get("counterparty") else [])
        refs: list[str] = []
        for c in counterparties:
            refs += world.pools.get(c, [c])
        last_used: dict[str, date] = {}
        daily: dict[date, int] = {}

        def emit(day: date, cp_ref: str, amount: Decimal, seconds: int | None = None) -> None:
            cp = world.cps[cp_ref]
            sec = seconds if seconds is not None else rng.randint(8 * 3600, 17 * 3600 + 3599)
            txs.append(Tx(utc(day, sec), cp.account_id if inbound else mine, mine if inbound else cp.account_id,
                          amount, flow.get("currency", "USD"), flow["rail"], flow["type"], cp.country,
                          flow=flow["id"], parties=[cp_ref], meta={"branch": rng.choice(flow["branches"])}
                          if flow.get("branches") else {}))
            daily[day] = daily.get(day, 0) + 1
            last_used[cp_ref] = day

        sched = flow.get("schedule")
        if sched:
            cp_ref = refs[0]
            if sched["freq"] == "monthly":
                for m0, m1 in _months(world.start, world.end):
                    day = next_business(m0 + timedelta(days=sched["day"] - 1))
                    if world.start <= day < world.end:
                        emit(day, cp_ref, _amount(rng, flow["amount"]))
            else:
                step = {"weekly": 7, "biweekly": 14}[sched["freq"]]
                day = parse_date(sched["anchor"])
                while day < world.end:
                    if day >= world.start:
                        emit(day, cp_ref, _amount(rng, flow["amount"]))
                    day += timedelta(days=step)
            continue

        season = flow.get("seasonality", [1.0] * 12)
        cooldown = timedelta(days=flow.get("cooldown_days", 5))
        cap = flow.get("max_per_day", 99)
        for m0, m1 in _months(world.start, world.end):
            count = round(flow["per_month"] * season[m0.month - 1] * rng.uniform(0.85, 1.15))
            days = [m0 + timedelta(days=i) for i in range((m1 - m0).days)]
            days = [d for d in days if is_business(d) and world.start <= d < world.end]
            for _ in range(count):
                for _try in range(40):
                    day = rng.choice(days)
                    if daily.get(day, 0) >= cap:
                        continue
                    pool = [r for r in refs if r not in last_used or day - last_used[r] >= cooldown or last_used[r] > day]
                    if pool:
                        break
                else:
                    continue
                weights = [1 / (i + 1) ** 0.5 for i in range(len(pool))]
                emit(day, rng.choices(pool, weights)[0], _amount(rng, flow["amount"]))
    return txs


def apply_balance_guard(txs: list[Tx], opening: dict[str, Decimal]) -> list[Tx]:
    """Drop baseline outflows that would overdraw a hero account (no overdraft product assumed)."""
    balance = dict(opening)
    kept: list[Tx] = []
    for tx in sorted(txs, key=lambda t: (t.ts, t.flow, t.source, t.target, t.amount)):
        if tx.source in balance and balance[tx.source] < tx.amount:
            continue
        if tx.source in balance:
            balance[tx.source] -= tx.amount
        if tx.target in balance:
            balance[tx.target] += tx.amount
        kept.append(tx)
    return kept


def balances(txs: list[Tx], opening: dict[str, Decimal]) -> dict[str, Decimal]:
    bal = dict(opening)
    for tx in sorted(txs, key=lambda t: t.ts):
        if tx.status in {"cancelled", "reversed"}:
            continue
        if tx.source in bal:
            bal[tx.source] -= tx.amount
        if tx.target in bal:
            bal[tx.target] += tx.amount
    return bal


def min_running_balance(txs: list[Tx], opening: dict[str, Decimal]) -> dict[str, Decimal]:
    bal, low = dict(opening), dict(opening)
    for tx in sorted(txs, key=lambda t: t.ts):
        if tx.status in {"cancelled", "reversed"}:
            continue
        for acct, sign in ((tx.source, -1), (tx.target, 1)):
            if acct in bal:
                bal[acct] += sign * tx.amount
                low[acct] = min(low[acct], bal[acct])
    return low
