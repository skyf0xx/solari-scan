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
 * directory.
 *
 * Root discovery itself is still correct: `pwd` is run in the guest at
 * runtime (see `discoverRoot()` below) and cached for the adapter's
 * lifetime — a Scan calls `snapshotFilesystem()` exactly twice (baseline,
 * post-run) and the guest's cwd doesn't change in between.
 * `sandbox.git.clone`/`sandbox.commands.run` (see `sandbox-adapter.ts`) run
 * without an explicit `cwd` override, so they share the same SDK-default
 * guest working directory `pwd` reports — `REPO_DIR`'s
 * relative-to-that-root assumption in `domain/scan.ts` holds.
 *
 * What changed is *what gets walked once the root is known*. The first fix
 * here was a blocklist of Linux pseudo-filesystems (`dev`/`proc`/`sys`),
 * widened once more (`usr`/`bin`/`sbin`/`lib`/`lib64`/`boot`/`media`/`mnt`/
 * `srv`) after a live run showed walking `/usr` alone — the entire OS
 * userland — is an effectively-unbounded walk (many minutes to hours, not a
 * hang: every `stat`+`read` pair costs a flat ~330ms RPC round trip
 * regardless of file size). That still wasn't enough: a further live run
 * showed `/etc` alone contributes 91% of all files walked (564 of 620) —
 * X11 configs, `update-alternatives` symlinks, locale data, none of it
 * something an unprivileged install/build plausibly writes to. Blocklisting
 * one more top-level name every time a base image ships another large
 * irrelevant tree is whack-a-mole with no natural end.
 *
 * The actual fix: invert to an ALLOWLIST, applied only when the discovered
 * root is unscoped (`"/"` exactly) — the case that showed both failure
 * modes above. A `pwd` that already reports a small, scoped directory (the
 * pre-bug assumption, still valid whenever it actually holds) is left alone
 * and walked in full, no allowlist applied. When the root is `"/"`, only
 * `home` (small on every base image seen live: one entry, the guest user's
 * own directory), `root` (small: a handful of dotfiles), `tmp`, and
 * `REPO_DIR_NAME` ("repo", matching `domain/scan.ts`'s `REPO_DIR` constant
 * verbatim — the two must stay in sync, since nothing enforces it
 * structurally) are recursed into; everything else at the root — `etc`,
 * `var`, `usr`, `bin`, and whatever other bulk a future base image adds —
 * is skipped without needing to be named. This matches the scan's actual
 * question ("did install/build write outside the repo directory") against
 * where an unprivileged process realistically *can* write: its own home
 * directory, `/tmp`, and the repo it's building. The restriction applies
 * only to the root's immediate children — once inside an allowed child,
 * the walk recurses fully, since everything below that point is plausible
 * install/build write surface.
 */

import { createHash } from "node:crypto";
import type { FilesystemChange, FilesystemSnapshot, SnapshotEntry } from "../../domain/ports.js";
import { PROXY_LOG_PATH, PROXY_SCRIPT_PATH } from "./proxy-capture.js";
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

/**
 * Hard cap on recursion depth from the walk root. `SandboxFsEntry`/`SandboxFsStat`
 * (mirroring the real SDK's `FsEntry`/`FsStat`) carry no inode/symlink
 * identity, so a directory symlink that loops back on an ancestor (e.g. a
 * base image's `/root/x` pointing at `/`) can't be detected and skipped by
 * identity — it looks exactly like a real, ever-deeper subtree. Confirmed
 * live: exactly this hung a scan indefinitely inside an allowed root child
 * (past the allowlist, which only restricts "/"'s immediate children — see
 * `isAllowedRootChild`), each `list`/`stat`/`read` still a real ~330ms RPC
 * with nothing timing the walk out. A depth cap bounds it deterministically
 * regardless of cause (a true cycle or just a surprisingly deep real tree)
 * without needing symlink identity the sandbox API doesn't expose. 40 is
 * generously above any real install/build tree seen live (node_modules
 * nesting included) while still bounding a cycle to a small, fast multiple
 * of the RPC cost instead of an unbounded hang.
 */
export const MAX_WALK_DEPTH = 40;

function walkDepthSentinelHash(): string {
  return "walk-depth-exceeded";
}

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

/** Must match `domain/scan.ts`'s `REPO_DIR` constant verbatim — the repo's
 *  clone destination, and the one allowlisted root-child that names the
 *  actual subject of the scan rather than a plausible-write-target guess.
 *  Nothing enforces this match structurally; see this file's header. */
const REPO_DIR_NAME = "repo";

/**
 * The only walk-root children recursed into — see this file's header for
 * why this is an allowlist rather than a growing pseudo-filesystem
 * blocklist. `home` and `root` are a guest's own directories (small on
 * every base image seen live); `tmp` and `REPO_DIR_NAME` are the other
 * plausible install/build write targets.
 */
const ALLOWED_ROOT_CHILDREN = new Set(["home", "root", "tmp", REPO_DIR_NAME]);

function isAllowedRootChild(name: string): boolean {
  return ALLOWED_ROOT_CHILDREN.has(name);
}

function joinPath(dir: string, name: string): string {
  if (dir === "." || dir === "") {
    return name;
  }
  // `pwd`-discovered roots can be "/" (this sandbox's real cwd, confirmed
  // live) — a plain `${dir}/${name}` then produces "//name". Avoid a
  // doubled separator when `dir` already ends in one.
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
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
    // The allowlist only applies when the discovered root is the actual
    // filesystem root ("/") — the case a live run showed walks the entire
    // OS image (see this file's header). A `pwd` that already reports a
    // small, scoped directory (e.g. "/home/solari") is itself the correct,
    // narrow walk root and needs no further restriction.
    await this.walk(root, root === "/", 0, entries);
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

  /**
   * `restrictChildren` is true only while listing the immediate children of
   * an unscoped ("/") walk root — see `snapshotFilesystem()`. It's cleared
   * (false) for every recursive call below that point, so once inside an
   * allowed child (`home`, `root`, `tmp`, the repo dir) everything under it
   * is walked without further restriction.
   */
  private async walk(dir: string, restrictChildren: boolean, depth: number, out: SnapshotEntry[]): Promise<void> {
    if (depth > MAX_WALK_DEPTH) {
      // See `MAX_WALK_DEPTH`'s doc comment: no symlink identity is available
      // to detect a cycle directly, so this is the backstop that turns an
      // unbounded hang into a bounded, reported-and-moves-on entry instead.
      out.push({ path: dir, hash: walkDepthSentinelHash() });
      return;
    }

    let listing;
    try {
      listing = await this.files.list(dir);
    } catch (err) {
      // Same rationale as `hashFile`'s unreadable-entry handling below: a
      // permissions-denied or otherwise unlistable directory anywhere in a
      // large tree (confirmed live inside a 628-package node_modules) would
      // abort the entire scan with no report at all if this threw. Record
      // the directory itself as unreadable and keep walking its siblings.
      out.push({ path: dir, hash: unreadableSentinelHash(errorMessage(err)) });
      return;
    }

    for (const entry of listing) {
      const path = joinPath(dir, entry.name);
      if (entry.dir) {
        if (restrictChildren && !isAllowedRootChild(entry.name)) {
          continue;
        }
        await this.walk(path, false, depth + 1, out);
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
    // Snapshot entries are paths joined against the pwd-discovered sandbox
    // root (see `joinPath`/`discoverRoot` above) — e.g. "/repo/..." when the
    // root is "/", not the bare "repo/..." `repoDir` alone would produce.
    // Comparing against `repoDir` directly here would silently never match,
    // making every file genuinely inside the repo look like an outside-repo
    // write. Resolve the same root `walk()` used (cached, no extra `pwd`
    // call) to build the prefix entries actually have.
    const root = await this.resolveRoot();
    const resolvedRepoDir = joinPath(root, repoDir);
    const prefix = `${resolvedRepoDir}/`;
    const isInsideRepo = (path: string) => path === resolvedRepoDir || path.startsWith(prefix);
    // The proxy script/log are this scanner's own artifacts, written (by
    // ProxyCaptureAdapter.startProxy(), after the baseline snapshot) between
    // the two snapshots this diff compares — confirmed live that without
    // this exclusion, PROXY_SCRIPT_PATH always appears as a false-positive
    // "created" finding on every scan.
    const isOwnArtifact = (path: string) => path === PROXY_SCRIPT_PATH || path === PROXY_LOG_PATH;

    const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry.hash]));
    const postRunByPath = new Map(postRun.entries.map((entry) => [entry.path, entry.hash]));

    const changes: FilesystemChange[] = [];

    for (const [path, hash] of postRunByPath) {
      if (isInsideRepo(path) || isOwnArtifact(path)) {
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
      if (isInsideRepo(path) || isOwnArtifact(path)) {
        continue;
      }
      if (!postRunByPath.has(path)) {
        changes.push({ path, changeType: "deleted" });
      }
    }

    return changes;
  }
}
