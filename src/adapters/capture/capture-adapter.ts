/**
 * Binds `domain`'s `CapturePort` to the real filesystem-hash and
 * forwarding-proxy boundaries. Composes `FilesystemCaptureAdapter` (the
 * sandbox tree snapshot/diff, via the injected `SandboxGuestAccess`'s
 * file-access slice) and `ProxyCaptureAdapter` (the in-guest forwarding
 * proxy — see that file's header comment for what's guaranteed by
 * construction vs. still unverified against a live sandbox).
 *
 * Takes `SandboxGuestAccess`, not the narrower `SandboxFileAccess`: the
 * proxy now runs *inside* the guest and needs to write its script and
 * start/kill it as a background command, which is a broader surface than
 * file access alone (see `sandbox-files.ts`'s header).
 *
 * `stopProxy()` returns raw `ObservedConnection[]` (host only, no
 * allowlist verdict) — `domain/scan.ts` already imports and calls
 * `classifyDestination` itself on each connection after `stopProxy()`
 * resolves. Classification is domain's business rule (`allowlist.ts`'s own
 * header says so); this layer's contract is to report what it saw, not to
 * judge it.
 */

import type { CapturePort, FilesystemChange, FilesystemSnapshot, ObservedConnection } from "../../domain/ports.js";
import { FilesystemCaptureAdapter } from "./filesystem-capture.js";
import { ProxyCaptureAdapter } from "./proxy-capture.js";
import type { SandboxGuestAccess } from "./sandbox-files.js";

export class CaptureAdapter implements CapturePort {
  private readonly filesystem: FilesystemCaptureAdapter;
  private readonly proxy: ProxyCaptureAdapter;

  constructor(guest: SandboxGuestAccess) {
    this.filesystem = new FilesystemCaptureAdapter(guest);
    this.proxy = new ProxyCaptureAdapter(guest);
  }

  snapshotFilesystem(): Promise<FilesystemSnapshot> {
    return this.filesystem.snapshotFilesystem();
  }

  diffFilesystem(
    baseline: FilesystemSnapshot,
    postRun: FilesystemSnapshot,
    repoDir: string,
  ): Promise<FilesystemChange[]> {
    return this.filesystem.diffFilesystem(baseline, postRun, repoDir);
  }

  startProxy(): Promise<{ port: number; env: Record<string, string> }> {
    return this.proxy.startProxy();
  }

  stopProxy(): Promise<ObservedConnection[]> {
    return this.proxy.stopProxy();
  }
}
