import { expect, it, vi } from "vitest";
import { collectFoundryWebRecon, collectWebRecon, searchCompanyOnWeb } from "./recon-web-search.js";

const observedAt = "2026-11-12T10:00:00.000Z";
const filing = "https://www.sec.gov/Archives/edgar/data/1813756/000119312523271902/d522028d8k.htm";
const loss = "https://filings.example.org/report.pdf?X-Amz-Signature=expiring";
const uncited = "https://issuer.com/announcement";
const lead = {
  category: "bankruptcy", headline: "Voluntary petition filed", reportedStage: "Chapter 11 petition filed",
  eventOn: "2023-11-06", match: "likely", matchBasis: "Named in the SEC filing.", priority: "high",
  verificationQuestion: "Does the named debtor match the legal entity?",
  source: { kind: "issuer", publishedOn: "2023-11-06" },
};
const line = (url: string, headline = lead.headline) => `${JSON.stringify({ ...lead, headline })} ([citation](${url}))`;
const completion = (content: string, citations: string[], searches = 1) => ({
  choices: [{ finish_reason: "stop", message: { content, annotations: citations.map(url => ({
    type: "url_citation", url_citation: { url, title: "Source filing" },
  })) } }],
  usage: { server_tool_use_details: { web_search_requests: searches } },
});

it("retains only durable source links associated with the lead by web search citation metadata", () => {
  const result = collectWebRecon(completion(
    [line(filing), line(loss, "Temporary URL"), line(uncited, "Uncited claim")].join("\n"), [filing, loss],
  ), observedAt);
  expect(result.sources).toMatchObject([{ url: filing, title: "Source filing", observedAt }]);
  expect(result.signals.map(signal => [signal.headline, signal.sourceIds])).toEqual([[lead.headline, [result.sources[0]!.sourceId]]]);
});

it("requires web search execution and distinguishes a real empty search from missing citations", () => {
  expect(collectWebRecon(completion("NO_LEADS", []), observedAt)).toEqual({ signals: [], sources: [] });
  expect(() => collectWebRecon(completion("NO_LEADS", [], 0), observedAt)).toThrow();
  expect(() => collectWebRecon(completion(line(filing), []), observedAt)).toThrow("discovery.web_citations_missing");
});

it("fails an answer it cannot use instead of recording it as a search with no leads", () => {
  // Leads were returned, but none survives: one is not valid JSON, the other cites only a temporary link.
  const unusable = [`{"category": "bankruptcy", "headline": ([citation](${filing}))`, line(loss, "Temporary URL")].join("\n");
  expect(() => collectWebRecon(completion(unusable, [filing, loss]), observedAt)).toThrow("discovery.web_output_unusable");
  // A multi-line JSON block has no single-line lead to parse.
  const block = `${JSON.stringify(lead, null, 2)} ([citation](${filing}))`;
  expect(() => collectWebRecon(completion(block, [filing]), observedAt)).toThrow("discovery.web_output_unusable");
});

it("uses the Foundry Responses API and attaches the provider's ranged citation to its lead", async () => {
  const row = JSON.stringify(lead);
  const text = `${row} [1]\n${JSON.stringify({ ...lead, headline: "Uncited claim" })}`;
  const output = {
    status: "completed", output: [
      { type: "reasoning" },
      { type: "web_search_call", status: "completed" },
      { type: "message", role: "assistant", status: "completed", content: [{
        type: "output_text", text, annotations: [{
          type: "url_citation", url: filing, title: "WeWork SEC filing", start_index: row.length + 1, end_index: row.length + 4,
        }],
      }] },
    ],
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(output));
  const env = { DISCOVERY_WEB_SEARCH_PROVIDER: "azure_foundry", DISCOVERY_FOUNDRY_ENDPOINT: "https://models.openai.azure.com/openai/v1/",
    DISCOVERY_FOUNDRY_DEPLOYMENT: "recon-deployment", DISCOVERY_FOUNDRY_API_KEY: "foundry-key", OPENROUTER_API_KEY: "other-key" };
  const result = await searchCompanyOnWeb({ companyName: "WeWork Inc.", country: "US" }, env, fetcher);
  const [url, request] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://models.openai.azure.com/openai/v1/responses");
  expect(request?.headers).toEqual({ "api-key": "foundry-key", "Content-Type": "application/json" });
  expect(JSON.parse(String(request?.body))).toMatchObject({
    model: "recon-deployment", tools: [{ type: "web_search" }], store: false,
    input: JSON.stringify({ companyName: "WeWork Inc.", country: "US" }),
  });
  expect(result).toMatchObject({ origin: "azure_foundry_web", signals: [{ headline: lead.headline }], sources: [{ url: filing }] });
  expect(() => collectFoundryWebRecon({ ...output, output: output.output.filter(item => item.type !== "web_search_call") }, observedAt))
    .toThrow("discovery.web_response_incomplete");
  await expect(searchCompanyOnWeb({ companyName: "WeWork Inc.", country: "US" }, { ...env, DISCOVERY_FOUNDRY_API_KEY: "" }, fetcher))
    .rejects.toThrow("discovery.web_foundry_configuration_invalid");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
