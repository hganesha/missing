import { describe, expect, it } from "vitest";
import { createOnboardingClient, OnboardingHttpError, probeOnboarding } from "./onboarding.js";

describe("bootstrap transport", () => {
  it("carries the bootstrap session, CSRF token and exact reviewed revision on writes", async () => {
    let observed: RequestInit | undefined;
    const client = createOnboardingClient({ getCsrf: () => "current-csrf", transport: async (_url, init) => { observed = init; return Response.json({ revision: 4 }); } });
    await client.request("/api/onboarding", { method: "PUT", headers: { "if-match": '"3"' }, body: "{}" });
    expect(observed).toMatchObject({ credentials: "same-origin", method: "PUT", headers: { "x-csrf-token": "current-csrf", "if-match": '"3"' } });
  });
  it("keeps authentication failures distinct from stale-write conflicts", async () => {
    const client = createOnboardingClient({ getCsrf: () => undefined, transport: async () => Response.json({ error: "setup.sign_in_required" }, { status: 401 }) });
    try { await client.request("/api/onboarding"); throw new Error("Expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(OnboardingHttpError); expect((error as OnboardingHttpError).status).toBe(401); }
  });
  it("keeps the launcher's recovery UI on server errors, without intercepting normal deployments", async () => {
    expect(await probeOnboarding(async () => Response.json({ error: "unavailable" }, { status: 503, headers: { "x-integralflow-launcher": "true" } }))).toBe(true);
    expect(await probeOnboarding(async () => Response.json({}, { status: 404 }))).toBe(false);
  });
});
