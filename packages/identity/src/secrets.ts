import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";

/**
 * Resolve a credential reference without tying the platform to one secret store.
 *
 * - `env:NAME` reads an environment variable.
 * - `file:/run/secrets/name` reads a mounted file. Every secret manager -- HashiCorp
 *   Vault, a cloud KMS or secret manager through the Secrets Store CSI driver or External
 *   Secrets, Docker or Kubernetes secrets -- can deliver a secret as a file, so the
 *   platform needs no client for any of them. When `SECRETS_DIR` is set the file must be
 *   inside it, so a stored reference cannot read arbitrary files.
 *
 * Values shorter than `minLength` are refused: a short shared secret is a guessable one.
 */
export async function resolveSecretRef(
  reference: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { minLength?: number } = {},
): Promise<string> {
  const minLength = options.minLength ?? 24;
  const envMatch = reference.match(/^env:([A-Z][A-Z0-9_]*)$/);
  let value: string | undefined;
  if (envMatch) {
    value = env[envMatch[1]!];
  } else if (reference.startsWith("file:")) {
    const path = normalize(reference.slice("file:".length));
    if (!isAbsolute(path)) throw new Error("secret.ref_unsupported");
    const root = env.SECRETS_DIR ? resolve(env.SECRETS_DIR) : undefined;
    if (root) {
      const inside = relative(root, path);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("secret.ref_outside_secrets_dir");
    }
    try { value = (await readFile(path, "utf8")).trim(); } catch { value = undefined; }
  } else {
    throw new Error("secret.ref_unsupported");
  }
  if (!value || value.length < minLength) throw new Error("secret.unavailable");
  return value;
}

/** Whether a reference uses a scheme `resolveSecretRef` accepts. */
export function isSupportedSecretRef(reference: string): boolean {
  return /^env:[A-Z][A-Z0-9_]*$/.test(reference) || /^file:\/[^\0]+$/.test(reference);
}
