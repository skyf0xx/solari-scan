# Working in this repo

This project is built with **Hedgehog**, a one-step-at-a-time build
discipline. The rules below aren't preferences — they're how the build
stays mechanically correct.

**State lives in the build graph (`.hedgehog/hedgehog.db`), the commit
log, and the code.** A fresh session loses nothing: run `hedgehog status`
and read the commit log to recover.

## Start here

```bash
hedgehog status    # what's built, what's ready, what's blocked
hedgehog next      # the task packet for one ready step
```

Agent files live in `.claude/agents`, and skills in
`.claude/skills`. The tables below name each file relative to
those directories.

If this project's instructions file still has unfilled `{{PLACEHOLDER}}`
text, nothing has been built yet — read `planner.md` and run planning
intake first.

## The loop

1. `hedgehog next` emits one task packet — STATUS, INTENT (the goal and
   outcome of the whole intent, not just this layer), RELEVANT RULES,
   INHERITED DEBT, WHY NOW, BLOCKED DOWNSTREAM, ALLOWED SCOPE,
   VERIFICATION. `hedgehog claim` emits the same packet and reserves the
   task with a lease. Trust it: a task is never
   emitted unless every dependency is `complete`.
2. Delegate the **full packet** to the agent that owns that layer (see
   the table below). Don't summarize it, and don't pass just a step name.
3. When the work is done, run `hedgehog verify <task-id>`. It checks the
   touched files against ALLOWED SCOPE, runs the verification command,
   and on a pass writes the commit and unlocks what the task blocked.

**An agent reporting success never moves a task — only a passing
`hedgehog verify` does.** This is the enforcement, and it holds no
matter which coding agent you are or what tools you were granted.

## Delegating

If your harness dispatches subagents, read the agent's file and pass its
**entire body** as that subagent's prompt, followed by the task packet.
The file is the role — don't summarize it.

If your harness has no subagent mechanism, read the agent's file and
follow it yourself in this thread, then clear the conversation at the
next unit boundary (a module's Phase A, a landing page section) and
recover with `hedgehog status`.

Either way, honor the "May" column below. Where a harness can't enforce a
tool grant, the constraint is yours to keep — and `hedgehog verify` still
gates the commit on ALLOWED SCOPE.

## Agents

| Agent | Use when | May | File |
| --- | --- | --- | --- |
| `bootstrap` | Use once per invocation, at the start of a new Hedgehog project, to land the workspace for whichever core `planner` selected at Phase 0 — the first real workspace this project gets, since `init` with no explicit core flag lands the shared agents/skills/build-graph payload and leaves the workspace to bootstrap. | Read, write, and edit files, and run shell commands. | `bootstrap.md` |
| `planner` | Use for planning intake (core selection, then scope boundary + domain vocabulary or Chain Method brief, depending on core) at the start of a project, and for re-entry when new scope enters play on a project already built or mid-build — including after a build has reached its Stop Condition, where it is the exit `tweaker` routes new scope to. | Read, write, and edit files, and run shell commands. | `planner.md` |
| `reviewer` | Use at a phase or layer transition the core's own loop skill defines, or when the Correction Protocol is invoked. | Read files and run shell commands. Do not write or edit any file — report findings as text. | `reviewer.md` |
| `tweaker` | Use when a change request lands on a project that already has a build graph and nothing in flight (`hedgehog status --brief` names no task) — a finished build being adjusted, or an adopted repo's next piece of work — and the user is offered a fresh-context session to iterate. | Read, write, and edit files, and run shell commands. | `tweaker.md` |

## Skills

Procedures to follow, not to improvise around. Read the file when its
situation applies.

| Skill | Use when | File |
| --- | --- | --- |
| `conventional-commits` | Use when uncommitted changes need to be split into atomic, conventional commits ordered for review. | `conventional-commits/SKILL.md` |
| `filing-issues` | Use when filing one or more GitHub issues for planned work — "file an issue for this", "turn this plan into issues", "open a tracking issue". | `filing-issues/SKILL.md` |
| `hedgehog-contributing` | Use when the user wants to contribute a fix or ROADMAP.md item back to the Hedgehog project itself (skyf0xx/hedgehog) rather than their own project. | `hedgehog-contributing/SKILL.md` |
| `hedgehog-daily` | Use when a change request lands on a project that already has `.hedgehog/` and no build in flight — a finished build being adjusted, or an adopted repo's next piece of work. | `hedgehog-daily/SKILL.md` |
| `hedgehog-planning-intake` | Use on any core for first-run planning intake — Phase 0 runs the vendored BMAD-METHOD planning shelf, shared by every core, and Phase 1 (mining `04-prd.md` into intent records plus the Add-ons/sync-and-remote-entities decision) is full-stack-app's and pwa-app's shared procedure — identical mechanics, a different decision at step 5/8. | `hedgehog-planning-intake/SKILL.md` |
| `no-history-in-output` | Apply whenever writing or updating a project-facing document — root CLAUDE.md, `.hedgehog/core-design.md`, specs, READMEs, or similar. | `no-history-in-output/SKILL.md` |
| `pr-writing` | Use whenever writing a PR title/description, a commit message body, a code review comment, or an issue — in Hedgehog's own repo or any consuming project. | `pr-writing/SKILL.md` |

## CLI reference

| Command | Does |
| --- | --- |
| `hedgehog status` | Every task, its state, and what it blocks |
| `hedgehog next` | The task packet for one ready task |
| `hedgehog verify <task-id>` | Gate a task: scope check, verification command, commit |
| `hedgehog why <path>` | Which task and layer a file belongs to |
| `hedgehog plan` | Compile intents into the task graph |
| `hedgehog intent add` | Record an intent at planning intake |
| `hedgehog friction add "<note>"` | Log build friction for later review |
| `hedgehog friction list` | Read the friction log |
| `hedgehog graph` | Live read-only diagram of the build graph |
