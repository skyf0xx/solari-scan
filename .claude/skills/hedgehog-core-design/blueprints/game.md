# Game blueprint

A starting layer sequence for `hedgehog-core-design` Step 3 on the game
system shape. Adapt it for the project at hand — the adaptation points
below are expected, not exceptions — and record what changed in
`core-design.md`'s rationale.

```
pattern: hexagonal   # state is deterministic and tickable through scripted intents with no window open — see "Boundary that must hold"
state   — the world model and the rules that mutate it: pure, deterministic, no rendering or input
systems — the per-tick logic (movement, collision, ai, scoring) operating on state
input   — device events to intents, so state never reads a keyboard or gamepad directly
render  — drawing current state to the canvas/scene graph, reading state and never writing it
loop    — the tick/frame driver wiring input, systems, and render together
```

## Adaptation points

- Merge `systems` into `state` for a game whose rules are small enough to
  live with the model (a puzzle game, a turn-based prototype).
- Add an `assets` layer before `render`, depending on nothing, when the
  game has a real content pipeline (sprite atlases, audio banks, level
  data) rather than a handful of inline files.
- On an engine that owns the frame loop, `loop` disappears into the
  engine — keep the other four, mapped onto the engine's own lifecycle
  hooks, and scope them to the engine's text sources (scripts), since
  scenes and prefabs are binary and can't be gated.

## Boundary that must hold

`render` reads `state` and never writes it, and `state` never reads input
devices or draws. A deterministic state layer is what makes a game
testable at all — you can tick it through a scripted sequence of intents
and assert the outcome with no window open. It's also what makes replays,
save files, and any future networking possible; a game whose rules mutate
during rendering can never get those without a rewrite.
