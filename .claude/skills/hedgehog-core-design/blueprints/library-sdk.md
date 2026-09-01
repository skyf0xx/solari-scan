# Library / SDK blueprint

A starting layer sequence for `hedgehog-core-design` Step 3 on the
library/SDK system shape. Adapt it for the project at hand — the
adaptation points below are expected, not exceptions — and record what
changed in `core-design.md`'s rationale.

```
pattern: layered   # the boundary is import-path/encapsulation discipline, not a domain kept pure of infrastructure — see "Boundary that must hold"
core     — the implementation, importable and testable with no knowledge of how it's packaged
public   — the exported surface: what `index.ts` re-exports, typed and versioned independently of internals
examples — runnable usage samples that exercise the public surface only, doubling as integration tests
```

## Adaptation points

- Drop `examples` as its own layer when the consuming ecosystem's
  convention folds them into the test suite (pytest doctests, Rust
  `examples/` compiled by `cargo test`) — fold its verify command into
  `public`'s instead.
- Split `core` into per-domain sub-layers (`core/{module}`) only when the
  library has genuinely independent domains a consumer might import
  separately (a multi-package SDK) — a single-purpose library keeps one
  `core` layer.

## Boundary that must hold

`public` re-exports from `core`; nothing outside `public` is a supported
import path. A consumer reaching into `core` directly is the signal this
boundary was drawn in the wrong place, not a usage error to document
around — the layer sequence exists so `core` can change shape without
breaking every consumer, and an internal import defeats that.
