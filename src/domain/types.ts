/**
 * Domain types for one Scan: the repo/PR under test, the Findings it
 * produced, and the Report bundling both. No I/O, no SDK types — this file
 * is the vocabulary every other layer (adapters, report, cli) is written
 * against.
 */

/**
 * Input naming the repo (and, optionally, PR) a Scan targets. `prNumber` is
 * absent for a plain repo link — the scan clones and runs against whatever
 * the default branch is, with no PR checkout step. Classifying a URL into
 * one shape or the other is CLI-layer parsing, not this type's concern.
 */
export interface ScanInput {
  repoUrl: string;
  prNumber?: number;
  /** Enables the filesystem hash/diff check (baseline + post-run snapshot,
   *  diff, filesystem findings). Defaults to off at the CLI layer — the
   *  check is a real cost (recursive sandbox tree hashing) most scans skip
   *  in favor of the fast network-only check; `--with-fs` opts back in. */
  withFilesystemCheck?: boolean;
}

/** Which capture mechanism produced a Finding. */
export type FindingKind = "network" | "filesystem";

/**
 * One observed fact: an unexpected outbound destination, or a filesystem
 * write outside the repo directory. Carries no verdict — only what was
 * observed and which step produced it.
 */
export interface Finding {
  kind: FindingKind;
  /** The host (network) or path (filesystem) the finding concerns. */
  detail: string;
  /** Which step of the seven-step mechanism produced this finding. */
  producedBy: ScanStep;
}

/** The seven-step mechanism, in order. Used to attribute Findings and errors. */
export type ScanStep =
  | "provision"
  | "clone"
  | "baseline-snapshot"
  | "proxy-start"
  | "install-build"
  | "post-run-snapshot"
  | "classify";

/** A count that domain expects to report a real, specific value for. */
export type ObservedCount = number;

/**
 * A value domain could not compute. Never silently defaulted to 0 or a
 * placeholder — callers (report/cli) must render this as "unavailable",
 * not as a fact.
 */
export type Unavailable = { readonly unavailable: true; readonly reason: string };

/**
 * Outcome of running the detected install and build commands. `buildExitCode`
 * is `Unavailable` when the build never ran because install failed first —
 * never a fabricated sentinel like `-1`.
 */
export interface ExecutionResult {
  installCommand: string;
  buildCommand: string;
  installExitCode: number;
  buildExitCode: number | Unavailable;
  /**
   * True when either install exited non-zero or build ran and exited
   * non-zero. The Scan still completes capture and reporting when this is
   * true — a non-zero exit is reported, never treated as a reason to abort
   * the Report.
   */
  failed: boolean;
}

export function isUnavailable<T>(value: T | Unavailable): value is Unavailable {
  return typeof value === "object" && value !== null && (value as Unavailable).unavailable === true;
}

/**
 * Narration facts gathered during the run — real counts/ports, never
 * placeholders. `filesHashedBaseline`/`filesHashedPostRun` are absent
 * entirely (not `Unavailable`, not a fabricated `0`) when the filesystem
 * check didn't run (`ScanInput.withFilesystemCheck` falsy) — `Unavailable`
 * means "the check ran but couldn't produce this value," which is a
 * different fact than "this check never ran," and report/narration code
 * must be able to tell the two apart to stay silent about a check that
 * never happened.
 */
export interface ScanTelemetry {
  filesHashedBaseline?: ObservedCount | Unavailable;
  filesHashedPostRun?: ObservedCount | Unavailable;
  proxyPort: ObservedCount | Unavailable;
  connectionsObserved: ObservedCount | Unavailable;
}

/** One completed Scan: its input, timestamps, execution outcome, and telemetry. */
export interface Scan {
  input: ScanInput;
  startedAt: Date;
  finishedAt: Date;
  execution: ExecutionResult;
  telemetry: ScanTelemetry;
}

/**
 * A Scan's Findings plus a rendering hint. `clean` means zero Findings —
 * consumers (report layer) collapse this to the one-line summary rather
 * than itemizing. `itemized` means one or more Findings exist and each
 * should be printed individually.
 */
export type ReportShape =
  | { kind: "clean" }
  | { kind: "itemized"; findings: Finding[] };

/** A Scan plus its Findings, shaped for rendering. Belongs to exactly one Scan. */
export interface Report {
  scan: Scan;
  findings: Finding[];
  shape: ReportShape;
}

export function buildReport(scan: Scan, findings: Finding[]): Report {
  return {
    scan,
    findings,
    shape: findings.length === 0 ? { kind: "clean" } : { kind: "itemized", findings },
  };
}
