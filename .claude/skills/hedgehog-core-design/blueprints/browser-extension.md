# Browser extension blueprint

A starting layer sequence for `hedgehog-core-design` Step 3 on the
browser extension system shape. Adapt it for the project at hand — the
adaptation points below are expected, not exceptions — and record what
changed in `core-design.md`'s rationale.

```
pattern: hexagonal   # background/content/popup each depend on messaging independently, not on each other — see "Boundary that must hold"
messaging  — the typed message contract between background/content-script/popup
background — the service-worker-side logic (state, alarms, cross-tab coordination)
content    — page-context logic (DOM reads/writes, page-side event listeners)
popup      — the extension UI, consumes background/content only through messaging
```

## Adaptation points

- Drop `popup` entirely for an extension with no browser action UI.
- Merge `content` into `background` when the extension never injects into
  page context (a pure background-worker extension).
- On a module axis, `background` is often shared rather than
  one-per-module (a single service worker coordinating state across every
  module's tabs) — the cross-cutting infrastructure Step 4 asks about.
  Give it its own fixed-scope layer there.

## Boundary that must hold

`popup` never imports from `background` or `content` directly — every
cross-context call goes through `messaging`, because a WebExtension's
contexts are separate JS runtimes and a direct import silently fails at
runtime rather than at build time.

## WXT entrypoint naming (must decide up front, not discover mid-build)

WXT derives an entrypoint's manifest name by splitting its `entrypoints/`
folder or file name at the **first** `.`. Two entrypoints that derive the
same name collide — observed failure modes include a build-time error
("Multiple entrypoints with the same name detected") and, in at least one
case, a colliding entrypoint silently missing from the built manifest
(`.output/*/manifest.json`) with no error at all. Don't assume which one
fires for a given WXT version or collision shape; treat any collision as
unsafe rather than relying on the build to always catch it.

Decide the naming convention in this step, per module, before any layer
is built against it — not after the first collision is hit:

- **Every entrypoint with more than one surface lives in its own folder**,
  `entrypoints/{module}/index.ts`, never a flat `entrypoints/{module}.ts`
  — a folder has no `.`-split ambiguity to collide on.
- **Colocated tests go inside that same folder** as a sibling
  (`entrypoints/{module}/index.test.ts`), never as a flat
  `entrypoints/{module}.test.ts` next to a flat entrypoint file — that's
  the same name-collision shape described above.
- **A module with two entrypoint surfaces** (e.g. popup and content) gets
  two folder names that don't share a prefix before the first `.` —
  `entrypoints/{module}-popup/` and `entrypoints/{module}-content/`, never
  a dotted variant like `entrypoints/{module}.content/`.

Add a cheap, generic guard to the entrypoint layer's `verify` command
regardless of the convention chosen: after `pnpm wxt build`, check the
built manifest's entrypoint count against the expected count (e.g. `node
-e "..."` reading `.output/*/manifest.json`) so a silent drop fails
`verify` instead of surfacing later as a missing feature.
