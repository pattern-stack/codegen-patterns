# ADR-016 — CLI UI System: Themed Output, Icons, Spinners, Interactive

**Status:** Draft
**Date:** 2026-04-13
**Owner:** Doug
**Related:** ADR-015 (CLI Command Architecture)

## Context

The current CLI emits output via `console.log` with ad-hoc color strings and no consistent iconography. Output formatting is duplicated across handlers. Error rendering is ad-hoc. There is no shared notion of success/warning/info/muted that commands can rely on.

As commands proliferate under the noun-verb architecture (ADR-015), we need a consistent visual grammar:

- Every `codegen entity new` success message should look identical to a `codegen subsystem install` success message.
- Errors should render uniformly, with truncation for long messages (mirroring `pts` which caps at 500 chars).
- Long-running operations should use spinners with consistent colors and terminal behavior.
- Environments without TTY (CI, piped output, dumb terminals) should degrade gracefully — ASCII fallbacks, no color, no spinners, no interactive prompts.
- A `--json` global flag (ADR-015) should produce machine-readable output across all commands, bypassing the entire visual layer.
- Future interactive/TUI modes (e.g. a live entity graph, a file-tree generation preview) should be opt-in via `--interactive` and not affect the default terminal experience.

`pts` (the Python reference) separates concerns: `ui/output.py` (semantic print helpers), `ui/tokens.py` (color tokens), `ui/themes.py` (theme application), `ui/icons.py` (icons with ASCII fallback), `with_status()` context manager. This architecture has held up across 15+ commands and multiple contributors. We adopt the same separation in TypeScript.

## Decision

### Module Layout

```
src/cli/ui/
  output.ts       # printSuccess, printError, printWarning, printInfo, printMuted
  theme.ts        # Chalk semantic tokens (success, error, warning, muted, agent, user, system)
  icons.ts        # Unicode icons with ASCII fallback based on env detection
  spinner.ts      # withStatus() wrapper around Ora
  pane.ts         # Summary pane rendering primitives (used by NounModule.summary())
  hints.ts        # Hint row rendering (used by NounModule.hints())
  json.ts         # JSON mode detection + structured output helpers
  components/     # Ink components — only loaded when --interactive is true
    EntityGraph.tsx
    GenerationProgress.tsx
    FileTree.tsx
```

### Theme Tokens

Theme tokens are defined in `theme.ts` as Chalk-bound functions. The palette aligns with the broader Pattern Stack TUI aesthetic — muted pastels, not saturated terminal primaries:

```typescript
// src/cli/ui/theme.ts
import chalk from 'chalk';

export const theme = {
  success: chalk.hex('#A8D8A8'),    // muted green
  error:   chalk.hex('#FF8A80'),    // coral red
  warning: chalk.hex('#FFD580'),    // soft amber
  system:  chalk.hex('#A0D8EF'),    // pale blue
  agent:   chalk.hex('#C4A7FF'),    // lavender
  user:    chalk.hex('#D4A5C9'),    // dusty pink
  muted:   chalk.hex('#888888'),    // dim gray
  dim:     chalk.dim,
} as const;
```

Commands and UI primitives reference tokens semantically (`theme.success`), never literal hex codes. A future dark/light toggle or theme preference becomes a one-file change.

### Icons

Icons are defined centrally with runtime detection of Unicode-capable terminals:

```typescript
// src/cli/ui/icons.ts
const unicode = process.stdout.isTTY && process.env.TERM !== 'dumb' && !process.env.CI;

export const icons = {
  success: unicode ? '✓' : '[OK]',
  error:   unicode ? '✗' : '[FAIL]',
  warning: unicode ? '⚠' : '[WARN]',
  info:    unicode ? '◆' : '[INFO]',
  arrow:   unicode ? '→' : '->',
  bullet:  unicode ? '▸' : '>',
  check:   unicode ? '✓' : '[x]',
  dash:    unicode ? '◌' : '[ ]',
} as const;
```

### Output Helpers

Semantic output helpers in `output.ts` compose theme + icons:

```typescript
// src/cli/ui/output.ts
export const printSuccess = (msg: string) =>
  console.log(`${theme.success(icons.success)} ${msg}`);

export const printError = (msg: string) =>
  console.error(`${theme.error(icons.error)} ${msg.slice(0, 500)}`);

export const printWarning = (msg: string) =>
  console.warn(`${theme.warning(icons.warning)} ${msg}`);

export const printInfo = (msg: string) =>
  console.log(`${theme.system(icons.info)} ${msg}`);

export const printMuted = (msg: string) =>
  console.log(theme.muted(msg));
```

Commands call these functions; they do not reach into `theme` or `icons` directly except for custom layouts (panes, hints).

Error truncation mirrors `pts` behavior: errors are capped at 500 characters in interactive output. Full error detail is available via `--verbose` or written to a log file (future).

### Spinners

`spinner.ts` wraps Ora in an async context function mirroring `pts` `with_status()`:

```typescript
// src/cli/ui/spinner.ts
import ora from 'ora';

export async function withStatus<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const spinner = ora({ text: label, color: 'magenta' }).start();
  try {
    const result = await fn();
    spinner.succeed();
    return result;
  } catch (err) {
    spinner.fail();
    throw err;
  }
}
```

`withStatus()` is automatically a no-op in `--json` mode and in non-TTY environments. Commands do not branch on environment; they always call `withStatus()`.

### Pane & Hints

`pane.ts` and `hints.ts` provide primitives for rendering the summary panes and hint rows that every `NounModule` emits (see ADR-015). They are responsible for layout (borders, columns, alignment) while the noun provides content.

Panes and hints render as plain text by default. In `--interactive` mode, they may be replaced by Ink components (`components/`). Noun modules do not know which mode is active; the pane/hints primitives dispatch internally.

### JSON Mode

`--json` is a global flag that short-circuits the visual layer:

- `printSuccess` / `printError` / etc. become no-ops.
- `withStatus()` becomes a direct passthrough (no spinner).
- Summary panes and hint rows are skipped.
- Commands must emit structured output via `printJson(data)` from `json.ts`.

JSON mode is intended for CI, scripting, and machine integration. Every command must produce meaningful JSON output when `--json` is set; commands that cannot (e.g. purely interactive flows) must fail with an explicit error.

### Interactive Mode

`--interactive` / `-i` is an opt-in flag that activates richer rendering:

- Ora spinners may be replaced by Ink progress components.
- Summary panes may become live-updating Ink views.
- Multi-step prompts use `@clack/prompts` (already in place).

Ink is dynamically imported only when `--interactive` is set, so the default CLI does not pay its startup cost.

### Dependency List

| Package | Purpose |
|---------|---------|
| `chalk` | Color tokens |
| `ora` | Spinners |
| `@clack/prompts` | Interactive prompts (already in use) |
| `ink` + `ink-*` | `--interactive` TUI components (lazy-loaded) |

## Consequences

### Positive

- Every command looks and behaves consistently.
- A one-line change to `theme.ts` or `icons.ts` restyles the entire CLI.
- CI output degrades cleanly — no garbage characters, no stuck spinners.
- `--json` support falls out of the architecture rather than being retrofitted.
- Interactive mode is possible without forcing every command to care about it.

### Negative

- More modules to import. `printSuccess`, `printError`, `withStatus`, `icons`, `theme` all become part of the standard command vocabulary.
- The pastel palette may have poor contrast on some terminal themes. Mitigated by `--no-color` support and eventual theme toggle.

### Neutral

- Chalk and Ora are mature, low-churn dependencies. Ink is heavier but only loaded on `--interactive`.
- `@clack/prompts` remains the sole interactive-prompt surface. Clipanion handles args; clack handles questions; the UI system handles display.
