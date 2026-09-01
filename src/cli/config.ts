/**
 * Env var loading for `command`: `SOLARI_API_KEY` (required) and
 * `SOLARI_BASE_URL` (optional) via `.env` + `dotenv`, read once here per
 * `core-design.md`'s "Config and secrets" section.
 *
 * `baseUrl`: `@solarisdk/sandbox`'s `SandboxClientOptions.baseUrl` is a
 * required string with no SDK-side default. Confirmed against
 * `@solarisdk/sdk`'s own bundled CLI (`dist/cli.js`), which reads the same
 * `SOLARI_API_KEY`/`SOLARI_BASE_URL` env var names and falls back to
 * `https://api.getsolari.com` — the real, documented gateway host.
 */

import { config as loadDotenv } from "dotenv";

/** The Solari gateway's default host, per `@solarisdk/sdk`'s own CLI. */
export const DEFAULT_BASE_URL = "https://api.getsolari.com";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "SOLARI_API_KEY is not set. Add it to a .env file in the current directory " +
        "(SOLARI_API_KEY=sk-...) or export it in your shell before running solari-scan.",
    );
    this.name = "MissingApiKeyError";
  }
}

export interface SolariConfig {
  apiKey: string;
  baseUrl: string;
}

/** Loads `.env` (if present) into `process.env`, then reads config from it.
 *  Throws `MissingApiKeyError` if `SOLARI_API_KEY` is absent. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SolariConfig {
  loadDotenv();

  const apiKey = env.SOLARI_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  const baseUrl = env.SOLARI_BASE_URL || DEFAULT_BASE_URL;

  return { apiKey, baseUrl };
}
