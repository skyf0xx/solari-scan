# Experience Spec — solari-scan

Compressed intake. Only flows/behaviour the brief actually states are
recorded here — no DESIGN.md, since a CLI has no visual identity to spec.

## Primary flow: `solari-scan <repo-url> --pr <n>`

One command, no config file, no required flags beyond `--pr`. This is
the entire demo surface — narration quality carries the "we actually ran
this" credibility claim, so every line below is real signal, not
decoration.

1. **Provisioning.** Narrate: sandbox creation starting, then confirmation
   once it exists. State plainly that code has not been executed yet at
   this point — clone is a distinct, earlier step than execution.
2. **Clone.** Stream confirmation that the target repo/PR is cloned into
   the sandbox.
3. **Baseline snapshot.** Narrate the actual file count hashed.
4. **Proxy start.** Narrate the actual port the forwarding proxy is
   listening on.
5. **Install.** Stream real stdout/stderr from the install command live,
   as produced — not buffered.
6. **Build.** Same live-streaming treatment.
7. **Post-run snapshot.** Narrate the actual file count re-hashed and
   diffed.
8. **Proxy log parse.** Narrate the actual number of distinct connections
   observed.
9. **Report.**
   - Clean run: collapses to one line — "No unexpected behavior observed
     during install/build."
   - Findings present: each printed individually (host or path, which
     capture step produced it).
   - Either way: one line near the findings stating the framing once —
     "Observed behavior, not a verdict."
   - `solari-scan-report.json` written as a secondary artifact (not
     narrated with the same weight as terminal output).
10. **Teardown.** Sandbox destroyed; narrate that it happened.

## Timing and pacing rules

- No artificial delays, no spinners standing in for unknown progress.
  Real step timing only — if sandbox boot is genuinely ~0.4s, the
  narration reflects that speed, not a padded-out sequence.
- Specificity is the point: actual counts, actual ports, actual
  destinations — never generic "scanning..." or "checking..." text with
  no real number behind it.

## Error paths (must not be stack traces)

- Credit exhaustion.
- Concurrent-sandbox limit already in use.
- Install or build exits non-zero — Scan still completes capture and
  reports what was observed rather than aborting.

Each of these needs a clear, specific, actionable message — this is the
most likely way a cold run from a stranger (a judge cloning the repo)
breaks, per the brief's own constraint.

## Explicitly not in scope for this spec

- Any web/dashboard surface — none exists.
- Config files, custom host allowlists as a runtime flag — README future
  work only, not v1 UX.
