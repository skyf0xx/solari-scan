import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxGuestAccess, GUEST_CALL_TIMEOUT_MS, type SandboxHandleSource } from "./guest-access.js";

function makeFakeSandbox() {
  return {
    files: {
      list: vi.fn(),
      stat: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
    },
    commands: {
      start: vi.fn(),
    },
  };
}

function makeSource(sandbox: ReturnType<typeof makeFakeSandbox>): SandboxHandleSource {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requireSandboxHandle: () => sandbox as any,
  };
}

describe("createSandboxGuestAccess", () => {
  it("delegates list() to sandbox.files.list and maps FsEntry fields", async () => {
    const sandbox = makeFakeSandbox();
    sandbox.files.list.mockResolvedValue([{ name: "a.txt", dir: false, size: 12 }]);
    const guest = createSandboxGuestAccess(makeSource(sandbox));

    const entries = await guest.list("repo");

    expect(sandbox.files.list).toHaveBeenCalledWith("repo");
    expect(entries).toEqual([{ name: "a.txt", dir: false, size: 12 }]);
  });

  it("delegates stat() to sandbox.files.stat and maps FsStat fields", async () => {
    const sandbox = makeFakeSandbox();
    sandbox.files.stat.mockResolvedValue({
      name: "a.txt",
      dir: false,
      size: 12,
      mode: 0o644,
      modTimeMs: 1700000000000,
    });
    const guest = createSandboxGuestAccess(makeSource(sandbox));

    const stat = await guest.stat("repo/a.txt");

    expect(sandbox.files.stat).toHaveBeenCalledWith("repo/a.txt");
    expect(stat).toEqual({
      name: "a.txt",
      dir: false,
      size: 12,
      mode: 0o644,
      modTimeMs: 1700000000000,
    });
  });

  it("delegates read() to sandbox.files.read", async () => {
    const sandbox = makeFakeSandbox();
    const bytes = new Uint8Array([1, 2, 3]);
    sandbox.files.read.mockResolvedValue(bytes);
    const guest = createSandboxGuestAccess(makeSource(sandbox));

    const result = await guest.read("repo/a.bin");

    expect(sandbox.files.read).toHaveBeenCalledWith("repo/a.bin");
    expect(result).toBe(bytes);
  });

  it("delegates write() to sandbox.files.write", async () => {
    const sandbox = makeFakeSandbox();
    sandbox.files.write.mockResolvedValue(undefined);
    const guest = createSandboxGuestAccess(makeSource(sandbox));

    await guest.write("/tmp/proxy.py", "print('hi')");

    expect(sandbox.files.write).toHaveBeenCalledWith("/tmp/proxy.py", "print('hi')");
  });

  it("delegates start() to sandbox.commands.start and wraps the returned handle", async () => {
    const sandbox = makeFakeSandbox();
    const onData = vi.fn();
    const wait = vi.fn().mockResolvedValue(0);
    const kill = vi.fn().mockResolvedValue(undefined);
    sandbox.commands.start.mockResolvedValue({ onData, wait, kill, cmdId: "cmd-1", stdin: vi.fn() });
    const guest = createSandboxGuestAccess(makeSource(sandbox));

    const handle = await guest.start("python3", { args: ["/tmp/proxy.py"], background: true });

    expect(sandbox.commands.start).toHaveBeenCalledWith("python3", {
      args: ["/tmp/proxy.py"],
      background: true,
    });

    const cb = vi.fn();
    handle.onData(cb);
    expect(onData).toHaveBeenCalledWith(cb);

    await handle.wait();
    expect(wait).toHaveBeenCalledTimes(1);

    await handle.kill(9);
    expect(kill).toHaveBeenCalledWith(9);
  });

  it("resolves the sandbox handle lazily: fails if requireSandboxHandle throws at call time", async () => {
    const source: SandboxHandleSource = {
      requireSandboxHandle: () => {
        throw new Error("not provisioned yet");
      },
    };
    const guest = createSandboxGuestAccess(source);

    await expect(guest.list("repo")).rejects.toThrow("not provisioned yet");
  });

  describe("guest call timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects with CaptureAdapterError if list() never resolves or rejects on its own", async () => {
      // Confirmed live: a single files.list/stat/read round trip can hang
      // indefinitely with no infinite recursion involved — only destroying
      // the sandbox from outside (which errors out whatever call was in
      // flight) unblocked it. A never-settling promise here reproduces that.
      const sandbox = makeFakeSandbox();
      sandbox.files.list.mockReturnValue(new Promise(() => {}));
      const guest = createSandboxGuestAccess(makeSource(sandbox));

      const result = guest.list("repo");
      const assertion = expect(result).rejects.toThrow(
        `Sandbox guest call timed out after ${GUEST_CALL_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(GUEST_CALL_TIMEOUT_MS);
      await assertion;
    });

    it("does not time out a call that resolves well within the limit", async () => {
      const sandbox = makeFakeSandbox();
      sandbox.files.list.mockResolvedValue([{ name: "a.txt", dir: false, size: 1 }]);
      const guest = createSandboxGuestAccess(makeSource(sandbox));

      const entries = await guest.list("repo");

      expect(entries).toEqual([{ name: "a.txt", dir: false, size: 1 }]);
    });
  });

  it("re-resolves the sandbox handle on every call (supports provisioning after construction)", async () => {
    let provisioned: ReturnType<typeof makeFakeSandbox> | undefined;
    const source: SandboxHandleSource = {
      requireSandboxHandle: () => {
        if (!provisioned) {
          throw new Error("not provisioned yet");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return provisioned as any;
      },
    };
    const guest = createSandboxGuestAccess(source);

    await expect(guest.list("repo")).rejects.toThrow("not provisioned yet");

    provisioned = makeFakeSandbox();
    provisioned.files.list.mockResolvedValue([{ name: "b.txt", dir: false, size: 1 }]);

    const entries = await guest.list("repo");
    expect(entries).toEqual([{ name: "b.txt", dir: false, size: 1 }]);
  });
});
