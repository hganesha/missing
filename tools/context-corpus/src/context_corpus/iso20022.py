"""ISO 20022 source form: `camt.053` statements generated from the committed Transaction records."""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Any
from xml.sax.saxutils import escape, unescape

NS = "urn:iso:std:iso20022:tech:xsd:camt.053.001.08"
CORPUS = "ehf.corpus"


def _names(records: list[dict[str, Any]]) -> dict[str, str]:
    entity = {r["id"]: r["data"]["name"] for r in records if r["object_type"] == "Entity"}
    return {r["id"]: entity[r["data"]["entity_id"]] for r in records if r["object_type"] == "Account"}


def _acct(tag: str, name: str, account: str) -> str:
    return (f"<{tag}><Nm>{escape(name)}</Nm></{tag}><{tag}Acct><Id><Othr><Id>{escape(account)}</Id></Othr></Id></{tag}Acct>")


def camt053(party: str, records: list[dict[str, Any]], hero_accounts: set[str], as_of: str) -> str:
    names = _names(records)
    txs = sorted((r["data"] for r in records if r["object_type"] == "Transaction"), key=lambda d: (d["timestamp"], d["event_id"]))
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for d in txs:
        reporting = d["target"] if d["target"] in hero_accounts else d["source"] if d["source"] in hero_accounts else d["source"]
        groups[(reporting, d["timestamp"][:7])].append(d)
    out = ['<?xml version="1.0" encoding="UTF-8"?>', f'<Document xmlns="{NS}"><BkToCstmrStmt>',
           f"<GrpHdr><MsgId>camt053-{party.lower()}</MsgId><CreDtTm>{as_of}</CreDtTm></GrpHdr>"]
    for (acct, month), entries in sorted(groups.items()):
        out.append(f"<Stmt><Id>stmt-{party.lower()}-{escape(acct)}-{month}</Id><CreDtTm>{as_of}</CreDtTm>"
                   f"<Acct><Id><Othr><Id>{escape(acct)}</Id></Othr></Id><Ccy>{entries[0]['currency']}</Ccy></Acct>")
        for d in entries:
            ext = (d.get("extensions", {}).get(CORPUS, {}) or {}).get("value", {})
            credit = d["target"] == acct
            status = {"settled": "BOOK", "pending": "PDNG", "reversed": "BOOK", "cancelled": "BOOK"}[d["status"]]
            info = []
            if d["status"] == "cancelled":
                info.append("status=cancelled")
            info += [f"{k}={ext[k]}" for k in ("branch", "flow") if k in ext]
            out.append(
                f'<Ntry><NtryRef>{d["event_id"]}</NtryRef><Amt Ccy="{d["currency"]}">{d["amount"]}</Amt>'
                f'<CdtDbtInd>{"CRDT" if credit else "DBIT"}</CdtDbtInd>{"<RvslInd>true</RvslInd>" if d["status"] == "reversed" else ""}'
                f'<Sts><Cd>{status}</Cd></Sts><BookgDt><DtTm>{d["timestamp"]}</DtTm></BookgDt>'
                f'<ValDt><Dt>{d["timestamp"][:10]}</Dt></ValDt>'
                f'<BkTxCd><Prtry><Cd>{escape(d.get("transaction_type", ""))}</Cd><Issr>{escape(ext.get("rail", ""))}</Issr></Prtry></BkTxCd>'
                f'<NtryDtls><TxDtls><Refs><EndToEndId>{d["event_id"]}</EndToEndId></Refs><RltdPties>'
                f'{_acct("Dbtr", names.get(d["source"], ""), d["source"])}{_acct("Cdtr", names.get(d["target"], ""), d["target"])}'
                f'</RltdPties><AddtlTxInf>ctry={d.get("country", "")}</AddtlTxInf></TxDtls></NtryDtls>'
                + (f'<AddtlNtryInf>{escape(";".join(info))}</AddtlNtryInf>' if info else "") + "</Ntry>")
        out.append("</Stmt>")
    out.append("</BkToCstmrStmt></Document>")
    return "\n".join(out) + "\n"


_ENTRY = re.compile(r"<Ntry>(.*?)</Ntry>", re.S)


def _one(pattern: str, text: str, default: str | None = None) -> str:
    m = re.search(pattern, text, re.S)
    if not m:
        if default is None:
            raise ValueError(f"camt.053 entry missing {pattern}")
        return default
    return unescape(m.group(1))


def parse_camt053(xml: str) -> list[dict[str, Any]]:
    """Strict subset parser (the shape `camt053` writes): one dict per entry, in corpus field names."""
    rows = []
    for body in _ENTRY.findall(xml):
        credit = _one(r"<CdtDbtInd>(\w+)</CdtDbtInd>", body) == "CRDT"
        sts = _one(r"<Sts><Cd>(\w+)</Cd></Sts>", body)
        info = _one(r"<AddtlNtryInf>(.*?)</AddtlNtryInf>", body, "")
        status = "cancelled" if "status=cancelled" in info else "reversed" if "<RvslInd>true" in body else \
            "pending" if sts == "PDNG" else "settled"
        rows.append({
            "event_id": _one(r"<NtryRef>(.*?)</NtryRef>", body), "amount": _one(r'<Amt Ccy="\w+">(.*?)</Amt>', body),
            "currency": _one(r'<Amt Ccy="(\w+)">', body), "timestamp": _one(r"<BookgDt><DtTm>(.*?)</DtTm>", body),
            "source": _one(r"<DbtrAcct><Id><Othr><Id>(.*?)</Id>", body), "target": _one(r"<CdtrAcct><Id><Othr><Id>(.*?)</Id>", body),
            "transaction_type": _one(r"<BkTxCd><Prtry><Cd>(.*?)</Cd>", body), "rail": _one(r"<Issr>(.*?)</Issr>", body),
            "country": _one(r"<AddtlTxInf>ctry=(.*?)</AddtlTxInf>", body), "status": status, "credit": credit,
        })
    return rows
