# solari-scan

A CLI that clones a GitHub PR into an isolated Solari sandbox, runs its
install and build steps, and reports the runtime behavior it actually
observed — unexpected outbound network destinations and unexpected
filesystem writes outside the repo directory — as facts, not a
safe/unsafe verdict.

```
solari-scan <repo-url> --pr <n>
```

No other flags, no config file. Point it at a public GitHub repo and a
pull request number; it clones that PR's code into a fresh Solari
sandbox, installs and builds it, and prints what it saw.

## What it does

1. Provisions a fresh Solari sandbox (a hardware-isolated microVM —
   isolation is Solari's own guarantee, not something this tool adds).
   No code has executed yet at this point.
2. Clones the target repo and checks out the PR's code into the sandbox.
   Still no code executed.
3. Hashes the sandbox's file tree — a baseline snapshot.
4. Starts a forwarding proxy inside the sandbox and exports
   `HTTP_PROXY`/`HTTPS_PROXY` so proxy-respecting outbound traffic during
   install and build is logged.
5. Detects the repo's package manager and runs its install command.
6. Runs the build command — only if install succeeded. The test suite is
   never run.
7. Hashes the file tree again and diffs it against the baseline.
8. Parses the proxy log and classifies each observed destination against
   a hardcoded host allowlist (package registries, git hosts, common
   CDNs).
9. Prints a report and writes `solari-scan-report.json`.
10. Destroys the sandbox — on every exit path, including a failed
    install/build, an uncaught error, or a user interrupt.

Install/build stdout and stderr stream to the terminal live, as
produced. A non-zero install or build exit does not abort the scan —
capture and reporting still complete, and the report says so.

A clean run collapses to one line:

```
No unexpected behavior observed during install/build.
```

A run with findings prints each one individually — the host or path,
and which capture step produced it — followed by:

```
Observed behavior, not a verdict.
```

That line, and the absence of the words "safe" or "unsafe" anywhere in
the output, is deliberate. This tool reports what a PR's install/build
did. Whether that's acceptable is a judgment call for the person
reviewing the PR, not something a hardcoded host list or a filesystem
diff can make.

## How it works

Everything above is observability this tool builds itself, layered on
top of Solari's own primitives: sandbox lifecycle (create, clone, run,
destroy) and live process exec with streamed stdout/stderr. The
filesystem hashing, the before/after diff, the in-sandbox forwarding
proxy, and the host-allowlist classification are not Solari features —
they're what this CLI adds on top of a plain sandbox to turn "run this
code somewhere isolated" into "tell me what it touched."

The hardware isolation itself — the guarantee that a malicious
`postinstall` script can't affect the machine running this CLI — is
Solari's own, stated at Solari's level, not this tool's.

## Why not something else

**Ephemeral CI runners** (a throwaway GitHub Actions job, a scratch
container) give you isolation but not observability — you get an exit
code and whatever the build script chose to print, not a structured
account of every filesystem write outside the repo or every
non-allowlisted host contacted.

**Supply-chain scanners** (static analysis over package manifests and
lockfiles) catch known-bad packages and suspicious patterns in source,
but never execute anything — they can't see what a `postinstall` script
actually does at runtime, only what it looks like it might do.

**OpenSSF-style package analysis** operates at the package-registry
level, profiling packages in the abstract. This tool operates at the
PR level, against the exact code in the exact PR someone is about to
merge, executed for real.

solari-scan sits in the gap: real execution, real isolation, and a
structured account of runtime behavior — for one specific PR, on
demand, without running untrusted code on your own machine.

## The proxy blind spot

The network capture only sees traffic that respects `HTTP_PROXY`/
`HTTPS_PROXY`. It does not see:

- Raw sockets opened directly, bypassing the proxy env vars entirely.
- Hardcoded transports (a library that ignores proxy env vars by
  design).
- Direct DNS resolution used as a side channel.

A destination that never appears in a report may still have been
contacted through one of these paths. This is a real limitation, not a
hedge — stated once, here.

## Setup

```
pnpm install
pnpm build
```

Requires a Solari API key. Add it to a `.env` file in the working
directory:

```
SOLARI_API_KEY=sk-...
```

`SOLARI_BASE_URL` is optional and defaults to Solari's own gateway.

## Usage

```
solari-scan https://github.com/<owner>/<repo> --pr <n>
```

Exit codes distinguish known failure modes (credit exhaustion, sandbox
concurrency limit, provisioning failure, clone failure, undetected
package manager) from a generic unexpected error and from a user
interrupt — never a raw stack trace for a known case.

## Future directions

- **Watch mode / CI integration.** Running this on every PR
  automatically, rather than on demand from the command line.
- **Behavioral baselining across runs.** Comparing a PR's observed
  behavior against the same repo's prior runs, rather than only against
  its own before/after snapshot.
- **Process-spawn tracing.** Whether tracing child processes spawned
  during install/build would surface behavior the filesystem/network
  capture alone misses — an open question, not a committed direction.
- **Closing the proxy blind spot.** Raw-socket and direct-DNS traffic
  currently goes unobserved; whether that's addressable without a much
  heavier capture mechanism (e.g. kernel-level tracing) is unresolved.
