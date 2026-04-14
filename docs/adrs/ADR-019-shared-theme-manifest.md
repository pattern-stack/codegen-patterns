# ADR-019 — Shared Theme Manifest for CLI + TUI

**Status:** Draft
**Date:** 2026-04-14
**Owner:** Doug
**Related:** ADR-016 (CLI UI System)

## Context

ADR-016 fixed the TypeScript CLI's visual grammar — semantic tokens, icon set with ASCII
fallback, pane and hint primitives. The palette and icons are currently hardcoded in
`src/cli/ui/theme.ts` and `src/cli/ui/icons.ts`:

- `success #A8D8A8`, `error #FF8A80`, `warning #FFD580`, `system #A0D8EF`,
  `agent #C4A7FF`, `user #D4A5C9`, `muted #888888`
- `success ✓ / [OK]`, `error ✗ / [FAIL]`, `warning ⚠ / [WARN]`, `info ◆ / [INFO]`,
  `arrow → / ->`, `bullet ▸ / >`, `check ✓ / [x]`, `dash ◌ / [ ]`

Issue #31 proposes a Bubble Tea (Go) TUI that pairs with the TypeScript `codegen` CLI.
The TUI is a second runtime for the same product and must share one visual identity —
a green success glyph must be the exact same green in both surfaces, a coral error the
exact same coral. Two runtimes with independently-maintained palettes will drift the
moment anyone adjusts a shade.

The `pattern-stack/chat-patterns` Go package (Bubble Tea v2, private) already ships
theme-loading infrastructure — `internal/ui/theme/loader.go` and
`internal/ui/theme/themes.go` — meaning the Go side has precedent for reading theme
definitions from a file rather than hardcoding them. The TypeScript CLI has no such
indirection yet; the palette is a literal object.

The open question this ADR resolves: **how do the TS CLI and Go TUI share one palette
and icon set without drift?** A single source-of-truth manifest, checked into the repo,
consumed by both runtimes — at build-time on the TS side, at startup on the Go side —
with a shared schema so any change that breaks one runtime breaks both.

## Decision

### A single YAML manifest at `shared/theme.yaml`

The canonical definition lives at `shared/theme.yaml` at the repo root. Both runtimes
read it. Neither runtime hardcodes palette values once this ADR lands.

```yaml
# shared/theme.yaml
version: 1
default: pastel

variants:
  pastel:
    palette:
      success: "#A8D8A8"  # muted green
      error:   "#FF8A80"  # coral red
      warning: "#FFD580"  # soft amber
      system:  "#A0D8EF"  # pale blue
      agent:   "#C4A7FF"  # lavender
      user:    "#D4A5C9"  # dusty pink
      muted:   "#888888"  # dim gray

icons:
  success: { unicode: "✓", ascii: "[OK]" }
  error:   { unicode: "✗", ascii: "[FAIL]" }
  warning: { unicode: "⚠", ascii: "[WARN]" }
  info:    { unicode: "◆", ascii: "[INFO]" }
  arrow:   { unicode: "→", ascii: "->" }
  bullet:  { unicode: "▸", ascii: ">" }
  check:   { unicode: "✓", ascii: "[x]" }
  dash:    { unicode: "◌", ascii: "[ ]" }
```

YAML is the right format here because:

- The repo already uses YAML as the authoring surface for entity definitions and
  `codegen.config.yaml`. Contributors are editing YAML daily.
- Comments are permitted — `# muted green` next to `#A8D8A8` is load-bearing for
  designers skimming the file.
- JSON requires escaping and forbids comments; TOML is unfamiliar to the frontend side;
  Starlark/CUE are overkill.
- Both `js-yaml` (TS) and `gopkg.in/yaml.v3` (Go) are mature, both validate cleanly
  into typed structures.

### Shared schema

Both runtimes validate the manifest on load against the same shape. Schema drift is a
build failure, not a runtime surprise.

**TypeScript** — Zod schema in `src/cli/ui/theme.schema.ts`:

```ts
import { z } from 'zod';

const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const PaletteSchema = z.object({
  success: HexColor,
  error:   HexColor,
  warning: HexColor,
  system:  HexColor,
  agent:   HexColor,
  user:    HexColor,
  muted:   HexColor,
});

export const IconPairSchema = z.object({
  unicode: z.string().min(1),
  ascii:   z.string().min(1),
});

export const ThemeManifestSchema = z.object({
  version: z.literal(1),
  default: z.string(),
  variants: z.record(z.object({
    palette: PaletteSchema,
    modifiers: z.record(z.enum(['dim', 'bold', 'italic'])).optional(),
  })),
  icons: z.record(IconPairSchema),
});

export type ThemeManifest = z.infer<typeof ThemeManifestSchema>;
```

**Go** — struct in `internal/ui/theme/manifest.go` (matches the chat-patterns
theme-loader shape for consistency):

```go
type ThemeManifest struct {
    Version  int                       `yaml:"version"`
    Default  string                    `yaml:"default"`
    Variants map[string]ThemeVariant   `yaml:"variants"`
    Icons    map[string]IconPair       `yaml:"icons"`
}

type ThemeVariant struct {
    Palette   Palette           `yaml:"palette"`
    Modifiers map[string]string `yaml:"modifiers,omitempty"`
}

type Palette struct {
    Success string `yaml:"success"`
    Error   string `yaml:"error"`
    Warning string `yaml:"warning"`
    System  string `yaml:"system"`
    Agent   string `yaml:"agent"`
    User    string `yaml:"user"`
    Muted   string `yaml:"muted"`
}

type IconPair struct {
    Unicode string `yaml:"unicode"`
    ASCII   string `yaml:"ascii"`
}
```

A schema change is co-located: modifying `version`, adding a palette key, or adding an
icon requires edits to both the Zod schema and the Go struct in the same PR. CI
enforces the round-trip (see Implementation Notes).

### Loading strategy

**TypeScript CLI — build-time codegen.** A prepublish / `just gen-theme` step reads
`shared/theme.yaml`, validates it against the Zod schema, and emits
`src/cli/ui/theme.generated.ts`:

```ts
// AUTO-GENERATED by scripts/gen-theme.ts from shared/theme.yaml. Do not edit.
import chalk from 'chalk';

export const theme = {
  success: chalk.hex('#A8D8A8'),
  error:   chalk.hex('#FF8A80'),
  warning: chalk.hex('#FFD580'),
  system:  chalk.hex('#A0D8EF'),
  agent:   chalk.hex('#C4A7FF'),
  user:    chalk.hex('#D4A5C9'),
  muted:   chalk.hex('#888888'),
  dim:     chalk.dim,
} as const;

export const iconPairs = {
  success: { unicode: '✓', ascii: '[OK]' },
  // ...
} as const;
```

The existing `src/cli/ui/theme.ts` and `src/cli/ui/icons.ts` become thin wrappers over
the generated module — `theme.ts` re-exports the palette and adds `dim: chalk.dim`,
`icons.ts` applies the runtime TTY/env detection (unchanged from ADR-016) to pick the
unicode or ASCII side of each pair.

Build-time codegen is preferred over runtime YAML parsing because:

- The CLI already has a zero-runtime-IO startup; adding a YAML read on every invocation
  regresses `codegen --help` latency.
- Chalk's `chalk.hex()` wrapping is a one-time operation that belongs in generated code,
  not reconstructed on each run.
- The generated file is diffable in PRs, so palette changes show up as concrete deltas
  in review.

**Go TUI — startup load via `//go:embed`.** The Go binary embeds `shared/theme.yaml` at
compile time and decodes it at startup, following the chat-patterns
`internal/ui/theme/loader.go` pattern:

```go
//go:embed shared/theme.yaml
var manifestBytes []byte

func Load() (*ThemeManifest, error) {
    var m ThemeManifest
    if err := yaml.Unmarshal(manifestBytes, &m); err != nil {
        return nil, fmt.Errorf("theme manifest: %w", err)
    }
    if m.Version != 1 { return nil, fmt.Errorf("unsupported theme version %d", m.Version) }
    // validate palette + icon keys are complete
    return &m, nil
}
```

Embedding (vs. reading from disk) keeps the TUI a single binary with no sibling-file
requirement. An advanced future feature — user-authored theme overrides loaded from
`~/.config/codegen/theme.yaml` — can layer on top of the embedded default without
changing this ADR.

### Drift prevention

Three CI checks make drift impossible to land:

1. **TS regen check.** `just gen-theme` runs and `git diff --exit-code
   src/cli/ui/theme.generated.ts` must be clean. Forgetting to regenerate fails CI.
2. **Schema parity check.** A fixture `shared/theme.yaml` is parsed by both runtimes in
   CI — a TS test (`bun test theme.schema.test.ts`) and a Go test
   (`go test ./internal/ui/theme`). If either fails, the manifest shape has diverged.
3. **Visual snapshot (future).** Once the TUI lands, a golden test captures a sample
   output from both runtimes and asserts the palette codes appearing in ANSI sequences
   match.

## Consequences

### Positive

- **Single source of truth.** A palette tweak is a one-line edit in `shared/theme.yaml`.
  Both runtimes pick it up on their next build.
- **Coordinated redesigns.** Swapping the default variant (e.g. a high-contrast theme)
  changes `default:` in the manifest — no per-runtime migration.
- **Themeable.** `variants:` opens the door to dark/light/high-contrast variants without
  re-plumbing. The TUI can expose a runtime picker; the CLI can honor
  `CODEGEN_THEME=mono` via env.
- **Schema-policed.** Zod and Go structs catch missing keys at build time. A palette
  member added on one side and forgotten on the other fails CI.
- **Chalk still wraps on the TS side.** Generated code still emits `chalk.hex(...)` —
  the manifest populates the hex values, it does not replace the chalk abstraction.
  Nothing in `output.ts`, `pane.ts`, or `hints.ts` changes.

### Negative

- **A generation step enters the TS build.** `just gen-theme` becomes a prepublish
  requirement. Missing the regen is a CI failure (see drift prevention) but still a
  footgun for contributors on their first palette PR.
- **Embed vs. read on the Go side.** Embedding locks themes into the binary at build
  time. Teams wanting live theme hot-reload must layer a user override path later.
  Acceptable for MVP.
- **Manifest is a new file to keep in sync with ADR-016 documentation.** The hex values
  listed in ADR-016's prose become informational — the manifest is canonical.

### Neutral

- `icons.ts` runtime TTY/env detection is unchanged. The manifest provides the pair set
  (`unicode` + `ascii`); the *selection* between them remains dynamic.
- Chalk remains the TS color library. The manifest doesn't commit either runtime to a
  specific rendering library — it commits both to the same numeric values.

## Alternatives Considered

### JSON manifest

Valid but strictly worse for authoring: no comments, more escaping, and no readability
advantage over YAML. Rejected.

### TOML manifest

TOML handles scalar maps cleanly but is less familiar in this codebase and worse at
nested maps (`variants[name].palette.*`). No meaningful win. Rejected.

### Keep the palette hardcoded in TS, duplicate it in Go

The current state. Works until the first redesign, at which point someone updates one
side and forgets the other. Rejected — this ADR exists specifically to avoid that
failure mode.

### Publish a small `@pattern-stack/theme` npm package + a Go module

Extract the manifest and schema into a cross-published artifact. Heavyweight for MVP —
two release pipelines, version-pinning pain, and no payoff versus a file in the repo
both runtimes already check out. Revisit if the theme is ever consumed by a third
runtime (web dashboard, IDE plugin). Rejected for now.

### CSS custom properties / design tokens spec (W3C)

The emerging W3C Design Tokens format is attractive for a web-bound design system but
adds tooling complexity (token transformers, Style Dictionary) for two terminal
runtimes. Not worth it at this stage. Revisit if a web surface joins the product.
Rejected.

## Implementation Notes

### File location: `shared/theme.yaml`

Placed at the repo root under `shared/` rather than `src/shared/theme.yaml` or
`config/theme.yaml`:

- Not under `src/` because the manifest is runtime-agnostic — `src/` connotes TS
  source in this repo.
- Not under `config/` because `config/` doesn't exist and the file is not per-project
  configuration; it's a product-level constant.
- `shared/` telegraphs the cross-runtime ownership and leaves room for future shared
  artifacts (e.g. `shared/icons.yaml` if icons ever split out, or
  `shared/semantic-tokens.yaml` for tokens that aren't colors).

### Build integration

- `scripts/gen-theme.ts` — reads `shared/theme.yaml`, validates, writes
  `src/cli/ui/theme.generated.ts`. Idempotent.
- `just gen-theme` — justfile recipe wrapping the above.
- `just install` — includes `gen-theme` so a fresh clone has the generated file.
- `package.json` `prepublishOnly` — runs `gen-theme` before publish so released
  artifacts always reflect the current manifest.
- `src/cli/ui/theme.generated.ts` is checked in (diffable palette changes in review),
  but regeneration is asserted in CI (see drift prevention).

### Icons ASCII fallback

Runtime detection (TTY present, `TERM != 'dumb'`, not in CI) remains in `icons.ts`, and
the equivalent check (Bubble Tea's `lipgloss.HasDarkBackground` + TTY detection) lives
on the Go side. The manifest only provides the unicode/ascii pair set — both runtimes
independently pick which side to render based on their own environment detection.

### Forward compatibility

- **Chalk-style modifiers.** `variants.<name>.modifiers` is reserved for per-variant
  `dim`/`bold`/`italic` mappings. The schema allows it; no runtime consumes it yet.
- **Named themes.** `variants:` already supports multiples. Adding `mono`, `high-
  contrast`, `solarized` is a manifest edit with no runtime changes once selection is
  wired up (CLI: `--theme` flag or `CODEGEN_THEME` env; TUI: in-app picker).
- **Version field.** `version: 1` exists so a future breaking shape change can bump the
  number and both runtimes can refuse to load a mismatched manifest.

### Out of scope

- User-level theme overrides (`~/.config/codegen/theme.yaml`). A future ADR if demand
  materializes.
- Shipping the manifest as a separate npm/Go package. See alternatives.
- Non-color semantic tokens (spacing, border characters). Separate concern; if needed,
  add `borders:` or `layout:` sections to the same manifest under their own schemas.

## References

- Issue `pattern-stack/codegen-patterns#31` — Bubble Tea TUI proposal
- ADR-016 — CLI UI System (palette and icon set this manifest externalizes)
- ADR-015 — CLI Command Architecture (noun-verb structure the TUI will mirror)
- ADR-017 — Barrel Files over Hygen Injects (precedent for generated files checked in)
- `pattern-stack/chat-patterns` — `internal/ui/theme/loader.go`,
  `internal/ui/theme/themes.go` (Go-side theme-loading precedent this ADR aligns with)
- `src/cli/ui/theme.ts`, `src/cli/ui/icons.ts` — files this ADR converts into
  manifest-driven modules
