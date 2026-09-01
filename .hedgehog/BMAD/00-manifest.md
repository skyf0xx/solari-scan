# Planning Intake Manifest

Source: vendored BMAD-METHOD (`bmad-code-org/BMAD-METHOD`, MIT-licensed),
pinned commit per `vendor-skills/BMAD/ATTRIBUTION.md`.

- **Mode:** compressed
- **Date:** 2026-09-01
- **Core:** authored (CLI tool, no shipped core's shape fits)

## What ran

Compressed intake: no live BMAD shelf skills ran. The user supplied a
fully-formed brief (`BRIEF.md`, in project root at intake time) that
already covers idea, mechanism, competitive framing, UX, scope
discipline, and future-work direction. Two gaps remained, closed by one
batched round of questions (see below). `04-prd.md` (§3 Glossary, §4
Features) and `05-ux-spec/EXPERIENCE.md` were derived directly from the
brief plus those answers.

Not written, per compressed-intake procedure: `01-brainstorming.md`,
`02-brief.md`, `03-prfaq.md`, `06-research.md`, `05-ux-spec/DESIGN.md`
(no visual identity to state — this is a CLI with no GUI surface).

## Batched round — questions and answers

1. **Expected-host classification list** (flagged open in BRIEF.md).
   Answer: broader default — npm/yarn/pnpm registries
   (registry.npmjs.org, registry.yarnpkg.com), PyPI
   (pypi.org, files.pythonhosted.org), git hosts (github.com,
   raw.githubusercontent.com, codeload.github.com, gitlab.com,
   bitbucket.org), and common CDNs sometimes hit by postinstall scripts
   (cdn.jsdelivr.net, unpkg.com).

2. **Solari signup/first-provision path** (flagged open in BRIEF.md).
   Answer: already resolved — user has a Solari API key in a local
   `.env` file (gitignored). No end-to-end signup walkthrough needed as
   a build task; integration work proceeds directly against the real
   SDK/API.

## Authored-core note

`hedgehog-core-design` reads this archive to pick a stack and derive
layers. This is a compressed PRD, thinner input than a full shelf run —
the architecture is designed from the brief plus the two answers above,
not from live-elicited drivers. Flagged at that skill's own Confirm &
Lock per compressed-intake procedure.
