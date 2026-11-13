import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";

export type DeliveryConnector = {
  channel: string; endpoint: string | null;
  authentication: { kind: string; credentialRef: string; audience: string | null; tokenUrl?: string | null; clientId?: string | null };
};
type ApprovedDestination = {
  endpoint: string; kind: string; credentialRef: string; audience: string | null;
  /** For `oauth2_client_credentials`: the token endpoint and client, approved together with the destination. */
  tokenUrl?: string | null; clientId?: string | null;
  /** Exact private IP exceptions, provisioned by deployment administrators. */
  allowedPrivateAddresses?: string[];
};
export type ValidatedDestination = { url: URL; address: string; family: number };

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

export function isPublicDeliveryAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

/** Configuration administrators cannot expand this deployment-controlled trust boundary. */
export async function validateIntegrationDestination(
  connector: DeliveryConnector,
  env: NodeJS.ProcessEnv = process.env,
  resolveAddresses: typeof lookup = lookup,
): Promise<ValidatedDestination | null> {
  if (connector.channel === "inbound_http") return null;
  if (!connector.endpoint) throw new Error("integration.destination_not_approved");
  if (connector.authentication.kind !== "hmac" && !connector.authentication.audience) throw new Error("integration.connector_audience_missing");
  const url = new URL(connector.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("integration.destination_invalid");
  let destinations: ApprovedDestination[];
  try {
    destinations = JSON.parse(env.INTEGRATION_DESTINATIONS_JSON ?? "[]") as ApprovedDestination[];
    if (!Array.isArray(destinations)) throw new Error();
  } catch { throw new Error("integration.destination_policy_invalid"); }
  const approved = destinations.find((item) => item.endpoint === url.href
    && item.kind === connector.authentication.kind && item.credentialRef === connector.authentication.credentialRef
    && item.audience === connector.authentication.audience
    && (item.tokenUrl ?? null) === (connector.authentication.tokenUrl ?? null)
    && (item.clientId ?? null) === (connector.authentication.clientId ?? null));
  if (!approved) throw new Error("integration.destination_not_approved");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveAddresses(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicDeliveryAddress(address)
    && !approved.allowedPrivateAddresses?.includes(address))) throw new Error("integration.destination_address_denied");
  return { url, ...addresses[0]! };
}

/** Pin the checked address for this connection; retain TLS hostname verification. No redirects. */
export function requestIntegrationDestination(
  destination: ValidatedDestination, options: { method: "POST" | "HEAD"; headers?: Record<string, string>; body?: string },
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(destination.url, {
      method: options.method, headers: options.headers, agent: false, signal: AbortSignal.timeout(15_000),
      lookup: (_hostname, _options, callback) => {
        if (_options.all) callback(null, [{ address: destination.address, family: destination.family }]);
        else callback(null, destination.address, destination.family);
      },
    }, (response) => {
      const status = response.statusCode ?? 502;
      response.destroy();
      resolve({ status });
    });
    req.setTimeout(15_000, () => req.destroy(new Error("integration.delivery_timeout")));
    req.on("error", reject);
    req.end(options.body);
  });
}
