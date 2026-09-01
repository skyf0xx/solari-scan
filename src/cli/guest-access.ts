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
 */

import type { Sandbox } from "@solarisdk/sandbox";
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

export function createSandboxGuestAccess(source: SandboxHandleSource): SandboxGuestAccess {
  return {
    async list(path: string): Promise<SandboxFsEntry[]> {
      const entries = await source.requireSandboxHandle().files.list(path);
      return entries.map((entry) => ({ name: entry.name, dir: entry.dir, size: entry.size }));
    },

    async stat(path: string): Promise<SandboxFsStat> {
      const stat = await source.requireSandboxHandle().files.stat(path);
      return {
        name: stat.name,
        dir: stat.dir,
        size: stat.size,
        mode: stat.mode,
        modTimeMs: stat.modTimeMs,
      };
    },

    async read(path: string): Promise<Uint8Array> {
      return source.requireSandboxHandle().files.read(path);
    },

    async write(path: string, data: Uint8Array | string): Promise<void> {
      await source.requireSandboxHandle().files.write(path, data);
    },

    async start(cmd: string, options?: SandboxCommandOptions): Promise<SandboxCommandHandle> {
      const handle = await source.requireSandboxHandle().commands.start(cmd, {
        ...(options?.args !== undefined ? { args: options.args } : {}),
        ...(options?.background !== undefined ? { background: options.background } : {}),
      });
      return {
        onData: (cb) => handle.onData(cb),
        wait: () => handle.wait(),
        kill: (signal?: number) => handle.kill(signal),
      };
    },

    async run(cmd: string, options?: SandboxCommandOptions): Promise<SandboxRunResult> {
      const result = await source.requireSandboxHandle().commands.run(cmd, {
        ...(options?.args !== undefined ? { args: options.args } : {}),
      });
      return { exitCode: result.exitCode, stdout: result.stdout };
    },
  };
}
