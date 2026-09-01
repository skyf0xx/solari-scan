/**
 * Renders a completed `Report` to the `solari-scan-report.json` content: a
 * stable, structured JSON representation meant to be piped into other tools
 * (CI, etc.), per the PRD's "easy to extend / pipe into your own CI" pitch.
 * No I/O — `command` decides where/whether to write the returned string.
 */

import { isUnavailable, type Finding, type ObservedCount, type Report, type Unavailable } from "../domain/types.js";

/** JSON-safe rendering of an `ObservedCount | Unavailable`: a real number
 *  stays a number; an `Unavailable` value becomes an explicit object naming
 *  the reason, never a silent `0` or `null`. */
type JsonObservedValue = { available: true; value: ObservedCount } | { available: false; reason: string };

function renderObservedValue(value: ObservedCount | Unavailable): JsonObservedValue {
  return isUnavailable(value) ? { available: false, reason: value.reason } : { available: true, value };
}

interface JsonFinding {
  kind: Finding["kind"];
  detail: string;
  producedBy: Finding["producedBy"];
}

function renderJsonFinding(finding: Finding): JsonFinding {
  return { kind: finding.kind, detail: finding.detail, producedBy: finding.producedBy };
}

export interface ReportJsonShape {
  scan: {
    input: {
      repoUrl: string;
      /** Absent for a plain repo-link scan — no PR to report, never a
       *  fabricated or `undefined` number. */
      prNumber?: number;
    };
    startedAt: string;
    finishedAt: string;
    execution: {
      installCommand: string;
      buildCommand: string;
      installExitCode: number;
      buildExitCode: JsonObservedValue;
      failed: boolean;
    };
    telemetry: {
      filesHashedBaseline: JsonObservedValue;
      filesHashedPostRun: JsonObservedValue;
      proxyPort: JsonObservedValue;
      connectionsObserved: JsonObservedValue;
    };
  };
  findings: JsonFinding[];
  shape: { kind: "clean" } | { kind: "itemized"; findings: JsonFinding[] };
}

/** Builds the structured, JSON-serializable shape of a `Report`. Exposed
 *  separately from `renderReportJson` so callers that want the object (not
 *  a pre-stringified blob) can consume it directly. */
export function buildReportJsonShape(report: Report): ReportJsonShape {
  const { scan } = report;

  return {
    scan: {
      input:
        scan.input.prNumber === undefined
          ? { repoUrl: scan.input.repoUrl }
          : { repoUrl: scan.input.repoUrl, prNumber: scan.input.prNumber },
      startedAt: scan.startedAt.toISOString(),
      finishedAt: scan.finishedAt.toISOString(),
      execution: {
        installCommand: scan.execution.installCommand,
        buildCommand: scan.execution.buildCommand,
        installExitCode: scan.execution.installExitCode,
        buildExitCode: renderObservedValue(scan.execution.buildExitCode),
        failed: scan.execution.failed,
      },
      telemetry: {
        filesHashedBaseline: renderObservedValue(scan.telemetry.filesHashedBaseline),
        filesHashedPostRun: renderObservedValue(scan.telemetry.filesHashedPostRun),
        proxyPort: renderObservedValue(scan.telemetry.proxyPort),
        connectionsObserved: renderObservedValue(scan.telemetry.connectionsObserved),
      },
    },
    findings: report.findings.map(renderJsonFinding),
    shape:
      report.shape.kind === "clean"
        ? { kind: "clean" }
        : { kind: "itemized", findings: report.shape.findings.map(renderJsonFinding) },
  };
}

/** Pretty-printed JSON string for `solari-scan-report.json`'s content. */
export function renderReportJson(report: Report): string {
  return JSON.stringify(buildReportJsonShape(report), null, 2);
}
