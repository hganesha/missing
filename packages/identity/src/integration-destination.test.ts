import { describe, expect, it, vi } from "vitest";
import { isPublicDeliveryAddress, validateIntegrationDestination } from "./integration-destination.js";
const connector = { channel: "outbound_webhook", endpoint: "https://approved.example/events", authentication: { kind: "managed_identity", credentialRef: "worker", audience: "api://approved/.default" } };
const env = { INTEGRATION_DESTINATIONS_JSON: JSON.stringify([{ endpoint: connector.endpoint, ...connector.authentication }]) };
describe("deployment-controlled delivery destinations", () => {
  it("rejects arbitrary audience/endpoint pairs before DNS or token acquisition", async () => {
    const lookup = vi.fn();
    for (const mutation of [{ endpoint: "https://attacker.example/" }, { authentication: { ...connector.authentication, audience: "https://admin.example.test/" } }]) {
      await expect(validateIntegrationDestination({ ...connector, ...mutation }, env, lookup as never)).rejects.toThrow("integration.destination_not_approved");
    }
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1"])("rejects private/reserved resolution %s", async (address) => {
    expect(isPublicDeliveryAddress(address)).toBe(false);
    await expect(validateIntegrationDestination(connector, env, vi.fn(async () => [{ address, family: address.includes(":") ? 6 : 4 }]) as never))
      .rejects.toThrow("integration.destination_address_denied");
  });
  it("pins a public address, rechecks DNS each delivery and honors exact deployment exceptions", async () => {
    const lookup = vi.fn().mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect((await validateIntegrationDestination(connector, env, lookup as never))?.address).toBe("8.8.8.8");
    await expect(validateIntegrationDestination(connector, env, lookup as never)).rejects.toThrow("integration.destination_address_denied");
    const privateEnv = { INTEGRATION_DESTINATIONS_JSON: JSON.stringify([{ endpoint: connector.endpoint, ...connector.authentication, allowedPrivateAddresses: ["127.0.0.1"] }]) };
    expect((await validateIntegrationDestination(connector, privateEnv, lookup as never))?.address).toBe("127.0.0.1");
  });
});
