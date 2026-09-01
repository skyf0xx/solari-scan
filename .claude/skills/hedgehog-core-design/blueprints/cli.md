# CLI blueprint

A starting layer sequence for `hedgehog-core-design` Step 3 on the CLI
system shape. Adapt it for the project at hand — the adaptation points
below are expected, not exceptions — and record what changed in
`core-design.md`'s rationale.

```
pattern: hexagonal   # domain is testable without a real filesystem or network — see "Boundary that must hold"
command    — argument/flag parsing and dispatch only, one file per subcommand
domain     — the logic the command triggers, no knowledge of argv or stdout
io-adapter — anything crossing a real boundary: filesystem, network, a wrapped subprocess
```

## Adaptation points

- Merge `io-adapter` into `domain` when the tool touches only the local
  filesystem through the language's standard library — no separate
  adapter earns its place.
- Add a `config` layer before `command` when the tool reads a
  project-level config file in addition to flags.

## Boundary that must hold

Never let `command` reach past `domain` into `io-adapter` directly — that
collapses the one boundary that makes `domain` testable without a real
filesystem or network.
