# BRIDGE-6 — Codegen `bridgeRegistry` from `@JobHandler.triggers`

**Issue:** BRIDGE-6
**Status:** Stub
**Phase:** ADR-023 Phase 2
**Depends on:** BRIDGE-2.
**Blocks:** BRIDGE-7, BRIDGE-8.

## Overview

AST scanner that walks the project's handler files, extracts `@JobHandler({ triggers: [...] })` metadata, validates every `triggers[].event` against the generated `eventRegistry`, and emits `runtime/subsystems/bridge/generated/registry.ts`. Hooked into `just gen-all`. Unknown event type → hard error. Empty project → empty `{}` stub.

## Context

**What exists.** `eventRegistry` at `runtime/subsystems/events/generated/registry.ts` (EVT-3). `@JobHandler` decorator (JOB-2). No bridge registry generator.

**What this PR adds.** The generator that bridges the two — takes decorator metadata from user handlers and produces a keyed, ordered, typed `bridgeRegistry`.

## Architecture

```
just gen-all
  ├── existing entity / event codegen (unchanged)
  └── generateBridgeRegistry()
        ├── scanHandlerFiles(handlersDir) via ts-morph or tsc AST
        │     for each class with @JobHandler decorator:
        │       extract type + triggers array
        │       each trigger gets triggerId = `${type}#${index}`
        │       preserve source file path (for error messages)
        ├── validateAgainstEventRegistry(triggers, eventRegistry)
        │     unknown event type → throw with file+line citation
        ├── buildRegistryFileContent(triggers)
        │     emits keyed Map<eventType, TriggerEntry[]>
        │     preserves declaration order per type
        └── write runtime/subsystems/bridge/generated/registry.ts
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/cli/shared/bridge-registry-generator.ts` | create | Scanner + emitter |
| `runtime/subsystems/bridge/generated/.gitkeep` | create | Dir stub |
| `runtime/subsystems/bridge/generated/registry.ts` | create (stub committed) | Empty `{}` baseline |
| `src/__tests__/cli/bridge-registry-generator.test.ts` | create | Unit tests |
| `src/cli/commands/entity.ts` or equivalent `gen-all` entry | modify | Wire generator |

## Interfaces

```ts
// runtime/subsystems/bridge/generated/registry.ts (emitted)
export const bridgeRegistry: BridgeRegistry = { /* ... */ }

// bridge.protocol.ts may need a companion type file —
// BridgeRegistry = Record<EventType, TriggerEntry[]>
// TriggerEntry = { triggerId, jobType, map, when? }
// If the type isn't already in BRIDGE-2, add in this PR.
```

## Implementation Steps

1. Choose AST toolchain. Prefer `ts-morph` if already a dep; else tsc compiler API. Match whatever EVT codegen uses (`src/cli/shared/event-codegen-generator.ts`).
2. Scan configured handler directories per project config (`codegen.config.yaml: jobs.handlers_dir` or default `src/jobs/`).
3. For each class decorated with `@JobHandler`, extract the metadata object literal:
   - `type` (string literal)
   - `triggers` (array literal) — each element has `event` (literal), `map` (arrow fn), optional `when` (arrow fn)
4. Build `triggerId = \`${type}#${index}\`` per trigger.
5. Validate every trigger's `event` against `eventRegistry`: unknown → throw `CodegenError` with file path, line, and the unknown name.
6. Group triggers by event type; preserve declaration order.
7. Emit `registry.ts` with `// Generated. Do not edit.` header; import callback bodies inlined as arrow-fn literals (AST carries their source text).
8. Hook generator into `just gen-all` after EVT codegen (must run after event registry exists).
9. Unit tests: fixture with (a) two handlers, three triggers total; (b) handler with unknown event → error; (c) empty handler dir → empty registry emission; (d) declaration-order preservation.
10. Baseline snapshot update.

## Acceptance Criteria

- [ ] AST scan locates all `@JobHandler` classes with a `triggers` array.
- [ ] `triggerId` format is exactly `<jobType>#<triggerIndex>`.
- [ ] Unknown event type → codegen hard error with file + line.
- [ ] Generated file header: `// Generated. Do not edit.`.
- [ ] Empty project → `bridgeRegistry = {}`; no error.
- [ ] Declaration order preserved per event type.
- [ ] `just gen-all` on fixture produces expected registry; subsequent `just gen-all` is idempotent (no churn).
- [ ] Baseline snapshot passes.

## Testing Strategy

- **Unit** (`src/__tests__/cli/bridge-registry-generator.test.ts`): fixture-driven.
- **Baseline** (`just test-baseline`): the repo's baseline handler fixture produces a stable registry file.

## Gate/Checkpoint

None.

## Open Questions

- [ ] **`map:` callback serialization.** The generator copies source text of the arrow fn. If a consumer writes `map: (e) => buildInput(e)` referencing a helper from another file, the emitted `registry.ts` must import that helper — but the generator has no way to know. Decision for Phase 2: document that `map:` / `when:` callbacks must be self-contained arrow expressions (no external refs beyond the `event` parameter). Enforce via lint or runtime TS compile error. Implementer confirms in PR body.

## References

- `docs/adrs/ADR-023-event-to-job-bridge.md` §`bridgeRegistry` shape, §Decision 5
- `docs/specs/BRIDGE-PHASE-2-PLAN.md` — row 6
- `docs/specs/EVT-3.md` — `eventRegistry` generator precedent
