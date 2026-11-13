/** Bootstrap has its own session and revision contract, before the Experience API exists. */
export type OnboardingPath = "/api/onboarding/resources" | "/api/onboarding/resources/recover" | "/api/onboarding" | "/api/onboarding/status" | "/api/onboarding/claim" | "/api/onboarding/test" | "/api/onboarding/deployment" | "/api/onboarding/deployment/recover" | "/api/onboarding/plan" | "/api/onboarding/review" | "/api/onboarding/configure" | "/auth/setup/logout";
export class OnboardingHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createOnboardingClient(options: { getCsrf: () => string | undefined; transport?: typeof fetch }) {
  const transport = options.transport ?? fetch;
  return {
    async request<T = any>(path: OnboardingPath, init: RequestInit = {}): Promise<T> {
      const csrf = options.getCsrf();
      const response = await transport(path, {
        ...init, headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}), ...init.headers },
        credentials: "same-origin", signal: init.signal ?? AbortSignal.timeout(25_000),
      });
      const body = await response.json();
      if (!response.ok) throw new OnboardingHttpError(response.status, response.status === 409
        ? "The saved configuration changed. Reload before continuing."
        : body.issues?.map((item: { path: string; message: string }) => `${item.path}: ${item.message}`).join("; ") ?? body.error ?? "Request failed");
      return body as T;
    },
  };
}

/** A missing route preserves the normal Experience API startup path. */
export async function probeOnboarding(transport: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await transport("/api/onboarding/status", { credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
    return response.headers.get("x-integralflow-launcher") === "true" || (response.ok && (await response.json()).enabled === true);
  } catch { return false; }
}
