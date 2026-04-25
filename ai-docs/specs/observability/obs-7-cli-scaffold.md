# OBS-7: CLI scaffold — `just gen-subsystem observability` — Spec

**Issue:** #209 (OBS-7)
**Status:** Draft
**Last Updated:** 2026-04-23

## Overview

Wires the `observability` combiner subsystem (shipped in OBS-5) into the `codegen subsystem install observability` CLI path. Consumers get `ObservabilityModule.forRoot()` registration guidance + an `observability:` config block in `codegen.config.yaml` via `just gen-subsystem observability`. Scaffold is lean — mirrors bridge — no schema, no worker, no `generated/` directory.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `templates/subsystem/observability/prompt.js` | create | Hygen locals coercion (mirror `bridge/prompt.js`) |
| `templates/subsystem/observability/main-hook.ejs.t` | create | **Comment-only** emit into `app.module.ts` directing human to wire `ObservabilityModule.forRoot()` (jobs-pattern — see decision below) |
| `templates/subsystem/observability-config/codegen-config-observability-block.ejs.t` | create | Append `observability:` block to `codegen.config.yaml` |
| `src/cli/shared/observability-scaffold-locals.ts` | create | Pure resolver for Hygen locals (mirror `bridge-scaffold-locals.ts`) |
| `src/cli/shared/subsystem-detect.ts` | modify | Add `'observability'` to `SubsystemName`; add descriptor with `'combiner'` backend literal |
| `src/cli/shared/config-block-detect.ts` | modify | Add `'observability'` to `SubsystemName` union |
| `src/cli/commands/subsystem.ts` | modify | Add `runObservabilityScaffold()`; wire into `execute()`; extend `actionFolder` union; special-case `printInfo` for combiner (no `backend` arg) |
| `src/cli/shared/__tests__/observability-scaffold-locals.test.ts` | create | Unit tests |
| `src/cli/__tests__/subsystem-install.observability.test.ts` | create | CLI-level install test |

## Resolved open questions (decisions)

- **Backend literal**: introduce `'combiner'` as a pseudo-backend (parallel to `openapi-config`'s `'config-only'`). Register observability's `SUBSYSTEMS` entry with `backends: ['combiner']`. Extend `inferBackend` to return `'combiner'` for observability.
- **`main-hook.ejs.t` strategy**: follow the **jobs-pattern** — emit a comment block / printInfo hint directing the human to wire `ObservabilityModule.forRoot()` manually. NO fragile regex injection into `app.module.ts`. This matches existing precedent and survives diverse `app.module.ts` layouts.
- **Ordering guidance**: the printInfo hint must say "Register `ObservabilityModule.forRoot()` AFTER Events/Jobs/Bridge/Sync in `app.module.ts`" — ordering matters because of the `@Optional()` DI resolution in the composer.
- **Reporter defaults in config block**: ship as `enabled: false` placeholders with a comment noting OBS-6 phase-2 consumes them. Phase 1 module ignores the block.

## Interfaces

### `observability-scaffold-locals.ts`

```typescript
export interface ObservabilityScaffoldLocals {
  appName: string;
  appModulePath: string;   // absolute
  configPath: string;      // absolute
  bridgeMetricsEnabled: boolean;  // reserved for OBS-6
}

export interface ObservabilityScaffoldLocalsInput {
  cwd: string;
  config: CodegenConfig | null;
  fileExists: (absolutePath: string) => boolean;
}

export function resolveObservabilityScaffoldLocals(
  input: ObservabilityScaffoldLocalsInput,
): ObservabilityScaffoldLocals;

export function localsToHygenArgs(locals: ObservabilityScaffoldLocals): string[];
```

### `subsystem-detect.ts`

```typescript
export type SubsystemName =
  | 'events' | 'jobs' | 'cache' | 'storage'
  | 'sync' | 'bridge' | 'openapi-config'
  | 'observability';   // new

// In SUBSYSTEMS list:
{
  name: 'observability',
  description: 'Combiner read-port over jobs/bridge/sync (ADR-025)',
  backends: ['combiner'],          // pseudo-backend; no durable state
  defaultBackend: 'combiner',
}

// inferBackend() — early return:
if (name === 'observability') return 'combiner';
```

### `main-hook.ejs.t` (comment emit)

```ejs
---
to: "<%= appModulePath %>"
inject: true
append: true
skip_if: "ObservabilityModule"
---

// TODO: Register ObservabilityModule (combiner subsystem, ADR-025)
// Add to AppModule.imports AFTER Events/Jobs/Bridge/Sync:
//
//   import { ObservabilityModule } from '@shared/subsystems/observability';
//   // ...
//   ObservabilityModule.forRoot(),
//
// ObservabilityModule composes sibling read ports via @Optional() DI; order matters.
```

This appends a comment block to the bottom of `app.module.ts` as a hint, and the `skip_if` guards against duplicate emission. Human opens `app.module.ts`, reads the comment, wires it up, and optionally deletes the comment.

### `codegen-config-observability-block.ejs.t`

```ejs
---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "observability:"
---

observability:
  # OBS-6 (phase 2) reserved — ObservabilityModule.forRoot() ignores this block
  # in phase 1 (module options are an empty interface). OBS-6 consumes these
  # values for the BridgeMetricsReporter's interval/window/tenant config.
  reporters:
    bridgeMetrics:
      enabled: false
      intervalMs: 60000
      windowHours: 24
```

## Implementation Steps

1. Register `observability` in `subsystem-detect.ts` (`SubsystemName` + `SUBSYSTEMS` + `inferBackend`). Introduce `'combiner'` backend literal.
2. Extend `config-block-detect.ts` `SubsystemName` union.
3. Create `observability-scaffold-locals.ts` mirroring `bridge-scaffold-locals.ts`. Resolve `appModulePath` by probing `<cwd>/<paths.backend_src>/app.module.ts` with `<cwd>/src/app.module.ts` fallback. Read `config.observability?.reporters?.bridgeMetrics?.enabled` with default `false`.
4. Create the three templates (`prompt.js`, `main-hook.ejs.t`, `codegen-config-observability-block.ejs.t`).
5. Wire `runObservabilityScaffold()` into `subsystem.ts` alongside `runBridgeScaffold()`. Extend `actionFolder` union to include `'observability-config'`. Special-case the `printInfo` register-hint so it says "Register `ObservabilityModule.forRoot()` AFTER Events/Jobs/Bridge/Sync" (no `backend` arg).
6. Unit tests for `observability-scaffold-locals`.
7. CLI test: `codegen subsystem install observability` against a tmp project.

## Testing Strategy

- **Unit**: pure resolver tests (default config, `paths.backend_src` override, reporters config read, args round-trip).
- **Integration**: full CLI install against a tmp dir with a canonical `app.module.ts`:
  - `--dry-run` lists planned files without writing
  - Comment block appears at bottom of `app.module.ts`
  - Config block appears in `codegen.config.yaml`
  - Idempotent: re-run is a no-op (skip_if on both templates)
  - `--force-config` re-injects the config block
- **Smoke (OBS-8)**: separate PR exercises the end-to-end scaffold + typecheck.

## Out of scope

- OBS-6 reporter implementation (sibling PR)
- OBS-8 smoke + baseline update
- Actual automated regex injection into `app.module.ts` (rejected above)

## References

- Plan: `.claude/specs/epic-195-plan.md` §OBS-7
- ADR-025
- Precedent: `templates/subsystem/bridge/`, `src/cli/shared/bridge-scaffold-locals.ts`, jobs-pattern main-hook comment emit
- `src/cli/commands/subsystem.ts` `runBridgeScaffold()` for structural mirror
- Module to point at: `runtime/subsystems/observability/observability.module.ts`
