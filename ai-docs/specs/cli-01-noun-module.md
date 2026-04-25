# SPEC-CLI-01: NounModule Base Abstraction

**Status:** Draft
**Date:** 2026-04-13
**Depends on:** ADR-015 (CLI Command Architecture), ADR-016 (CLI UI System)

---

## Purpose

Define the concrete interface, runtime contract, and registration mechanics for the `NounModule` pattern introduced in ADR-015. Every noun (`entity`, `subsystem`, `project`, `manifest`) must conform to this shape so that the CLI root can register commands, render summaries, and show hints uniformly.

This spec does not implement any single noun — it implements the base abstraction that the per-noun specs (CLI-02, CLI-03, ...) build on.

---

## Files to Create or Modify

| File | Action | Notes |
|------|--------|-------|
| `src/cli/noun-module.ts` | create | `NounModule` interface + `registerNoun()` helper |
| `src/cli/index.ts` | create | Root Clipanion Cli, imports + registers each noun |
| `src/cli/shared/context.ts` | create | `Context` type + `loadContext()` — config, cwd, project detection |
| `src/cli/ui/pane.ts` | create | `renderPane()` — border + content + hint footer |
| `src/cli/ui/hints.ts` | create | `Hint` type + `renderHints()` |
| `src/cli/ui/output.ts` | create | `printSuccess`, `printError`, `printWarning`, `printInfo`, `printMuted` |
| `src/cli/ui/theme.ts` | create | Chalk semantic tokens |
| `src/cli/ui/icons.ts` | create | Unicode + ASCII fallback |
| `src/cli/ui/spinner.ts` | create | `withStatus()` Ora wrapper |
| `src/cli/ui/json.ts` | create | `isJsonMode()`, `printJson()` |
| `package.json` | modify | Add dependencies: `clipanion`, `chalk`, `ora`, update `bin` to `src/cli/index.ts` |

`src/cli.ts` is kept as a temporary compatibility shim that re-exports or delegates; it will be removed once all nouns are migrated. This is covered in later specs.

---

## NounModule Interface

```typescript
// src/cli/noun-module.ts
import type { Command } from 'clipanion';
import type { Context } from './shared/context';

export interface Hint {
  command: string;          // e.g. "codegen entity new <file>"
  description: string;      // e.g. "Generate entity from YAML"
}

export interface PaneOutput {
  title: string;            // rendered in the pane border
  body: string | string[];  // pre-formatted content (noun owns layout)
  footer?: string;          // optional subtitle (e.g. "5 entities · 3 families")
}

export interface NounModule {
  name: string;                                           // "entity", "subsystem", ...
  commandClasses: Array<new () => Command>;               // Clipanion Command classes
  summary(ctx: Context): Promise<PaneOutput>;             // renders when no verb given
  hints(ctx: Context): Promise<Hint[]>;                   // dynamic, state-aware
}
```

### Conventions for Command Classes

Each Command class a noun exports must:

- Set `static paths = [[nounName, verbName]]` (e.g. `[['entity', 'new']]`)
- Set `static usage = Command.Usage({ description, examples })` with a one-line description
- Implement `async execute()` that uses the UI helpers (`printSuccess`, `withStatus`, etc.)
- Throw on unrecoverable errors; let the root Cli handle exit codes

Commands never directly `process.exit()` from their own code except via rethrow. The root handles exit codes uniformly (0 success, 1 recoverable error, 2 usage error).

---

## Root CLI Wiring

```typescript
// src/cli/index.ts
import { Cli, Builtins } from 'clipanion';
import { entity } from './commands/entity';
import { subsystem } from './commands/subsystem';
import { project } from './commands/project';
import { manifest } from './commands/manifest';
import { InitShortcut } from './shortcuts/init';
import { RootSummaryCommand } from './commands/root';

const cli = new Cli({
  binaryLabel: 'codegen',
  binaryName: 'codegen',
  binaryVersion: require('../../package.json').version,
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

// Root: `codegen` with no args → summary or intro
cli.register(RootSummaryCommand);

// Shortcuts
cli.register(InitShortcut);

// Nouns
for (const noun of [entity, subsystem, project, manifest]) {
  for (const CommandClass of noun.commandClasses) {
    cli.register(CommandClass);
  }
  // Register the "noun only" command that renders summary + hints
  cli.register(buildNounSummaryCommand(noun));
}

cli.runExit(process.argv.slice(2));
```

### `buildNounSummaryCommand(noun)`

Generates a Clipanion Command class whose path is `[[noun.name]]` (zero-verb) and whose `execute()` body is:

1. Load context via `loadContext()`.
2. Call `noun.summary(ctx)` → `PaneOutput`.
3. Call `noun.hints(ctx)` → `Hint[]`.
4. Render via `renderPane(paneOutput)` and `renderHints(hints)`.

This helper lives in `src/cli/noun-module.ts`. Individual nouns do not hand-write their summary command class — they just export `summary()` and `hints()`.

---

## Context

```typescript
// src/cli/shared/context.ts
export interface Context {
  cwd: string;                              // working directory
  configPath: string | null;                // absolute path or null if not found
  config: CodegenConfig | null;             // loaded config or null
  isInitialized: boolean;                   // config + entities dir present
  framework: FrameworkDetectionResult | null;  // from scanner
  installedSubsystems: string[];            // detected from user's project
  entityCount: number;
}

export async function loadContext(overrides?: {
  cwd?: string;
  configPath?: string;
  json?: boolean;
}): Promise<Context>;
```

`loadContext()`:
- Resolves `cwd` (default `process.cwd()`, override via `--cwd`).
- Finds the nearest `codegen.config.yaml` walking up from `cwd`, or uses `--config` path.
- Loads config if found; returns `null` if not.
- Runs scanner detection (framework, naming, installed subsystems).
- Returns a fully-populated `Context`.

All commands receive a `Context` and should not re-read config or re-run detection.

---

## Pane Rendering

```typescript
// src/cli/ui/pane.ts
import { theme } from './theme';

export function renderPane(pane: PaneOutput): void {
  const width = Math.min(process.stdout.columns ?? 80, 80);
  const top = '┌─ ' + pane.title + ' ' + '─'.repeat(Math.max(0, width - pane.title.length - 5)) + '┐';
  const bot = '└' + '─'.repeat(width - 2) + '┘';
  console.log(theme.muted(top));
  const lines = Array.isArray(pane.body) ? pane.body : pane.body.split('\n');
  for (const line of lines) {
    console.log('  ' + line);
  }
  if (pane.footer) {
    console.log('');
    console.log(theme.muted('  ' + pane.footer));
  }
  console.log(theme.muted(bot));
}
```

Noun-owned formatting is inside `pane.body`. The pane module handles the border and footer only.

### Hints Row

```typescript
// src/cli/ui/hints.ts
import { theme } from './theme';
import { icons } from './icons';

export function renderHints(hints: Hint[]): void {
  if (hints.length === 0) return;
  console.log('');
  console.log(theme.muted('  Next:'));
  const maxCmd = Math.max(...hints.map((h) => h.command.length));
  for (const h of hints) {
    const pad = ' '.repeat(maxCmd - h.command.length + 2);
    console.log(`    ${theme.system(h.command)}${pad}${theme.muted(h.description)}`);
  }
}
```

---

## JSON Mode

```typescript
// src/cli/ui/json.ts
let jsonMode = false;

export function setJsonMode(enabled: boolean) { jsonMode = enabled; }
export function isJsonMode(): boolean { return jsonMode; }

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
```

`setJsonMode(true)` is called by the root Cli when `--json` is detected. All UI helpers (`printSuccess`, `withStatus`, `renderPane`, `renderHints`) check `isJsonMode()` and no-op or substitute structured output.

In JSON mode, noun summary commands emit:

```json
{
  "noun": "entity",
  "summary": {
    "title": "entities",
    "body": "...",
    "footer": "5 entities · 3 families"
  },
  "hints": [
    { "command": "codegen entity new <file>", "description": "..." }
  ]
}
```

Individual verb commands define their own JSON output shape.

---

## Testing

Unit tests live in `src/__tests__/cli/`:

- `noun-module.test.ts` — exercises `buildNounSummaryCommand()` with a fake NounModule, asserts pane + hints are rendered
- `context.test.ts` — exercises `loadContext()` with various project layouts (initialized, not initialized, with/without config)
- `output.test.ts` — exercises semantic output helpers with captured stdout
- `json.test.ts` — exercises JSON mode short-circuits

Each subsequent CLI spec brings its own tests for the noun it implements.

---

## Migration Notes

- Old `src/cli.ts` is kept in place during the transition. Until all noun modules are migrated, the old CLI and new CLI coexist.
- `package.json` `bin.codegen` initially points at `src/cli.ts` (old). It is flipped to `src/cli/index.ts` (new) only when at least one noun is fully migrated and the root command (`codegen` with no args) is implemented.
- The `justfile` recipes (`gen`, `gen-all`, `gen-subsystem`, `scan`) are updated incrementally per migrated noun.
