/**
 * The sandbox-guest dependencies `capture-adapter` needs. Mirrors the slice
 * of `SessionHandle` (`@solarisdk/core`'s `dist/handle.d.ts`) this layer
 * actually uses, rather than depending on `SandboxAdapter` directly, which
 * would cross the hexagonal boundary between sibling adapters (see
 * `.hedgehog/core-design.md`'s split-adapter note). `command` wires the
 * real `Sandbox` handle in later (see
 * `hedgehog decision list SOLARI-SCAN-CAPTURE-ADAPTER`).
 *
 * Two surfaces are named here:
 *
 * - `SandboxFileAccess` — the narrow read-side slice `FilesystemCaptureAdapter`
 *   uses to walk and hash the sandbox's file tree (`list`/`stat`/`read`).
 * - `SandboxGuestAccess` — a superset both `ProxyCaptureAdapter` and
 *   `FilesystemCaptureAdapter` need: writing the forwarding-proxy script
 *   into the guest (`SessionHandle.files.write`), starting/awaiting/killing
 *   it as a background process (`SessionHandle.commands.start`), and
 *   running a single one-shot command to completion
 *   (`SessionHandle.commands.run`) — used by `FilesystemCaptureAdapter` to
 *   discover the guest's real working directory (`pwd`) instead of assuming
 *   a hardcoded walk root (confirmed live: `"."` resolves close to the
 *   guest filesystem root, not a scoped home directory — see
 *   `filesystem-capture.ts`'s header). `run` is the simpler fit for a
 *   single quick command that runs to completion: `start` returns
 *   immediately and requires wiring `onData`/`wait` to reconstruct a result
 *   a one-shot call already gets directly from `commands.run`.
 */

/** One entry in a directory listing, matching `FsEntry`'s shape. */
export interface SandboxFsEntry {
  name: string;
  dir: boolean;
  size: number;
}

/** A path's metadata, matching `FsStat`'s shape. */
export interface SandboxFsStat {
  name: string;
  dir: boolean;
  size: number;
  mode: number;
  modTimeMs: number;
}

/**
 * The sandbox file-access surface `FilesystemCaptureAdapter` depends on. A
 * subset of `SessionHandle.files` — only what recursive hashing needs.
 * `read` (not `readText`) is used deliberately: hashing must be byte-exact,
 * and decoding arbitrary file content (binaries dropped by postinstall
 * scripts, images, etc.) as text before hashing would corrupt non-UTF8
 * bytes and break hash consistency.
 */
export interface SandboxFileAccess {
  list(path: string): Promise<SandboxFsEntry[]>;
  stat(path: string): Promise<SandboxFsStat>;
  read(path: string): Promise<Uint8Array>;
}

/** One stdout/stderr chunk from a started command, matching
 *  `CommandHandle.onData`'s callback shape. */
export interface SandboxCommandChunk {
  stream: "stdout" | "stderr";
  data: string;
}

/**
 * A started background command, matching the slice of `CommandHandle`
 * (`@solarisdk/core`'s `dist/handle.d.ts`) this layer needs: subscribe to
 * output, wait for exit, and send a kill signal.
 */
export interface SandboxCommandHandle {
  onData(cb: (chunk: SandboxCommandChunk) => void): void;
  wait(): Promise<number>;
  kill(signal?: number): Promise<void>;
}

/** Options for starting a background command, matching the slice of
 *  `CommandOptions` this layer needs. `args` matches `CommandOptions.args`
 *  — the guest runs `cmd` with these directly, not via a shell. */
export interface SandboxCommandOptions {
  args?: string[];
  background?: boolean;
}

/** Terminal result of a one-shot command run to completion, matching the
 *  slice of `CommandResult` (`@solarisdk/core`'s `dist/types.d.ts`) this
 *  layer needs. */
export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
}

/**
 * The sandbox-guest surface `ProxyCaptureAdapter` and `FilesystemCaptureAdapter`
 * depend on: everything `SandboxFileAccess` offers, plus writing a file into
 * the guest, starting/observing a background command, and running a single
 * one-shot command to completion — together, enough to upload the proxy
 * script, launch it as a background process inside the guest, wait for its
 * readiness signal, kill it and read back its log, and (for
 * `FilesystemCaptureAdapter`) discover the guest's real working directory.
 */
export interface SandboxGuestAccess extends SandboxFileAccess {
  /** Write `data` to `path` inside the guest (matches
   *  `SessionHandle.files.write`). Used to upload the proxy script. */
  write(path: string, data: Uint8Array | string): Promise<void>;

  /** Start `cmd` as a background command inside the guest and return a
   *  handle immediately (matches `SessionHandle.commands.start`). */
  start(cmd: string, options?: SandboxCommandOptions): Promise<SandboxCommandHandle>;

  /** Run `cmd` inside the guest to completion and return its exit code and
   *  stdout (matches `SessionHandle.commands.run`). Used for quick one-shot
   *  lookups, e.g. `pwd` to discover the guest's real working directory. */
  run(cmd: string, options?: SandboxCommandOptions): Promise<SandboxRunResult>;
}
