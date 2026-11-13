import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request: send }));
import { requestIntegrationDestination } from "./integration-destination.js";

it("uses the validated IP with the original TLS hostname and never follows a redirect", async () => {
  const destroy = vi.fn();
  let receivedOptions: Record<string, unknown> = {};
  send.mockImplementation((_url, options, callback) => {
    receivedOptions = options;
    const req = new EventEmitter() as EventEmitter & { end: () => void; setTimeout: () => void };
    req.setTimeout = vi.fn(); req.end = () => callback({ statusCode: 302, headers: { location: "https://attacker.example/" }, destroy });
    return req;
  });
  const url = new URL("https://approved.example/events");
  const result = await requestIntegrationDestination({ url, address: "8.8.8.8", family: 4 }, { method: "POST", headers: { authorization: "Bearer test" } });
  expect(result.status).toBe(302);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBe(url);
  const callback = vi.fn();
  (receivedOptions.lookup as Function)("approved.example", { all: true }, callback);
  expect(callback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  expect(receivedOptions.agent).toBe(false);
});
