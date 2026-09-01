import { describe, expect, it } from "vitest";
import { buildReport, type Finding, type Scan } from "../domain/types.js";
import { CLEAN_RUN_LINE, SUSPICIOUS_LINE, renderReportText } from "./report-text.js";

function makeScan(overrides: Partial<Scan> = {}): Scan {
  return {
    input: { repoUrl: "https://github.com/example/repo", prNumber: 42 },
    startedAt: new Date("2026-09-01T00:00:00.000Z"),
    finishedAt: new Date("2026-09-01T00:00:05.000Z"),
    execution: {
      installCommand: "npm install",
      buildCommand: "npm run build",
      installExitCode: 0,
      buildExitCode: 0,
      failed: false,
    },
    telemetry: {
      filesHashedBaseline: 10,
      filesHashedPostRun: 10,
      proxyPort: 8080,
      connectionsObserved: 1,
    },
    ...overrides,
  };
}

describe("renderReportText", () => {
  it("collapses a clean run to exactly the one-line verdict", () => {
    const report = buildReport(makeScan(), []);

    const text = renderReportText(report);
    const lines = text.split("\n");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CLEAN_RUN_LINE);
  });

  it("itemizes each finding with its kind, detail, and producedBy step", () => {
    const findings: Finding[] = [
      { kind: "network", detail: "telemetry.evil.example", producedBy: "classify" },
      { kind: "filesystem", detail: "/etc/passwd", producedBy: "post-run-snapshot" },
    ];
    const report = buildReport(makeScan(), findings);

    const text = renderReportText(report);

    expect(text).toContain("network");
    expect(text).toContain("telemetry.evil.example");
    expect(text).toContain("classify");
    expect(text).toContain("filesystem");
    expect(text).toContain("/etc/passwd");
    expect(text).toContain("post-run-snapshot");
  });

  it("does not print the clean-run line when findings are present", () => {
    const findings: Finding[] = [{ kind: "network", detail: "evil.example", producedBy: "classify" }];
    const report = buildReport(makeScan(), findings);

    const text = renderReportText(report);

    expect(text).not.toContain(CLEAN_RUN_LINE);
  });

  it("states the suspicious-activity verdict exactly once when findings are present", () => {
    const findings: Finding[] = [
      { kind: "network", detail: "a.example", producedBy: "classify" },
      { kind: "network", detail: "b.example", producedBy: "classify" },
      { kind: "filesystem", detail: "/tmp/x", producedBy: "post-run-snapshot" },
    ];
    const report = buildReport(makeScan(), findings);

    const text = renderReportText(report);
    const occurrences = text.split(SUSPICIOUS_LINE).length - 1;

    expect(occurrences).toBe(1);
  });

  it("does not print the suspicious-activity verdict on a clean run", () => {
    const report = buildReport(makeScan(), []);

    const text = renderReportText(report);

    expect(text).not.toContain(SUSPICIOUS_LINE);
  });

  it("prefixes the clean-run verdict with a checkmark icon", () => {
    const report = buildReport(makeScan(), []);

    const text = renderReportText(report);

    expect(text).toContain(`✅ ${CLEAN_RUN_LINE}`);
  });

  it("prefixes the suspicious-activity verdict with a warning icon", () => {
    const findings: Finding[] = [{ kind: "network", detail: "evil.example", producedBy: "classify" }];
    const report = buildReport(makeScan(), findings);

    const text = renderReportText(report);

    expect(text).toContain(`⚠️ ${SUSPICIOUS_LINE}`);
  });

  it("does not emit ANSI color codes when stdout is not a TTY", () => {
    const findings: Finding[] = [{ kind: "network", detail: "evil.example", producedBy: "classify" }];
    const report = buildReport(makeScan(), findings);

    const text = renderReportText(report);

    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[/);
  });
});
