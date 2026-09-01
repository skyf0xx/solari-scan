/**
 * Binds `domain`'s `SandboxPort` to the real `@solarisdk/sandbox` SDK:
 * provision, clone, list, run, destroy — with error mapping applied at
 * every real SDK call site. The sandbox handle is created lazily by
 * `provision()` and reused by every other method for the adapter's
 * lifetime.
 */

import { SandboxClient, type Sandbox } from "@solarisdk/sandbox";
import { CloneError, SandboxProvisioningError } from "../../domain/errors.js";
import type {
  CloneOptions,
  DirectoryEntryName,
  RunCommandOptions,
  RunCommandResult,
  SandboxPort,
} from "../../domain/ports.js";
import { mapSdkError } from "./errors.js";

export interface SandboxAdapterOptions {
  apiKey: string;
  /**
   * Required by `@solarisdk/sandbox`'s `SandboxClientOptions` (no SDK-side
   * default exists despite this being commonly optional in similar SDKs) —
   * `command` must supply it, e.g. from a `SOLARI_BASE_URL` env var or a
   * hardcoded default of its own choosing.
   */
  baseUrl: string;
}

/**
 * Local branch name the PR's server-side ref is fetched into. GitHub's
 * `pull/<n>/head` is a special server-side ref only reachable via `git
 * fetch origin pull/<n>/head:<local-branch>` — it is not checkout-able as a
 * `branch`/`tag` at clone time, which is what `GitCloneOptions.branch`
 * ("Branch/tag to check out") maps to under the hood (plain `git clone
 * --branch <x>` semantics). So the PR is fetched and checked out as a
 * separate step after a normal clone, rather than passed to `git.clone`.
 */
function prLocalBranch(prNumber: number): string {
  return `pr-${prNumber}`;
}

/**
 * Splits a shell-style command line ("npm install", "pip install -r
 * requirements.txt") into an executable name plus its arguments. Confirmed
 * live: `sandbox.commands.run(cmd, opts)` execs `cmd` as a literal filename
 * — it does not shell-interpret it — so passing `"npm install"` straight
 * through as `cmd` fails with "executable file not found in $PATH" (it
 * looks for a file literally named `npm install`), even though `npm` alone
 * resolves fine. The SDK's own internal usage (`handle.js`'s `git.clone`
 * fetch step) confirms the intended shape: bare executable in `cmd`,
 * arguments in a separate `args` array. `domain/package-manager.ts`'s
 * `DetectedCommands` fields stay a single command-line string — a
 * reasonable domain-level concept — this split is purely an SDK-call-site
 * concern, so it's confined here. Plain whitespace splitting is sufficient:
 * every command `package-manager.ts` can produce is a fixed, known string
 * with no quoted or space-containing arguments.
 */
function splitCommandLine(cmd: string): [string, ...string[]] {
  const [executable, ...args] = cmd.trim().split(/\s+/);
  return [executable as string, ...args];
}

export class SandboxAdapter implements SandboxPort {
  private readonly client: SandboxClient;
  private sandbox: Sandbox | undefined;

  constructor(options: SandboxAdapterOptions) {
    this.client = new SandboxClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });
  }

  async provision(): Promise<void> {
    try {
      const sandbox = await this.client.create();
      // `create()` returns a handle whose control WebSocket is not yet
      // open — `connect()` must be called before `.git`/`.commands`/
      // `.files` (all of which go over that channel) or every one of them
      // rejects with "Not connected — call connect() first". Confirmed
      // against a live sandbox during this build: the SDK's own type
      // doc-comments don't state this ordering requirement explicitly.
      await sandbox.connect();
      this.sandbox = sandbox;
    } catch (err) {
      throw mapSdkError(err, "Sandbox provisioning failed for an unknown reason.");
    }
  }

  async clone(repoUrl: string, options: CloneOptions): Promise<void> {
    const sandbox = this.requireSandbox();
    const localBranch = prLocalBranch(options.prNumber);

    try {
      await sandbox.git.clone(repoUrl, { path: options.path });
    } catch (err) {
      throw this.cloneError(repoUrl, options.prNumber, err);
    }

    try {
      const fetchResult = await sandbox.commands.run("git", {
        args: ["fetch", "origin", `pull/${options.prNumber}/head:${localBranch}`],
        cwd: options.path,
      });
      if (fetchResult.exitCode !== 0) {
        throw new Error(fetchResult.stderr || `git fetch exited with code ${fetchResult.exitCode}`);
      }
    } catch (err) {
      throw this.cloneError(repoUrl, options.prNumber, err);
    }

    try {
      const checkoutResult = await sandbox.commands.run("git", {
        args: ["checkout", localBranch],
        cwd: options.path,
      });
      if (checkoutResult.exitCode !== 0) {
        throw new Error(checkoutResult.stderr || `git checkout exited with code ${checkoutResult.exitCode}`);
      }
    } catch (err) {
      throw this.cloneError(repoUrl, options.prNumber, err);
    }
  }

  private cloneError(repoUrl: string, prNumber: number, err: unknown): CloneError {
    const message = err instanceof Error ? err.message : String(err);
    return new CloneError(`Failed to clone ${repoUrl} (PR #${prNumber}): ${message}`, { cause: err });
  }

  async listDirectory(dir: string): Promise<DirectoryEntryName[]> {
    const sandbox = this.requireSandbox();
    const entries = await sandbox.files.list(dir);
    return entries.map((entry) => ({ name: entry.name, dir: entry.dir }));
  }

  async runCommand(cmd: string, options?: RunCommandOptions): Promise<RunCommandResult> {
    const sandbox = this.requireSandbox();
    const [executable, ...args] = splitCommandLine(cmd);
    try {
      const result = await sandbox.commands.run(executable, {
        ...(args.length > 0 ? { args } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
        ...(options?.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
      });
      return { exitCode: result.exitCode };
    } catch (err) {
      throw mapSdkError(err, `Running "${cmd}" in the sandbox failed for an unknown reason.`);
    }
  }

  async destroy(): Promise<void> {
    if (!this.sandbox) {
      return;
    }
    await this.sandbox.kill();
  }

  /**
   * The raw provisioned `Sandbox` handle, once `provision()` has succeeded.
   * `SandboxPort`'s own methods deliberately don't expose this — `domain`
   * only ever sees the port's narrow surface — but `command` needs it to
   * wire the same guest session into `capture-adapter`'s `SandboxGuestAccess`
   * (see `hedgehog decision list SOLARI-SCAN-CAPTURE-ADAPTER`: capture and
   * sandbox adapters share one guest session rather than each provisioning
   * their own). Not part of `SandboxPort` — a `command`-only escape hatch.
   */
  requireSandboxHandle(): Sandbox {
    return this.requireSandbox();
  }

  private requireSandbox(): Sandbox {
    if (!this.sandbox) {
      throw new SandboxProvisioningError(
        "Sandbox operation attempted before provision() succeeded.",
      );
    }
    return this.sandbox;
  }
}
