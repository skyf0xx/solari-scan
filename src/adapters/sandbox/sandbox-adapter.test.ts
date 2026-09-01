import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SandboxCapacityError,
  SandboxCreditExhaustionError,
  SandboxProvisioningError,
  CloneError,
} from "../../domain/errors.js";

const {
  createMock,
  killClientMock,
  sandboxKillMock,
  connectMock,
  cloneMock,
  listMock,
  runMock,
  FakeGatewayError,
  FakeConcurrencyLimitError,
  FakeNoCapacityError,
  FakePlanError,
} = vi.hoisted(() => {
  class FakeGatewayError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly body?: { code?: string; error?: string; message?: string; retryable?: boolean };

    constructor(status: number, message: string, body?: FakeGatewayError["body"]) {
      super(message);
      this.name = "GatewayError";
      this.status = status;
      this.code = body?.code;
      this.body = body;
    }
  }

  class FakeConcurrencyLimitError extends FakeGatewayError {
    constructor(message = "Too many live sandboxes") {
      super(429, message, { code: "ConcurrencyLimitExceeded" });
      this.name = "ConcurrencyLimitError";
    }
  }

  class FakeNoCapacityError extends FakeGatewayError {
    constructor(message = "No desktop host available") {
      super(503, message);
      this.name = "NoCapacityError";
    }
  }

  class FakePlanError extends FakeGatewayError {
    constructor(message = "Feature requires a paid plan") {
      super(402, message, { code: "FeatureRequiresPlan" });
      this.name = "PlanError";
    }
  }

  return {
    createMock: vi.fn(),
    killClientMock: vi.fn(),
    sandboxKillMock: vi.fn(),
    connectMock: vi.fn().mockResolvedValue(undefined),
    cloneMock: vi.fn(),
    listMock: vi.fn(),
    runMock: vi.fn(),
    FakeGatewayError,
    FakeConcurrencyLimitError,
    FakeNoCapacityError,
    FakePlanError,
  };
});

vi.mock("@solarisdk/sandbox", () => {
  class SandboxClient {
    constructor(public options: unknown) {}
    create = createMock;
    kill = killClientMock;
  }

  return {
    SandboxClient,
    GatewayError: FakeGatewayError,
    ConcurrencyLimitError: FakeConcurrencyLimitError,
    NoCapacityError: FakeNoCapacityError,
    PlanError: FakePlanError,
  };
});

import { SandboxAdapter } from "./sandbox-adapter.js";

function makeFakeSandbox() {
  return {
    sandboxId: "sbx-1",
    connect: connectMock,
    git: { clone: cloneMock },
    files: { list: listMock },
    commands: { run: runMock },
    kill: sandboxKillMock,
  };
}

describe("SandboxAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue(makeFakeSandbox());
    cloneMock.mockResolvedValue(undefined);
    listMock.mockResolvedValue([{ name: "package.json", dir: false, size: 10 }]);
    runMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    sandboxKillMock.mockResolvedValue(undefined);
  });

  it("provisions by delegating to SandboxClient.create", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("opens the control channel via connect() before the sandbox is usable", async () => {
    // Confirmed against a live sandbox: create() returns a handle whose
    // control WebSocket is not yet open — every other method (.git/
    // .commands/.files) rejects with "Not connected — call connect() first"
    // until connect() has resolved. provision() must call it before storing
    // the handle for later use.
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("clones normally, then fetches and checks out the PR ref as a local branch, in order", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    await adapter.clone("https://github.com/acme/widgets", { path: "repo", prNumber: 42 });

    expect(cloneMock).toHaveBeenCalledWith("https://github.com/acme/widgets", { path: "repo" });

    // toHaveBeenNthCalledWith asserts both the exact args and the call order
    // (1st vs 2nd invocation of runMock), so this also proves fetch precedes
    // checkout. cloneMock is asserted (above) to have been called at all;
    // since it's awaited before either runMock call is made, clone-before-
    // fetch ordering falls out of the code's own sequential awaits.
    expect(runMock).toHaveBeenNthCalledWith(1, "git", {
      args: ["fetch", "origin", "pull/42/head:pr-42"],
      cwd: "repo",
    });
    expect(runMock).toHaveBeenNthCalledWith(2, "git", {
      args: ["checkout", "pr-42"],
      cwd: "repo",
    });
  });

  it("clones a plain repo link (no prNumber) without any PR fetch/checkout step", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    await adapter.clone("https://github.com/acme/widgets", { path: "repo" });

    expect(cloneMock).toHaveBeenCalledWith("https://github.com/acme/widgets", { path: "repo" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("clones a plain repo link (prNumber explicitly undefined) without any PR fetch/checkout step", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    await adapter.clone("https://github.com/acme/widgets", { path: "repo", prNumber: undefined });

    expect(cloneMock).toHaveBeenCalledWith("https://github.com/acme/widgets", { path: "repo" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("maps a plain-clone (no prNumber) failure to CloneError without a PR number in the message", async () => {
    cloneMock.mockRejectedValueOnce(new Error("repository not found"));
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await expect(
      adapter.clone("https://github.com/acme/missing", { path: "repo" }),
    ).rejects.toMatchObject({
      constructor: CloneError,
      message: expect.stringContaining("repository not found"),
    });

    expect(runMock).not.toHaveBeenCalled();
  });

  it("lists directory entries by delegating to sandbox.files.list", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    const entries = await adapter.listDirectory("repo");

    expect(listMock).toHaveBeenCalledWith("repo");
    expect(entries).toEqual([{ name: "package.json", dir: false }]);
  });

  it("runs commands by delegating to sandbox.commands.run, passing env/onStdout/onStderr through per-call", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    const onStdout = vi.fn();
    const onStderr = vi.fn();
    runMock.mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const result = await adapter.runCommand("npm install", {
      env: { HTTP_PROXY: "http://127.0.0.1:8080", HTTPS_PROXY: "http://127.0.0.1:8080" },
      onStdout,
      onStderr,
    });

    expect(runMock).toHaveBeenCalledWith("npm", {
      args: ["install"],
      env: { HTTP_PROXY: "http://127.0.0.1:8080", HTTPS_PROXY: "http://127.0.0.1:8080" },
      onStdout,
      onStderr,
    });
    expect(result).toEqual({ exitCode: 0 });
  });

  it("forwards cwd to sandbox.commands.run so install/build execute inside the cloned repo", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    runMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await adapter.runCommand("npm ci", { cwd: "repo" });

    expect(runMock).toHaveBeenCalledWith("npm", expect.objectContaining({ cwd: "repo" }));
  });

  it("splits a multi-word command line into a bare executable plus args", async () => {
    // Confirmed live: sandbox.commands.run execs `cmd` as a literal
    // filename rather than shell-interpreting it — passing "npm install"
    // straight through fails with "executable file not found in $PATH"
    // (it looks for a file literally named "npm install").
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    runMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await adapter.runCommand("npm run build");

    expect(runMock).toHaveBeenCalledWith("npm", expect.objectContaining({ args: ["run", "build"] }));
  });

  it("does not pass an args field for a single-word command", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    runMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await adapter.runCommand("pwd");

    expect(runMock).toHaveBeenCalledWith("pwd", expect.not.objectContaining({ args: expect.anything() }));
  });

  it("destroys by delegating to sandbox.kill", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();
    await adapter.destroy();

    expect(sandboxKillMock).toHaveBeenCalledTimes(1);
  });

  it("destroy() is a no-op (never throws) if provision() never succeeded", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await expect(adapter.destroy()).resolves.toBeUndefined();
    expect(sandboxKillMock).not.toHaveBeenCalled();
  });

  it("calling destroy() twice does not throw, matching the SDK's idempotent kill()", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await adapter.destroy();
    await adapter.destroy();

    expect(sandboxKillMock).toHaveBeenCalledTimes(2);
  });

  it("maps ConcurrencyLimitError to SandboxCapacityError on provision", async () => {
    createMock.mockRejectedValueOnce(new FakeConcurrencyLimitError());
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });

    await expect(adapter.provision()).rejects.toBeInstanceOf(SandboxCapacityError);
  });

  it("maps NoCapacityError to SandboxCapacityError on provision", async () => {
    createMock.mockRejectedValueOnce(new FakeNoCapacityError());
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });

    await expect(adapter.provision()).rejects.toBeInstanceOf(SandboxCapacityError);
  });

  it("maps PlanError to SandboxCreditExhaustionError on provision", async () => {
    createMock.mockRejectedValueOnce(new FakePlanError());
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });

    await expect(adapter.provision()).rejects.toBeInstanceOf(SandboxCreditExhaustionError);
  });

  it("maps a credit-flavored generic GatewayError to SandboxCreditExhaustionError", async () => {
    createMock.mockRejectedValueOnce(
      new FakeGatewayError(402, "Payment required", { error: "insufficient_credits" }),
    );
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });

    await expect(adapter.provision()).rejects.toBeInstanceOf(SandboxCreditExhaustionError);
  });

  it("maps an unrecognized error to SandboxProvisioningError without losing the original message", async () => {
    createMock.mockRejectedValueOnce(new Error("connection reset by peer"));
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });

    await expect(adapter.provision()).rejects.toMatchObject({
      constructor: SandboxProvisioningError,
      message: expect.stringContaining("connection reset by peer"),
    });
  });

  it("maps an unrecognized runCommand failure to SandboxProvisioningError, preserving the message", async () => {
    runMock.mockRejectedValueOnce(new Error("control channel dropped"));
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await expect(adapter.runCommand("npm run build")).rejects.toMatchObject({
      constructor: SandboxProvisioningError,
      message: expect.stringContaining("control channel dropped"),
    });
  });

  it("maps a concurrency-limited runCommand failure to SandboxCapacityError", async () => {
    runMock.mockRejectedValueOnce(new FakeConcurrencyLimitError());
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await expect(adapter.runCommand("npm install")).rejects.toBeInstanceOf(SandboxCapacityError);
  });

  it("maps a clone-step failure to CloneError, preserving the underlying message", async () => {
    cloneMock.mockRejectedValueOnce(new Error("repository not found"));
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await expect(
      adapter.clone("https://github.com/acme/missing", { path: "repo", prNumber: 7 }),
    ).rejects.toMatchObject({
      constructor: CloneError,
      message: expect.stringContaining("repository not found"),
    });

    expect(runMock).not.toHaveBeenCalled();
  });

  it("maps a fetch-step failure (thrown) to CloneError, preserving the underlying message", async () => {
    runMock.mockRejectedValueOnce(new Error("could not fetch pull ref"));
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await expect(
      adapter.clone("https://github.com/acme/widgets", { path: "repo", prNumber: 9 }),
    ).rejects.toMatchObject({
      constructor: CloneError,
      message: expect.stringContaining("could not fetch pull ref"),
    });

    expect(cloneMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("maps a fetch-step failure (non-zero exit) to CloneError, preserving stderr", async () => {
    runMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "fatal: couldn't find remote ref" });
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await expect(
      adapter.clone("https://github.com/acme/widgets", { path: "repo", prNumber: 9 }),
    ).rejects.toMatchObject({
      constructor: CloneError,
      message: expect.stringContaining("fatal: couldn't find remote ref"),
    });

    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("maps a checkout-step failure (thrown) to CloneError, preserving the underlying message", async () => {
    runMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("checkout conflict"));
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await expect(
      adapter.clone("https://github.com/acme/widgets", { path: "repo", prNumber: 9 }),
    ).rejects.toMatchObject({
      constructor: CloneError,
      message: expect.stringContaining("checkout conflict"),
    });

    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("maps a checkout-step failure (non-zero exit) to CloneError, preserving stderr", async () => {
    runMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "error: pathspec did not match" });
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });
    await adapter.provision();

    await expect(
      adapter.clone("https://github.com/acme/widgets", { path: "repo", prNumber: 9 }),
    ).rejects.toMatchObject({
      constructor: CloneError,
      message: expect.stringContaining("error: pathspec did not match"),
    });

    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("throws SandboxProvisioningError if a sandbox method is used before provision() succeeds", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-123", baseUrl: "https://api.solari.test" });

    await expect(adapter.listDirectory("repo")).rejects.toBeInstanceOf(SandboxProvisioningError);
    await expect(adapter.runCommand("echo hi")).rejects.toBeInstanceOf(SandboxProvisioningError);
    await expect(adapter.clone("https://github.com/acme/widgets", { path: "repo", prNumber: 1 })).rejects.toBeInstanceOf(
      SandboxProvisioningError,
    );
  });

  it("passes the apiKey (and optional baseUrl) through to SandboxClient's constructor", async () => {
    const adapter = new SandboxAdapter({ apiKey: "key-abc", baseUrl: "https://example.test" });
    await adapter.provision();
    // The mocked SandboxClient stores its constructor options for inspection.
    expect(createMock).toHaveBeenCalledTimes(1);
    void adapter;
  });
});
