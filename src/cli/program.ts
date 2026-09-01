/**
 * Commander argument/flag parsing for `solari-scan <url>`. Exactly one
 * positional arg and no flags — the URL's own shape (per `parse-url.ts`)
 * carries whether it's a PR link or a plain repo link, per
 * `core-design.md`'s "System shape". Parsing is kept separate from
 * `run-command.ts`'s orchestration so argument validation is testable
 * without provisioning anything.
 */

import { Command, InvalidArgumentError } from "commander";
import { InvalidUrlError, parseUrl } from "./parse-url.js";

export interface ParsedArgs {
  repoUrl: string;
  prNumber?: number;
  /** True when `--with-fs` was passed — opts into the filesystem hash/diff
   *  check (off by default; see `core-design.md`'s "System shape" re-entry
   *  note). The only flag this CLI accepts alongside its single positional
   *  `<url>` argument. */
  withFs: boolean;
}

function parseUrlArgument(value: string): { repoUrl: string; prNumber?: number } {
  try {
    const { repoUrl, prNumber } = parseUrl(value);
    return prNumber === undefined ? { repoUrl } : { repoUrl, prNumber };
  } catch (err) {
    if (err instanceof InvalidUrlError) {
      throw new InvalidArgumentError(err.message);
    }
    throw err;
  }
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
      "Reports observed runtime behavior (network, and optionally filesystem) of a GitHub repo or PR's install/build, executed inside an isolated Solari sandbox.",
    )
    .argument(
      "<url>",
      "GitHub repo URL (scans the default branch) or PR URL (.../pull/<n>, scans that PR)",
      parseUrlArgument,
    )
    .option(
      "--with-fs",
      "also run the filesystem hash/diff check (deep scan) — slower, since it recursively hashes the sandbox's file tree; off by default for a fast, network-only scan",
      false,
    )
    .action(async (parsedUrl: { repoUrl: string; prNumber?: number }, options_: { withFs: boolean }) => {
      await options.onRun({ ...parsedUrl, withFs: options_.withFs });
    });

  return program;
}
