/**
 * The Scan orchestrator: sequences the seven-step mechanism (provision →
 * clone → baseline snapshot → proxy start → install/build → post-run
 * snapshot → classify) against `SandboxPort`/`CapturePort`, and produces a
 * `Report`. No real filesystem, network, or Solari SDK calls — only the
 * ports. `report`/`command` render the result; this function's job ends at
 * a typed `Report`.
 */

import { PackageManagerUndetectedError } from "./errors.js";
import { detectPackageManager } from "./package-manager.js";
import type { CapturePort, SandboxPort } from "./ports.js";
import {
  buildReport,
  isUnavailable,
  type ExecutionResult,
  type Finding,
  type Report,
  type ScanInput,
  type ScanTelemetry,
} from "./types.js";
import { classifyDestination } from "./allowlist.js";

export interface ScanPorts {
  sandbox: SandboxPort;
  capture: CapturePort;
}

/**
 * Optional live-output forwarding for the install/build steps. `command`
 * passes real terminal-writing callbacks here so stdout/stderr streams as
 * produced rather than being buffered and narrated in a post-hoc burst
 * (Correction Protocol: `runScan` previously called
 * `ports.sandbox.runCommand` without forwarding `RunCommandOptions.onStdout`/
 * `onStderr` at all, even though `sandbox-adapter` already wired them
 * through to the real SDK — the one gap in an otherwise-complete plumbing
 * path). Optional and separate from `ScanPorts`: it's an output sink, not a
 * dependency `domain`'s own logic branches on.
 */
export interface ScanOutput {
  onInstallOutput?: (stream: "stdout" | "stderr", data: string) => void;
  onBuildOutput?: (stream: "stdout" | "stderr", data: string) => void;
}

/** Directory the repo is cloned into, relative to the sandbox root. Fixed
 *  so `CapturePort.diffFilesystem` can identify writes outside it. */
const REPO_DIR = "repo";

/**
 * Run one Scan end to end. Provisioning/clone failures propagate as the
 * typed errors adapters throw (`SandboxProvisioningError`,
 * `SandboxCapacityError`, `SandboxCreditExhaustionError`, `CloneError`) —
 * the sandbox is destroyed on every path once it exists, including these.
 * An install/build non-zero exit is not an error: capture and reporting
 * continue and the Report says so.
 */
export async function runScan(input: ScanInput, ports: ScanPorts, output: ScanOutput = {}): Promise<Report> {
  const startedAt = new Date();
  const findings: Finding[] = [];

  await ports.sandbox.provision();

  try {
    await ports.sandbox.clone(input.repoUrl, { path: REPO_DIR, prNumber: input.prNumber });

    const rootEntries = await ports.sandbox.listDirectory(REPO_DIR);
    const detected = detectPackageManager(rootEntries.map((entry) => entry.name));
    if (!detected) {
      throw new PackageManagerUndetectedError(
        `No known package manager marker file found at the root of ${input.repoUrl}`,
      );
    }

    const baselineSnapshot = await ports.capture.snapshotFilesystem();
    const filesHashedBaseline = baselineSnapshot.entries.length;

    const { port: proxyPort, env: proxyEnv } = await ports.capture.startProxy();

    const installResult = await ports.sandbox.runCommand(detected.installCommand, {
      cwd: REPO_DIR,
      env: proxyEnv,
      ...(output.onInstallOutput ? { onStdout: (data: string) => output.onInstallOutput?.("stdout", data) } : {}),
      ...(output.onInstallOutput ? { onStderr: (data: string) => output.onInstallOutput?.("stderr", data) } : {}),
    });
    const buildExitCode: ExecutionResult["buildExitCode"] =
      installResult.exitCode === 0
        ? (
            await ports.sandbox.runCommand(detected.buildCommand, {
              cwd: REPO_DIR,
              env: proxyEnv,
              ...(output.onBuildOutput ? { onStdout: (data: string) => output.onBuildOutput?.("stdout", data) } : {}),
              ...(output.onBuildOutput ? { onStderr: (data: string) => output.onBuildOutput?.("stderr", data) } : {}),
            })
          ).exitCode
        : { unavailable: true, reason: "build did not run because install exited non-zero" };

    const observedConnections = await ports.capture.stopProxy();

    const postRunSnapshot = await ports.capture.snapshotFilesystem();
    const filesHashedPostRun = postRunSnapshot.entries.length;

    const filesystemChanges = await ports.capture.diffFilesystem(baselineSnapshot, postRunSnapshot, REPO_DIR);
    for (const change of filesystemChanges) {
      findings.push({ kind: "filesystem", detail: change.path, producedBy: "post-run-snapshot" });
    }

    for (const connection of observedConnections) {
      const finding = classifyDestination(connection.host, "classify");
      if (finding) {
        findings.push(finding);
      }
    }

    const telemetry: ScanTelemetry = {
      filesHashedBaseline,
      filesHashedPostRun,
      proxyPort,
      connectionsObserved: observedConnections.length,
    };

    const finishedAt = new Date();

    const failed = installResult.exitCode !== 0 || (!isUnavailable(buildExitCode) && buildExitCode !== 0);

    const execution: ExecutionResult = {
      installCommand: detected.installCommand,
      buildCommand: detected.buildCommand,
      installExitCode: installResult.exitCode,
      buildExitCode,
      failed,
    };

    return buildReport({ input, startedAt, finishedAt, execution, telemetry }, findings);
  } finally {
    await ports.sandbox.destroy();
  }
}
