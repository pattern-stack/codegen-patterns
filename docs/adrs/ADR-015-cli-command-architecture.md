# ADR-015 — CLI Command Architecture: Noun-Verb with Summary Panes

**Status:** Draft
**Date:** 2026-04-13
**Owner:** Doug
**Related:** ADR-008 (Subsystem Architecture)

## Context

The current CLI (`src/cli.ts`) is a ~25K single-file implementation using `node:util.parseArgs`. Nine commands — entity generation, subsystem scaffolding, project scanning, validation, analysis, statistics, documentation, manifest management, transitive suggestions — all live in one switch statement. The file mixes argument parsing, input validation, business logic delegation, and output formatting.

This does not scale as the CLI grows:

1. Commands are discoverable only by reading the file or running `--help`. There is no self-documentation.
2. New commands or sub-commands cannot be added without editing the root handler.
3. Shared concerns (config loading, output formatting, spinner state) are inlined and inconsistent.
4. Options are parsed as strings and re-validated in each handler.
5. The mental model for users is flat — `codegen entity`, `codegen manifest`, `codegen analyze` — which flattens unrelated concerns onto the same surface.

The `pattern-stack` Python CLI (`pts`) provides a reference implementation of what works at this scale. It uses Typer for per-domain routing (one file per domain with its own Typer app), semantic output helpers, and a thin entrypoint that registers each domain. The architecture has proven sustainable across 15+ commands.

This ADR proposes a parallel TypeScript structure built on Clipanion, with an additional pattern we're introducing: **noun-verb commands with summary panes and dynamic hints**.

## Decision

### The Pattern: Noun-Verb with Summary Panes

Every command takes the form:

```
codegen {noun}                 → summary pane + dynamic hint row
codegen {noun} {verb} [args]   → action
```

Top-level shortcuts are permitted for high-traffic actions (e.g. `codegen init` as an alias for `codegen project init`), but the noun-verb form is canonical. When a shortcut exists, the domain form still works — shortcuts never replace domains.

Running `codegen` with no arguments behaves like `codegen status` (or equivalent): a root summary if the project is initialized, or an intro/onboarding pane if not.

### Every Noun Is a Module

Each noun exports a module conforming to a `NounModule` shape:

```typescript
interface NounModule {
  name: string;
  summary(ctx: Context): Promise<PaneOutput>;
  commands: Record<string, Command>;        // verb → Clipanion Command class
  hints(ctx: Context): Hint[];              // dynamic, state-aware
}
```

- `summary()` renders the pane shown when the user types `codegen {noun}` alone. The noun owns the visualization — tables, trees, metrics, text — whatever fits.
- `commands` maps verb strings to Clipanion Command classes. Clipanion paths are set to `[[noun, verb]]`, making `codegen entity new` invoke `EntityNewCommand`.
- `hints()` returns a list of suggested next commands. Hints are **dynamic** based on project state (e.g. "no subsystems installed → suggest `install`", "all subsystems installed → suggest `list`").

This gives the user a consistent mental model: every noun has a home page, every home page shows current state and what to do next, every noun supports the same exploration pattern.

### Parser Library: Clipanion

Clipanion is the chosen argument parser. Rationale:

- **Class-based commands** align cleanly with the `NounModule` interface. Each verb becomes a Command subclass with decorated options, which maps to the noun's `commands` map by construction.
- **Nested command paths** (`[[noun, verb]]`) are first-class and composable.
- **Introspectable** — commands can be iterated to auto-generate the `hints()` default list and help surfaces.
- **Typed options** via `Option.String` / `Option.Boolean` with validation, eliminating the manual argument parsing in the current CLI.
- **Built-in help and version commands** (`Builtins.HelpCommand`, `Builtins.VersionCommand`).

Alternatives considered:

| Library | Rejected because |
|---------|------------------|
| `commander` | Works, but more verbose for nested commands and does not cleanly map to the class-per-command pattern. |
| `citty` | Nuxt's CLI framework. Newer, ESM-first, less mature ecosystem. Considered for a future migration if Clipanion becomes limiting. |
| `yargs` | Historically popular, but imperative API and poor typing story for nested commands. |
| `node:util.parseArgs` (current) | Flat-only. Does not scale to nested commands or shared option sets. |

### Project Structure

```
src/
  cli/
    index.ts                       # Clipanion Cli, registers all nouns
    noun-module.ts                 # NounModule interface + base helpers
    commands/
      entity.ts                    # EntityNoun: summary + new/list/validate/inspect
      subsystem.ts                 # SubsystemNoun: summary + install/list/remove
      project.ts                   # ProjectNoun: summary + init/scan/config/analyze/stats/doc
      manifest.ts                  # ManifestNoun: summary + update/suggestions/apply
    shortcuts/
      init.ts                      # Top-level `codegen init` → project init
    ui/                            # See ADR-016 for UI system
    shared/
      context.ts                   # Context loading (config, project detection, etc.)
      hygen.ts                     # Hygen invocation helper
      runtime-copier.ts            # Copy runtime/ into user projects
```

One file per noun. Each file exports:
- One or more Clipanion `Command` classes (one per verb)
- A `summary()` function
- A `hints()` function
- An aggregate `NounModule` default export

The root `cli/index.ts` imports each noun module and registers its commands with the Clipanion `Cli` instance.

### Shortcut Commands

Top-level shortcuts for high-traffic actions are opt-in conveniences, not a competing surface. They must be explicit about being shortcuts:

```
codegen init      # shortcut → same as `codegen project init`
```

Shortcuts live in `src/cli/shortcuts/` as separate Command classes that paths to the root. Each shortcut imports and delegates to the canonical command — no duplicate implementation.

### Configuration via Flags

Global options live on the root Cli instance:
- `--config <path>` — override config file location
- `--cwd <path>` — override working directory
- `--json` — machine-readable output (forced, no color, no spinners, no interactive prompts)
- `--verbose` / `-v` — verbose logging
- `--no-color` — disable color

Command-specific options live on the Command class.

## Consequences

### Positive

- **Self-documenting.** `codegen {noun}` shows current state and suggests actions. No separate cheatsheet required.
- **Testable in isolation.** Each Command class can be unit-tested with mocked context.
- **Extensible.** Adding a verb = adding a Command class to a noun file. Adding a noun = adding a file + registering it.
- **Refactorable to decorators.** The `NounModule` shape becomes a natural target for decorators (`@Noun("entity")`, `@Verb("new")`) once the pattern settles.
- **Consistent UX.** Every noun has summary + hints. Users learn one pattern and apply it everywhere.

### Negative

- **More typing for users.** `codegen entity new foo.yaml` is longer than `codegen entity foo.yaml`. Mitigated by shortcuts for the most-used commands and shell completion (future).
- **More files.** 4 noun files + shortcuts + UI + shared vs. one 25K file. The overall code volume is similar; the spread is wider.
- **Hints must be dynamic.** Writing `hints()` for each noun requires deciding what state to read and what to recommend. This is useful discipline, but it's discipline we have to apply.

### Neutral

- Clipanion requires Node 14+; we target Bun, so no concern.
- Existing commands must be migrated. Migration is per-noun, can happen incrementally with the old `cli.ts` delegating to the new system during transition.

## Implementation Notes

- The CLI can be built and tested against a target project (e.g. Dealbrain) to validate the UX before merging. Dogfooding is the acceptance criterion, not a test suite.
- The `runtime/` directory (shipped code) is orthogonal to the CLI; the CLI installs runtime code into user projects, but does not depend on runtime at its own build time.
- The `@clack/prompts` integration is preserved as the interactive prompt layer. Clipanion handles arg parsing; clack handles interactive multi-step prompts.
