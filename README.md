# solari-scan

Clones a GitHub PR into an isolated Solari sandbox, runs install and
build, and reports whether it found anything suspicious — unexpected
network destinations, unexpected filesystem writes outside the repo.

```
solari-scan <repo-url> --pr <n>
```

No other flags, no config.

## What it does

1. Provisions a fresh Solari sandbox.
2. Clones the repo, checks out the PR.
3. Hashes the file tree as a baseline.
4. Starts a forwarding proxy, exports `HTTP_PROXY`/`HTTPS_PROXY` to log
   proxy-respecting traffic.
5. Detects the package manager, runs install.
6. Runs build, only if install succeeded. Never runs tests.
7. Hashes the file tree again, diffs against the baseline.
8. Classifies each destination against a hardcoded host allowlist
   (registries, git hosts, common CDNs).
9. Prints a report, writes `solari-scan-report.json`.
10. Destroys the sandbox on every exit path — failure, crash, or
    interrupt.

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

## Future directions

- **Watch mode / CI integration**: run on every PR automatically.
- **Closing spots**: raw-socket and direct-DNS traffic
- **Expand languages**: currently only runs Javascript/ Typescript
