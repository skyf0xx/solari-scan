/**
 * The `SandboxGuestAccess` shim `capture-adapter` depends on
 * (`src/adapters/capture/sandbox-files.ts`), bound to the real,
 * already-provisioned `Sandbox` handle from `SandboxAdapter.requireSandboxHandle()`
 * (`hedgehog decision list SOLARI-SCAN-CAPTURE-ADAPTER`: capture and sandbox
 * adapters share one guest session rather than each provisioning their own).
 *
 * `Sandbox extends SessionHandle`, whose `files.list/stat/read/write` and
 * `commands.start` match `SandboxGuestAccess`'s methods field-for-field —
 * `FsEntry`/`FsStat`/`CommandHandle` (`@solarisdk/core`'s `dist/types.d.ts`)
 * carry the exact same fields `SandboxFsEntry`/`SandboxFsStat`/
 * `SandboxCommandHandle` declare, so no field remapping is needed beyond
 * picking the matching keys.
 *
 * Deliberately reads `sandboxAdapter.requireSandboxHandle()` lazily inside
 * each method rather than capturing the handle once at construction time —
 * see `run-command.ts`'s header comment for why (the shim can be constructed
 * before `provision()` has run, since `runScan` provisions internally).
 *
 * `files.list/stat/read` and `commands.run` take no `timeoutMs` option of
 * their own (unlike several other `@solarisdk/core` calls that do) — the SDK
 * gives no way to bound one of these calls at the request level. Confirmed
 * live: a `snapshotFilesystem()` walk hung indefinitely on "Hashing post-run
 * snapshot" long after the sandboxed build had exited, with no infinite
 * recursion involved — a single `list`/`stat`/`read` round trip simply never
 * resolved or rejected on its own, and only destroying the sandbox from
 * outside (which errors out whatever call was in flight) unblocked it. Each
 * call below is raced against `GUEST_CALL_TIMEOUT_MS` so a stuck round trip
 * fails fast as a `CaptureAdapterError` instead of hanging the whole scan.
 */

import type { Sandbox } from "@solarisdk/sandbox";
import { CaptureAdapterError } from "../adapters/capture/errors.js";
import type {
  SandboxCommandHandle,
  SandboxCommandOptions,
  SandboxFsEntry,
  SandboxFsStat,
  SandboxGuestAccess,
  SandboxRunResult,
} from "../adapters/capture/sandbox-files.js";

export interface SandboxHandleSource {
  requireSandboxHandle(): Sandbox;
}

/**
 * Upper bound on a single guest RPC (`list`/`stat`/`read`/`run`). Generous
 * relative to the ~330ms round trip these calls normally cost (see
 * `filesystem-capture.ts`'s header) — this is a backstop against a stuck
 * call, not a latency budget to tune against normal traffic.
 */
export const GUEST_CALL_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new CaptureAdapterError(
          `Sandbox guest call timed out after ${GUEST_CALL_TIMEOUT_MS}ms: ${description}`,
        ),
      );
    }, GUEST_CALL_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createSandboxGuestAccess(source: SandboxHandleSource): SandboxGuestAccess {
  return {
    async list(path: string): Promise<SandboxFsEntry[]> {
      const entries = await withTimeout(source.requireSandboxHandle().files.list(path), `list(${path})`);
      return entries.map((entry) => ({ name: entry.name, dir: entry.dir, size: entry.size }));
    },

    async stat(path: string): Promise<SandboxFsStat> {
      const stat = await withTimeout(source.requireSandboxHandle().files.stat(path), `stat(${path})`);
      return {
        name: stat.name,
        dir: stat.dir,
        size: stat.size,
        mode: stat.mode,
        modTimeMs: stat.modTimeMs,
      };
    },

    async read(path: string): Promise<Uint8Array> {
      return withTimeout(source.requireSandboxHandle().files.read(path), `read(${path})`);
    },

    async write(path: string, data: Uint8Array | string): Promise<void> {
      await withTimeout(source.requireSandboxHandle().files.write(path, data), `write(${path})`);
    },

    async start(cmd: string, options?: SandboxCommandOptions): Promise<SandboxCommandHandle> {
      const handle = await withTimeout(
        source.requireSandboxHandle().commands.start(cmd, {
          ...(options?.args !== undefined ? { args: options.args } : {}),
          ...(options?.background !== undefined ? { background: options.background } : {}),
        }),
        `start(${cmd})`,
      );
      return {
        onData: (cb) => handle.onData(cb),
        wait: () => handle.wait(),
        kill: (signal?: number) => handle.kill(signal),
      };
    },

    async run(cmd: string, options?: SandboxCommandOptions): Promise<SandboxRunResult> {
      const result = await withTimeout(
        source.requireSandboxHandle().commands.run(cmd, {
          ...(options?.args !== undefined ? { args: options.args } : {}),
        }),
        `run(${cmd})`,
      );
      return { exitCode: result.exitCode, stdout: result.stdout };
    },
  };
}
