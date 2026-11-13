import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * An asymmetric JWT signer backed by a private key the platform mounts as a file.
 *
 * The key can come from anywhere that can write a file -- a Kubernetes secret, a secret
 * manager through the Secrets Store CSI driver, or an HSM/KMS export -- so signing needs
 * no cloud SDK. Verifiers hold only the public key (`ENVELOPE_VERIFIER=public_key`).
 * A KMS that never releases its key can implement the same shape (`algorithm`, `keyId`,
 * `sign`) in an adapter without changing any caller.
 */
export type PrivateKeyJwtSigner = {
  algorithm: "RS256";
  keyId: string;
  sign(input: Uint8Array): Promise<Uint8Array>;
  /** The matching public key (SPKI PEM), for a service that verifies what it signed itself. */
  publicKeyPem: string;
};

export type SignedEnvelopeKind = "EXECUTION_ENVELOPE" | "RUNTIME_GRANT" | "INTEGRATION_ENVELOPE" | "DELEGATED_ENVELOPE" | "LEDGER_EXPORT";

export function createPrivateKeyJwtSigner(input: { privateKeyPem: string; keyId: string }): PrivateKeyJwtSigner {
  let key: KeyObject;
  try { key = createPrivateKey(input.privateKeyPem); } catch { throw new Error("identity.signing_key_invalid"); }
  if (key.asymmetricKeyType !== "rsa") throw new Error("identity.signing_key_rsa_required");
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("identity.signing_key_too_short");
  if (!input.keyId.trim()) throw new Error("identity.signing_key_id_missing");
  return {
    algorithm: "RS256",
    keyId: input.keyId,
    publicKeyPem: createPublicKey(input.privateKeyPem).export({ type: "spki", format: "pem" }).toString(),
    async sign(bytes) {
      return sign("sha256", bytes, key);
    },
  };
}

/**
 * Read `<KIND>_PRIVATE_KEY_FILE` and `<KIND>_KEY_ID`. The key is read once at startup;
 * rotating it is a rollout, and verifiers accept the new public key before signers switch.
 */
export function createPrivateKeyJwtSignerFromEnv(kind: SignedEnvelopeKind, env: NodeJS.ProcessEnv = process.env): PrivateKeyJwtSigner {
  const path = env[`${kind}_PRIVATE_KEY_FILE`];
  const keyId = env[`${kind}_KEY_ID`];
  if (!path || !keyId) throw new Error(`identity.private_key_signer_missing:${kind}`);
  let pem: string;
  try { pem = readFileSync(path, "utf8"); } catch { throw new Error(`identity.private_key_unreadable:${kind}`); }
  return createPrivateKeyJwtSigner({ privateKeyPem: pem, keyId });
}
