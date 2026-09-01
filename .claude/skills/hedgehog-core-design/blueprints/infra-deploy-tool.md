# Infra / deploy tool blueprint

A starting layer sequence for `hedgehog-core-design` Step 3 on the
infra/deploy tool system shape. Adapt it for the project at hand — the
adaptation points below are expected, not exceptions — and record what
changed in `core-design.md`'s rationale.

```
pattern: hexagonal   # plan is printable and diffable on its own, with no credentials required — see "Boundary that must hold"
model    — the typed desired-state the tool works against, parsed and validated from config
provider — the typed operations against each target system (cloud api, kubernetes, ssh), one per target
plan     — diffing desired state against observed state into an ordered list of changes, pure and printable
apply    — executing a plan through providers, with the failure/rollback behavior the tool promises
cli      — argv, output rendering, and the confirmation gate in front of apply
```

## Adaptation points

- On the TypeScript substitute (a thin wrapper generating config/manifests
  with no systems-level need), `provider` isn't a live target system —
  there's no observed state to read, so `plan` and `apply` collapse into
  one `render` layer producing the config/manifest text, and `provider`
  drops entirely. The dry-run safety property below doesn't apply: the
  tool's output *is* the printable, diffable artifact, so there's nothing
  further to preview.
- Merge `plan` into `apply` only for a Go-stack tool that is genuinely
  fire-and-forget (a one-shot bootstrap script) — and note that this gives
  up the dry-run surface, which is the main reason to reach for this shape.
- Split `provider` per target (`provider/{module}`) when the tool spans
  several systems with independent auth and failure modes; keep one layer
  for a single target.
- Drop `model` as its own layer when desired state comes entirely from
  flags rather than a config file.

## Boundary that must hold

`plan` computes changes without performing any, and `apply` performs only
what a plan named. A tool that mutates during planning can't offer a
trustworthy dry run, and dry run is the safety property this shape exists
to provide — an infra tool without it is a script that edits production
with no preview. `plan` must be printable and diffable on its own, with
no credentials required beyond reading observed state. This boundary is
moot on the TS/`render`-collapsed substitute above, where there's no live
target to mutate in the first place.
