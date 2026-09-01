import { describe, expect, it } from "vitest";
import { FALLBACK_SANDBOX_ROOT, FilesystemCaptureAdapter, MAX_HASHABLE_BYTES, MAX_WALK_DEPTH } from "./filesystem-capture.js";
import type {
  SandboxCommandHandle,
  SandboxCommandOptions,
  SandboxFsEntry,
  SandboxFsStat,
  SandboxGuestAccess,
  SandboxRunResult,
} from "./sandbox-files.js";

interface FakeFile {
  content: Uint8Array;
  modTimeMs: number;
  sizeOverride?: number;
}

/** A tiny in-memory filesystem implementing `SandboxGuestAccess`, keyed by
 *  full path (e.g. "repo/package.json", "cache/x.bin"). By default `run("pwd")`
 *  reports `"."` as the discovered root, so existing path fixtures (written
 *  relative to `.`) keep resolving the same way; tests exercising root
 *  discovery itself override `pwdResult`/`pwdError`. */
class FakeSandboxFiles implements SandboxGuestAccess {
  private readonly files = new Map<string, FakeFile>();
  pwdResult: SandboxRunResult = { exitCode: 0, stdout: ".\n" };
  pwdError: Error | undefined;
  runCalls = 0;

  setFile(path: string, content: string | Uint8Array, modTimeMs = 1000, sizeOverride?: number): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path, { content: bytes, modTimeMs, ...(sizeOverride !== undefined ? { sizeOverride } : {}) });
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }

  async write(_path: string, _data: Uint8Array | string): Promise<void> {
    throw new Error("not used in this test");
  }

  async start(_cmd: string, _options?: SandboxCommandOptions): Promise<SandboxCommandHandle> {
    throw new Error("not used in this test");
  }

  async run(_cmd: string, _options?: SandboxCommandOptions): Promise<SandboxRunResult> {
    this.runCalls += 1;
    if (this.pwdError) {
      throw this.pwdError;
    }
    return this.pwdResult;
  }

  async list(path: string): Promise<SandboxFsEntry[]> {
    const prefix = path === "." ? "" : path === "/" ? "/" : `${path}/`;
    const seen = new Map<string, boolean>();

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const rest = filePath.slice(prefix.length);
      const slashIndex = rest.indexOf("/");
      if (slashIndex === -1) {
        seen.set(rest, false);
      } else {
        seen.set(rest.slice(0, slashIndex), true);
      }
    }

    return Array.from(seen.entries()).map(([name, dir]) => ({
      name,
      dir,
      size: dir ? 0 : (this.files.get(`${prefix}${name}`)?.content.length ?? 0),
    }));
  }

  async stat(path: string): Promise<SandboxFsStat> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`no such file: ${path}`);
    }
    return {
      name: path.split("/").pop() ?? path,
      dir: false,
      size: file.sizeOverride ?? file.content.length,
      mode: 0o644,
      modTimeMs: file.modTimeMs,
    };
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`no such file: ${path}`);
    }
    return file.content;
  }
}

describe("FilesystemCaptureAdapter.snapshotFilesystem", () => {
  it("hashes files consistently: identical content produces identical hashes", async () => {
    const files = new FakeSandboxFiles();
    files.setFile("repo/a.txt", "hello world");
    files.setFile("repo/b.txt", "hello world");
    files.setFile("repo/c.txt", "different content");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    const byPath = new Map(snapshot.entries.map((e) => [e.path, e.hash]));
    expect(byPath.get("repo/a.txt")).toBe(byPath.get("repo/b.txt"));
    expect(byPath.get("repo/a.txt")).not.toBe(byPath.get("repo/c.txt"));
  });

  it("walks nested directories recursively", async () => {
    const files = new FakeSandboxFiles();
    files.setFile("repo/src/deep/nested.txt", "content");
    files.setFile("cache/other.bin", "cache content");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();
    const paths = snapshot.entries.map((e) => e.path).sort();

    expect(paths).toEqual(["cache/other.bin", "repo/src/deep/nested.txt"]);
  });

  it("hashes are content-based sha256 hex digests (64 hex chars)", async () => {
    const files = new FakeSandboxFiles();
    files.setFile("repo/a.txt", "hello world");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(snapshot.entries[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats files over MAX_HASHABLE_BYTES as oversized, using a size+mtime sentinel instead of content", async () => {
    const files = new FakeSandboxFiles();
    files.setFile("repo/huge.bin", "small-actual-content", 5000, MAX_HASHABLE_BYTES + 1);

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(snapshot.entries[0]!.hash).toBe(`oversized:${MAX_HASHABLE_BYTES + 1}:5000`);
  });

  it("two untouched oversized files with the same size/mtime compare equal", async () => {
    const baseline = new FakeSandboxFiles();
    baseline.setFile("repo/huge.bin", "x", 5000, MAX_HASHABLE_BYTES + 1);
    const postRun = new FakeSandboxFiles();
    postRun.setFile("repo/huge.bin", "x", 5000, MAX_HASHABLE_BYTES + 1);

    const adapter = new FilesystemCaptureAdapter(baseline);
    const baselineSnapshot = await adapter.snapshotFilesystem();
    const postRunSnapshot = await new FilesystemCaptureAdapter(postRun).snapshotFilesystem();

    expect(baselineSnapshot.entries[0]!.hash).toBe(postRunSnapshot.entries[0]!.hash);
  });

  it("records a list() failure with a sentinel hash instead of aborting the scan", async () => {
    // Confirmed live: a directory anywhere in a large tree (e.g. a
    // 628-package node_modules) can fail to list — a permissions issue or
    // a race with the install/build still writing to it. Aborting the
    // whole scan over one unlistable directory would fail every run
    // against any repo whose install produces one.
    const files = new FakeSandboxFiles();
    files.setFile("repo/a.txt", "hello");
    const originalList = files.list.bind(files);
    files.list = async (dir: string) => {
      if (dir === "repo") {
        throw new Error("permission denied");
      }
      return originalList(dir);
    };

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    const entry = snapshot.entries.find((e) => e.path === "repo");
    expect(entry).toBeDefined();
    expect(entry!.hash).toContain("unreadable:");
    expect(entry!.hash).toContain("permission denied");
  });

  it("records an unreadable entry with a sentinel hash instead of aborting the scan", async () => {
    // Confirmed live: a sandbox's own root can contain entries (e.g. a `bin`
    // symlink) that are listed but fail to stat/read as regular files.
    // Aborting the whole scan on one such entry would fail every run
    // against any sandbox whose base image includes one.
    const files = new FakeSandboxFiles();
    files.setFile("repo/a.txt", "hello");
    const originalRead = files.read.bind(files);
    files.read = async (path: string) => {
      if (path === "repo/a.txt") {
        throw new Error("disk error");
      }
      return originalRead(path);
    };

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    const entry = snapshot.entries.find((e) => e.path === "repo/a.txt");
    expect(entry).toBeDefined();
    expect(entry!.hash).toContain("unreadable:");
    expect(entry!.hash).toContain("disk error");
  });

  it("records a stat() failure with a sentinel hash instead of aborting the scan", async () => {
    const files = new FakeSandboxFiles();
    files.setFile("repo/a.txt", "hello");
    const originalStat = files.stat.bind(files);
    files.stat = async (path: string) => {
      if (path === "repo/a.txt") {
        throw new Error("broken symlink");
      }
      return originalStat(path);
    };

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    const entry = snapshot.entries.find((e) => e.path === "repo/a.txt");
    expect(entry).toBeDefined();
    expect(entry!.hash).toContain("unreadable:");
    expect(entry!.hash).toContain("broken symlink");
  });
});

describe("FilesystemCaptureAdapter.diffFilesystem", () => {
  it("detects a file created outside repoDir", async () => {
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const baseline = { entries: [{ path: "repo/a.txt", hash: "h1" }] };
    const postRun = {
      entries: [
        { path: "repo/a.txt", hash: "h1" },
        { path: "cache/new-file.bin", hash: "h2" },
      ],
    };

    const changes = await adapter.diffFilesystem(baseline, postRun, "repo");
    expect(changes).toEqual([{ path: "cache/new-file.bin", changeType: "created" }]);
  });

  it("detects a file modified outside repoDir", async () => {
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const baseline = { entries: [{ path: "cache/x.bin", hash: "h1" }] };
    const postRun = { entries: [{ path: "cache/x.bin", hash: "h2" }] };

    const changes = await adapter.diffFilesystem(baseline, postRun, "repo");
    expect(changes).toEqual([{ path: "cache/x.bin", changeType: "modified" }]);
  });

  it("detects a file deleted outside repoDir", async () => {
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const baseline = { entries: [{ path: "cache/x.bin", hash: "h1" }] };
    const postRun = { entries: [] };

    const changes = await adapter.diffFilesystem(baseline, postRun, "repo");
    expect(changes).toEqual([{ path: "cache/x.bin", changeType: "deleted" }]);
  });

  it("ignores created/modified/deleted changes inside repoDir", async () => {
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const baseline = {
      entries: [
        { path: "repo/a.txt", hash: "h1" },
        { path: "repo/b.txt", hash: "h1" },
      ],
    };
    const postRun = {
      entries: [
        { path: "repo/a.txt", hash: "h1-modified" },
        { path: "repo/c.txt", hash: "h-new" },
      ],
    };

    const changes = await adapter.diffFilesystem(baseline, postRun, "repo");
    expect(changes).toEqual([]);
  });

  it("does not treat a sibling directory sharing repoDir's name as a prefix as inside repoDir", async () => {
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const baseline = { entries: [] };
    const postRun = { entries: [{ path: "repo-backup/x.txt", hash: "h1" }] };

    const changes = await adapter.diffFilesystem(baseline, postRun, "repo");
    expect(changes).toEqual([{ path: "repo-backup/x.txt", changeType: "created" }]);
  });

  it("ignores changes inside repoDir even when the walk root is '/', not '.'", async () => {
    // Confirmed live (axios/axios PR #11174, a 628-package install): when
    // `pwd` resolves to "/", walk() builds entries as "/repo/..." (see
    // joinPath), not "repo/...". Comparing those against the bare `repoDir`
    // string ("repo") never matches, so every file genuinely inside the
    // repo — the entire node_modules tree included — was wrongly reported
    // as an outside-repo write.
    const files = new FakeSandboxFiles();
    files.pwdResult = { exitCode: 0, stdout: "/\n" };
    const adapter = new FilesystemCaptureAdapter(files);

    const baseline = { entries: [{ path: "/repo/package.json", hash: "h1" }] };
    const postRun = {
      entries: [
        { path: "/repo/package.json", hash: "h1" },
        { path: "/repo/node_modules/.bin/acorn", hash: "h2" },
      ],
    };

    const changes = await adapter.diffFilesystem(baseline, postRun, "repo");
    expect(changes).toEqual([]);
  });

  it("returns no changes for two identical snapshots", async () => {
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const snapshot = { entries: [{ path: "cache/x.bin", hash: "h1" }] };
    const changes = await adapter.diffFilesystem(snapshot, snapshot, "repo");
    expect(changes).toEqual([]);
  });

  it("excludes the scanner's own proxy script/log from findings, even though they're outside repoDir", async () => {
    // Confirmed live: ProxyCaptureAdapter.startProxy() writes
    // /tmp/solari-scan-proxy.py after the baseline snapshot is taken —
    // without this exclusion it always appears as a false-positive
    // "created" finding on every single scan, since it's this scanner's
    // own artifact, not something the target repo's install/build did.
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const baseline = { entries: [] };
    const postRun = {
      entries: [
        { path: "/tmp/solari-scan-proxy.py", hash: "h1" },
        { path: "/tmp/solari-scan-proxy.log", hash: "h2" },
        { path: "/tmp/actually-written-by-install.txt", hash: "h3" },
      ],
    };

    const changes = await adapter.diffFilesystem(baseline, postRun, "repo");
    expect(changes).toEqual([{ path: "/tmp/actually-written-by-install.txt", changeType: "created" }]);
  });

  it("excludes the scanner's own proxy script/log even when they're deleted between snapshots", async () => {
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const baseline = { entries: [{ path: "/tmp/solari-scan-proxy.py", hash: "h1" }] };
    const postRun = { entries: [] };

    const changes = await adapter.diffFilesystem(baseline, postRun, "repo");
    expect(changes).toEqual([]);
  });
});

describe("FilesystemCaptureAdapter root discovery", () => {
  it("discovers the walk root via a one-shot `pwd` and walks from it", async () => {
    const files = new FakeSandboxFiles();
    files.pwdResult = { exitCode: 0, stdout: "/home/solari\n" };
    files.setFile("/home/solari/cache/x.bin", "content");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(files.runCalls).toBe(1);
    expect(snapshot.entries.map((e) => e.path)).toEqual(["/home/solari/cache/x.bin"]);
  });

  it("caches the discovered root: a second snapshotFilesystem() call does not re-run the discovery command", async () => {
    const files = new FakeSandboxFiles();
    files.pwdResult = { exitCode: 0, stdout: "/home/solari\n" };
    files.setFile("/home/solari/a.txt", "content");

    const adapter = new FilesystemCaptureAdapter(files);
    await adapter.snapshotFilesystem();
    await adapter.snapshotFilesystem();

    expect(files.runCalls).toBe(1);
  });

  it("falls back to the degraded '.' root if the discovery command exits non-zero", async () => {
    const files = new FakeSandboxFiles();
    files.pwdResult = { exitCode: 1, stdout: "" };
    files.setFile("repo/a.txt", "content");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(snapshot.entries.map((e) => e.path)).toEqual(["repo/a.txt"]);
  });

  it("falls back to the degraded '.' root if the discovery command returns empty output", async () => {
    const files = new FakeSandboxFiles();
    files.pwdResult = { exitCode: 0, stdout: "   \n" };
    files.setFile("repo/a.txt", "content");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(snapshot.entries.map((e) => e.path)).toEqual(["repo/a.txt"]);
  });

  it("falls back to the degraded '.' root if the discovery command throws, still completing the scan", async () => {
    const files = new FakeSandboxFiles();
    files.pwdError = new Error("command not found: pwd");
    files.setFile("repo/a.txt", "content");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(snapshot.entries.map((e) => e.path)).toEqual(["repo/a.txt"]);
  });

  it("exposes the fallback root as FALLBACK_SANDBOX_ROOT for callers to reason about degraded mode", () => {
    expect(FALLBACK_SANDBOX_ROOT).toBe(".");
  });
});

/** A `SandboxGuestAccess` whose `list()` reports one ever-deeper nested
 *  directory no matter what path it's asked about — simulates a directory
 *  symlink cycle (e.g. a base image's `dir/x` pointing back at an ancestor),
 *  which the real SDK's `FsEntry`/`FsStat` give no inode/symlink identity to
 *  detect directly (see `MAX_WALK_DEPTH`'s doc comment). Counts calls so
 *  tests can assert the walk actually stopped rather than exhausting time or
 *  memory. */
class InfiniteNestingSandboxFiles implements SandboxGuestAccess {
  listCalls = 0;

  async write(): Promise<void> {
    throw new Error("not used in this test");
  }
  async start(): Promise<SandboxCommandHandle> {
    throw new Error("not used in this test");
  }
  async run(): Promise<SandboxRunResult> {
    return { exitCode: 0, stdout: "/home/solari\n" };
  }
  async list(_path: string): Promise<SandboxFsEntry[]> {
    this.listCalls += 1;
    return [{ name: "loop", dir: true, size: 0 }];
  }
  async stat(): Promise<SandboxFsStat> {
    throw new Error("not used in this test");
  }
  async read(): Promise<Uint8Array> {
    throw new Error("not used in this test");
  }
}

describe("FilesystemCaptureAdapter walk depth cap", () => {
  it("terminates a cyclic/unbounded directory tree instead of recursing forever", async () => {
    // Confirmed live: a directory symlink loop inside an allowed root child
    // (past the "/" allowlist, which only restricts one level) hung a scan
    // indefinitely — every list()/stat()/read() a real ~330ms RPC with
    // nothing timing the walk out. This proves the depth cap bounds it.
    const files = new InfiniteNestingSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const snapshot = await adapter.snapshotFilesystem();

    expect(files.listCalls).toBeLessThanOrEqual(MAX_WALK_DEPTH + 2);
    expect(snapshot.entries.some((e) => e.hash === "walk-depth-exceeded")).toBe(true);
  });
});

describe("FilesystemCaptureAdapter walking a root of '/'", () => {
  it("only walks the allowlisted root children (home/root/tmp/repo), skipping everything else", async () => {
    // Confirmed live: a `pwd` root of "/" otherwise makes the walk recurse
    // into pseudo-filesystems (dev/proc/sys), the entire OS userland
    // (usr/bin/sbin/lib/lib64/boot/media/mnt/srv), and base-image config
    // bulk (etc alone was 91% of all files walked in one live run) — none
    // of it something an unprivileged install/build plausibly writes to.
    const files = new FakeSandboxFiles();
    files.pwdResult = { exitCode: 0, stdout: "/\n" };
    files.setFile("/dev/null", "device");
    files.setFile("/proc/cpuinfo", "cpu");
    files.setFile("/sys/kernel/x", "kernel");
    files.setFile("/usr/lib/x.so", "lib");
    files.setFile("/bin/sh", "shell");
    files.setFile("/sbin/init", "init");
    files.setFile("/lib/libc.so", "libc");
    files.setFile("/lib64/ld.so", "ld");
    files.setFile("/boot/vmlinuz", "kernel image");
    files.setFile("/media/x", "media");
    files.setFile("/mnt/x", "mount");
    files.setFile("/srv/x", "srv");
    files.setFile("/etc/npmrc", "etc");
    files.setFile("/var/cache/x", "var");
    files.setFile("/opt/toolchain/x", "opt");
    files.setFile("/home/solari/.npm/cache.json", "home");
    files.setFile("/root/.cache/x", "root");
    files.setFile("/tmp/x.tmp", "tmp");
    files.setFile("/repo/a.txt", "repo");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(snapshot.entries.map((e) => e.path).sort()).toEqual(
      ["/home/solari/.npm/cache.json", "/root/.cache/x", "/tmp/x.tmp", "/repo/a.txt"].sort(),
    );
  });

  it("does not restrict children of an already-scoped root (pwd not '/')", async () => {
    // A `pwd` that already reports a small, scoped directory is the correct
    // walk root as-is — the allowlist only kicks in for an unscoped "/".
    const files = new FakeSandboxFiles();
    files.pwdResult = { exitCode: 0, stdout: "/home/solari\n" };
    files.setFile("/home/solari/cache/x.bin", "content");
    files.setFile("/home/solari/repo/a.txt", "content");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(snapshot.entries.map((e) => e.path).sort()).toEqual(
      ["/home/solari/cache/x.bin", "/home/solari/repo/a.txt"].sort(),
    );
  });

  it("walks fully once inside an allowed root child — the allowlist is one level deep only", async () => {
    const files = new FakeSandboxFiles();
    files.pwdResult = { exitCode: 0, stdout: "/\n" };
    files.setFile("/home/solari/.cache/deep/nested/file.bin", "content");

    const adapter = new FilesystemCaptureAdapter(files);
    const snapshot = await adapter.snapshotFilesystem();

    expect(snapshot.entries.map((e) => e.path)).toEqual(["/home/solari/.cache/deep/nested/file.bin"]);
  });
});
