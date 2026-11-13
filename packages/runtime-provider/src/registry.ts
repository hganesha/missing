import {
  runtimeBindingSchema,
  runtimeTargetSchema,
  type PlatformSettings,
} from "@ehf/contracts";
import { allowsInsecureEndpoints } from "@ehf/identity";
import { createDatabricksTokenProvider, DatabricksRuntimeProvider } from "./databricks.js";
import {
  createRuntimeProviderFromEnv,
  HostedHttpRuntimeProvider,
  LocalHttpRuntimeProvider,
  runtimeEnvOverlay,
  runtimeHostCredential,
  type RuntimeProvider,
} from "./index.js";

type Fetch = typeof globalThis.fetch;
type RuntimeBinding = ReturnType<typeof runtimeBindingSchema.parse>;

export type RuntimeAdapterContext = {
  env: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
};

/**
 * A runtime adapter: a place the platform's per-node executor can run. Every adapter
 * speaks the same `runtime.invocation` protocol and leaves authority where it is (the
 * dispatcher's lease and fence, the envelope broker, the capability gateway); adapters
 * differ only in where the executor is hosted and how the dispatcher authenticates.
 *
 * `fromBinding` builds a provider for a named, administered binding; `fromEnvironment`
 * builds the adapter's default from the dispatcher's environment.
 */
export type RuntimeAdapter = {
  id: string;
  description: string;
  /** Hosted adapters run outside the platform's own containers (required for production agents). */
  hosted: boolean;
  fromBinding(binding: RuntimeBinding, name: string, context: RuntimeAdapterContext): RuntimeProvider;
  fromEnvironment(context: RuntimeAdapterContext): RuntimeProvider;
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`runtime.config_missing:${name}`);
  return value;
}

function bearerFor(binding: RuntimeBinding, context: RuntimeAdapterContext): () => Promise<string> {
  if (binding.auth === "platform_token") return runtimeHostCredential(context.env);
  return createDatabricksTokenProvider({
    kind: "oauth_m2m",
    workspaceHost: binding.workspaceHost!,
    clientId: requiredEnv(context.env, binding.clientIdEnv!),
    clientSecret: requiredEnv(context.env, binding.clientSecretEnv!),
  }, { ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}), allowLocal: allowsInsecureEndpoints(context.env) });
}

const adapters = new Map<string, RuntimeAdapter>();

export function registerRuntimeAdapter(adapter: RuntimeAdapter): void {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(adapter.id)) throw new Error(`runtime.adapter_id_invalid:${adapter.id}`);
  if (adapters.has(adapter.id)) throw new Error(`runtime.adapter_duplicate:${adapter.id}`);
  adapters.set(adapter.id, adapter);
}

export function runtimeAdapter(id: string): RuntimeAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`runtime.adapter_unknown:${id}`);
  return adapter;
}

export function listRuntimeAdapters(): Array<Pick<RuntimeAdapter, "id" | "description" | "hosted">> {
  return [...adapters.values()].map(({ id, description, hosted }) => ({ id, description, hosted }));
}

registerRuntimeAdapter({
  id: "local_http",
  description: "The platform's own runtime host container, reached over HTTP.",
  hosted: false,
  fromBinding: (binding, _name, context) => new LocalHttpRuntimeProvider(binding.endpoint, bearerFor(binding, context), context.fetchImpl),
  fromEnvironment: (context) => createRuntimeProviderFromEnv({ ...context.env, RUNTIME_PROVIDER: "local_http" }, context),
});

registerRuntimeAdapter({
  id: "hosted_http",
  description: "The platform's runtime host deployed as its own HTTPS service (any Kubernetes cluster or container platform).",
  hosted: true,
  fromBinding: (binding, _name, context) => new HostedHttpRuntimeProvider(binding.endpoint, bearerFor(binding, context), context.fetchImpl,
    { allowLocal: allowsInsecureEndpoints(context.env) }),
  fromEnvironment: (context) => createRuntimeProviderFromEnv({ ...context.env, RUNTIME_PROVIDER: "hosted_http" }, context),
});

registerRuntimeAdapter({
  id: "databricks",
  description: "A Databricks App (or other Databricks-hosted HTTPS endpoint) running the platform's runtime image.",
  hosted: true,
  fromBinding: (binding, name, context) => {
    if (binding.auth === "platform_token") throw new Error("runtime.databricks_auth_invalid");
    const token = bearerFor(binding, context);
    return new DatabricksRuntimeProvider(binding.endpoint, token, {
      ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}), allowLocal: allowsInsecureEndpoints(context.env), bindingName: name,
    });
  },
  fromEnvironment: (context) => {
    const env = context.env;
    const endpoint = requiredEnv(env, "DATABRICKS_RUNTIME_ENDPOINT");
    const token = createDatabricksTokenProvider({
      kind: "oauth_m2m", workspaceHost: requiredEnv(env, "DATABRICKS_HOST"),
      clientId: requiredEnv(env, "DATABRICKS_CLIENT_ID"), clientSecret: requiredEnv(env, "DATABRICKS_CLIENT_SECRET"),
    }, { ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}), allowLocal: allowsInsecureEndpoints(env) });
    return new DatabricksRuntimeProvider(endpoint, token, { ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}), allowLocal: allowsInsecureEndpoints(env) });
  },
});

export function parseRuntimeTarget(target: string): { adapter: string; binding: string | null } {
  const parsed = runtimeTargetSchema.safeParse(target);
  if (!parsed.success) throw new Error(`runtime.target_invalid:${target}`);
  const [adapter, binding] = parsed.data.split(":");
  return { adapter: adapter!, binding: binding ?? null };
}

/**
 * Resolve a node's runtime target to a provider.
 *
 * The plan's target wins; without one, the administered default applies. A named binding
 * must exist in the administered runtime bindings and name the same adapter, so a plan
 * cannot be redirected to a different kind of runtime by editing a binding. An unnamed
 * target uses the adapter's environment default (the pre-registry behaviour).
 */
export function createRuntimeProvider(
  target: string | undefined,
  options: RuntimeAdapterContext & { settings?: Omit<PlatformSettings["runtime"], "bindings"> & { bindings?: PlatformSettings["runtime"]["bindings"] } },
): RuntimeProvider {
  const settings = options.settings;
  const resolved = parseRuntimeTarget(target ?? settings?.provider ?? options.env.RUNTIME_PROVIDER ?? "local_http");
  const adapter = runtimeAdapter(resolved.adapter);
  const context: RuntimeAdapterContext = { ...options, env: settings ? { ...options.env, ...runtimeEnvOverlay(settings), RUNTIME_PROVIDER: resolved.adapter } : options.env };
  if (!resolved.binding) return adapter.fromEnvironment(context);
  const raw = settings?.bindings?.[resolved.binding];
  if (!raw) throw new Error(`runtime.binding_unknown:${resolved.binding}`);
  const binding = runtimeBindingSchema.parse(raw);
  if (binding.adapter !== resolved.adapter) throw new Error(`runtime.binding_adapter_mismatch:${resolved.binding}`);
  return adapter.fromBinding(binding, resolved.binding, context);
}

/** The adapter IDs a node may target in production: hosted runtimes only. */
export function isHostedRuntimeTarget(target: string): boolean {
  const { adapter } = parseRuntimeTarget(target);
  return adapters.get(adapter)?.hosted ?? false;
}
