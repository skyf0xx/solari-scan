/**
 * Package manager detection: which install/build commands to run, chosen
 * from files present at the repo root. Business rule, not I/O — the
 * directory listing itself comes from `SandboxPort.listDirectory`.
 */

export interface DetectedCommands {
  installCommand: string;
  buildCommand: string;
}

const DETECTION_RULES: ReadonlyArray<{ marker: string; commands: DetectedCommands }> = [
  { marker: "package-lock.json", commands: { installCommand: "npm ci", buildCommand: "npm run build" } },
  { marker: "package.json", commands: { installCommand: "npm install", buildCommand: "npm run build" } },
  { marker: "requirements.txt", commands: { installCommand: "pip install -r requirements.txt", buildCommand: "python -m build" } },
  { marker: "pyproject.toml", commands: { installCommand: "pip install .", buildCommand: "python -m build" } },
];

/**
 * Detect the install/build commands from a list of file names present at
 * the repo root. Returns `undefined` when no known marker file is present
 * — callers must surface this as an unavailable detection, never guess a
 * default command.
 */
export function detectPackageManager(entryNames: readonly string[]): DetectedCommands | undefined {
  const names = new Set(entryNames);
  for (const rule of DETECTION_RULES) {
    if (names.has(rule.marker)) {
      return rule.commands;
    }
  }
  return undefined;
}
