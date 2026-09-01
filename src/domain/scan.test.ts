import { describe, expect, it } from "vitest";
import { PackageManagerUndetectedError, SandboxProvisioningError } from "./errors.js";
import { runScan } from "./scan.js";
import { FakeCapturePort, FakeSandboxPort } from "./test-fakes.js";
import type { ScanInput } from "./types.js";

const INPUT: ScanInput = { repoUrl: "https://github.com/example/repo", prNumber: 42 };

describe("runScan", () => {
  it("reports zero findings for a clean run (allowlisted host, no writes outside repo dir)", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      observedConnections: [{ host: "registry.npmjs.org" }],
      filesystemChanges: [],
    });

    const report = await runScan(INPUT, { sandbox, capture });

    expect(report.findings).toEqual([]);
    expect(report.shape).toEqual({ kind: "clean" });
    expect(report.scan.execution.failed).toBe(false);
    expect(sandbox.destroyCallCount).toBe(1);
  });

  it("reports both network and filesystem findings when both are present", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      observedConnections: [{ host: "registry.npmjs.org" }, { host: "telemetry.evil.example" }],
      filesystemChanges: [{ path: "/etc/passwd", changeType: "modified" }],
    });

    const report = await runScan(INPUT, { sandbox, capture });

    expect(report.shape.kind).toBe("itemized");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        { kind: "filesystem", detail: "/etc/passwd", producedBy: "post-run-snapshot" },
        { kind: "network", detail: "telemetry.evil.example", producedBy: "classify" },
      ]),
    );
    expect(report.findings).toHaveLength(2);
  });

  it("still completes capture and reports when install fails, and never runs build", async () => {
    const sandbox = new FakeSandboxPort({
      commandResults: { "npm install": { exitCode: 1 } },
    });
    const capture = new FakeCapturePort();

    const report = await runScan(INPUT, { sandbox, capture });

    expect(report.scan.execution.installExitCode).toBe(1);
    expect(report.scan.execution.buildExitCode).toEqual({
      unavailable: true,
      reason: "build did not run because install exited non-zero",
    });
    expect(report.scan.execution.failed).toBe(true);
    expect(sandbox.commandsRun.map((c) => c.cmd)).toEqual(["npm install"]);
    expect(sandbox.destroyCallCount).toBe(1);
    // capture still ran to completion despite the install failure
    expect(capture.calls).toContain("stopProxy");
  });

  it("still completes capture and reports when build fails", async () => {
    const sandbox = new FakeSandboxPort({
      commandResults: { "npm run build": { exitCode: 2 } },
    });
    const capture = new FakeCapturePort();

    const report = await runScan(INPUT, { sandbox, capture });

    expect(report.scan.execution.installExitCode).toBe(0);
    expect(report.scan.execution.buildExitCode).toBe(2);
    expect(report.scan.execution.failed).toBe(true);
    expect(sandbox.commandsRun.map((c) => c.cmd)).toEqual(["npm install", "npm run build"]);
  });

  it("never runs a test command", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    await runScan(INPUT, { sandbox, capture });

    for (const { cmd } of sandbox.commandsRun) {
      expect(cmd.toLowerCase()).not.toMatch(/\btest\b/);
    }
  });

  it("clones before any command runs", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    await runScan(INPUT, { sandbox, capture });

    const cloneIndex = sandbox.calls.indexOf("clone");
    const firstRunIndex = sandbox.calls.findIndex((c) => c.startsWith("runCommand"));
    expect(cloneIndex).toBeGreaterThanOrEqual(0);
    expect(firstRunIndex).toBeGreaterThan(cloneIndex);
  });

  it("destroys the sandbox exactly once even when provisioning throws", async () => {
    const sandbox = new FakeSandboxPort({ provisionError: new SandboxProvisioningError("no capacity") });
    const capture = new FakeCapturePort();

    await expect(runScan(INPUT, { sandbox, capture })).rejects.toBeInstanceOf(SandboxProvisioningError);
    // provision itself failed, so nothing was provisioned to destroy
    expect(sandbox.destroyCallCount).toBe(0);
  });

  it("destroys the sandbox exactly once when an error occurs after provisioning", async () => {
    const sandbox = new FakeSandboxPort({ rootEntries: [{ name: "README.md", dir: false }] });
    const capture = new FakeCapturePort();

    await expect(runScan(INPUT, { sandbox, capture })).rejects.toBeInstanceOf(PackageManagerUndetectedError);
    expect(sandbox.destroyCallCount).toBe(1);
  });

  it("passes proxy env vars into install and build commands", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({ proxyPort: 9999 });

    await runScan(INPUT, { sandbox, capture });

    for (const { options } of sandbox.commandsRun) {
      expect(options?.env?.HTTP_PROXY).toBe("http://127.0.0.1:9999");
    }
  });

  it("runs install and build inside the cloned repo directory, not the sandbox default cwd", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    await runScan(INPUT, { sandbox, capture });

    for (const { options } of sandbox.commandsRun) {
      expect(options?.cwd).toBe("repo");
    }
  });

  it("reports real observed telemetry values, not placeholders", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      baselineSnapshot: { entries: [{ path: "repo/a.txt", hash: "h1" }, { path: "repo/b.txt", hash: "h2" }] },
      postRunSnapshot: { entries: [{ path: "repo/a.txt", hash: "h1" }] },
      proxyPort: 54321,
      observedConnections: [{ host: "github.com" }, { host: "registry.npmjs.org" }],
    });

    const report = await runScan(INPUT, { sandbox, capture });

    expect(report.scan.telemetry.filesHashedBaseline).toBe(2);
    expect(report.scan.telemetry.filesHashedPostRun).toBe(1);
    expect(report.scan.telemetry.proxyPort).toBe(54321);
    expect(report.scan.telemetry.connectionsObserved).toBe(2);
  });

  it("forwards install/build stdout/stderr live to the caller's output callbacks", async () => {
    // Correction Protocol: runScan previously called
    // ports.sandbox.runCommand without forwarding onStdout/onStderr at
    // all, so install/build output was never streamed anywhere — command
    // could only narrate a burst of already-known facts after runScan
    // resolved, never the live process output itself.
    const sandbox = new FakeSandboxPort({
      commandOutput: {
        "npm install": [{ stream: "stdout", data: "installing...\n" }],
        "npm run build": [
          { stream: "stdout", data: "building...\n" },
          { stream: "stderr", data: "a warning\n" },
        ],
      },
    });
    const capture = new FakeCapturePort();

    const installChunks: Array<{ stream: string; data: string }> = [];
    const buildChunks: Array<{ stream: string; data: string }> = [];

    await runScan(
      INPUT,
      { sandbox, capture },
      {
        onInstallOutput: (stream, data) => installChunks.push({ stream, data }),
        onBuildOutput: (stream, data) => buildChunks.push({ stream, data }),
      },
    );

    expect(installChunks).toEqual([{ stream: "stdout", data: "installing...\n" }]);
    expect(buildChunks).toEqual([
      { stream: "stdout", data: "building...\n" },
      { stream: "stderr", data: "a warning\n" },
    ]);
  });

  it("runs with no output callbacks at all without throwing (ScanOutput is optional)", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    await expect(runScan(INPUT, { sandbox, capture })).resolves.toBeDefined();
  });

  it("clones with the PR number when input.prNumber is present (existing PR behavior unchanged)", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    const report = await runScan(INPUT, { sandbox, capture });

    expect(sandbox.cloneCalls).toEqual([
      { repoUrl: INPUT.repoUrl, options: { path: "repo", prNumber: 42 } },
    ]);
    expect(report.scan.input.prNumber).toBe(42);
  });

  it("clones without a PR number when input.prNumber is absent (plain repo link, default branch)", async () => {
    const input: ScanInput = { repoUrl: "https://github.com/example/repo" };
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    const report = await runScan(input, { sandbox, capture });

    expect(sandbox.cloneCalls).toEqual([
      { repoUrl: input.repoUrl, options: { path: "repo", prNumber: undefined } },
    ]);
    expect(report.scan.input.prNumber).toBeUndefined();
  });

  it("completes a full scan and reports normally for a plain repo link (no PR)", async () => {
    const input: ScanInput = { repoUrl: "https://github.com/example/repo" };
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      observedConnections: [{ host: "registry.npmjs.org" }],
      filesystemChanges: [],
    });

    const report = await runScan(input, { sandbox, capture });

    expect(report.findings).toEqual([]);
    expect(report.shape).toEqual({ kind: "clean" });
    expect(report.scan.execution.failed).toBe(false);
    expect(report.scan.input.prNumber).toBeUndefined();
    expect(sandbox.destroyCallCount).toBe(1);
  });
});
