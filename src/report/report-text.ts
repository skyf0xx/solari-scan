/**
 * Renders a completed `Report`'s findings section to terminal text: the
 * clean-run one-liner, or itemized findings, plus the "observed behavior,
 * not a verdict" framing line exactly once. This is the post-scan summary —
 * the live per-step facts (file counts, proxy port, etc.) are rendered by
 * `narration.ts` as `command` calls it during the Scan, not here.
 */

import type { Finding, Report } from "../domain/types.js";

export const CLEAN_RUN_LINE = "No unexpected behavior observed during install/build.";

export const FRAMING_LINE = "Observed behavior, not a verdict.";

function renderFinding(finding: Finding): string {
  return `- [${finding.kind}] ${finding.detail} (produced by ${finding.producedBy})`;
}

/**
 * Full human-readable terminal report text for a completed Scan: the
 * clean-run line or itemized findings, followed by the framing line.
 */
export function renderReportText(report: Report): string {
  const lines: string[] = [];

  if (report.shape.kind === "clean") {
    lines.push(CLEAN_RUN_LINE);
  } else {
    lines.push("Findings:");
    for (const finding of report.shape.findings) {
      lines.push(renderFinding(finding));
    }
  }

  lines.push(FRAMING_LINE);

  return lines.join("\n");
}
