import {
  discoveryAgentDraftSchema, discoverySearchResultSchema, discoverySearchSeedSchema,
  type DiscoveryBrief,
} from "@ehf/contracts";

const searches = [
  ["commercial register", "Handelsregister", "former name", "acquired by", "subsidiary of", "wholly owned", "group structure"],
  ["judgment", "consent order", "enforcement action", "fraud charges", "bribery", "money laundering", "sanctions evasion", "plant closure", "layoffs", "cyber breach"],
  ["bankruptcy", "bankruptcy filing", "insolvency", "Chapter 11", "winding up", "administration", "restructuring", "liquidation", "going concern", "net loss", "operating loss", "widening losses", "impairment charge", "profit warning"],
  ["credit rating downgrade", "credit rating upgrade", "negative outlook", "positive outlook", "outlook revision", "rating watch", "rating withdrawal"],
];

const fixture = [
  {
    sourceId: "court-restructuring", kind: "court", title: "Fictional court docket: restructuring filing",
    url: "https://court.example/restructuring", publishedOn: "2025-05-03",
    snippet: "A fictional court docket reports a restructuring filing on 2025-05-02 for Asterion Advanced Materials. The abbreviated company name lacks a registration identifier.",
  },
  {
    sourceId: "issuer-operating-loss", kind: "issuer", title: "Fictional annual results: operating loss",
    url: "https://issuer.example/annual-report", publishedOn: "2025-04-30",
    snippet: "A fictional annual report attributed to Asterion Advanced Materials Ltd. reports an operating loss for the financial year ended 2024-12-31.",
  },
  {
    sourceId: "rating-downgrade", kind: "rating_agency", title: "Fictional Meridian Ratings notice: credit rating downgrade",
    url: "https://ratings.example/rating-action", publishedOn: "2025-05-05",
    snippet: "Fictional Meridian Ratings reported a credit rating downgrade on 2025-05-05 for the issuer named Asterion Advanced Materials Ltd. The notice is a downgrade, distinct from an outlook revision.",
  },
] as const;

export function searchDiscoveryFixture(raw: unknown) {
  const seed = discoverySearchSeedSchema.parse(raw);
  const observedAt = new Date().toISOString();
  const results = fixture.filter(result => searches.some(terms => terms.some(term => result.snippet.toLowerCase().includes(term.toLowerCase()))))
    .map(result => ({ ...result, observedAt }));
  return discoverySearchResultSchema.parse({
    schemaVersion: "discovery.search.v1",
    origin: "synthetic_fixture",
    queries: searches.map(terms => `"${seed.companyName}" ${seed.country} (${terms.map(term => `"${term}"`).join(" OR ")})`),
    results,
    limitations: ["Fictional search index. These results describe a synthetic company and carry no real-world coverage."],
  });
}

const recordedSignals = [
  {
    category: "bankruptcy", headline: "Possible restructuring filing for a similarly named company",
    reportedStage: "Filing reported", eventOn: "2025-05-02", sourceIds: ["court-restructuring"],
    match: "uncertain", matchBasis: "The fictional docket uses an abbreviated name and gives no registration identifier.",
    priority: "high", verificationQuestion: "Does the court docket identify the customer as the entity that filed?",
  },
  {
    category: "financial_losses", headline: "Reported operating loss for the 2024 financial year",
    reportedStage: "Annual results reported", eventOn: "2024-12-31", sourceIds: ["issuer-operating-loss"],
    match: "possible", matchBasis: "The fictional report uses the legal name. The issuer still needs verification.",
    priority: "medium", verificationQuestion: "Does the customer's audited annual report show a 2024 operating loss?",
  },
  {
    category: "credit_rating", headline: "Reported Meridian Ratings issuer downgrade",
    reportedStage: "Downgrade reported", eventOn: "2025-05-05", sourceIds: ["rating-downgrade"],
    match: "possible", matchBasis: "The fictional notice uses the legal name. The rated issuer still needs verification.",
    priority: "medium", verificationQuestion: "Did Meridian Ratings downgrade the customer's issuer rating or revise its outlook?",
  },
] satisfies Omit<DiscoveryBrief["signals"][number], "signalId" | "verificationStatus">[];

export function recordedDiscoveryDraft(input: unknown) {
  const raw = input && typeof input === "object" && "input" in input ? input.input : null;
  const search = discoverySearchResultSchema.parse(raw);
  const ids = new Set(search.results.map(result => result.sourceId));
  const signals = recordedSignals.filter(signal => signal.sourceIds.every(id => ids.has(id)));
  return discoveryAgentDraftSchema.parse({
    summary: signals.length ? "Fictional sources suggest questions about restructuring, annual losses and a credit rating change."
      : "The recorded synthesis produced no usable leads.",
    signals,
    limitations: ["Recorded model output for synthetic rehearsal."],
  });
}
