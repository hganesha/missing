import { discoveryBriefSchema, discoveryFixtureCompany, type DiscoveryBrief } from "@ehf/contracts";

type FixtureScope = Pick<DiscoveryBrief, "briefId" | "caseId" | "subjectId" | "parentPlanDigest" | "intakeDecisionId" | "intakeSettlement" | "recordedAt">;

export const discoveryFixtureName = discoveryFixtureCompany;

export function makeDiscoveryFixture(scope: FixtureScope): DiscoveryBrief {
  return discoveryBriefSchema.parse({
    ...scope,
    schemaVersion: "discovery.brief.v1",
    origin: "synthetic_fixture",
    status: "complete",
    summary: "Fictional sources raise three questions about restructuring, operating losses and a credit rating change.",
    limitations: ["Synthetic rehearsal using fictional sources. No external searches were performed."],
    sources: [
      { sourceId: "court", title: "Fictional restructuring docket", kind: "court", url: "https://court.example/restructuring", publishedOn: "2025-05-03", observedAt: scope.recordedAt },
      { sourceId: "issuer", title: "Fictional annual report", kind: "issuer", url: "https://issuer.example/annual-report", publishedOn: "2025-04-30", observedAt: scope.recordedAt },
      { sourceId: "rating", title: "Fictional rating agency notice", kind: "rating_agency", url: "https://ratings.example/rating-action", publishedOn: "2025-05-05", observedAt: scope.recordedAt },
    ],
    signals: [
      {
        signalId: "restructuring", category: "bankruptcy", headline: "Possible restructuring filing involving a similarly named company",
        reportedStage: "Filing reported", eventOn: "2025-05-02", sourceIds: ["court"], match: "uncertain",
        matchBasis: "The abbreviated name in the fictional docket has no registration identifier.",
        verificationStatus: "UNVERIFIED", priority: "high", verificationQuestion: "Which legal entity filed, and what stage does the docket report?",
      },
      {
        signalId: "operating-loss", category: "financial_losses", headline: "Reported operating loss for the 2024 financial year",
        reportedStage: "Annual results reported", eventOn: "2024-12-31", sourceIds: ["issuer"], match: "possible",
        matchBasis: "The fictional report uses the corporate name. Its issuer has not been independently verified.",
        verificationStatus: "UNVERIFIED", priority: "medium", verificationQuestion: "Does the audited report for the customer show an operating loss for 2024?",
      },
      {
        signalId: "rating-action", category: "credit_rating", headline: "Possible issuer credit rating downgrade",
        reportedStage: "Downgrade reported", eventOn: "2025-05-05", sourceIds: ["rating"], match: "possible",
        matchBasis: "The name matches. The rated entity and security have not been checked.",
        verificationStatus: "UNVERIFIED", priority: "medium", verificationQuestion: "Which entity and rating did the agency change, and was this a downgrade or an outlook revision?",
      },
    ],
  });
}
