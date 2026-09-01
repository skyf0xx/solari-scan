import { describe, expect, it } from "vitest";
import { FilesystemCaptureAdapter, MAX_HASHABLE_BYTES } from "./filesystem-capture.js";
import type { SandboxFileAccess, SandboxFsEntry, SandboxFsStat } from "./sandbox-files.js";
import { CaptureAdapterError } from "./errors.js";

interface FakeFile {
  content: Uint8Array;
  modTimeMs: number;
  sizeOverride?: number;
}

/** A tiny in-memory filesystem implementing `SandboxFileAccess`, keyed by
 *  full path (e.g. "repo/package.json", "cache/x.bin"). */
class FakeSandboxFiles implements SandboxFileAccess {
  private readonly files = new Map<string, FakeFile>();

  setFile(path: string, content: string | Uint8Array, modTimeMs = 1000, sizeOverride?: number): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path, { content: bytes, modTimeMs, ...(sizeOverride !== undefined ? { sizeOverride } : {}) });
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }

  async list(path: string): Promise<SandboxFsEntry[]> {
    const prefix = path === "." ? "" : `${path}/`;
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

  it("wraps a list() failure in CaptureAdapterError", async () => {
    const files: SandboxFileAccess = {
      list: async () => {
        throw new Error("permission denied");
      },
      stat: async () => {
        throw new Error("unreachable");
      },
      read: async () => {
        throw new Error("unreachable");
      },
    };

    const adapter = new FilesystemCaptureAdapter(files);
    await expect(adapter.snapshotFilesystem()).rejects.toBeInstanceOf(CaptureAdapterError);
  });

  it("wraps a read() failure in CaptureAdapterError", async () => {
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
    await expect(adapter.snapshotFilesystem()).rejects.toBeInstanceOf(CaptureAdapterError);
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

  it("returns no changes for two identical snapshots", async () => {
    const files = new FakeSandboxFiles();
    const adapter = new FilesystemCaptureAdapter(files);

    const snapshot = { entries: [{ path: "cache/x.bin", hash: "h1" }] };
    const changes = await adapter.diffFilesystem(snapshot, snapshot, "repo");
    expect(changes).toEqual([]);
  });
});
