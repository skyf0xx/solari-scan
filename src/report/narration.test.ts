import { describe, expect, it } from "vitest";
import type { Unavailable } from "../domain/types.js";
import {
  renderBaselineSnapshotLine,
  renderCloneDoneLine,
  renderCommandStartLine,
  renderPostRunSnapshotLine,
  renderProvisioningDoneLine,
  renderProvisioningStartLine,
  renderProxyLogParseLine,
  renderProxyStartLine,
  renderTeardownLine,
} from "./narration.js";

const UNAVAILABLE: Unavailable = { unavailable: true, reason: "hashing timed out" };

describe("narration lines", () => {
  it("renders the actual file count for a baseline snapshot", () => {
    expect(renderBaselineSnapshotLine(128)).toContain("128");
  });

  it("renders an Unavailable baseline count distinctly from a real number", () => {
    const line = renderBaselineSnapshotLine(UNAVAILABLE);

    expect(line).not.toContain("hashed 0 ");
    expect(line).not.toMatch(/hashed\s*$/);
    expect(line).toContain("unknown");
    expect(line).toContain("hashing timed out");
  });

  it("renders the actual file count for a post-run snapshot", () => {
    expect(renderPostRunSnapshotLine(64)).toContain("64");
  });

  it("renders an Unavailable post-run count distinctly from a real number", () => {
    const line = renderPostRunSnapshotLine(UNAVAILABLE);

    expect(line).toContain("unknown");
    expect(line).toContain("hashing timed out");
  });

  it("renders the actual proxy port", () => {
    expect(renderProxyStartLine(54321)).toContain("54321");
  });

  it("renders an Unavailable proxy port distinctly from a real number, never as 0", () => {
    const line = renderProxyStartLine(UNAVAILABLE);

    expect(line).not.toContain("port 0");
    expect(line).toContain("unknown");
  });

  it("renders the actual connection count observed", () => {
    expect(renderProxyLogParseLine(7)).toContain("7");
  });

  it("renders an Unavailable connection count distinctly from a real number", () => {
    const line = renderProxyLogParseLine(UNAVAILABLE);

    expect(line).toContain("unknown");
    expect(line).toContain("hashing timed out");
  });

  it("states plainly that code has not executed yet during provisioning", () => {
    expect(renderProvisioningStartLine().toLowerCase()).toContain("no code executed");
  });

  it("confirms provisioning completed", () => {
    expect(renderProvisioningDoneLine().toLowerCase()).toContain("provisioned");
  });

  it("confirms the target repo/PR was cloned, naming the repo and PR", () => {
    const line = renderCloneDoneLine("https://github.com/example/repo", 42);

    expect(line).toContain("https://github.com/example/repo");
    expect(line).toContain("42");
  });

  it("announces which command is about to run for install and build", () => {
    expect(renderCommandStartLine("install", "npm install")).toContain("npm install");
    expect(renderCommandStartLine("build", "npm run build")).toContain("npm run build");
  });

  it("confirms teardown happened", () => {
    expect(renderTeardownLine().toLowerCase()).toContain("destroyed");
  });

  it("never renders the words 'safe' or 'unsafe' in any narration line", () => {
    const lines = [
      renderProvisioningStartLine(),
      renderProvisioningDoneLine(),
      renderCloneDoneLine("https://github.com/example/repo", 1),
      renderBaselineSnapshotLine(10),
      renderBaselineSnapshotLine(UNAVAILABLE),
      renderProxyStartLine(8080),
      renderProxyStartLine(UNAVAILABLE),
      renderCommandStartLine("install", "npm install"),
      renderCommandStartLine("build", "npm run build"),
      renderPostRunSnapshotLine(10),
      renderPostRunSnapshotLine(UNAVAILABLE),
      renderProxyLogParseLine(3),
      renderProxyLogParseLine(UNAVAILABLE),
      renderTeardownLine(),
    ];

    for (const line of lines) {
      expect(line.toLowerCase()).not.toMatch(/\bsafe\b/);
      expect(line.toLowerCase()).not.toMatch(/\bunsafe\b/);
    }
  });
});
