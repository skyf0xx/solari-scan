import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaptureAdapterError } from "./errors.js";
import { ProxyCaptureAdapter } from "./proxy-capture.js";
import type {
  SandboxCommandChunk,
  SandboxCommandHandle,
  SandboxCommandOptions,
  SandboxGuestAccess,
  SandboxRunResult,
} from "./sandbox-files.js";

/**
 * A fake `SandboxGuestAccess` standing in for the injected sandbox
 * dependency. `start()` returns a controllable fake `SandboxCommandHandle`
 * so tests can drive the `LISTENING:<port>` readiness signal (or withhold
 * it) exactly like `startProxy()`'s `waitForListening()` expects.
 */
class FakeCommandHandle implements SandboxCommandHandle {
  killed = false;
  private dataCb: ((chunk: SandboxCommandChunk) => void) | undefined;
  private waitResolve: ((code: number) => void) | undefined;
  private waitPromise = new Promise<number>((resolve) => {
    this.waitResolve = resolve;
  });

  onData(cb: (chunk: SandboxCommandChunk) => void): void {
    this.dataCb = cb;
  }

  emit(chunk: SandboxCommandChunk): void {
    this.dataCb?.(chunk);
  }

  exit(code: number): void {
    this.waitResolve?.(code);
  }

  wait(): Promise<number> {
    return this.waitPromise;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

class FakeSandboxGuest implements SandboxGuestAccess {
  written = new Map<string, Uint8Array | string>();
  startCalls: { cmd: string; options?: SandboxCommandOptions }[] = [];
  lastHandle: FakeCommandHandle | undefined;
  logFile: string | undefined;
  logFileError = false;

  /** Resolves once `start()` has created `lastHandle` — tests await this
   *  before emitting readiness output, instead of racing a bare
   *  `queueMicrotask` against `startProxy()`'s own internal await chain
   *  (write() then start()), which resolves after an unpredictable number
   *  of microtask turns. */
  private handleReadyResolve: (() => void) | undefined;
  handleReady = new Promise<void>((resolve) => {
    this.handleReadyResolve = resolve;
  });

  async list() {
    return [];
  }
  async stat(): Promise<never> {
    throw new Error("not used in this test");
  }
  async read(path: string): Promise<Uint8Array> {
    if (this.logFileError || this.logFile === undefined) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return new TextEncoder().encode(this.logFile);
  }
  async write(path: string, data: Uint8Array | string): Promise<void> {
    this.written.set(path, data);
  }
  async start(cmd: string, options?: SandboxCommandOptions): Promise<SandboxCommandHandle> {
    this.startCalls.push({ cmd, options });
    const handle = new FakeCommandHandle();
    this.lastHandle = handle;
    this.handleReadyResolve?.();
    return handle;
  }
  async run(_cmd: string, _options?: SandboxCommandOptions): Promise<SandboxRunResult> {
    throw new Error("not used in this test");
  }
}

/**
 * Waits until `startProxy()` has actually registered its command handle
 * (i.e. past the `write()` and `start()` awaits), then yields one more real
 * macrotask turn before emitting fake stdout — `handleReady` resolving and
 * `startProxy()` calling `command.onData(cb)` are two separate microtask
 * chains off the same underlying promise, so nothing guarantees `onData`
 * has already been called by the time `handleReady` settles; a `setTimeout`
 * turn lets that chain fully unwind first.
 */
async function afterHandleReady(guest: FakeSandboxGuest): Promise<void> {
  await guest.handleReady;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function emit(guest: FakeSandboxGuest, chunk: SandboxCommandChunk): Promise<void> {
  await afterHandleReady(guest);
  guest.lastHandle?.emit(chunk);
}

async function emitExit(guest: FakeSandboxGuest, code: number): Promise<void> {
  await afterHandleReady(guest);
  guest.lastHandle?.exit(code);
}

describe("ProxyCaptureAdapter (mocked SandboxGuestAccess)", () => {
  it("writes the Python proxy script to the guest before starting it", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    void emit(guest, { stream: "stdout", data: "LISTENING:9999\n" });
    await startPromise;

    expect(guest.written.size).toBe(1);
    const entry = Array.from(guest.written.entries())[0];
    if (!entry) {
      throw new Error("expected exactly one written file");
    }
    const [path, source] = entry;
    expect(path).toBe("/tmp/solari-scan-proxy.py");
    expect(typeof source).toBe("string");
    expect(source as string).toContain("LISTENING:");
    expect(source as string).toContain("do_CONNECT");
  });

  it("starts python3 with the script path as an argument, as a background command", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    void emit(guest, { stream: "stdout", data: "LISTENING:9999\n" });
    await startPromise;

    expect(guest.startCalls).toHaveLength(1);
    expect(guest.startCalls[0]!.cmd).toBe("python3");
    expect(guest.startCalls[0]!.options?.args).toEqual(["/tmp/solari-scan-proxy.py"]);
    expect(guest.startCalls[0]!.options?.background).toBe(true);
  });

  it("waits for the LISTENING:<port> stdout line and extracts the port into env.HTTP_PROXY/HTTPS_PROXY", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    // Simulate output arriving in two chunks, split mid-line, to prove the
    // adapter buffers rather than assuming one line per chunk.
    void (async () => {
      await afterHandleReady(guest);
      guest.lastHandle?.emit({ stream: "stdout", data: "LISTEN" });
      guest.lastHandle?.emit({ stream: "stdout", data: "ING:34567\n" });
    })();

    const { port, env } = await startPromise;

    expect(port).toBe(34567);
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:34567");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:34567");
  });

  it("ignores stderr chunks and non-LISTENING stdout noise while waiting for readiness", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    void (async () => {
      await afterHandleReady(guest);
      guest.lastHandle?.emit({ stream: "stderr", data: "LISTENING:1\n" });
      guest.lastHandle?.emit({ stream: "stdout", data: "some banner text\n" });
      guest.lastHandle?.emit({ stream: "stdout", data: "LISTENING:22222\n" });
    })();

    const { port } = await startPromise;
    expect(port).toBe(22222);
  });

  it("rejects if the proxy process exits before reporting readiness", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    void emitExit(guest, 1);

    await expect(startPromise).rejects.toBeInstanceOf(CaptureAdapterError);
  });

  it("throws if startProxy() is called twice without stopping in between", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    void emit(guest, { stream: "stdout", data: "LISTENING:1234\n" });
    await startPromise;

    await expect(adapter.startProxy()).rejects.toBeInstanceOf(CaptureAdapterError);
  });

  it("stopProxy() kills the command handle and parses the log file into distinct hosts", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    void emit(guest, { stream: "stdout", data: "LISTENING:1234\n" });
    await startPromise;

    guest.logFile = "example.com\nregistry.npmjs.org\nexample.com\nregistry.npmjs.org\n";

    const observed = await adapter.stopProxy();

    expect(guest.lastHandle?.killed).toBe(true);
    expect(observed.map((c) => c.host).sort()).toEqual(["example.com", "registry.npmjs.org"]);
  });

  it("stopProxy() treats a missing log file as zero observed connections, not an error", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    void emit(guest, { stream: "stdout", data: "LISTENING:1234\n" });
    await startPromise;

    guest.logFileError = true; // read() throws, simulating "file never created"

    const observed = await adapter.stopProxy();
    expect(observed).toEqual([]);
  });

  it("stopProxy() treats an empty log file as zero observed connections", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);

    const startPromise = adapter.startProxy();
    void emit(guest, { stream: "stdout", data: "LISTENING:1234\n" });
    await startPromise;

    guest.logFile = "";

    const observed = await adapter.stopProxy();
    expect(observed).toEqual([]);
  });

  it("throws if stopProxy() is called before startProxy() ever succeeded", async () => {
    const guest = new FakeSandboxGuest();
    const adapter = new ProxyCaptureAdapter(guest);
    await expect(adapter.stopProxy()).rejects.toBeInstanceOf(CaptureAdapterError);
  });
});

// ============================================================================
// Real-subprocess test of the Python proxy SCRIPT ITSELF (not the adapter).
//
// The adapter's own tests above mock the sandbox entirely, so they can't
// prove the embedded Python source is actually a correct HTTP/CONNECT proxy.
// This suite extracts `PROXY_SCRIPT_SOURCE` from the built module, writes it
// to a real temp file, and runs it as a real local `python3` child process
// via `node:child_process` — de-risking the proxy logic itself, even though
// the in-guest launching mechanism (`SandboxGuestAccess.start`) can't be
// exercised against a real Solari sandbox in this session.
// ============================================================================

let pythonAvailable = false;
try {
  execFileSync("python3", ["--version"], { stdio: "ignore" });
  pythonAvailable = true;
} catch {
  pythonAvailable = false;
}

const describeIfPython = pythonAvailable ? describe : describe.skip;

describeIfPython("Python proxy script (real python3 subprocess, not the adapter)", () => {
  let upstream: { server: Server; port: number };
  let scriptDir: string;
  let scriptPath: string;
  let logPath: string;
  let proxyProcess: ChildProcessByStdio<null, Readable, Readable>;
  let proxyPort: number;

  function startUpstream(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("upstream-ok");
      });
      server.listen(0, "127.0.0.1", () => {
        resolve({ server, port: (server.address() as AddressInfo).port });
      });
    });
  }

  function requestThroughProxy(targetHost: string, targetPort: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: `http://${targetHost}:${targetPort}/`,
          method: "GET",
          headers: { host: `${targetHost}:${targetPort}`, connection: "close" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function connectThroughProxy(targetHost: string, targetPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: `${targetHost}:${targetPort}`,
      });
      req.on("connect", (_res, socket) => {
        socket.end();
        resolve();
      });
      req.on("error", reject);
      req.end();
    });
  }

  beforeEach(async () => {
    upstream = await startUpstream();

    // Re-derive the script source the same way `proxy-capture.ts` embeds it,
    // by re-importing the module and reading its (non-exported) constant
    // indirectly: simplest reliable path is to re-run `startProxy()`'s write
    // against a fake guest and capture what it wrote, then execute that.
    const { ProxyCaptureAdapter: Adapter } = await import("./proxy-capture.js");
    const guest = new FakeSandboxGuest();
    const adapter = new Adapter(guest);
    const startPromise = adapter.startProxy();
    void emit(guest, { stream: "stdout", data: "LISTENING:1\n" });
    await startPromise;
    const source = guest.written.get("/tmp/solari-scan-proxy.py") as string;

    scriptDir = mkdtempSync(join(tmpdir(), "solari-scan-proxy-test-"));
    scriptPath = join(scriptDir, "solari-scan-proxy.py");
    logPath = join(scriptDir, "solari-scan-proxy.log");
    // The real script hardcodes /tmp/solari-scan-proxy.log; point this test's
    // copy at an isolated temp file instead so parallel test runs don't
    // collide on a shared path.
    const isolatedSource = source.replace(
      "LOG_PATH = \"/tmp/solari-scan-proxy.log\"",
      `LOG_PATH = ${JSON.stringify(logPath)}`,
    );
    writeFileSync(scriptPath, isolatedSource);

    proxyPort = await new Promise((resolve, reject) => {
      const proc = spawn("python3", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
      proxyProcess = proc;
      let buffer = "";
      let stderrBuffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = buffer.match(/LISTENING:(\d+)/);
        if (match) {
          proc.stdout.off("data", onData);
          resolve(Number(match[1]));
        }
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
      });
      proc.on("error", reject);
      setTimeout(() => {
        reject(new Error(`Python proxy did not report LISTENING within 5s. stderr: ${stderrBuffer}`));
      }, 5000);
    });
  });

  afterEach(async () => {
    proxyProcess?.kill();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it("forwards a plain HTTP request and logs the destination host", async () => {
    const body = await requestThroughProxy("127.0.0.1", upstream.port);
    expect(body).toBe("upstream-ok");

    await new Promise((resolve) => setTimeout(resolve, 100));
    const logged = readFileSync(logPath, "utf8");
    expect(logged).toContain("127.0.0.1");
  });

  it("tunnels a CONNECT request and logs the destination host", async () => {
    await connectThroughProxy("127.0.0.1", upstream.port);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const logged = readFileSync(logPath, "utf8");
    expect(logged).toContain("127.0.0.1");
  });

  it("logs distinct hosts only once each is deduped by the reading layer, but writes one line per request", async () => {
    await requestThroughProxy("127.0.0.1", upstream.port);
    await requestThroughProxy("127.0.0.1", upstream.port);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const logged = readFileSync(logPath, "utf8").trim().split("\n");
    expect(logged).toEqual(["127.0.0.1", "127.0.0.1"]);
  });
});

if (!pythonAvailable) {
  // `describeIfPython` above is `describe.skip` in this environment, so the
  // real-subprocess suite is reported as skipped rather than silently
  // absent — this just documents why, for anyone reading test output.
  // eslint-disable-next-line no-console
  console.warn("python3 not found — skipping the real-subprocess proxy script test suite.");
}
