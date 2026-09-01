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
 * live, not narrated after the fact. `ScanOutput` also carries
 * `onInstallExit`/`onBuildExit`, fired the instant each command's exit code
 * resolves — wired below to print immediately rather than waiting for the
 * final report.
 *
 * --- Heartbeat coverage, and where it can't reach (SOLARI-SCAN-LIVE-PROGRESS-COMMAND) ---
 *
 * There is no SDK-side progress signal for sandbox provisioning, or for the
 * capture-adapter's filesystem-hashing/proxy-log-parsing steps (confirmed by
 * the `sandbox-adapter`/`capture-adapter` layers) — any "still working"
 * output during those stretches has to be a plain client-side timer, keyed
 * off wall-clock time only (`./heartbeat.ts`).
 *
 * Provisioning: `runScan` calls `ports.sandbox.provision()` internally,
 * before its own try/finally, so `command` never gets a "provisioning
 * specifically finished" signal distinct from "the whole scan resolved or
 * rejected" — there is no earlier callback to hook. The best available
 * proxy is `onInstallOutput`'s *first* call, which can only fire after
 * provisioning, clone, and package-manager detection have all already
 * succeeded — so provisioning is *definitely* done by then. The heartbeat
 * below runs from right after `renderProvisioningStartLine()` until the
 * first of {`onInstallOutput` first fires, `runScan` settles}, which covers
 * provisioning plus clone plus package-manager detection under one label.
 * That's a deliberately loose boundary, not a precise "provisioning done"
 * signal — accepted per the packet's own guidance ("no silent stretch
 * longer than ~2-3 heartbeat ticks", not architectural precision), and
 * because a real per-step signal would require a `domain`-layer change this
 * task's scope doesn't include.
 *
 * Post-run snapshot hashing and proxy-log parsing: covered the same way as
 * install/build's exit callbacks, via `ScanOutput`'s
 * `onProxyLogParseStart`/`onProxyLogParseDone` and
 * `onPostRunSnapshotStart`/`onPostRunSnapshotDone` (added to `domain/scan.ts`
 * via Correction Protocol after this layer's own INTENT CHECK flagged the
 * gap). Each `*Start` starts a tracked heartbeat and each matching `*Done`
 * stops it, following the exact same pattern as the provisioning/install/
 * build heartbeats above. `onProxyLogParseDone`/`onPostRunSnapshotDone`
 * don't print their own summary line beyond stopping the heartbeat — the
 * existing post-hoc `renderProxyLogParseLine`/`renderPostRunSnapshotLine`
 * calls in `narrateFromReport` below still print the final counts as part
 * of the step-by-step burst once the full `Report` is known, so the count
 * isn't narrated twice.
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
  renderBuildExitLine,
  renderCloneDoneLine,
  renderInstallExitLine,
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
import { startHeartbeat } from "./heartbeat.js";
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
      `Cloning the target repo failed.\n` +
      `Check that the URL is correct and reachable (and, if it names a PR, that the PR exists).\n(${err.message})`,
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

  // Every heartbeat started anywhere below is stopped unconditionally in
  // `finally`, in addition to being stopped at its own natural end point —
  // `Heartbeat.stop()` is idempotent, so this is a safety net against a
  // dangling `setInterval` on a path (e.g. `runScan` rejecting) that skips
  // that heartbeat's own stop call.
  const activeHeartbeats: ReturnType<typeof startHeartbeat>[] = [];
  const trackedHeartbeat = (label: string): ReturnType<typeof startHeartbeat> => {
    const heartbeat = startHeartbeat(label, writeStdout);
    activeHeartbeats.push(heartbeat);
    return heartbeat;
  };

  try {
    stdout(renderProvisioningStartLine());

    // Covers provisioning + clone + package-manager detection under one
    // label, stopped at the first of {onInstallOutput's first call, runScan
    // settling} — see this file's header ("Heartbeat coverage") for why
    // there's no more precise "provisioning specifically done" signal
    // available to this layer.
    const provisioningHeartbeat = trackedHeartbeat("Provisioning sandbox");

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

    // Covers the silent gap between "Running install/build..." printing and
    // that step's first real output chunk arriving — cleared the instant
    // the first chunk shows up (below), not just on the command's eventual
    // completion, per this task's packet.
    const installHeartbeat = trackedHeartbeat("Running install");
    let buildHeartbeat: ReturnType<typeof startHeartbeat> | undefined;

    const onInstallOutput = (stream: "stdout" | "stderr", data: string): void => {
      if (!installStarted) {
        installStarted = true;
        provisioningHeartbeat.stop();
        installHeartbeat.stop();
        stdout("Running install...");
      }
      (stream === "stdout" ? writeStdout : writeStderr)(data);
    };
    const onBuildOutput = (stream: "stdout" | "stderr", data: string): void => {
      if (!buildStarted) {
        buildStarted = true;
        buildHeartbeat?.stop();
        stdout("Running build...");
      }
      (stream === "stdout" ? writeStdout : writeStderr)(data);
    };
    const onInstallExit = (exitCode: number): void => {
      installHeartbeat.stop();
      stdout(renderInstallExitLine(exitCode));
      if (exitCode === 0) {
        buildHeartbeat = trackedHeartbeat("Running build");
      }
    };
    const onBuildExit = (exitCode: number): void => {
      buildHeartbeat?.stop();
      stdout(renderBuildExitLine(exitCode));
    };

    // Covers the two remaining silent stretches named in this file's header
    // ("Heartbeat coverage") — both run entirely inside runScan, after
    // install/build, with no other signal available until each one's own
    // Start/Done callback fires.
    let proxyLogParseHeartbeat: ReturnType<typeof startHeartbeat> | undefined;
    let postRunSnapshotHeartbeat: ReturnType<typeof startHeartbeat> | undefined;
    const onProxyLogParseStart = (): void => {
      proxyLogParseHeartbeat = trackedHeartbeat("Parsing proxy log");
    };
    const onProxyLogParseDone = (_connectionsObserved: number): void => {
      proxyLogParseHeartbeat?.stop();
    };
    const onPostRunSnapshotStart = (): void => {
      postRunSnapshotHeartbeat = trackedHeartbeat("Hashing post-run snapshot");
    };
    const onPostRunSnapshotDone = (_filesHashed: number): void => {
      postRunSnapshotHeartbeat?.stop();
    };

    const report = await runScan(
      { repoUrl: deps.args.repoUrl, prNumber: deps.args.prNumber, withFilesystemCheck: deps.args.withFs },
      { sandbox: sandboxAdapter, capture: captureAdapter },
      {
        onInstallOutput,
        onBuildOutput,
        onInstallExit,
        onBuildExit,
        onProxyLogParseStart,
        onProxyLogParseDone,
        onPostRunSnapshotStart,
        onPostRunSnapshotDone,
      },
    );

    if (interrupted) {
      return { exitCode: INTERRUPT_EXIT_CODE };
    }

    narrateFromReport(report, stdout);

    stdout("");
    stdout(renderReportText(report));

    await writeReportJson(REPORT_JSON_PATH, renderReportJson(report));

    // Exit 0 regardless of report.scan.execution.failed: a non-zero
    // install/build exit inside the scanned repo is a finding this scan
    // reports on, not a failure of the scan itself — solari-scan's own
    // exit code stays reserved for solari-scan failing to do its job (the
    // ERROR_MAPPINGS cases above), never for what it found.
    return { exitCode: 0, report };
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
    // Stops every heartbeat started above, on every exit path (success,
    // known ScanError, unexpected error, interrupt) — most are already
    // stopped by their own natural end point by the time this runs, and
    // `Heartbeat.stop()` is idempotent, so this is purely the dangling-timer
    // safety net described where `activeHeartbeats` is declared.
    for (const heartbeat of activeHeartbeats) {
      heartbeat.stop();
    }
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
  // Both lines are skipped entirely, not printed with an "unavailable"
  // reason, when the filesystem check didn't run (no --with-fs) — the
  // fields are absent from telemetry in that case (see
  // `domain/types.ts`'s `ScanTelemetry` doc comment), and the report must
  // read as if the filesystem check were never a feature at all.
  if (scan.telemetry.filesHashedBaseline !== undefined) {
    stdout(renderBaselineSnapshotLine(scan.telemetry.filesHashedBaseline));
  }
  stdout(renderProxyStartLine(scan.telemetry.proxyPort));
  if (scan.telemetry.filesHashedPostRun !== undefined) {
    stdout(renderPostRunSnapshotLine(scan.telemetry.filesHashedPostRun));
  }
  stdout(renderProxyLogParseLine(scan.telemetry.connectionsObserved));
  stdout(renderTeardownLine());
}
