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

const ANSI_RED = "\x1b[31m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_RESET = "\x1b[0m";
const WARNING_ICON = "⚠️";
const CLEAN_ICON = "✅";

/**
 * Whether to colorize the verdict line: only when writing to an actual
 * terminal, so piped output (CI logs, `| tee`, the JSON report) stays
 * free of escape codes. `NO_COLOR` (https://no-color.org) always wins.
 */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

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
    lines.push(
      colorEnabled()
        ? `${ANSI_BOLD}${ANSI_GREEN}${CLEAN_ICON} ${CLEAN_RUN_LINE}${ANSI_RESET}`
        : `${CLEAN_ICON} ${CLEAN_RUN_LINE}`,
    );
  } else {
    const verdict = colorEnabled()
      ? `${ANSI_BOLD}${ANSI_RED}${WARNING_ICON} ${SUSPICIOUS_LINE}${ANSI_RESET}`
      : `${WARNING_ICON} ${SUSPICIOUS_LINE}`;
    lines.push(verdict);
    for (const finding of report.shape.findings) {
      lines.push(renderFinding(finding));
    }
  }

  return lines.join("\n");
}
