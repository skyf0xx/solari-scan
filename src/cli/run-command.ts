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
 * --- The live-narration gap (flagged, not silently built around) ---
 *
 * The committed UX spec (`.hedgehog/BMAD/05-ux-spec/EXPERIENCE.md`) and PRD
 * (`.hedgehog/BMAD/04-prd.md`) both require: live per-step narration as each
 * of the seven steps completes (step 1 provisioning, step 2 clone, step 3
 * baseline snapshot count, step 4 proxy port, steps 5-6 live install/build
 * stdout/stderr streaming, step 7 post-run snapshot count, step 8 connection
 * count, step 10 teardown) — "no artificial delays... real step timing
 * only."
 *
 * `runScan`'s actual signature (`src/domain/scan.ts`) has NO progress hook,
 * callback, or emitter parameter — it takes `(input, ports)` and resolves
 * once with a final `Report`. It also does not forward `onStdout`/
 * `onStderr` when it calls `ports.sandbox.runCommand(detected.installCommand,
 * { env: proxyEnv })` (no third options field is passed), even though
 * `SandboxPort.runCommand` and `SandboxAdapter.runCommand` both already
 * accept and wire those callbacks through to the real SDK. So even the
 * install/build live-streaming requirement is not satisfiable through
 * `runScan` as currently exposed — the streaming plumbing exists one layer
 * down (`sandbox-adapter`) and one layer up (`ports.ts`'s
 * `RunCommandOptions`), but `scan.ts`'s own call site is the one place that
 * doesn't pass them through.
 *
 * This is a genuine gap between the locked UX spec and `runScan`'s locked,
 * completed signature — `command` cannot fix it without changing
 * `domain/scan.ts`, which is out of this layer's scope and a Correction
 * Protocol case for `planner`/`domain`, not something to patch from here.
 *
 * What `command` builds instead, within its own scope: a "Running scan..."
 * line before calling `runScan`, then — once `runScan` resolves — every
 * `narration.ts` function is called once each, in step order, reading their
 * inputs off the final `Report`'s `scan.telemetry`/`scan.input`/
 * `scan.execution` fields rather than off live per-step events. This
 * produces the *shape* of the narrated sequence the UX spec describes (same
 * lines, same order, same real counts/ports — never placeholders) but all
 * printed in a burst after the scan finishes, not truly live during it, and
 * install/build stdout/stderr is not streamed at all in this build (neither
 * `command` nor `runScan` has a way to see it as it happens). Flagged
 * prominently in this task's final report rather than silently shipped as
 * if it met the live-streaming requirement.
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
  renderCommandStartLine,
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

    const report = await runScan(
      { repoUrl: deps.args.repoUrl, prNumber: deps.args.prNumber },
      { sandbox: sandboxAdapter, capture: captureAdapter },
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
 * Prints the full narrated sequence in step order, reading every fact off
 * the already-completed `Report` — see this file's header for why this is
 * a burst-after-the-fact rendering, not truly live per-step narration.
 */
function narrateFromReport(report: Report, stdout: (line: string) => void): void {
  const { scan } = report;
  stdout(renderProvisioningDoneLine());
  stdout(renderCloneDoneLine(scan.input.repoUrl, scan.input.prNumber));
  stdout(renderBaselineSnapshotLine(scan.telemetry.filesHashedBaseline));
  stdout(renderProxyStartLine(scan.telemetry.proxyPort));
  stdout(renderCommandStartLine("install", scan.execution.installCommand));
  stdout(renderCommandStartLine("build", scan.execution.buildCommand));
  stdout(renderPostRunSnapshotLine(scan.telemetry.filesHashedPostRun));
  stdout(renderProxyLogParseLine(scan.telemetry.connectionsObserved));
  stdout(renderTeardownLine());
}
