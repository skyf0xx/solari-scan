/**
 * Port interfaces the orchestrator depends on. `sandbox-adapter` binds
 * `SandboxPort` to the real `@solarisdk/sandbox` SDK; `capture-adapter`
 * binds `CapturePort` to the real filesystem and forwarding proxy. Domain
 * never imports either adapter — it only defines these shapes and is
 * tested against fakes of them.
 *
 * `SandboxPort`'s shape is deliberately narrow and mirrors what
 * `SessionHandle` (`@solarisdk/core`'s `dist/handle.d.ts`) actually offers
 * (`sandbox.git.clone()`, `sandbox.commands.run(cmd, { env, onStdout,
 * onStderr })`, `sandbox.kill()`) so `sandbox-adapter` can bind it directly
 * rather than redesigning it later.
 */

import type { ScanStep } from "./types.js";

/** Live output callback, matching `CommandOptions.onStdout`/`onStderr`'s shape. */
export type OutputCallback = (data: string) => void;

export interface RunCommandOptions {
  /** Working directory the command runs in, relative to the sandbox root
   *  (e.g. the cloned repo's `CloneOptions.path`). Without this, the
   *  command runs at the sandbox's default working directory rather than
   *  inside the repo. */
  cwd?: string;
  /** Per-command env vars (e.g. HTTP_PROXY/HTTPS_PROXY scoped to install/build only). */
  env?: Record<string, string>;
  onStdout?: OutputCallback;
  onStderr?: OutputCallback;
}

export interface RunCommandResult {
  exitCode: number;
}

export interface CloneOptions {
  /** Destination directory the repo is cloned into, relative to the sandbox root. */
  path: string;
  /** PR number to clone/check out. Absent for a plain repo link — the clone
   *  is a normal `git clone` left on whatever the default branch is, with
   *  no checkout step. */
  prNumber?: number;
}

/** The name of an entry in a directory listing, matching `FsEntry`'s shape. */
export interface DirectoryEntryName {
  name: string;
  dir: boolean;
}

/**
 * The sandbox lifecycle and execution boundary. One `SandboxPort` instance
 * represents one provisioned sandbox for the duration of one Scan.
 */
export interface SandboxPort {
  /** Provision a fresh sandbox. Throws `SandboxProvisioningError` /
   *  `SandboxCapacityError` / `SandboxCreditExhaustionError` on failure. */
  provision(): Promise<void>;

  /** Clone the target repo/PR into the sandbox. Never executes code.
   *  Throws `CloneError` on failure. */
  clone(repoUrl: string, options: CloneOptions): Promise<void>;

  /** List the top-level entries of `dir` in the sandbox — used to detect
   *  the repo's package manager from files present at its root, without
   *  running any code. */
  listDirectory(dir: string): Promise<DirectoryEntryName[]>;

  /** Run one command to completion inside the sandbox, streaming output live. */
  runCommand(cmd: string, options?: RunCommandOptions): Promise<RunCommandResult>;

  /** Destroy the sandbox. Idempotent — safe to call more than once. */
  destroy(): Promise<void>;
}

/** One entry in a filesystem snapshot: path plus a content hash. */
export interface SnapshotEntry {
  path: string;
  hash: string;
}

/** A hashed snapshot of the sandbox's file tree at one point in time. */
export interface FilesystemSnapshot {
  entries: SnapshotEntry[];
}

/** One filesystem change detected between two snapshots. */
export interface FilesystemChange {
  path: string;
  changeType: "created" | "modified" | "deleted";
}

/** One outbound connection destination observed by the proxy. */
export interface ObservedConnection {
  host: string;
}

/**
 * The filesystem-hash and network-proxy capture boundary. `capture-adapter`
 * binds this to real recursive tree hashing and a real forwarding proxy.
 */
export interface CapturePort {
  /** Hash the sandbox's file tree rooted at `repoDir`'s parent (or wherever
   *  the sandbox root is) so writes outside `repoDir` are detectable. */
  snapshotFilesystem(): Promise<FilesystemSnapshot>;

  /** Diff two snapshots for changes outside `repoDir`. */
  diffFilesystem(
    baseline: FilesystemSnapshot,
    postRun: FilesystemSnapshot,
    repoDir: string,
  ): Promise<FilesystemChange[]>;

  /** Start the forwarding proxy. Resolves once it's listening. Returns the
   *  port it's listening on and the env vars to inject into the
   *  install/build commands (HTTP_PROXY/HTTPS_PROXY). */
  startProxy(): Promise<{ port: number; env: Record<string, string> }>;

  /** Stop the proxy and return the distinct destinations it observed. */
  stopProxy(): Promise<ObservedConnection[]>;
}

/** Attributes a step name to values produced during that step — used by the
 *  orchestrator to tag Findings with the `ScanStep` that produced them. */
export type StepTag = ScanStep;
