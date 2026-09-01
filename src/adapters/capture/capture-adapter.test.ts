import { describe, expect, it } from "vitest";
import { CaptureAdapter } from "./capture-adapter.js";
import type {
  SandboxCommandChunk,
  SandboxCommandHandle,
  SandboxCommandOptions,
  SandboxFsEntry,
  SandboxFsStat,
  SandboxGuestAccess,
} from "./sandbox-files.js";

class FakeCommandHandle implements SandboxCommandHandle {
  private dataCb: ((chunk: SandboxCommandChunk) => void) | undefined;

  onData(cb: (chunk: SandboxCommandChunk) => void): void {
    this.dataCb = cb;
    // Emit the readiness line asynchronously, like a real background
    // process would after binding its socket.
    queueMicrotask(() => this.dataCb?.({ stream: "stdout", data: "LISTENING:54321\n" }));
  }

  wait(): Promise<number> {
    return new Promise(() => {
      // Never resolves on its own in this fake — the proxy is killed, not
      // waited on to exit naturally.
    });
  }

  async kill(): Promise<void> {}
}

class FakeSandboxGuest implements SandboxGuestAccess {
  written = new Map<string, Uint8Array | string>();

  async list(_path: string): Promise<SandboxFsEntry[]> {
    return [];
  }
  async stat(_path: string): Promise<SandboxFsStat> {
    throw new Error("not used in this test");
  }
  async read(_path: string): Promise<Uint8Array> {
    throw new Error("no log file written in this test");
  }
  async write(path: string, data: Uint8Array | string): Promise<void> {
    this.written.set(path, data);
  }
  async start(_cmd: string, _options?: SandboxCommandOptions): Promise<SandboxCommandHandle> {
    return new FakeCommandHandle();
  }
}

describe("CaptureAdapter", () => {
  it("implements CapturePort by delegating to the filesystem and proxy pieces", async () => {
    const adapter = new CaptureAdapter(new FakeSandboxGuest());

    const snapshot = await adapter.snapshotFilesystem();
    expect(snapshot.entries).toEqual([]);

    const changes = await adapter.diffFilesystem(snapshot, snapshot, "repo");
    expect(changes).toEqual([]);

    const { port } = await adapter.startProxy();
    expect(port).toBeGreaterThan(0);

    const observed = await adapter.stopProxy();
    expect(observed).toEqual([]);
  });

  it("stopProxy() returns raw observed hosts with no allowlist classification applied — domain owns that", async () => {
    const adapter = new CaptureAdapter(new FakeSandboxGuest());
    await adapter.startProxy();
    const observed = await adapter.stopProxy();

    // Contract check: ObservedConnection is `{ host }` only, no verdict field.
    expect(observed.every((c) => Object.keys(c).length === 1 && "host" in c)).toBe(true);
  });
});
