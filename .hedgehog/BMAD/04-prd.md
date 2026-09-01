# PRD — solari-scan

Compressed intake. Only §3 Glossary and §4 Features are written, per
compressed-intake procedure — the minimum shape Phase 1 mining reads.

## §3 Glossary

- **Scan** — one invocation of `solari-scan <repo-url> --pr <n>`: clone,
  execute install+build in an isolated sandbox, report. Has-many
  Findings; has-one Report.
- **Sandbox** — an ephemeral Solari code sandbox (microVM), created fresh
  per Scan, destroyed at the end of it. One Scan uses exactly one
  Sandbox.
- **Filesystem Snapshot** — a hash of the sandbox's file tree, taken
  before and after install+build. A Scan has exactly two (baseline,
  post-run); their diff produces zero or more filesystem Findings.
- **Proxy Log** — the record of outbound connection attempts captured by
  the in-sandbox forwarding proxy during install+build. A Scan has one;
  it produces zero or more network Findings.
- **Host Allowlist** — the small, hardcoded, conservative list of
  expected network destinations (package registries, git hosts, common
  CDNs — see manifest) that Proxy Log entries are classified against.
  Project-wide, not per-Scan.
- **Finding** — one reported fact: an unexpected outbound destination, or
  a filesystem write outside the repo directory. Belongs to exactly one
  Scan. Carries no verdict (no safe/unsafe label) — only what was
  observed.
- **Report** — the terminal output plus the secondary
  `solari-scan-report.json` artifact for one Scan. Belongs to exactly one
  Scan; has-many Findings (zero for a clean run).

## §4 Features

### Feature: Sandbox provisioning and cleanup

Clone the target repo/PR into a fresh Solari sandbox, and guarantee the
sandbox is destroyed when the Scan ends (success, failure, or error) so
no sandbox leaks past one Scan's lifetime — this is the property the
free tier's 1-concurrent-sandbox limit depends on.

**Consequences (testable):**
- Given a valid repo URL and PR number, a sandbox is created and the
  target PR's code is cloned into it before any install/build command
  runs.
- Given any exit path (clean finish, install/build failure, uncaught
  error, user interrupt), the sandbox is destroyed exactly once before
  the process exits.
- Given exhausted credits or the concurrent-sandbox limit already in use,
  the CLI prints a clear, actionable error naming the constraint — never
  a raw stack trace.

**Rules:**
- Code is not executed during clone — narrated explicitly as a distinct,
  earlier step than install/build.

### Feature: Filesystem behavior capture

Hash the sandbox's file tree before install+build and again after,
diffing for writes that land outside the repo directory.

**Consequences (testable):**
- Given a baseline and post-run snapshot, any file created, modified, or
  deleted outside the repo directory appears as a Finding with its path.
- Given no writes outside the repo directory, this Feature contributes
  zero Findings (not a printed "no writes" line per file — collapses
  into the clean-run summary).
- Narration during the Scan states the actual number of files
  hashed/diffed at each snapshot, not a generic "scanning files..."
  message.

### Feature: Network behavior capture

Run a local forwarding proxy inside the sandbox for the duration of
install+build, with `HTTP_PROXY`/`HTTPS_PROXY` exported so proxy-respecting
traffic routes through and is logged, then classify each logged
destination against the Host Allowlist.

**Consequences (testable):**
- Given any outbound connection attempt during install+build that
  respects the proxy env vars, its destination is logged.
- Given a logged destination not on the Host Allowlist, it appears as a
  Finding naming the host.
- Given only allowlisted destinations were contacted, this Feature
  contributes zero Findings.
- Narration states the actual proxy port in use and the actual
  connection count observed, not placeholder text.

**Rules:**
- Raw sockets, hardcoded transports, and direct DNS are not captured —
  this limit is stated once in the README, not hidden or hedged.

### Feature: Install and build execution

Run the target's install step (`npm install` / `pip install` /
equivalent, detected from repo contents) and its build step only — never
the test suite.

**Consequences (testable):**
- Given a repo with a detectable package manager, the correct
  install command runs before any build command.
- Given install or build exits non-zero, the Scan still completes its
  filesystem/network capture and reports what was observed, rather than
  aborting the Report.
- The test suite is never invoked by any code path.
- stdout/stderr from install and build stream to the terminal live, as
  they're produced — not buffered and dumped at the end.

### Feature: Report rendering

Render the Scan's Findings to the terminal and to
`solari-scan-report.json`.

**Consequences (testable):**
- Given zero Findings, the terminal output collapses to one line: "No
  unexpected behavior observed during install/build."
- Given one or more Findings, each is printed individually with enough
  detail to act on (host or path, and which capture Feature produced
  it) — itemized output only appears when there's something to itemize.
- Given any Scan (clean or not), one line near the Findings states the
  framing once: observed behavior, not a verdict. Never the words "safe"
  or "unsafe" appear anywhere in output.
- Given any Scan (clean or not), `solari-scan-report.json` is written
  with structured Scan/Finding data, whether or not any Findings exist.
- No artificial delays, spinners, or progress theater — step timing
  reflects real elapsed time.

**Rules:**
- CLI is the entire product surface. No web dashboard, no server
  process, no flags beyond `--pr <n>` required for the primary path.
