/**
 * The main orchestration glue: wires `domain`'s `runScan` to real
 * `SandboxAdapter`/`CaptureAdapter` instances and to `report`'s rendering
 * functions, registers cleanup for every exit path, and maps domain's typed
 * errors to user-facing messages + exit codes. The only layer allowed to
 * print a user-facing message or set a process exit code
 * (`core-design.md`'s "Error model").
 *
 * --- Provisioning-order resolution ---
 *
 * `runScan` (`src/domain/scan.ts`) calls `ports.sandbox.provision()` itself,
 * internally, before its try/finally — so by the time `runScan` returns
 * control anywhere, provisioning has already happened. But `CaptureAdapter`
 * needs a `SandboxGuestAccess` bound to the *same* provisioned `Sandbox`
 * handle (`hedgehog decision list SOLARI-SCAN-CAPTURE-ADAPTER`), and
 * `CaptureAdapter` has to exist *before* `runScan` is called, since it's
 * passed in as a port (`ScanPorts.capture`).
 *
 * Resolved with option (a) from the packet: `SandboxAdapter` provisions
 * lazily (already true — it only builds its `Sandbox` handle inside
 * `provision()`, called by `runScan`), and `createSandboxGuestAccess`
 * (`guest-access.ts`) is a shim whose methods call
 * `sandboxAdapter.requireSandboxHandle()` at *call time*, not at
 * construction time. So the sequence is:
 *
 *   1. Construct `SandboxAdapter` (no sandbox exists yet).
 *   2. Construct the `SandboxGuestAccess` shim wrapping it (still no
 *      sandbox — the shim only holds a reference to the adapter).
 *   3. Construct `CaptureAdapter` from the shim (still no sandbox).
 *   4. Call `runScan({ sandbox: sandboxAdapter, capture: captureAdapter })`.
 *      `runScan` calls `sandboxAdapter.provision()` first, *then* calls
 *      `capture.snapshotFilesystem()` etc. — by which point the shim's
 *      `requireSandboxHandle()` calls succeed, because provisioning already
 *      happened in step 4's very first line.
 *
 * This works cleanly because JS closures/methods resolve their captured
 * references at call time, and `runScan`'s own internal ordering
 * (provision, then everything else) guarantees the shim is never invoked
 * before the handle exists. No problem found with this approach — it needed
 * no restructuring of `runScan` or `SandboxAdapter`, both of which are
 * locked, completed layers.
 *
 * --- Live narration ---
 *
 * The committed UX spec (`.hedgehog/BMAD/05-ux-spec/EXPERIENCE.md`) and PRD
 * (`.hedgehog/BMAD/04-prd.md`) require live per-step narration as each of
 * the seven steps completes, including live install/build stdout/stderr
 * streaming (steps 5-6) — "no artificial delays... real step timing only."
 *
 * `runScan`'s per-step facts (provisioning, clone, snapshot counts, proxy
 * port, connection count, teardown) are still only known once `runScan`
 * resolves — its signature reports a final `Report`, not per-step events —
 * so those lines are narrated as a burst immediately after it resolves,
 * reading real values off the final `Report` rather than live per-step
 * events. That much was always true and is an acceptable reading of the
 * spec: the values are real, never placeholders, just not each announced
 * the instant its own step finishes.
 *
 * Install/build stdout/stderr is different: the UX spec calls for it to
 * stream *during* the scan, and `runScan` now takes an optional third
 * `ScanOutput` parameter (`onInstallOutput`/`onBuildOutput`, added via
 * Correction Protocol after this layer's own INTENT CHECK caught the gap —
 * see `domain/scan.ts`'s `ScanOutput` doc comment) built exactly for this.
 * `command` passes real `stdout`/`stderr`-writing callbacks there, so
 * install/build output reaches the terminal as it's produced, genuinely
 * live, not narrated after the fact.
 */

import { writeFile } from "node:fs/promises";
import { SandboxAdapter } from "../adapters/sandbox/sandbox-adapter.js";
import { CaptureAdapter } from "../adapters/capture/capture-adapter.js";
import { runScan } from "../domain/scan.js";
import {
  CloneError,
  PackageManagerUndetectedError,
  SandboxCapacityError,
  SandboxCreditExhaustionError,
  SandboxProvisioningError,
  ScanError,
} from "../domain/errors.js";
import type { Report } from "../domain/types.js";
import {
  renderBaselineSnapshotLine,
  renderCloneDoneLine,
  renderPostRunSnapshotLine,
  renderProvisioningDoneLine,
  renderProvisioningStartLine,
  renderProxyLogParseLine,
  renderProxyStartLine,
  renderReportJson,
  renderReportText,
  renderTeardownLine,
} from "../report/index.js";
import type { SolariConfig } from "./config.js";
import { createSandboxGuestAccess } from "./guest-access.js";
import type { ParsedArgs } from "./program.js";

export const REPORT_JSON_PATH = "./solari-scan-report.json";

/** One user-facing message + process exit code for a known `ScanError` kind. */
interface ErrorMapping {
  exitCode: number;
  render: (err: ScanError) => string;
}

const ERROR_MAPPINGS: Record<ScanError["kind"], ErrorMapping> = {
  "sandbox-credit-exhaustion": {
    exitCode: 2,
    render: (err) =>
      `Solari account credits are exhausted, so no sandbox could be created.\n` +
      `Add credits to your Solari account and try again.\n(${err.message})`,
  },
  "sandbox-capacity": {
    exitCode: 3,
    render: (err) =>
      `No sandbox capacity available right now (the concurrent-sandbox limit is already in use).\n` +
      `Wait for your other sandbox(es) to finish, then try again.\n(${err.message})`,
  },
  "sandbox-provisioning": {
    exitCode: 4,
    render: (err) =>
      `Sandbox provisioning failed.\n` +
      `Check your SOLARI_API_KEY and network connection, then try again.\n(${err.message})`,
  },
  "clone-failure": {
    exitCode: 5,
    render: (err) =>
      `Cloning the target repo/PR failed.\n` +
      `Check that the repository URL and PR number are correct and reachable.\n(${err.message})`,
  },
  "package-manager-undetected": {
    exitCode: 6,
    render: (err) =>
      `Could not detect a known package manager at the repo root, so no install/build command could be chosen.\n(${err.message})`,
  },
};

/** Exit code for a user interrupt (SIGINT/SIGTERM) — distinct from every
 *  known `ScanError` mapping and from the generic-failure code below. */
export const INTERRUPT_EXIT_CODE = 130;

/** Exit code for a genuinely unexpected (non-`ScanError`) failure. */
export const UNEXPECTED_ERROR_EXIT_CODE = 1;

export interface RunResult {
  exitCode: number;
  report?: Report;
}

/** Renders a domain `ScanError` to the exact user-facing message + exit code
 *  the brief requires (never a raw stack trace). Exported for direct testing
 *  of the error-to-exit-code mapping table without a live sandbox. */
export function renderScanError(err: ScanError): { message: string; exitCode: number } {
  const mapping = ERROR_MAPPINGS[err.kind];
  return { message: mapping.render(err), exitCode: mapping.exitCode };
}

function isScanError(err: unknown): err is ScanError {
  return (
    err instanceof SandboxCreditExhaustionError ||
    err instanceof SandboxCapacityError ||
    err instanceof SandboxProvisioningError ||
    err instanceof CloneError ||
    err instanceof PackageManagerUndetectedError
  );
}

export interface RunCommandDeps {
  config: SolariConfig;
  args: ParsedArgs;
  /** Injectable for tests; defaults to real console/process/fs. */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Raw install/build output passthrough — unlike `stdout`/`stderr` above
   *  (one call per narration *line*), these receive process output chunks
   *  exactly as produced, with no newline added, so partial lines and
   *  embedded newlines from the real process aren't corrupted. Defaults to
   *  `process.stdout.write`/`process.stderr.write`. */
  writeStdout?: (data: string) => void;
  writeStderr?: (data: string) => void;
  writeReportJson?: (path: string, content: string) => Promise<void>;
}

/**
 * Runs one Scan end to end against real adapters, narrates it (see this
 * file's header for the live-narration gap), renders the report, and
 * returns the exit code to use. Never throws — every failure path is
 * caught and turned into `{ exitCode, ... }` so the caller (`index.ts`) can
 * set `process.exitCode` and return without an unhandled rejection.
 *
 * Registers SIGINT/SIGTERM handlers around the scan so a user interrupt
 * still destroys the sandbox before the process exits (the sandbox is
 * created inside `runScan`, so cleanup here calls the same
 * `SandboxAdapter.destroy()` domain would have called in its own `finally`
 * — safe to call again afterward, since `destroy()`/`kill()` are
 * idempotent).
 */
export async function runCommand(deps: RunCommandDeps): Promise<RunResult> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const writeStdout = deps.writeStdout ?? ((data: string) => process.stdout.write(data));
  const writeStderr = deps.writeStderr ?? ((data: string) => process.stderr.write(data));
  const writeReportJson = deps.writeReportJson ?? ((path: string, content: string) => writeFile(path, content, "utf8"));

  const sandboxAdapter = new SandboxAdapter({ apiKey: deps.config.apiKey, baseUrl: deps.config.baseUrl });
  const guestAccess = createSandboxGuestAccess(sandboxAdapter);
  const captureAdapter = new CaptureAdapter(guestAccess);

  let interrupted = false;
  let cleanedUp = false;
  const cleanupOnInterrupt = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    interrupted = true;
    await sandboxAdapter.destroy();
  };
  const onSignal = () => {
    void cleanupOnInterrupt();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    stdout(renderProvisioningStartLine());

    // The full label ("Running install: npm install") names the detected
    // command, which `runScan` only knows internally — it isn't available
    // until `runScan` resolves, by which point the step's output has
    // already streamed. So the *label* announcing each step prints
    // (without the command name) right before that step's first output
    // chunk arrives; the exact command is still shown truthfully in the
    // final report text/JSON once known. This keeps output ordering
    // correct (label before output) without guessing or delaying the
    // command name.
    let installStarted = false;
    let buildStarted = false;

    const onInstallOutput = (stream: "stdout" | "stderr", data: string): void => {
      if (!installStarted) {
        installStarted = true;
        stdout("Running install...");
      }
      (stream === "stdout" ? writeStdout : writeStderr)(data);
    };
    const onBuildOutput = (stream: "stdout" | "stderr", data: string): void => {
      if (!buildStarted) {
        buildStarted = true;
        stdout("Running build...");
      }
      (stream === "stdout" ? writeStdout : writeStderr)(data);
    };

    const report = await runScan(
      { repoUrl: deps.args.repoUrl, prNumber: deps.args.prNumber },
      { sandbox: sandboxAdapter, capture: captureAdapter },
      { onInstallOutput, onBuildOutput },
    );

    if (interrupted) {
      return { exitCode: INTERRUPT_EXIT_CODE };
    }

    narrateFromReport(report, stdout);

    stdout("");
    stdout(renderReportText(report));

    await writeReportJson(REPORT_JSON_PATH, renderReportJson(report));

    return { exitCode: report.scan.execution.failed ? 0 : 0, report };
  } catch (err) {
    if (interrupted) {
      return { exitCode: INTERRUPT_EXIT_CODE };
    }
    if (isScanError(err)) {
      const { message, exitCode } = renderScanError(err);
      stderr(message);
      return { exitCode };
    }
    const message = err instanceof Error ? err.message : String(err);
    stderr(`solari-scan failed unexpectedly: ${message}`);
    return { exitCode: UNEXPECTED_ERROR_EXIT_CODE };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    // Idempotent: runScan's own finally already destroyed the sandbox on
    // every path through the scan itself, and cleanupOnInterrupt (if it
    // fired) already destroyed it on the signal path. This call is the
    // "exactly once, on every exit path" guarantee for the one remaining
    // case — success — where nothing else has called destroy() yet.
    await sandboxAdapter.destroy();
  }
}

/**
 * Prints the narrated sequence for every step except install/build, reading
 * each fact off the already-completed `Report` — see this file's header for
 * why this remains a burst-after-the-fact rendering for these steps (their
 * facts, unlike install/build's live output, are only known once `runScan`
 * resolves). Install/build's own "Running install/build..." labels and
 * output already printed live, during the scan — see `runCommand`'s
 * `onInstallOutput`/`onBuildOutput` — so they're intentionally not repeated
 * here; the exact command each ran is still shown in `renderReportText`'s
 * output below.
 */
function narrateFromReport(report: Report, stdout: (line: string) => void): void {
  const { scan } = report;
  stdout(renderProvisioningDoneLine());
  stdout(renderCloneDoneLine(scan.input.repoUrl, scan.input.prNumber));
  stdout(renderBaselineSnapshotLine(scan.telemetry.filesHashedBaseline));
  stdout(renderProxyStartLine(scan.telemetry.proxyPort));
  stdout(renderPostRunSnapshotLine(scan.telemetry.filesHashedPostRun));
  stdout(renderProxyLogParseLine(scan.telemetry.connectionsObserved));
  stdout(renderTeardownLine());
}
