# ADR-018 — Consolidate Interactive Surface on Bubble Tea TUI (Deprecate Ink Plan)

**Status:** Draft
**Date:** 2026-04-14
**Owner:** Doug
**Related:** ADR-015 (CLI Command Architecture), ADR-016 (CLI UI System — partially superseded), #31

## Context

Issue pattern-stack/codegen-patterns#31 proposes a dedicated Bubble Tea (Go) TUI that
pairs with the existing `codegen` CLI. The TUI is keyboard-first, embeds the
chat-patterns surface, and talks to the CLI by shelling out to `codegen <noun> <verb>
--json`. It is a standalone binary with its own build and distribution pipeline.

ADR-016 (CLI UI System) independently sketched a second interactive surface: an
`--interactive` / `-i` flag on the TypeScript CLI that dynamically imports
[Ink](https://github.com/vadimdemedes/ink) and swaps plain-text panes and spinners
for React components under `src/cli/ui/components/*.tsx` (e.g. `EntityGraph.tsx`,
`GenerationProgress.tsx`, `FileTree.tsx`). The rationale in ADR-016 was defensive:
keep interactive mode possible without forcing every command to care about it, and
lazy-load Ink so the default CLI pays no startup cost.

Both paths target the same user need — a live, explorable view of the generator's
state — but from opposite ends. The Bubble Tea TUI is a product; the Ink plan is a
render-swap inside a CLI. Shipping both creates a fork:

- Two themes to keep in sync (pastel tokens in `theme.ts` vs. lipgloss styles).
- Two progress abstractions (Ora/Ink vs. Bubble Tea `tea.Cmd`).
- Two homes for visualizations like the entity graph. When the TUI adds a feature,
  does the Ink version follow? If it doesn't, users learn two different tools with
  the same brand.
- Two dependency surfaces: `ink`, `ink-*`, and React in `package.json` on top of
  whatever the Go binary needs.

The Ink plan has not landed. No `src/cli/ui/components/` directory exists. No React
or Ink dependency has been added. This is the correct moment to pick one surface
before either commits code.

## Decision

Bubble Tea is the single interactive surface for codegen-patterns. The TypeScript
CLI remains plain-text output plus theme tokens plus `--json`, and nothing more.

Concretely:

1. **The Ink plan in ADR-016 does not land.** The `components/` directory, the
   dynamic Ink import, and the Ink dependencies listed in ADR-016's Dependency List
   are removed from the plan.
2. **The `--interactive` / `-i` flag is dropped.** See Implementation Notes for the
   alternative (repurpose as a TUI launcher) and why we prefer dropping it outright.
3. **The TUI (issue #31) is the home for every interactive feature.** Entity graph
   browsing, generation progress with live file tree, chat-patterns embed, and any
   future interactive flow live in the Go TUI and consume the CLI via
   `codegen <noun> <verb> --json`.
4. **The CLI's JSON contract becomes load-bearing.** Every noun and verb must
   produce meaningful JSON output when `--json` is set. This is already required by
   ADR-015/016; ADR-018 promotes it from "nice to have" to "the TUI depends on it."
5. **The plain-text UI primitives in `src/cli/ui/` stay.** `theme.ts`, `icons.ts`,
   `output.ts`, `spinner.ts`, `pane.ts`, `hints.ts`, and `json.ts` remain the CLI's
   rendering layer exactly as ADR-016 specifies. They are not affected by this
   decision.

The CLI is the data plane. The TUI is the interactive plane. They are separate
products with a single protocol (`--json`) between them.

## Consequences

### Positive

- **One interactive product, one theme, one keybinding grammar.** Users who want a
  live view get the TUI; users who want scripts get the CLI. No overlap.
- **No React, no Ink, no JSX toolchain in `package.json`.** The CLI stays small and
  boots fast. No lazy-import escape hatch to maintain.
- **`src/cli/ui/components/` never exists.** No `.tsx` files under `src/cli/`, no
  TSX compile step, no runtime mode switch inside pane/hints primitives (see the
  "pane/hints dispatch internally" line in ADR-016 — that dispatch disappears).
- **The `--json` contract gets a real consumer.** Dogfooding the TUI exercises
  every command's JSON output, which surfaces gaps the CLI's own tests wouldn't
  catch.
- **Chat-patterns can embed in the TUI naturally.** A keyboard-first Bubble Tea
  shell is the right host for a chat surface; an Ink CLI mode is not.

### Negative

- **Adds a Go toolchain.** Contributors who want to work on the TUI need Go
  installed. The main repo's Just targets (`just install`, `just test-unit`) remain
  Bun/Node-only, but a new `tui/` directory (or sibling repo) brings Go into the
  ecosystem.
- **Binary distribution is a new problem.** The CLI ships via npm (`bun install`);
  the TUI ships as a Go binary. That's GitHub Releases, Homebrew, or similar — a
  distribution channel codegen-patterns doesn't currently maintain. A future ADR
  will cover this; #31 flags it as out of scope for the initial spike.
- **Users on restricted machines may only have the CLI.** If someone can `npm i
  -g @pattern-stack/codegen` but can't install a Go binary, they get no
  interactive experience. Mitigated by the CLI remaining fully functional on its
  own — interactive mode has always been opt-in.
- **The Ink option is gone if we later want an in-process TUI.** Rehydrating Ink
  would mean reversing ADR-018. That's fine; the cost of the reversal is about the
  same as the cost of shipping it the first time, so we lose little by deferring.

### Neutral

- **Existing CLI UI primitives are untouched.** `src/cli/ui/theme.ts`,
  `src/cli/ui/icons.ts`, `src/cli/ui/pane.ts`, `src/cli/ui/hints.ts`,
  `src/cli/ui/output.ts`, `src/cli/ui/spinner.ts`, and `src/cli/ui/json.ts` stay
  exactly as they are. The pastel palette, the icon fallbacks, the border
  rendering, the Next-row — all preserved.
- **The `NounModule` interface (`src/cli/noun-module.ts`) is unchanged.** Summary
  panes and hints render the same way. The TUI consumes the same JSON payload that
  `buildNounSummaryCommand` emits in JSON mode, so there is no second rendering
  path to maintain.
- **Clipanion, Chalk, Ora, and `@clack/prompts` keep their current roles.**
  Clipanion parses args, Chalk colors output, Ora spins, `@clack/prompts` asks
  questions. None of this changes.

## Alternatives Considered

### 1. Ship both (accept the fork)

Keep the Ink plan from ADR-016 and build the Bubble Tea TUI in parallel. Rejected:
every interactive feature would have to be built twice or arbitrarily assigned to
one surface, and users would encounter two different visual grammars under the same
brand. The fork cost compounds — the entity graph alone would need a React
component and a Bubble Tea model, each with its own state machine.

### 2. Ink only (no TUI)

Drop #31 and commit to Ink as the only interactive surface. Rejected because the
#31 vision is broader than what Ink can host. It's a keyboard-first shell with
embedded chat-patterns, persistent layout, and cross-command navigation — that's a
product, not a render mode. Ink components inside a per-command flag can't provide
a persistent shell, and React-in-terminal is a worse fit than Bubble Tea for that
interaction style. Chat-patterns is already Bubble Tea; embedding it in Ink would
be a rewrite.

### 3. WASM hybrid (compile the Go TUI to WASM and run it inside the Node CLI)

Compile the Bubble Tea TUI to WebAssembly and load it from the Node CLI so there is
one distribution channel. Rejected as overkill: the toolchain (tinygo or similar,
plus a WASM runtime in Node, plus terminal IO bindings) is more complex than
shipping two binaries, and it buys us nothing the "two artifacts, one JSON
protocol" split doesn't already deliver.

### 4. Build the TUI as another TypeScript surface (Ink-based, but a separate
binary)

Keep everything in TypeScript by building the full keyboard-first shell in Ink as
a separate entrypoint. Rejected because the chat-patterns surface is already
Bubble Tea, and forcing a rewrite into Ink to preserve language uniformity is the
wrong tradeoff. The TUI is interactive-terminal software; Go + Bubble Tea is a
better fit than Node + Ink for that category.

## Implementation Notes

### Amendment to ADR-016

ADR-016's status changes from **Draft** to **Partially superseded by ADR-018**.
The following sections of ADR-016 are deprecated:

- The `components/` entry in the Module Layout.
- The "Interactive Mode" section (the `--interactive` / `-i` flag description).
- The Ink row (`ink` + `ink-*`) in the Dependency List.
- The line in the Panes & Hints section that says "In `--interactive` mode, they
  may be replaced by Ink components." Panes and hints render plain text always.

The rest of ADR-016 — theme tokens, icons, output helpers, spinners, JSON mode,
pane/hint primitives — stays in force. The CLI UI system is intact; only the Ink
extension is removed.

### Removals

- No `src/cli/ui/components/` directory is created.
- No `ink`, `ink-spinner`, `ink-text-input`, `react`, or `@types/react`
  dependencies are added to `package.json`.
- No `--interactive` / `-i` option is added to the root Cli instance or to any
  `NounModule` command.

### Fate of the `--interactive` flag

Two options were considered:

1. **Drop it entirely.** The flag never ships. Users who want interactivity run
   the TUI binary.
2. **Repurpose it as a TUI launcher.** `codegen --interactive` (or `codegen tui`)
   shells out to the Bubble Tea binary, passing through the current `--cwd` and
   `--config`.

**Recommendation: drop it.** Keeping the CLI minimal is the point. A launcher flag
is a trap — it couples CLI releases to TUI binary availability, adds a
PATH-discovery failure mode, and implies the CLI "knows about" the TUI when the
whole point of this ADR is that they are separate products connected only by
`--json`. If a launcher is ever wanted, `codegen tui` as a proper noun-verb
command (ADR-015 style) is cleaner than a flag — but that's a future decision, not
one ADR-018 needs to make.

### Binary distribution

Out of scope for this ADR. A future ADR will cover how the TUI binary is built,
signed, and distributed — likely a combination of GitHub Releases for direct
downloads and a Homebrew tap for macOS/Linux. #31 flags this as a follow-up.

### CLI obligations

The CLI's `--json` output is now a public contract consumed by a second product.
That means:

- Every noun's `summary()` and every verb's execute path must emit JSON when
  `--json` is set. This is already the rule in ADR-015/016; ADR-018 makes it
  non-negotiable.
- Breaking changes to the JSON shape require the same version discipline as any
  other public API. The TUI will pin to a known CLI version range.
- New commands should be designed with the TUI in mind: what does the TUI need to
  render this in a live pane? The JSON shape is part of the command's design, not
  an afterthought.

## References

- Issue pattern-stack/codegen-patterns#31 — Bubble Tea TUI proposal
- ADR-015 — CLI Command Architecture (noun-verb; the contract the TUI consumes)
- ADR-016 — CLI UI System (partially superseded; theme/icons/output/spinner/pane/
  hints survive, Ink plan does not)
- `src/cli/ui/theme.ts`, `src/cli/ui/pane.ts`, `src/cli/ui/hints.ts` — the
  plain-text primitives that remain
- `src/cli/noun-module.ts` — the JSON emission path the TUI calls into
