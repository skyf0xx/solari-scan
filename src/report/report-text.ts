/**
 * Renders a completed `Report`'s findings section to terminal text: the
 * clean-run verdict line, or the suspicious-activity verdict line followed
 * by itemized findings. This is the post-scan summary — the live per-step
 * facts (file counts, proxy port, etc.) are rendered by `narration.ts` as
 * `command` calls it during the Scan, not here.
 */

import type { Finding, Report } from "../domain/types.js";

export const CLEAN_RUN_LINE = "No malware found.";

export const SUSPICIOUS_LINE = "Suspicious activity found.";

function renderFinding(finding: Finding): string {
  return `- [${finding.kind}] ${finding.detail} (produced by ${finding.producedBy})`;
}

/**
 * Full human-readable terminal report text for a completed Scan: the
 * clean-run verdict, or the suspicious-activity verdict followed by each
 * itemized finding.
 */
export function renderReportText(report: Report): string {
  const lines: string[] = [];

  if (report.shape.kind === "clean") {
    lines.push(CLEAN_RUN_LINE);
  } else {
    lines.push(SUSPICIOUS_LINE);
    for (const finding of report.shape.findings) {
      lines.push(renderFinding(finding));
    }
  }

  return lines.join("\n");
}
