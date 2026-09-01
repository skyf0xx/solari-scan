import { describe, expect, it } from "vitest";
import { buildReport, type Finding, type Scan } from "../domain/types.js";
import { buildReportJsonShape, renderReportJson } from "./report-json.js";

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

describe("renderReportJson", () => {
  it("round-trips: parsing the JSON back reflects the input Report's key fields", () => {
    const findings: Finding[] = [{ kind: "network", detail: "evil.example", producedBy: "classify" }];
    const report = buildReport(makeScan(), findings);

    const parsed = JSON.parse(renderReportJson(report));

    expect(parsed.scan.input.repoUrl).toBe(report.scan.input.repoUrl);
    expect(parsed.scan.input.prNumber).toBe(report.scan.input.prNumber);
    expect(parsed.scan.startedAt).toBe(report.scan.startedAt.toISOString());
    expect(parsed.scan.finishedAt).toBe(report.scan.finishedAt.toISOString());
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toEqual({ kind: "network", detail: "evil.example", producedBy: "classify" });
    expect(parsed.shape.kind).toBe("itemized");
  });

  it("renders dates as ISO strings, not Date objects", () => {
    const report = buildReport(makeScan(), []);

    const json = renderReportJson(report);

    expect(json).toContain('"2026-09-01T00:00:00.000Z"');
    expect(json).toContain('"2026-09-01T00:00:05.000Z"');
  });

  it("writes a clean shape with an empty findings array when there are zero findings", () => {
    const report = buildReport(makeScan(), []);

    const parsed = JSON.parse(renderReportJson(report));

    expect(parsed.findings).toEqual([]);
    expect(parsed.shape).toEqual({ kind: "clean" });
  });

  it("renders a real telemetry number as a plain available value", () => {
    const report = buildReport(makeScan(), []);

    const shape = buildReportJsonShape(report);

    expect(shape.scan.telemetry.proxyPort).toEqual({ available: true, value: 8080 });
  });

  it("renders an Unavailable telemetry value distinctly, never as 0 or null", () => {
    const report = buildReport(
      makeScan({
        telemetry: {
          filesHashedBaseline: 10,
          filesHashedPostRun: 10,
          proxyPort: { unavailable: true, reason: "proxy failed to bind" },
          connectionsObserved: 1,
        },
      }),
      [],
    );

    const shape = buildReportJsonShape(report);
    const json = renderReportJson(report);

    expect(shape.scan.telemetry.proxyPort).toEqual({ available: false, reason: "proxy failed to bind" });
    expect(json).not.toContain('"proxyPort": 0');
    expect(json).toContain("proxy failed to bind");
  });

  it("renders an Unavailable buildExitCode distinctly, never as a fabricated exit code", () => {
    const report = buildReport(
      makeScan({
        execution: {
          installCommand: "npm install",
          buildCommand: "npm run build",
          installExitCode: 1,
          buildExitCode: { unavailable: true, reason: "build did not run because install exited non-zero" },
          failed: true,
        },
      }),
      [],
    );

    const shape = buildReportJsonShape(report);

    expect(shape.scan.execution.buildExitCode).toEqual({
      available: false,
      reason: "build did not run because install exited non-zero",
    });
  });

  it("includes findings with kind, detail, and producedBy in the itemized shape", () => {
    const findings: Finding[] = [
      { kind: "filesystem", detail: "/etc/passwd", producedBy: "post-run-snapshot" },
      { kind: "network", detail: "evil.example", producedBy: "classify" },
    ];
    const report = buildReport(makeScan(), findings);

    const shape = buildReportJsonShape(report);

    expect(shape.shape).toEqual({ kind: "itemized", findings });
    expect(shape.findings).toEqual(findings);
  });

  it("never renders the words 'safe' or 'unsafe' anywhere in the JSON output", () => {
    const findings: Finding[] = [
      { kind: "network", detail: "evil.example", producedBy: "classify" },
      { kind: "filesystem", detail: "/etc/passwd", producedBy: "post-run-snapshot" },
    ];
    const report = buildReport(makeScan(), findings);

    const json = renderReportJson(report).toLowerCase();

    expect(json).not.toMatch(/\bsafe\b/);
    expect(json).not.toMatch(/\bunsafe\b/);
  });

  it("is pretty-printed for readability", () => {
    const report = buildReport(makeScan(), []);

    const json = renderReportJson(report);

    expect(json).toContain("\n");
    expect(json.startsWith("{\n")).toBe(true);
  });
});
