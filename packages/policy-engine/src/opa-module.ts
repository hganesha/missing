import { stableDigest } from "@ehf/contracts";
import { OpaServerPool } from "./decision-table/opa-server.js";
import { verifyOpaVersion } from "./decision-table/compile.js";

export const POLICY_OPA_VERSION = "1.9.0";
const pools = new Map<string, OpaServerPool>();
export function opaModuleBundle(path: string, rego: string) {
  const files = { [path]: rego };
  return { files, bundleDigest: stableDigest({ files, opaVersion: POLICY_OPA_VERSION }) };
}
export async function evaluateOpaModule(bundle: ReturnType<typeof opaModuleBundle>, entrypoint: string, input: unknown) {
  const binary = process.env.OPA_PATH ?? process.env.OPA_BIN ?? "opa";
  await verifyOpaVersion(binary, POLICY_OPA_VERSION);
  let pool = pools.get(binary);
  if (!pool) { pool = new OpaServerPool({ binary, maxServers: 4 }); pools.set(binary, pool); }
  return pool.evaluate(bundle, entrypoint, input);
}
export async function closeOpaModules() { await Promise.all([...pools.values()].map(pool => pool.close())); pools.clear(); }
