import { describe, expect, expectTypeOf, it } from "vitest";
import type { Schemas } from "@ehf/ui-contracts";
import { ApiError, createExperienceClient } from "./index.js";

type Seen = { url: string; method: string; headers: Headers; body: string | null };

function fakeFetch(respond: (request: Seen) => Response) {
  const seen: Seen[] = [];
  const impl = async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const entry = { url: request.url, method: request.method, headers: request.headers, body: request.method === "GET" ? null : await request.clone().text() };
    seen.push(entry);
    return respond(entry);
  };
  return { seen, fetch: impl as typeof fetch };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("ExperienceClient", () => {
  it('addresses auth outside the API base and keeps CSRF on logout', async () => {
    const { seen, fetch } = fakeFetch(() => new Response('',{status:200}));
    const client=createExperienceClient({baseUrl:'http://ui.test/api',getCsrf:()=> 'csrf-1',fetch});
    await client.postAuthLogout();
    expect(seen[0]?.url).toBe('http://ui.test/auth/logout');
    expect(seen[0]?.headers.get('x-csrf-token')).toBe('csrf-1');
  });
  it('returns binary exports intact and preserves a failed sign-out reason', async()=>{
    const {fetch}=fakeFetch(request=>request.url.includes('/auth/logout')?json(403,{error:'csrf.invalid',message:'Try again'}):new Response('%PDF-test',{headers:{'content-type':'application/pdf'}}));
    const client=createExperienceClient({baseUrl:'http://ui.test/api',getCsrf:()=> 'token',fetch});
    const file=await client.getCasesCaseIdExportsDigestFormat({path:{caseId:'case',digest:'a'.repeat(64),format:'pdf'}});
    expect(file).toBeInstanceOf(Blob);expect(await file.text()).toBe('%PDF-test');
    await expect(client.postAuthLogout()).rejects.toMatchObject({status:403,reason:'csrf.invalid'});
  });
  it("sends X-CSRF-Token on mutations only", async () => {
    const { seen, fetch } = fakeFetch(() => json(201, {}));
    const client = createExperienceClient({ baseUrl: "http://ui.test/api", getCsrf: () => "csrf-1", fetch });
    await client.call("getSession");
    await client.call("postOperationsHumanWorkWorkItemIdClaim", { path: { workItemId: "wi_1" } } as never);
    expect(seen[0]!.headers.get("x-csrf-token")).toBeNull();
    expect(seen[1]!.headers.get("x-csrf-token")).toBe("csrf-1");
    expect(seen[1]!.url).toBe("http://ui.test/api/v1/operations/human-work/wi_1/claim");
  });

  it("keeps the upstream status and reason code", async () => {
    const { fetch } = fakeFetch(() => json(409, { error: "workflow.human_decision_not_assigned", message: "Claim first", correlationId: "c-1" }));
    const client = createExperienceClient({ baseUrl: "http://ui.test/api", getCsrf: () => "t", fetch });
    const error = await client.postOperationsHumanWorkWorkItemIdClaim({ path: { workItemId: "wi_1" } } as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).reason).toBe("workflow.human_decision_not_assigned");
    expect((error as ApiError).correlationId).toBe("c-1");
  });

  it("maps a network failure to bff.upstream_unavailable", async () => {
    const client = createExperienceClient({ baseUrl: "http://ui.test/api", getCsrf: () => null, fetch: (async () => { throw new TypeError("network"); }) as typeof fetch });
    await expect(client.getSession()).rejects.toMatchObject({ status: 503, reason: "bff.upstream_unavailable", retryable: true });
  });

  it("reports 304 for conditional GETs", async () => {
    const { seen, fetch } = fakeFetch(() => new Response(null, { status: 304, headers: { etag: '"seq-14"' } }));
    const client = createExperienceClient({ baseUrl: "http://ui.test/api", getCsrf: () => null, fetch });
    const result = await client.call("getSession", { ifNoneMatch: '"seq-14"' });
    expect(result.notModified).toBe(true);
    expect(seen[0]!.headers.get("if-none-match")).toBe('"seq-14"');
  });

  it("is typed by operation", () => {
    const client = createExperienceClient({ getCsrf: () => null });
    expectTypeOf(client.getSession).returns.resolves.toEqualTypeOf<Schemas["Session"]>();
  });
});
