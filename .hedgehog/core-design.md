# Core Design — solari-scan

Authored core. No shipped core fits: this is a CLI tool with no
persistent domain data of its own, no server-side logic, no marketing
page, not a DSH plugin.

## System shape

A CLI (Step 1) — `solari-scan <repo-url> --pr <n>`, one primary command,
no other surface.

## Stack

TypeScript + Node, Commander, Vitest, pnpm — the shape's table default
(`hedgehog-core-design`'s Step 2 table). No substitution: nothing in the
brief names a Python- or Go-first ecosystem, and Solari's own
cookbook/SDK examples are JS/TS-first, which reinforces rather than
overrides the default.

- **Composition** — explicit constructor/function-parameter passing. No
  DI container: the dependency graph is small and fixed (one command,
  two adapters, one report renderer), so a container buys nothing a
  CLI this size needs.
- **Error model** — typed errors (a small discriminated-union-style error
  type per failure class: credit exhaustion, concurrency limit, sandbox
  provisioning failure, install/build non-zero exit) crossing layer
  boundaries as return values or thrown typed errors caught once at the
  `command` layer, which is the only layer allowed to print a
  user-facing message or set a process exit code.
- **Config and secrets** — env vars only (`SOLARI_API_KEY` from `.env`
  via `dotenv`, read once at the `command` layer). No config file — the
  brief explicitly rules that out as v1 scope.
- **Entrypoint layout** — `src/index.ts` is the package's bin entry;
  `src/cli/` owns Commander wiring and dispatches into `domain`.

## Layer blueprint used

`blueprints/cli.md`, adapted:

- The blueprint's `io-adapter` layer is **split into two** —
  `sandbox-adapter` (the Solari SDK boundary: sandbox lifecycle, clone,
  exec, destroy) and `capture-adapter` (the filesystem-hash and
  network-proxy boundary) — rather than merged into `domain` or kept as
  one adapter. These are two independent external boundaries with
  different failure modes (Solari API errors vs. local fs/proxy errors)
  and different test doubles; keeping them separate keeps each layer's
  `verify` meaningful and its scope narrow. This is a split, not the
  blueprint's own listed adaptation point (which is about *merging*
  io-adapter into domain for filesystem-only tools) — recorded here as
  the actual adaptation made.
- No `config` layer added — the blueprint's config adaptation point is
  for a project-level config file, which is explicitly out of v1 scope
  (README future-work only, per the brief).
- `report` is promoted to its own layer, not folded into `command`. It's
  a pure function (Scan result → terminal output shape +
  `solari-scan-report.json` content) with its own meaningful test
  surface (clean-run collapse to one line, itemized findings, the
  "observed behavior, not a verdict" line, JSON shape) — worth verifying
  in isolation rather than only reachable through `command`'s own tests.

## Layers, in order

1. **domain** — the Scan orchestration: the seven-step mechanism
   (provision → clone → baseline snapshot → proxy start → install/build
   → post-run snapshot → classify → report → destroy) sequenced against
   port interfaces the adapters implement. No real filesystem, network,
   or Solari SDK calls — testable entirely against fakes. Owns the
   Scan/Finding/Report types.
2. **sandbox-adapter** — binds `domain`'s sandbox port to the real Solari
   SDK: create sandbox, clone repo/PR, run install/build with live
   stdout/stderr streaming, destroy on every exit path. Owns
   credit-exhaustion and concurrency-limit error detection and mapping
   to domain's typed errors.
3. **capture-adapter** — binds `domain`'s capture port to the real
   filesystem and network: recursive tree hashing for the before/after
   snapshot and diff, the local forwarding proxy server plus
   `HTTP_PROXY`/`HTTPS_PROXY` export, proxy log parsing, and
   classification against the hardcoded host allowlist (registries, git
   hosts, common CDNs — see `.hedgehog/BMAD/00-manifest.md`).
4. **report** — binds `domain`'s report port: renders a Scan's Findings
   to the terminal output shape (clean-run one-liner vs. itemized
   findings, the observed-behavior framing line) and to
   `solari-scan-report.json`. No I/O of its own — `command` performs the
   actual writes/prints using this layer's pure output.
5. **command** — the CLI entrypoint: Commander argument/flag parsing for
   `solari-scan <repo-url> --pr <n>`, env var loading, wiring `domain`
   to the two adapters and to `report`, and the top-level error handler
   that turns a typed error into the specific user-facing message the
   brief requires (never a raw stack trace) and a non-zero exit code.

## Module axis

**Linear chain**, not a module axis. This project has one primary
command and no repeating domain unit (no per-entity module the way
`full-stack-app`'s tables are) — it's built once, front to back. Mined
as a single intent; no `{module}` anywhere in `core.yaml`.

## Dependency chain, and why it's linear rather than a tree

`hedgehog-core-design`'s schema allows exactly one `depends_on` per
layer (no multi-parent). `command` genuinely needs all four prior layers
to exist (it wires all of them), so the chain is expressed as
`domain → sandbox-adapter → capture-adapter → report → command`, each
layer depending on the one immediately before it. `sandbox-adapter`,
`capture-adapter`, and `report` don't depend on each other's *content* —
each only depends on `domain`'s port interfaces — but the schema's
single-parent constraint means the build order is expressed as a chain,
which correctly serializes them (each is buildable once `domain`'s ports
exist) even though the ordering among the three middle layers itself is
arbitrary.

## Pattern

`hexagonal` — the same value `cli.md`'s blueprint declares, carried
forward unchanged. The boundary the blueprint names still holds under
the split-adapter adaptation: `domain` is never allowed to depend on
`sandbox-adapter`, `capture-adapter`, or `report` — it defines ports:,
they bind them — so `domain` stays testable without a real Solari
sandbox, filesystem, or network.

## Push/deploy (Step 4c)

Not applicable. Nothing in this project deploys, publishes, or acts on
a system outside the working tree — the Scan's whole effect is a
terminal report and a local JSON file. No layer needs a push-timing
answer.

## Reachability gate (Step 4d)

Not applicable. No arbitrator (ingress, router, gateway) sits in front
of anything this project publishes — it's a CLI with a single surface
(its own stdout), not a module axis with independently-scoped surfaces
that could disagree at a router. No reachability layer needed.

## Compressed intake note

`.hedgehog/BMAD/00-manifest.md` records a compressed intake: this
architecture is designed from `BRIEF.md` (already unusually thorough on
mechanism and scope) plus one batched round of questions (host allowlist
breadth, Solari signup status), not from a full elicited-drivers BMAD
shelf run. The layer sequence above rests on that brief's own "Committed
mechanism" section, which independently specifies most of what a full
PRD elicitation would otherwise have drawn out — the risk this note
exists to flag is narrower here than on a typical compressed-intake
project, but still real: nothing here was pressure-tested by BMAD's own
brainstorming or PR-FAQ skills.

## Left unresolved

- Exact recursive-hashing strategy for the filesystem snapshot (full
  content hash vs. mtime+size heuristic) is a `capture-adapter`
  implementation detail, not an architecture decision — left to that
  layer's own build step.
- Whether the Solari SDK's sandbox API exposes a way to run a process
  with a custom env (for `HTTP_PROXY`/`HTTPS_PROXY` injection) needs
  confirming against the real SDK during `sandbox-adapter`'s build — the
  brief's mechanism assumes this is possible but it hasn't been verified
  against the actual API surface yet.
