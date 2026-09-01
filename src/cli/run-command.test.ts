import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloneError,
  PackageManagerUndetectedError,
  SandboxCapacityError,
  SandboxCreditExhaustionError,
  SandboxProvisioningError,
} from "../domain/errors.js";
import type { Report } from "../domain/types.js";

const { runScanMock, sandboxDestroyMock, sandboxAdapterCtor, captureAdapterCtor } = vi.hoisted(() => {
  return {
    runScanMock: vi.fn(),
    sandboxDestroyMock: vi.fn(),
    sandboxAdapterCtor: vi.fn(),
    captureAdapterCtor: vi.fn(),
  };
});

vi.mock("../domain/scan.js", () => ({
  runScan: runScanMock,
}));

vi.mock("../adapters/sandbox/sandbox-adapter.js", () => {
  class SandboxAdapter {
    constructor(options: unknown) {
      sandboxAdapterCtor(options);
    }
    provision = vi.fn();
    clone = vi.fn();
    listDirectory = vi.fn();
    runCommand = vi.fn();
    destroy = sandboxDestroyMock;
    requireSandboxHandle = vi.fn(() => ({ files: {}, commands: {} }));
  }
  return { SandboxAdapter };
});

vi.mock("../adapters/capture/capture-adapter.js", () => {
  class CaptureAdapter {
    constructor(guest: unknown) {
      captureAdapterCtor(guest);
    }
  }
  return { CaptureAdapter };
});

import { renderScanError, runCommand, INTERRUPT_EXIT_CODE, UNEXPECTED_ERROR_EXIT_CODE } from "./run-command.js";

function makeReport(overrides: Partial<Report> = {}): Report {
  const base: Report = {
    scan: {
      input: { repoUrl: "https://github.com/acme/widgets", prNumber: 42 },
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:00:05.000Z"),
      execution: {
        installCommand: "npm install",
        buildCommand: "npm run build",
        installExitCode: 0,
        buildExitCode: 0,
        failed: false,
      },
      telemetry: {
        filesHashedBaseline: 10,
        filesHashedPostRun: 12,
        proxyPort: 8080,
        connectionsObserved: 2,
      },
    },
    findings: [],
    shape: { kind: "clean" },
  };
  return { ...base, ...overrides };
}

describe("renderScanError", () => {
  it("maps SandboxCreditExhaustionError to a specific message and exit code, never a raw stack trace", () => {
    const err = new SandboxCreditExhaustionError("Payment required");
    const { message, exitCode } = renderScanError(err);
    expect(message).toContain("credits");
    expect(message).not.toContain("at ");
    expect(exitCode).toBeGreaterThan(0);
  });

  it("maps SandboxCapacityError to a distinct exit code naming the concurrency constraint", () => {
    const err = new SandboxCapacityError("Too many live sandboxes");
    const { message, exitCode } = renderScanError(err);
    expect(message.toLowerCase()).toContain("capacity");
    expect(exitCode).toBeGreaterThan(0);
  });

  it("maps SandboxProvisioningError to a distinct exit code", () => {
    const err = new SandboxProvisioningError("boom");
    const { message, exitCode } = renderScanError(err);
    expect(message.toLowerCase()).toContain("provisioning");
    expect(exitCode).toBeGreaterThan(0);
  });

  it("maps CloneError to a distinct exit code naming the clone failure", () => {
    const err = new CloneError("repository not found");
    const { message, exitCode } = renderScanError(err);
    expect(message.toLowerCase()).toContain("clon");
    expect(exitCode).toBeGreaterThan(0);
  });

  it("maps PackageManagerUndetectedError to a distinct exit code", () => {
    const err = new PackageManagerUndetectedError("no marker file found");
    const { message, exitCode } = renderScanError(err);
    expect(message.toLowerCase()).toContain("package manager");
    expect(exitCode).toBeGreaterThan(0);
  });

  it("every known ScanError kind maps to a distinct, non-zero exit code", () => {
    const errors = [
      new SandboxCreditExhaustionError("x"),
      new SandboxCapacityError("x"),
      new SandboxProvisioningError("x"),
      new CloneError("x"),
      new PackageManagerUndetectedError("x"),
    ];
    const codes = errors.map((err) => renderScanError(err).exitCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => code > 0)).toBe(true);
  });
});

describe("runCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("on success: renders the report, writes the JSON artifact, and destroys the sandbox exactly once", async () => {
    const report = makeReport();
    runScanMock.mockResolvedValue(report);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const writeReportJson = vi.fn().mockResolvedValue(undefined);

    const result = await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 42 },
      stdout,
      stderr,
      writeReportJson,
    });

    expect(result.exitCode).toBe(0);
    expect(sandboxDestroyMock).toHaveBeenCalledTimes(1);
    expect(writeReportJson).toHaveBeenCalledTimes(1);
    expect(writeReportJson.mock.calls[0]?.[0]).toBe("./solari-scan-report.json");
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout.mock.calls.some(([line]) => typeof line === "string" && line.includes("Sandbox provisioned"))).toBe(
      true,
    );
  });

  it("wires SandboxAdapter with the config's apiKey/baseUrl", async () => {
    runScanMock.mockResolvedValue(makeReport());

    await runCommand({
      config: { apiKey: "sk-abc", baseUrl: "https://custom.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 1 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn().mockResolvedValue(undefined),
    });

    expect(sandboxAdapterCtor).toHaveBeenCalledWith({ apiKey: "sk-abc", baseUrl: "https://custom.test" });
  });

  it("wires CaptureAdapter with a guest-access shim (not the raw SandboxAdapter)", async () => {
    runScanMock.mockResolvedValue(makeReport());

    await runCommand({
      config: { apiKey: "sk-abc", baseUrl: "https://custom.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 1 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn().mockResolvedValue(undefined),
    });

    expect(captureAdapterCtor).toHaveBeenCalledTimes(1);
    const guest = captureAdapterCtor.mock.calls[0]?.[0];
    expect(guest).toHaveProperty("list");
    expect(guest).toHaveProperty("stat");
    expect(guest).toHaveProperty("read");
    expect(guest).toHaveProperty("write");
    expect(guest).toHaveProperty("start");
  });

  it("passes both ports into runScan", async () => {
    runScanMock.mockResolvedValue(makeReport());

    await runCommand({
      config: { apiKey: "sk-abc", baseUrl: "https://custom.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 7 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn().mockResolvedValue(undefined),
    });

    expect(runScanMock).toHaveBeenCalledTimes(1);
    const [input, ports] = runScanMock.mock.calls[0] ?? [];
    expect(input).toEqual({ repoUrl: "https://github.com/acme/widgets", prNumber: 7 });
    expect(ports).toHaveProperty("sandbox");
    expect(ports).toHaveProperty("capture");
  });

  it("on a SandboxCreditExhaustionError from runScan: prints a clear message, sets the mapped exit code, and still destroys the sandbox once", async () => {
    runScanMock.mockRejectedValue(new SandboxCreditExhaustionError("Payment required"));
    const stderr = vi.fn();

    const result = await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 42 },
      stdout: vi.fn(),
      stderr,
      writeReportJson: vi.fn(),
    });

    expect(result.exitCode).toBe(renderScanError(new SandboxCreditExhaustionError("x")).exitCode);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0]).not.toContain(" at "); // no stack trace
    expect(sandboxDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("on a SandboxCapacityError from runScan: maps to its own exit code and destroys the sandbox once", async () => {
    runScanMock.mockRejectedValue(new SandboxCapacityError("Too many live sandboxes"));

    const result = await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 42 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn(),
    });

    expect(result.exitCode).toBe(renderScanError(new SandboxCapacityError("x")).exitCode);
    expect(sandboxDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("on a CloneError from runScan: maps to its own exit code and destroys the sandbox once", async () => {
    runScanMock.mockRejectedValue(new CloneError("repository not found"));

    const result = await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/missing", prNumber: 1 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn(),
    });

    expect(result.exitCode).toBe(renderScanError(new CloneError("x")).exitCode);
    expect(sandboxDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("on a PackageManagerUndetectedError from runScan: maps to its own exit code and destroys the sandbox once", async () => {
    runScanMock.mockRejectedValue(new PackageManagerUndetectedError("no marker file"));

    const result = await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 1 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn(),
    });

    expect(result.exitCode).toBe(renderScanError(new PackageManagerUndetectedError("x")).exitCode);
    expect(sandboxDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("on a genuinely unexpected (non-ScanError) failure: prints a clean message (not a raw stack), uses the generic exit code, and still destroys the sandbox once", async () => {
    runScanMock.mockRejectedValue(new Error("something truly unexpected"));
    const stderr = vi.fn();

    const result = await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 1 },
      stdout: vi.fn(),
      stderr,
      writeReportJson: vi.fn(),
    });

    expect(result.exitCode).toBe(UNEXPECTED_ERROR_EXIT_CODE);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("something truly unexpected");
    expect(stderr.mock.calls[0]?.[0]).not.toContain(" at ");
    expect(sandboxDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("a clean report and a failed-execution report both exit 0 (a non-zero install/build exit is not a CLI error)", async () => {
    const failedReport = makeReport({
      scan: {
        ...makeReport().scan,
        execution: {
          installCommand: "npm install",
          buildCommand: "npm run build",
          installExitCode: 1,
          buildExitCode: { unavailable: true, reason: "build did not run because install exited non-zero" },
          failed: true,
        },
      },
    });
    runScanMock.mockResolvedValue(failedReport);

    const result = await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 1 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.exitCode).toBe(0);
  });

  it("narrates every step-shaped line once, in order, using the final report's telemetry", async () => {
    const report = makeReport();
    runScanMock.mockResolvedValue(report);
    const stdout = vi.fn();

    await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 42 },
      stdout,
      stderr: vi.fn(),
      writeReportJson: vi.fn().mockResolvedValue(undefined),
    });

    const lines = stdout.mock.calls.map(([line]) => line as string);
    expect(lines.some((l) => l.includes("Provisioning sandbox"))).toBe(true);
    expect(lines.some((l) => l.includes("Sandbox provisioned"))).toBe(true);
    expect(lines.some((l) => l.includes("Cloned") && l.includes("PR #42"))).toBe(true);
    expect(lines.some((l) => l.includes("Baseline snapshot") && l.includes("10"))).toBe(true);
    expect(lines.some((l) => l.includes("Proxy listening on port 8080"))).toBe(true);
    expect(lines.some((l) => l.includes("Running install: npm install"))).toBe(true);
    expect(lines.some((l) => l.includes("Running build: npm run build"))).toBe(true);
    expect(lines.some((l) => l.includes("Post-run snapshot") && l.includes("12"))).toBe(true);
    expect(lines.some((l) => l.includes("observed 2 distinct connections"))).toBe(true);
    expect(lines.some((l) => l.includes("Sandbox destroyed"))).toBe(true);
    expect(lines.join("\n")).not.toContain("safe");
    expect(lines.join("\n")).not.toContain("unsafe");
  });

  it("registers and cleans up SIGINT/SIGTERM handlers around the scan", async () => {
    runScanMock.mockResolvedValue(makeReport());
    const onSpy = vi.spyOn(process, "once");
    const removeSpy = vi.spyOn(process, "removeListener");

    await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 1 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn().mockResolvedValue(undefined),
    });

    const registeredSignals = onSpy.mock.calls.map(([signal]) => signal);
    expect(registeredSignals).toContain("SIGINT");
    expect(registeredSignals).toContain("SIGTERM");
    const removedSignals = removeSpy.mock.calls.map(([signal]) => signal);
    expect(removedSignals).toContain("SIGINT");
    expect(removedSignals).toContain("SIGTERM");

    onSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("on a user interrupt (SIGINT) during the scan: destroys the sandbox and exits with the interrupt code", async () => {
    let sigintHandler: (() => void) | undefined;
    const onSpy = vi.spyOn(process, "once").mockImplementation(((signal: string, handler: () => void) => {
      if (signal === "SIGINT") {
        sigintHandler = handler;
      }
      return process;
    }) as typeof process.once);
    vi.spyOn(process, "removeListener").mockImplementation(() => process);

    runScanMock.mockImplementation(async () => {
      sigintHandler?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return makeReport();
    });

    const result = await runCommand({
      config: { apiKey: "sk-test", baseUrl: "https://api.test" },
      args: { repoUrl: "https://github.com/acme/widgets", prNumber: 1 },
      stdout: vi.fn(),
      stderr: vi.fn(),
      writeReportJson: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.exitCode).toBe(INTERRUPT_EXIT_CODE);
    expect(sandboxDestroyMock).toHaveBeenCalled();

    onSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
