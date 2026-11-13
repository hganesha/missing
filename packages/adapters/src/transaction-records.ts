import { stableDigest } from "@ehf/contracts";
import { extensionBlock } from "@ehf/library-contracts";
import type { NormalizedRecords, RecordSourceContext } from "./canonical-records.js";
import { recordWriter } from "./record-writer.js";

/**
 * `financial.transactions.v1` normalizer: ISO 20022 `camt.053` statements → `Transaction` records
 * (and a `DatasetScope` when the provider states the window). Same contract as the other
 * normalizers in this package: canonical fields only, source fields under
 * `data.extensions["ehf.connector"]`, every record validated before it leaves, and no records
 * (plus a `recordGap`) when the result cannot establish what a skill needs.
 *
 * Completeness is never inferred from the entries: a `DatasetScope` is written only from a scope
 * the provider supplied, and only with `complete: true` when the provider said so.
 */
export const TRANSACTION_NORMALIZER = "wiring.transactions";
export const TRANSACTION_NORMALIZER_VERSION = "1";
const NAMESPACE = "ehf.connector";
const EXTENSION_VERSION = "1.0.0";

export type TransactionScope = { start: string; end: string; complete: boolean; expected_count: number; watermark: string };
export type TransactionStatementsInput = {
  /** One or more camt.053 documents, in the subset `parseCamt053` accepts. */
  statements: string[];
  /** The provider's statement of the window and completeness; absent: no DatasetScope is written. */
  scope?: TransactionScope;
  /** Account identifier → entity id, used to make both parties subjects of each transaction. */
  accountEntities?: Record<string, string>;
  /** Restrict to these statement accounts. A restricted result can never claim the full scope. */
  accounts?: string[];
  /** True when the provider ran in simulation, fixture or replay mode. */
  synthetic?: boolean;
};

export type StatementEntry = {
  statementAccount: string; eventId: string; amount: string; currency: string; timestamp: string;
  source: string; target: string; credit: boolean; status: "settled" | "pending" | "reversed" | "cancelled";
  transactionType: string; rail: string; country: string; extras: Record<string, string>;
};

const unescapeXml = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Element and value extraction by linear scanning. Lazy regexes such as
// /<Stmt>[\s\S]*?<\/Stmt>/ or /<Id>(.*?)<\/Id>/ backtrack polynomially on hostile provider
// input; these helpers return exactly what those patterns matched, in one pass.

/** Every `<tag>…</tag>` element, including its tags: the global matches of /<tag>[\s\S]*?<\/tag>/g. */
function elements(xml: string, tag: string): string[] {
  const open = `<${tag}>`, close = `</${tag}>`;
  const found: string[] = [];
  for (let start = xml.indexOf(open); start >= 0;) {
    const end = xml.indexOf(close, start + open.length);
    if (end < 0) break;
    found.push(xml.slice(start, end + close.length));
    start = xml.indexOf(open, end + close.length);
  }
  return found;
}

/** The first match of /open(.*?)close/: like `.`, the value never spans a line break. */
function between(body: string, open: string, close: string): string | undefined {
  for (let start = body.indexOf(open); start >= 0;) {
    const from = start + open.length;
    const end = body.indexOf(close, from);
    if (end < 0) return undefined;
    const value = body.slice(from, end);
    const lineBreak = value.search(/[\n\r\u2028\u2029]/);
    if (lineBreak < 0) return value;
    // Every opening tag before the break would reach the same closing tag across it.
    start = body.indexOf(open, from + lineBreak);
  }
  return undefined;
}

function one(body: string, open: string, close: string, field: string): string {
  const value = between(body, open, close);
  if (value === undefined) throw new Error(`camt053.entry_missing_${field}`);
  return unescapeXml(value);
}

/** A one-word code: the match of /open(\w+)close/. */
function code(body: string, open: string, close: string, field: string): string {
  const value = between(body, open, close);
  if (value === undefined || !/^\w+$/.test(value)) throw new Error(`camt053.entry_missing_${field}`);
  return value;
}

/** Strict parser for the camt.053 subset providers of this capability emit; anything else throws. */
export function parseCamt053(xml: string): StatementEntry[] {
  if (!xml.includes("camt.053")) throw new Error("camt053.not_a_statement");
  const entries: StatementEntry[] = [];
  for (const stmt of elements(xml, "Stmt")) {
    const statementAccount = one(stmt, "<Acct><Id><Othr><Id>", "</Id>", "account");
    for (const body of elements(stmt, "Ntry")) {
      const credit = code(body, "<CdtDbtInd>", "</CdtDbtInd>", "direction") === "CRDT";
      const statusCode = code(body, "<Sts><Cd>", "</Cd></Sts>", "status");
      const info = between(body, "<AddtlNtryInf>", "</AddtlNtryInf>") ?? "";
      const extras = Object.fromEntries(unescapeXml(info).split(";").filter((p) => p.includes("=")).map((p) => p.split("=") as [string, string]));
      const status = extras.status === "cancelled" ? "cancelled" : body.includes("<RvslInd>true</RvslInd>") ? "reversed" : statusCode === "PDNG" ? "pending" : "settled";
      const amount = /<Amt Ccy="(\w+)">/.exec(body);
      if (!amount) throw new Error("camt053.entry_missing_currency");
      entries.push({
        statementAccount, credit, status, extras,
        eventId: one(body, "<NtryRef>", "</NtryRef>", "reference"),
        amount: one(body.slice(amount.index), amount[0], "</Amt>", "amount"),
        currency: unescapeXml(amount[1]!),
        timestamp: one(body, "<BookgDt><DtTm>", "</DtTm>", "booking_time"),
        source: one(body, "<DbtrAcct><Id><Othr><Id>", "</Id>", "debtor_account"),
        target: one(body, "<CdtrAcct><Id><Othr><Id>", "</Id>", "creditor_account"),
        transactionType: one(body, "<BkTxCd><Prtry><Cd>", "</Cd>", "type"),
        rail: one(body, "<Issr>", "</Issr>", "rail"),
        country: one(body, "<AddtlTxInf>ctry=", "</AddtlTxInf>", "country"),
      });
    }
  }
  return entries;
}

const gap = (reason: string): NormalizedRecords => ({ records: [], recordGap: { code: "EVIDENCE_GAP", reason, outcome: null } });
const validTime = (value: string) => Number.isFinite(Date.parse(value));
const AMOUNT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function normalizeTransactionStatements(input: TransactionStatementsInput, context: RecordSourceContext): NormalizedRecords {
  let entries: StatementEntry[];
  try {
    entries = input.statements.flatMap(parseCamt053).filter((e) => !input.accounts || input.accounts.includes(e.statementAccount));
  } catch (error) {
    return gap(`statement not parseable: ${(error as Error).message}`);
  }
  if (entries.length === 0) return gap("statement contained no entries");

  const seen = new Map<string, string>();
  const unique: StatementEntry[] = [];
  for (const entry of entries) {
    if (!AMOUNT.test(entry.amount) || !validTime(entry.timestamp)) return gap(`entry ${entry.eventId} has an invalid amount or time`);
    // A credit must name the statement account as creditor, a debit as debtor; otherwise the sides are unreliable.
    if ((entry.credit ? entry.target : entry.source) !== entry.statementAccount) return gap(`entry ${entry.eventId} disagrees with its statement account`);
    const semantic = stableDigest({ a: entry.amount, c: entry.currency, s: entry.source, t: entry.target, ts: entry.timestamp, st: entry.status });
    const prior = seen.get(entry.eventId);
    if (prior !== undefined) {
      if (prior !== semantic) return gap(`event ${entry.eventId} appears twice with conflicting values`);
      continue;
    }
    seen.set(entry.eventId, semantic);
    unique.push(entry);
  }

  const observedAt = context.observedAt ?? new Date(Math.max(...unique.map((e) => Date.parse(e.timestamp)))).toISOString();
  const { records, add } = recordWriter(context, TRANSACTION_NORMALIZER, TRANSACTION_NORMALIZER_VERSION, input.synthetic === true);

  const accountEntities = input.accountEntities ?? {};
  for (const e of unique) {
    const subjects = [...new Set([context.subjectId, accountEntities[e.source], accountEntities[e.target]].filter((s): s is string => Boolean(s)))];
    const { branch, flow } = e.extras;
    const block = extensionBlock(NAMESPACE, EXTENSION_VERSION, { rail: e.rail, ...(branch ? { branch } : {}), ...(flow ? { flow } : {}) });
    add("Transaction", `txn:${e.eventId}`, {
      source: e.source, target: e.target, amount: e.amount, currency: e.currency, timestamp: e.timestamp,
      event_id: e.eventId, status: e.status, transaction_type: e.transactionType, country: e.country,
      ...(block ? { extensions: block } : {}),
    }, subjects, e.timestamp);
  }

  if (input.scope) {
    const s = input.scope;
    // Provider-stated; a count that disagrees with what was returned can never be "complete".
    const complete = s.complete && s.expected_count === unique.length;
    add("DatasetScope", `scope:${s.start}/${s.end}`, { ...s, complete }, context.subjectId ? [context.subjectId] : [], observedAt);
  }
  return {
    records,
    recordGap: input.scope ? null : { code: "EVIDENCE_GAP", reason: "provider did not state the window or completeness; no DatasetScope written", outcome: null },
    ...(context.subjectId ? { subjectEntityId: context.subjectId } : {}),
  };
}
