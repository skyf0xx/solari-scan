# Compiler / language tool blueprint

A starting layer sequence for `hedgehog-core-design` Step 3 on the
compiler/language tool system shape. Adapt it for the project at hand —
the adaptation points below are expected, not exceptions — and record
what changed in `core-design.md`'s rationale.

```
pattern: layered   # a straight transformation pipeline (text to tokens to ast to diagnostics/output) - no layer is singled out as pure and isolated against the rest, unlike the other blueprints' domain layers
ast       — the node types, spans, and the diagnostic type every later layer reports through
lexer     — source text to tokens
parser    — tokens to ast, recovering from errors rather than aborting on the first one
analysis  — name resolution, type checking, lints: ast in, diagnostics out
emit      — the output artifact: generated code, a formatted document, a transformed ast
```

## Adaptation points

- Merge `lexer` into `parser` when the grammar is simple enough that the
  tokenizer is a handful of functions (a config language, a template
  syntax) — a separate layer buys nothing.
- Drop `emit` for a pure analysis tool (a linter, a type checker) whose
  output is diagnostics rather than an artifact.
- Drop `analysis` for a pure syntactic tool (a formatter, a
  syntax-highlighter grammar) that never resolves names or types.
- Add a `driver` layer after `emit` when the tool has a real CLI or
  watch-mode surface — it owns argv, file discovery, and diagnostic
  rendering, keeping the pipeline layers free of both.

## Boundary that must hold

`ast` comes first and everything depends on it, because the node types
and the span/diagnostic representation are the contract every other layer
speaks. Layers report errors as diagnostics carrying spans — never by
printing, and never by aborting on the first failure. A tool that stops
at the first error can't be used in an editor, and retrofitting error
recovery after `parser` is written is a rewrite of `parser`.
