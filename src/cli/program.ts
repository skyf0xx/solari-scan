/**
 * Commander argument/flag parsing for `solari-scan <repo-url> --pr <n>`.
 * Exactly one positional arg and one required numeric option — no other
 * flags, per the brief's "no flags beyond --pr required" rule. Parsing is
 * kept separate from `run-command.ts`'s orchestration so argument validation
 * is testable without provisioning anything.
 */

import { Command, InvalidArgumentError } from "commander";

export interface ParsedArgs {
  repoUrl: string;
  prNumber: number;
}

function parsePrNumber(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("--pr must be a positive integer.");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("--pr must be a positive integer.");
  }
  return parsed;
}

export interface CreateProgramOptions {
  /** Invoked with the parsed args once Commander accepts them. */
  onRun: (args: ParsedArgs) => void | Promise<void>;
}

/** Builds the `solari-scan` Commander program. Does not call `parse()` —
 *  callers decide when/how to invoke it against `process.argv` (or a test's
 *  own argv array). */
export function createProgram(options: CreateProgramOptions): Command {
  const program = new Command();

  // Throw CommanderError instead of calling process.exit directly, so
  // run-command.ts's own top-level error handler stays the single place
  // that sets the process exit code (never Commander itself, never twice).
  program.exitOverride();

  program
    .name("solari-scan")
    .description(
      "Reports observed runtime behavior (network + filesystem) of a GitHub PR's install/build, executed inside an isolated Solari sandbox.",
    )
    .argument("<repo-url>", "GitHub repository URL to scan")
    .requiredOption("--pr <n>", "pull request number to scan", parsePrNumber)
    .action(async (repoUrl: string, opts: { pr: number }) => {
      await options.onRun({ repoUrl, prNumber: opts.pr });
    });

  return program;
}
