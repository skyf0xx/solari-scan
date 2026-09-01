# solari-scan

Clones a GitHub repo or PR into an isolated Solari sandbox, runs install
and build, and reports whether it found anything suspicious — unexpected
network destinations, unexpected filesystem writes outside the repo.

```
solari-scan <url> [--with-fs]
```

`<url>` is either a plain repo link (`https://github.com/owner/repo`,
scanning the default branch) or a PR link
(`https://github.com/owner/repo/pull/<n>`, scanning that PR). No config.

## Scan depth

solari-scan runs at one of two depths, the same way a disk check or an
antivirus scan offers a quick pass versus a thorough one:

- **Default (fast)** — network check only. Watches the install/build's
  outbound traffic through a forwarding proxy and classifies each
  destination against a hardcoded host allowlist. No filesystem hashing,
  so a scan finishes in roughly the time the install/build itself takes.
- **`--with-fs` (deep)** — adds the filesystem check on top: hashes the
  sandbox's file tree before and after install/build and reports any
  file created, modified, or deleted outside the repo directory. This is
  more thorough but slower — recursively hashing a sandbox's file tree
  means many round trips to the sandbox, which can add real time on a
  large install (e.g. a big `node_modules`). Use it when you specifically
  want filesystem-write visibility and can afford the extra time; skip it
  for a quick pass.

This is the first of what may become multiple scan-depth levels —
more mechanisms can slot in behind their own opt-in flag the same way,
without changing the default fast path.

## What it does

1. Provisions a fresh Solari sandbox.
2. Clones the repo, checks out the PR if the URL named one.
3. With `--with-fs`: hashes the file tree as a baseline.
4. Starts a forwarding proxy, exports `HTTP_PROXY`/`HTTPS_PROXY` to log
   proxy-respecting traffic.
5. Detects the package manager, runs install.
6. Runs build, only if install succeeded. Never runs tests.
7. With `--with-fs`: hashes the file tree again, diffs against the
   baseline.
8. Classifies each destination against a hardcoded host allowlist
   (registries, git hosts, common CDNs) — see [Host allowlist](#host-allowlist).
9. Prints a report, writes `solari-scan-report.json`.
10. Destroys the sandbox on every exit path — failure, crash, or
    interrupt.

Without `--with-fs`, steps 3 and 7 are skipped entirely and nothing in
the report mentions them — the output looks exactly as if the filesystem
check didn't exist.

Install/build output streams live. A failed install or build doesn't
abort the scan — capture and reporting still complete.

Clean run:

```
No malware found.
```

Findings print the verdict, then each one — host or path, which step
caught it:

```
Suspicious activity found.
```

## Host allowlist

Any outbound destination not on this list is reported as a network
finding:

- **Package registries**: `registry.npmjs.org`, `registry.yarnpkg.com`
- **Git hosts**: `github.com`, `raw.githubusercontent.com`,
  `codeload.github.com`, `gitlab.com`, `bitbucket.org`
- **CDNs** (sometimes hit by postinstall scripts): `cdn.jsdelivr.net`,
  `unpkg.com`

Matching is exact, host by host — a subdomain isn't automatically
allowed by its parent domain being listed (e.g.
`objects.githubusercontent.com` is not covered by `github.com`). The
list is project-wide, not configurable per scan.

## Future directions

- **Watch mode / CI integration**: run on every PR automatically.
- **Expand languages**: currently only runs Javascript/ Typescript

### Future scan-depth levels

`--with-fs` is the first opt-in check beyond the default network scan;
the same pattern (off by default, named flag, silent when skipped) leaves
room for more, each trading scan time for a different kind of visibility:

- **Process/syscall watch** — flag suspicious child processes spawned
  during install/build (e.g. `curl`, `nc`, a shell invoked with an
  encoded payload), not just what they printed.
- **Secrets/credential-exposure check** — scan files the filesystem check
  already finds created or modified for patterns that look like read or
  exfiltrated credentials (`.npmrc` tokens, `~/.aws/credentials`), rather
  than only reporting that the file changed.
- **Dependency-manifest diffing** — compare `package.json`/the lockfile
  before and after install, to catch a postinstall script that rewrites
  its own manifest or silently adds an undeclared dependency.
- **Raw-socket / direct-DNS visibility** — the current network check only
  sees traffic that respects `HTTP_PROXY`/`HTTPS_PROXY`; a deeper level
  could also watch DNS queries and direct socket connections that bypass
  the proxy entirely.
- **Request-method-aware classification** — today a destination is
  classified by host alone; a plain-HTTP GET to an allowlisted registry
  and a POST shipping data to the same host look identical. Only
  reachable for plain HTTP traffic, though: HTTPS is CONNECT-tunneled, so
  the proxy sees opaque encrypted bytes once the tunnel opens and can't
  read the method or path without terminating TLS itself (an on-the-fly
  MITM certificate per host) — a much larger change than the check
  itself. Also needs a real rule, not just "GET is safe, everything else
  isn't": legitimate installs do issue POST/PUT against some registries.
- **Resource/behavior anomaly check** — flag an install that spawns an
  unusual number of processes or runs far longer than expected, a coarse
  signal for something like a cryptominer dropped by a malicious
  postinstall.
