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

  it("reports both network and filesystem findings when both are present and --with-fs is on", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      observedConnections: [{ host: "registry.npmjs.org" }, { host: "telemetry.evil.example" }],
      filesystemChanges: [{ path: "/etc/passwd", changeType: "modified" }],
    });

    const report = await runScan({ ...INPUT, withFilesystemCheck: true }, { sandbox, capture });

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

    const report = await runScan({ ...INPUT, withFilesystemCheck: true }, { sandbox, capture });

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

  it("fires onInstallExit and onBuildExit with the real exit codes right as each command resolves", async () => {
    const sandbox = new FakeSandboxPort({
      commandResults: { "npm install": { exitCode: 0 }, "npm run build": { exitCode: 0 } },
    });
    const capture = new FakeCapturePort();

    const events: Array<{ kind: string; exitCode: number }> = [];

    await runScan(
      INPUT,
      { sandbox, capture },
      {
        onInstallExit: (exitCode) => events.push({ kind: "install", exitCode }),
        onBuildExit: (exitCode) => events.push({ kind: "build", exitCode }),
      },
    );

    expect(events).toEqual([
      { kind: "install", exitCode: 0 },
      { kind: "build", exitCode: 0 },
    ]);
  });

  it("fires onInstallExit with the non-zero exit code and never fires onBuildExit when install fails", async () => {
    const sandbox = new FakeSandboxPort({
      commandResults: { "npm install": { exitCode: 1 } },
    });
    const capture = new FakeCapturePort();

    const installExits: number[] = [];
    const buildExits: number[] = [];

    await runScan(
      INPUT,
      { sandbox, capture },
      {
        onInstallExit: (exitCode) => installExits.push(exitCode),
        onBuildExit: (exitCode) => buildExits.push(exitCode),
      },
    );

    expect(installExits).toEqual([1]);
    expect(buildExits).toEqual([]);
  });

  it("fires onBuildExit with a non-zero build exit code", async () => {
    const sandbox = new FakeSandboxPort({
      commandResults: { "npm run build": { exitCode: 2 } },
    });
    const capture = new FakeCapturePort();

    const buildExits: number[] = [];

    await runScan(
      INPUT,
      { sandbox, capture },
      { onBuildExit: (exitCode) => buildExits.push(exitCode) },
    );

    expect(buildExits).toEqual([2]);
  });

  it("runs with no output callbacks at all without throwing (ScanOutput is optional)", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    await expect(runScan(INPUT, { sandbox, capture })).resolves.toBeDefined();
  });

  it("fires onProxyLogParseStart/onProxyLogParseDone around stopProxy with the real connection count", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      observedConnections: [{ host: "registry.npmjs.org" }, { host: "github.com" }],
    });

    const events: string[] = [];

    await runScan(
      INPUT,
      { sandbox, capture },
      {
        onProxyLogParseStart: () => events.push("start"),
        onProxyLogParseDone: (connectionsObserved) => events.push(`done:${connectionsObserved}`),
      },
    );

    expect(events).toEqual(["start", "done:2"]);
  });

  it("fires onPostRunSnapshotStart/onPostRunSnapshotDone around the post-run snapshotFilesystem call with the real hashed-file count", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      baselineSnapshot: { entries: [{ path: "repo/a.txt", hash: "h1" }] },
      postRunSnapshot: {
        entries: [
          { path: "repo/a.txt", hash: "h1" },
          { path: "repo/b.txt", hash: "h2" },
          { path: "repo/c.txt", hash: "h3" },
        ],
      },
    });

    const events: string[] = [];

    await runScan(
      { ...INPUT, withFilesystemCheck: true },
      { sandbox, capture },
      {
        onPostRunSnapshotStart: () => events.push("start"),
        onPostRunSnapshotDone: (filesHashed) => events.push(`done:${filesHashed}`),
      },
    );

    expect(events).toEqual(["start", "done:3"]);
  });

  it("fires proxy-log-parse and post-run-snapshot callbacks in scan order: proxy parse completes before the post-run snapshot starts", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    const events: string[] = [];

    await runScan(
      { ...INPUT, withFilesystemCheck: true },
      { sandbox, capture },
      {
        onProxyLogParseStart: () => events.push("proxyStart"),
        onProxyLogParseDone: () => events.push("proxyDone"),
        onPostRunSnapshotStart: () => events.push("snapshotStart"),
        onPostRunSnapshotDone: () => events.push("snapshotDone"),
      },
    );

    expect(events).toEqual(["proxyStart", "proxyDone", "snapshotStart", "snapshotDone"]);
  });

  it("does not fire onPostRunSnapshotStart/Done for the baseline snapshot call, only the post-run one", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort();

    const startCalls: number[] = [];
    const doneCalls: number[] = [];

    await runScan(
      { ...INPUT, withFilesystemCheck: true },
      { sandbox, capture },
      {
        onPostRunSnapshotStart: () => startCalls.push(1),
        onPostRunSnapshotDone: (filesHashed) => doneCalls.push(filesHashed),
      },
    );

    // FakeCapturePort's snapshotFilesystem is called twice (baseline, post-run);
    // only the second (post-run) call should trigger these callbacks.
    expect(capture.calls.filter((c) => c === "snapshotFilesystem")).toHaveLength(2);
    expect(startCalls).toHaveLength(1);
    expect(doneCalls).toHaveLength(1);
  });

  it("never calls snapshotFilesystem/diffFilesystem or fires post-run-snapshot callbacks when withFilesystemCheck is off (the default)", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      observedConnections: [{ host: "registry.npmjs.org" }],
    });

    const events: string[] = [];

    const report = await runScan(
      INPUT,
      { sandbox, capture },
      {
        onPostRunSnapshotStart: () => events.push("start"),
        onPostRunSnapshotDone: () => events.push("done"),
      },
    );

    expect(capture.calls).not.toContain("snapshotFilesystem");
    expect(capture.calls).not.toContain("diffFilesystem");
    expect(events).toEqual([]);
    expect(report.scan.telemetry.filesHashedBaseline).toBeUndefined();
    expect(report.scan.telemetry.filesHashedPostRun).toBeUndefined();
    expect("filesHashedBaseline" in report.scan.telemetry).toBe(false);
    expect("filesHashedPostRun" in report.scan.telemetry).toBe(false);
  });

  it("produces zero filesystem findings when withFilesystemCheck is off, even if the fake capture port is configured to report changes", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      observedConnections: [{ host: "registry.npmjs.org" }],
      filesystemChanges: [{ path: "/etc/passwd", changeType: "modified" }],
    });

    const report = await runScan(INPUT, { sandbox, capture });

    expect(report.findings.some((f) => f.kind === "filesystem")).toBe(false);
  });

  it("runs unchanged when onPostRunSnapshotStart/Done and onProxyLogParseStart/Done aren't provided", async () => {
    const sandbox = new FakeSandboxPort();
    const capture = new FakeCapturePort({
      observedConnections: [{ host: "registry.npmjs.org" }],
      filesystemChanges: [],
    });

    const report = await runScan(INPUT, { sandbox, capture });

    expect(report.findings).toEqual([]);
    expect(report.shape).toEqual({ kind: "clean" });
    expect(report.scan.execution.failed).toBe(false);
    expect(report.scan.telemetry.connectionsObserved).toBe(1);
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
