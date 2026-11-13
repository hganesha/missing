import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

/** Evaluates one entrypoint of a compiled, digest-bound bundle. */
export type OpaBundleEvaluator = {
  evaluate(bundle: { bundleDigest: string; files: Record<string, string> }, entrypoint: string, input: unknown): Promise<unknown>;
};

type Server = { root: string; socket: string; child: ChildProcess };

/**
 * Long-running OPA servers, one per bundle digest, for the production policy path.
 *
 * Starting `opa eval` for every gate costs a process start plus a Rego parse and compile
 * each time. Here each bundle is loaded once into `opa run --server`, listening on a Unix
 * socket inside a private temporary directory, and every evaluation is one local HTTP call.
 * A bundle is identified by its digest, which the caller has already recomputed from the
 * sources, so a server only ever answers for the exact bundle it was started with. The
 * least recently used server is stopped once `maxServers` are running; a server that
 * fails is discarded and started again once.
 */
export class OpaServerPool implements OpaBundleEvaluator {
  private readonly servers = new Map<string, Promise<Server>>();
  private readonly binary: string;
  private readonly maxServers: number;
  private readonly startTimeoutMs: number;
  private readonly children = new Set<ChildProcess>();
  private hooked = false;
  // Synchronous: no promise callback runs once the process is exiting.
  private readonly exitHook = () => { for (const child of this.children) child.kill("SIGKILL"); };

  constructor(options: { binary?: string; maxServers?: number; startTimeoutMs?: number } = {}) {
    this.binary = options.binary ?? process.env.OPA_PATH ?? process.env.OPA_BIN ?? "opa";
    this.maxServers = options.maxServers ?? 4;
    this.startTimeoutMs = options.startTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.maxServers) || this.maxServers < 1) throw new Error("policy.opa_server_limit_invalid");
  }

  async evaluate(bundle: { bundleDigest: string; files: Record<string, string> }, entrypoint: string, input: unknown): Promise<unknown> {
    if (!/^data\.[a-z0-9_.]+$/.test(entrypoint)) throw new Error("policy.opa_entrypoint_invalid");
    const path = `/v1/data/${entrypoint.slice("data.".length).replaceAll(".", "/")}`;
    for (let attempt = 0; ; attempt += 1) {
      const server = await this.server(bundle);
      try {
        const body = await post(server.socket, path, JSON.stringify({ input }));
        // OPA answers an undefined decision with no `result`; `opa eval --fail` treats that
        // as an error, and so does this path.
        if (!body || typeof body !== "object" || !("result" in body)) throw new Error("policy.opa_response_invalid");
        return (body as { result: unknown }).result;
      } catch (error) {
        if (error instanceof Error && error.message === "policy.opa_response_invalid") throw error;
        await this.discard(bundle.bundleDigest);
        if (attempt > 0) throw new Error(`policy.opa_evaluation_failed:${error instanceof Error ? error.message : "unknown"}`);
      }
    }
  }

  /** Stops every server and removes its files. */
  async close(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((digest) => this.discard(digest)));
    process.off("exit", this.exitHook);
    this.hooked = false;
  }

  private async server(bundle: { bundleDigest: string; files: Record<string, string> }): Promise<Server> {
    const existing = this.servers.get(bundle.bundleDigest);
    if (existing) {
      // Most recently used last, so eviction takes the head of the map.
      this.servers.delete(bundle.bundleDigest);
      this.servers.set(bundle.bundleDigest, existing);
      return existing;
    }
    while (this.servers.size >= this.maxServers) await this.discard(this.servers.keys().next().value!);
    const started = this.start(bundle.files);
    this.servers.set(bundle.bundleDigest, started);
    started.catch(() => { if (this.servers.get(bundle.bundleDigest) === started) this.servers.delete(bundle.bundleDigest); });
    return started;
  }

  private async start(files: Record<string, string>): Promise<Server> {
    const root = await mkdtemp(resolve(tmpdir(), "ehf-opa-server-"));
    const bundleRoot = resolve(root, "bundle");
    try {
      await Promise.all(Object.entries(files).map(async ([path, source]) => {
        const target = resolve(bundleRoot, path);
        if (!target.startsWith(`${bundleRoot}/`)) throw new Error("policy.bundle_path_invalid");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, source, "utf8");
      }));
      const socket = resolve(root, "opa.sock");
      const child = spawn(this.binary, ["run", "--server", "--disable-telemetry", "--log-level", "error", "--addr", `unix://${socket}`, bundleRoot], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
      if (!this.hooked) { process.once("exit", this.exitHook); this.hooked = true; }
      this.children.add(child);
      child.once("exit", () => this.children.delete(child));
      const deadline = Date.now() + this.startTimeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`policy.opa_server_exited:${stderr.trim().slice(0, 200)}`);
        try {
          await get(socket, "/health");
          return { root, socket, child };
        } catch { await new Promise((done) => setTimeout(done, 50)); }
      }
      child.kill("SIGKILL");
      throw new Error("policy.opa_server_start_timeout");
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  private async discard(digest: string): Promise<void> {
    const pending = this.servers.get(digest);
    this.servers.delete(digest);
    const server = await pending?.catch(() => undefined);
    if (!server) return;
    server.child.kill("SIGTERM");
    await rm(server.root, { recursive: true, force: true });
  }
}

function call(socket: string, method: "GET" | "POST", path: string, body?: string): Promise<unknown> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, method, path, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}, timeout: 10_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 400) { fail(new Error(`opa_http_${response.statusCode}`)); return; }
        try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); } catch { fail(new Error("opa_json_invalid")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("opa_timeout")));
    req.on("error", fail);
    req.end(body);
  });
}
const get = (socket: string, path: string) => call(socket, "GET", path);
const post = (socket: string, path: string, body: string) => call(socket, "POST", path, body);
