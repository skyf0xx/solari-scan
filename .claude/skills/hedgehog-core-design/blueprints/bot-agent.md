# Bot / agent blueprint

A starting layer sequence for `hedgehog-core-design` Step 3 on the
bot/agent system shape. Adapt it for the project at hand — the
adaptation points below are expected, not exceptions — and record what
changed in `core-design.md`'s rationale.

```
pattern: hexagonal   # policy is testable without standing up the real delivery surface or a live model — see "Boundary that must hold"
contract  — the typed input/output shape of every capability, and the intent type policy decides over
tools     — each capability's implementation, independently callable and testable with no model in the loop
policy    — the decision logic: which tool a given input calls, knowing nothing about the delivery surface
transport — the platform integration (webhook, socket, polling loop) carrying input in and results back out
```

## Adaptation points

- Merge `transport` into `policy` when the agent runs as a single-process
  script with no external trigger surface (a CLI-invoked agent, a batch
  job) — there's no separate integration to isolate.
- Split `tools` per capability (`tools/{module}`) when the agent's
  capabilities hit independent external systems with their own auth and
  failure modes; keep one layer when they share a backend.
- Add a `memory` layer between `tools` and `policy`, depending on
  `contract`, when the agent persists state across runs (conversation
  history, a vector store) — keep it out of `policy` so the decision logic
  stays testable against a fake memory.

## Boundary that must hold

`policy` calls tools only through the types `contract` defines — never by
constructing a provider-specific call inline — and never imports
`transport`. This is what makes the decision logic testable without
standing up the real delivery surface or a live model: a policy layer
that reaches into a specific SDK can only be tested against that SDK, and
that is the layer whose behavior most needs cheap tests.
