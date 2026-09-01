/**
 * The package's bin entry (`package.json`'s `bin.solari-scan`). Owns nothing
 * beyond invoking the CLI — argument parsing lives in `cli/program.ts`,
 * orchestration in `cli/run-command.ts`.
 */

import { CommanderError } from "commander";
import { loadConfig, MissingApiKeyError } from "./cli/config.js";
import { createProgram } from "./cli/program.js";
import { runCommand } from "./cli/run-command.js";

async function main(): Promise<void> {
  const program = createProgram({
    onRun: async (args) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        if (err instanceof MissingApiKeyError) {
          console.error(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      const result = await runCommand({ config, args });
      process.exitCode = result.exitCode;
    },
  });

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`solari-scan failed unexpectedly: ${message}`);
  process.exitCode = 1;
});
