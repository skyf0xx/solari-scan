/**
 * Live, per-step narration lines. Each function renders exactly one fact as
 * it becomes known — `command` calls these as each step of the seven-step
 * mechanism completes, so the CLI narrates during the Scan rather than only
 * summarizing after it. No timing, delay, or spinner logic lives here: this
 * layer only turns an already-known fact into its display string.
 *
 * `Unavailable` values (per `domain/types.ts`) always render with their
 * reason, distinct from a real number — never silently as 0 or blank.
 */

import { isUnavailable, type ObservedCount, type Unavailable } from "../domain/types.js";

function renderCountOrUnavailable(value: ObservedCount | Unavailable): string {
  return isUnavailable(value) ? `unknown (${value.reason})` : String(value);
}

/** Step 1a: sandbox creation has started. Code has not executed yet. */
export function renderProvisioningStartLine(): string {
  return "Provisioning sandbox... (no code executed yet)";
}

/** Step 1b: sandbox creation confirmed. */
export function renderProvisioningDoneLine(): string {
  return "Sandbox provisioned.";
}

/** Step 2: target repo (and, if present, PR) cloned into the sandbox. Still
 *  no code executed. A plain repo-link scan has no PR to name — the line
 *  omits the PR mention entirely rather than printing a fabricated or
 *  undefined PR number. */
export function renderCloneDoneLine(repoUrl: string, prNumber: number | undefined): string {
  return prNumber === undefined ? `Cloned ${repoUrl} into sandbox.` : `Cloned ${repoUrl} (PR #${prNumber}) into sandbox.`;
}

/** Step 3: baseline filesystem snapshot hashed. */
export function renderBaselineSnapshotLine(filesHashed: ObservedCount | Unavailable): string {
  return `Baseline snapshot: hashed ${renderCountOrUnavailable(filesHashed)} files.`;
}

/** Step 4: forwarding proxy listening. */
export function renderProxyStartLine(port: ObservedCount | Unavailable): string {
  return `Proxy listening on port ${renderCountOrUnavailable(port)}.`;
}

/** Step 5/6: install or build command about to run. Live stdout/stderr
 *  streaming itself is `command`'s responsibility — this only announces
 *  which command is starting. */
export function renderCommandStartLine(step: "install" | "build", command: string): string {
  return `Running ${step}: ${command}`;
}

/** Step 7: post-run filesystem snapshot hashed and diffed. */
export function renderPostRunSnapshotLine(filesHashed: ObservedCount | Unavailable): string {
  return `Post-run snapshot: hashed ${renderCountOrUnavailable(filesHashed)} files.`;
}

/** Step 8: proxy log parsed for distinct connections observed. */
export function renderProxyLogParseLine(connectionsObserved: ObservedCount | Unavailable): string {
  return `Proxy log: observed ${renderCountOrUnavailable(connectionsObserved)} distinct connections.`;
}

/** Step 10: sandbox destroyed. */
export function renderTeardownLine(): string {
  return "Sandbox destroyed.";
}
