"""Digital and fraud layer (L8): devices, sessions, authentication events, payments, fraud signals.

Baseline behaviour is the customer's own history; the account-takeover injector plants one episode
(new device, credential reset, impossible travel, a new payee that is a mule, a probe payment and a
large held payment). Fraud signals are scored by a transparent rule model (`corpus-fraud-rules-v1`),
so the answer key can say why each score is what it is.
"""
from __future__ import annotations

import random
from datetime import timedelta
from decimal import Decimal
from typing import Any

from . import names
from .ledger import Tx, World, is_business, money, parse_date, utc
from .world import fraction, sha256_hex

MODEL_VERSION = "corpus-fraud-rules-v1"
BASELINE = {"typing_speed": ("48", "72"), "session_seconds": ("120", "900"), "pages_per_session": ("3", "14")}
PRIMARY_DEVICE = {"os": "iOS 18", "browser": "Safari"}


def ato_score(signals: dict[str, Any]) -> str:
    """Rule model: reset .25, new device .25, impossible travel .30, failed attempts .05 each (max 4)."""
    score = (Decimal("0.25") * bool(signals.get("credential_reset")) + Decimal("0.25") * bool(signals.get("new_device"))
             + Decimal("0.30") * bool(signals.get("impossible_travel")) + Decimal("0.05") * min(signals.get("failed_attempts", 0), 4))
    return fraction(min(score, Decimal(1)))


def payment_score(amount: Decimal, baseline_maximum: Decimal) -> str:
    over = max(Decimal(0), amount - baseline_maximum)
    return fraction(min(Decimal(1), over / (baseline_maximum * 2)))


def _features(rng: random.Random) -> dict[str, str]:
    out = {}
    for name, (lo, hi) in BASELINE.items():
        lo_d, hi_d = Decimal(lo), Decimal(hi)
        out[name] = str((lo_d + (hi_d - lo_d) * Decimal(str(round(rng.uniform(0.2, 0.8), 3)))).quantize(Decimal("0.1")))
    return out


def baseline(world: World, spec: dict[str, Any]) -> None:
    cfg = spec.get("digital")
    if not cfg:
        return
    rng = random.Random(f"{spec['seed']}:digital")
    world.digital["devices"].append({"ref": "primary", **PRIMARY_DEVICE, "permitted": True})
    months, cur = [], world.start.replace(day=1)
    while cur < world.end:
        nxt = cur.replace(year=cur.year + (cur.month == 12), month=cur.month % 12 + 1)
        if (min(nxt, world.end) - max(cur, world.start)).days >= 15:
            months.append(cur)
        cur = nxt
    for m0 in months:
        days = [m0 + timedelta(days=i) for i in range(28) if is_business(m0 + timedelta(days=i))]
        for k, day in enumerate(sorted(rng.sample(days, cfg["sessions_per_month"]))):
            ref = f"s-{m0.year}{m0.month:02d}-{k + 1}"
            world.digital["sessions"].append({"ref": ref, "at": utc(day, rng.randint(18 * 3600, 22 * 3600)), "device": "primary",
                                              "features": _features(rng), "ato": False})
            failed = 1 if rng.random() < 0.1 else 0
            world.digital["auth"].append({"session": ref, "signals": {"credential_reset": False, "failed_attempts": failed,
                                                                      "impossible_travel": False, "new_device": False}})


def account_takeover(world: World, hero: str, sig: dict[str, Any], accounts: dict[str, str]) -> tuple[list[Tx], list[dict]]:
    p, rng = sig["params"], random.Random(sig["id"])
    mine, cur = accounts[p.get("account", "deposit")], p.get("currency", "EUR")
    day = parse_date(p["day"])
    world.digital["devices"].append({"ref": "takeover", "os": "Android 14", "browser": "Chrome", "permitted": True})
    ref = "s-takeover"
    world.digital["sessions"].append({"ref": ref, "at": utc(day, 2 * 3600 + 14 * 60), "device": "takeover", "ato": True,
                                      "features": {"typing_speed": "118.0", "session_seconds": "41.0", "pages_per_session": "2.0"}})
    world.digital["auth"].append({"session": ref, "signals": {"credential_reset": True, "failed_attempts": 4,
                                                              "impossible_travel": True, "new_device": True}, "signal": sig["id"]})
    shared_phone = p["shared_phone"]
    mule = world.add(f"mule-{sha256_hex(sig['id'])[:6]}", names.person(rng), "individual", p.get("payee_country", "NL"),
                     ["mule_account", "new_payee"], {"phone": shared_phone})
    for i in range(p.get("ring_size", 2)):
        world.ring.append(world.add(f"ring-{sha256_hex(sig['id'] + str(i))[:6]}", names.person(rng), "individual", "NL", [],
                                    {"phone": shared_phone}))
    probe = Tx(utc(day, 2 * 3600 + 36 * 60), mine, mule.account_id, money(p["probe"]), cur, "sepa_instant", "transfer", mule.country,
               flow=sig["id"], parties=[mule.ref], signal=sig["id"])
    main = Tx(utc(day, 2 * 3600 + 44 * 60), mine, mule.account_id, money(p["amount"]), cur, "sepa_instant", "transfer", mule.country,
              status="pending", flow=sig["id"], parties=[mule.ref], signal=sig["id"])
    return [probe, main], []


def emit(b, spec: dict[str, Any], world: World, customer_eid: str, txs: list[Tx], tx_ids: dict[int, str],
         hero_accounts: set[str], ext) -> dict[str, dict[str, list[str]]]:
    """Write L8 records; returns planted record ids per signal id (answer key only)."""
    cfg = spec.get("digital")
    by_signal: dict[str, dict[str, list[str]]] = {}
    if not cfg:
        return by_signal
    subj = [customer_eid]
    devices = {}
    for d in world.digital["devices"]:
        devices[d["ref"]] = b.add("Device", d["ref"], {"attributes": {"device_id": f"dev-{d['ref']}", "os": d["os"], "browser": d["browser"]},
                                                       "permitted": d["permitted"]}, subjects=subj)
    sessions: dict[str, str] = {}
    base = {k: {"minimum": lo, "maximum": hi} for k, (lo, hi) in BASELINE.items()}
    for s in world.digital["sessions"]:
        when = s["at"].strftime("%Y-%m-%dT%H:%M:%SZ")
        sessions[s["ref"]] = b.add("Session", s["ref"], {"modality": "web", "features": s["features"], "baseline": base,
                                   "extensions": ext({"device": devices[s["device"]]})}, subjects=subj, observed_at=when)
    def evidence(key: str, text: str, when: str) -> str:
        return b.add("Evidence", key, {"content": text, "content_hash": sha256_hex(text), "source_id": f"{spec['id']}-{key}",
                                       "requirement_ids": [], "verified": True}, subjects=subj, observed_at=when)
    for a in world.digital["auth"]:
        s = next(x for x in world.digital["sessions"] if x["ref"] == a["session"])
        when = s["at"].strftime("%Y-%m-%dT%H:%M:%SZ")
        auth = b.add("AuthenticationEvent", a["session"], {"session_id": sessions[a["session"]], "signals": a["signals"]},
                     subjects=subj, observed_at=when)
        ev = evidence(f"session-{a['session']}", f"SPECIMEN authentication log for session {a['session']}", when)
        sig = b.add("FraudSignal", f"ato-{a['session']}", {"score": ato_score(a["signals"]), "kind": "account_takeover",
                    "model_version": MODEL_VERSION, "evidence_ids": [ev]}, subjects=subj, observed_at=when)
        if s["ato"]:
            sid = a.get("signal", "")
            by_signal.setdefault(sid, {}).update({"Session": [sessions[a["session"]]], "AuthenticationEvent": [auth],
                                                  "FraudSignal": [sig], "Device": [devices[s["device"]]]})
    pay = cfg.get("payments")
    if pay:
        cap = Decimal(pay["baseline_maximum"])
        for tx in txs:
            if tx.source in hero_accounts and tx.ttype in pay["types"] and tx.status != "cancelled":
                when = tx.ts.strftime("%Y-%m-%dT%H:%M:%SZ")
                rec = b.add("Payment", f"{tx.seq:06d}", {"amount": str(tx.amount), "currency": tx.currency, "baseline_maximum": str(cap),
                            "extensions": ext({"event_id": tx.event_id})}, subjects=subj, observed_at=when)
                ev = evidence(f"payment-{tx.seq:06d}", f"SPECIMEN payment instruction {tx.event_id}", when)
                fs = b.add("FraudSignal", f"pay-{tx.seq:06d}", {"score": payment_score(tx.amount, cap), "kind": "payment_anomaly",
                           "model_version": MODEL_VERSION, "evidence_ids": [ev]}, subjects=subj, observed_at=when)
                if tx.signal and tx.amount > cap:
                    by_signal.setdefault(tx.signal, {}).setdefault("Payment", []).append(rec)
                    by_signal[tx.signal].setdefault("FraudSignal", []).append(fs)
    return by_signal
