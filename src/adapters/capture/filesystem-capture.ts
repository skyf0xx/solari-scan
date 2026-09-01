/**
 * Recursive filesystem snapshot/diff, hashed via the injected
 * `SandboxGuestAccess` dependency. `CapturePort.snapshotFilesystem()` takes
 * no parameters, but the tree it hashes lives inside the Solari sandbox —
 * reachable only through this constructor-injected dependency (see
 * `hedgehog decision list SOLARI-SCAN-CAPTURE-ADAPTER`).
 *
 * Walk root: `domain/scan.ts`'s `REPO_DIR` constant ("repo") is the clone
 * destination *relative to the sandbox's default working directory* — so
 * hashing has to start above it to see writes the install/build made
 * outside the repo directory (e.g. a postinstall script writing to
 * `~/.cache` or `/tmp`). The walk root used to be hardcoded as `"."`, on
 * the assumption that `"."` resolves to that same scoped working
 * directory. A live end-to-end run disproved this: the walk reached
 * `dev/cpu/1`, a real Linux device pseudo-file — meaning `"."` resolves
 * close to the guest's actual filesystem root, not a scoped home
 * directory. Walking `/dev`, `/proc`, `/sys`-style trees is both wrong
 * (huge, unrelated pseudo-trees) and risky (unpredictable hangs/errors).
 *
 * The fix: discover the guest's real working directory at runtime by
 * running `pwd` in the guest (see `discoverRoot()` below), and cache the
 * result for the adapter's lifetime — a Scan calls `snapshotFilesystem()`
 * exactly twice (baseline, post-run) and the guest's cwd doesn't change in
 * between. `sandbox.git.clone`/`sandbox.commands.run` (see
 * `sandbox-adapter.ts`) are called without an explicit `cwd` override, so
 * they run under the same SDK-default guest working directory that `pwd`
 * (also run without an explicit `cwd`) reports — `REPO_DIR`'s
 * relative-to-that-root assumption in `domain/scan.ts` holds.
 */

import { createHash } from "node:crypto";
import type { FilesystemChange, FilesystemSnapshot, SnapshotEntry } from "../../domain/ports.js";
import { CaptureAdapterError } from "./errors.js";
import type { SandboxGuestAccess } from "./sandbox-files.js";

/** Degraded-mode fallback walk root, used only if the guest's real working
 *  directory can't be discovered (see `discoverRoot()`). Matches the old,
 *  disproven-live hardcoded behavior — a worse but non-crashing default. */
export const FALLBACK_SANDBOX_ROOT = ".";

/**
 * Files larger than this are not read for hashing — reading a multi-GB
 * file into memory to hash it is not a feasible default for a CLI that
 * scans arbitrary third-party repos. Oversized files still appear in the
 * snapshot (so create/delete is still detectable) but with a sentinel hash
 * derived from size + mtime rather than content, so two untouched
 * oversized files still compare equal and a same-size content edit is not
 * guaranteed to be caught — a stated, narrower guarantee for this one case
 * rather than a silent full-content promise the adapter can't keep.
 */
export const MAX_HASHABLE_BYTES = 50 * 1024 * 1024; // 50 MiB

function oversizedSentinelHash(size: number, modTimeMs: number): string {
  return `oversized:${size}:${modTimeMs}`;
}

/**
 * Sentinel for an entry that's listed but can't be stat'd or read as a
 * regular file — a broken or dangling symlink, a device file, a socket, or
 * a permissions-denied path. Confirmed live: a sandbox's own root directory
 * can contain such entries (e.g. a `bin` symlink at the guest's home/working
 * directory) that have nothing to do with the repo under scan. Aborting the
 * whole scan on one unreadable entry would fail every run against any
 * sandbox whose base image includes one — instead the entry is recorded
 * (so create/delete is still detectable if it later becomes readable) and
 * the reason is preserved, rather than crashing or silently omitting it.
 */
function unreadableSentinelHash(reason: string): string {
  return `unreadable:${reason}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinPath(dir: string, name: string): string {
  if (dir === "." || dir === "") {
    return name;
  }
  return `${dir}/${name}`;
}

/** Binds `CapturePort`'s filesystem half to the sandbox's real file tree
 *  via the injected `SandboxGuestAccess` (needs the fuller surface, not just
 *  `SandboxFileAccess`, to run the one-shot `pwd` root-discovery lookup). */
export class FilesystemCaptureAdapter {
  /** Cached result of `discoverRoot()` — populated on first
   *  `snapshotFilesystem()` call and reused for the adapter's lifetime. */
  private cachedRoot: string | undefined;

  constructor(private readonly files: SandboxGuestAccess) {}

  async snapshotFilesystem(): Promise<FilesystemSnapshot> {
    const root = await this.resolveRoot();
    const entries: SnapshotEntry[] = [];
    await this.walk(root, entries);
    return { entries };
  }

  private async resolveRoot(): Promise<string> {
    if (this.cachedRoot === undefined) {
      this.cachedRoot = await this.discoverRoot();
    }
    return this.cachedRoot;
  }

  /**
   * Runs `pwd` in the guest to discover its real default working
   * directory. Falls back to `FALLBACK_SANDBOX_ROOT` (degraded mode,
   * matching the old disproven-live behavior) if the command fails to run,
   * exits non-zero, or returns empty output — rare, but better to keep
   * scanning in a documented degraded mode than to crash the whole Scan
   * over a `pwd` lookup.
   */
  private async discoverRoot(): Promise<string> {
    try {
      const result = await this.files.run("pwd");
      const path = result.stdout.trim();
      if (result.exitCode === 0 && path.length > 0) {
        return path;
      }
    } catch {
      // Fall through to the degraded-mode fallback below.
    }
    return FALLBACK_SANDBOX_ROOT;
  }

  private async walk(dir: string, out: SnapshotEntry[]): Promise<void> {
    let listing;
    try {
      listing = await this.files.list(dir);
    } catch (err) {
      throw new CaptureAdapterError(`Failed to list "${dir}" while snapshotting the filesystem.`, {
        cause: err,
      });
    }

    for (const entry of listing) {
      const path = joinPath(dir, entry.name);
      if (entry.dir) {
        await this.walk(path, out);
        continue;
      }
      out.push({ path, hash: await this.hashFile(path) });
    }
  }

  private async hashFile(path: string): Promise<string> {
    let stat;
    try {
      stat = await this.files.stat(path);
    } catch (err) {
      return unreadableSentinelHash(errorMessage(err));
    }

    if (stat.size > MAX_HASHABLE_BYTES) {
      return oversizedSentinelHash(stat.size, stat.modTimeMs);
    }

    try {
      const content = await this.files.read(path);
      return createHash("sha256").update(content).digest("hex");
    } catch (err) {
      return unreadableSentinelHash(errorMessage(err));
    }
  }

  async diffFilesystem(
    baseline: FilesystemSnapshot,
    postRun: FilesystemSnapshot,
    repoDir: string,
  ): Promise<FilesystemChange[]> {
    const prefix = `${repoDir}/`;
    const isInsideRepo = (path: string) => path === repoDir || path.startsWith(prefix);

    const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry.hash]));
    const postRunByPath = new Map(postRun.entries.map((entry) => [entry.path, entry.hash]));

    const changes: FilesystemChange[] = [];

    for (const [path, hash] of postRunByPath) {
      if (isInsideRepo(path)) {
        continue;
      }
      const baselineHash = baselineByPath.get(path);
      if (baselineHash === undefined) {
        changes.push({ path, changeType: "created" });
      } else if (baselineHash !== hash) {
        changes.push({ path, changeType: "modified" });
      }
    }

    for (const path of baselineByPath.keys()) {
      if (isInsideRepo(path)) {
        continue;
      }
      if (!postRunByPath.has(path)) {
        changes.push({ path, changeType: "deleted" });
      }
    }

    return changes;
  }
}
