/**
 * Fake `SandboxPort`/`CapturePort` implementations for exercising the
 * orchestrator without any real filesystem, network, or Solari SDK call.
 * Not exported via `index.ts` — test-only support code.
 */

import type {
  CapturePort,
  CloneOptions,
  DirectoryEntryName,
  FilesystemChange,
  FilesystemSnapshot,
  ObservedConnection,
  RunCommandOptions,
  RunCommandResult,
  SandboxPort,
} from "./ports.js";

export interface FakeSandboxConfig {
  rootEntries?: DirectoryEntryName[];
  commandResults?: Record<string, RunCommandResult>;
  provisionError?: Error;
  cloneError?: Error;
  /** When set, `runCommand` invokes the matching command's `onStdout`/
   *  `onStderr` with these chunks before resolving — lets a test observe
   *  that a caller's output callbacks actually receive data. */
  commandOutput?: Record<string, Array<{ stream: "stdout" | "stderr"; data: string }>>;
}

export class FakeSandboxPort implements SandboxPort {
  readonly calls: string[] = [];
  readonly commandsRun: Array<{ cmd: string; options?: RunCommandOptions }> = [];
  destroyCallCount = 0;

  constructor(private readonly config: FakeSandboxConfig = {}) {}

  async provision(): Promise<void> {
    this.calls.push("provision");
    if (this.config.provisionError) {
      throw this.config.provisionError;
    }
  }

  async clone(_repoUrl: string, _options: CloneOptions): Promise<void> {
    this.calls.push("clone");
    if (this.config.cloneError) {
      throw this.config.cloneError;
    }
  }

  async listDirectory(_dir: string): Promise<DirectoryEntryName[]> {
    this.calls.push("listDirectory");
    return this.config.rootEntries ?? [{ name: "package.json", dir: false }];
  }

  async runCommand(cmd: string, options?: RunCommandOptions): Promise<RunCommandResult> {
    this.calls.push(`runCommand:${cmd}`);
    this.commandsRun.push({ cmd, options });
    for (const chunk of this.config.commandOutput?.[cmd] ?? []) {
      if (chunk.stream === "stdout") {
        options?.onStdout?.(chunk.data);
      } else {
        options?.onStderr?.(chunk.data);
      }
    }
    return this.config.commandResults?.[cmd] ?? { exitCode: 0 };
  }

  async destroy(): Promise<void> {
    this.calls.push("destroy");
    this.destroyCallCount += 1;
  }
}

export interface FakeCaptureConfig {
  baselineSnapshot?: FilesystemSnapshot;
  postRunSnapshot?: FilesystemSnapshot;
  filesystemChanges?: FilesystemChange[];
  proxyPort?: number;
  observedConnections?: ObservedConnection[];
}

export class FakeCapturePort implements CapturePort {
  readonly calls: string[] = [];
  private snapshotCallCount = 0;

  constructor(private readonly config: FakeCaptureConfig = {}) {}

  async snapshotFilesystem(): Promise<FilesystemSnapshot> {
    this.snapshotCallCount += 1;
    this.calls.push("snapshotFilesystem");
    if (this.snapshotCallCount === 1) {
      return this.config.baselineSnapshot ?? { entries: [{ path: "repo/a.txt", hash: "h1" }] };
    }
    return this.config.postRunSnapshot ?? this.config.baselineSnapshot ?? { entries: [{ path: "repo/a.txt", hash: "h1" }] };
  }

  async diffFilesystem(
    _baseline: FilesystemSnapshot,
    _postRun: FilesystemSnapshot,
    _repoDir: string,
  ): Promise<FilesystemChange[]> {
    this.calls.push("diffFilesystem");
    return this.config.filesystemChanges ?? [];
  }

  async startProxy(): Promise<{ port: number; env: Record<string, string> }> {
    this.calls.push("startProxy");
    const port = this.config.proxyPort ?? 8080;
    return { port, env: { HTTP_PROXY: `http://127.0.0.1:${port}`, HTTPS_PROXY: `http://127.0.0.1:${port}` } };
  }

  async stopProxy(): Promise<ObservedConnection[]> {
    this.calls.push("stopProxy");
    return this.config.observedConnections ?? [];
  }
}
