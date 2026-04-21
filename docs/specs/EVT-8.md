# EVT-8 — Scaffold Templates + Atlas Migration Docs + Skill Updates

**Issue:** EVT-8
**Status:** Stub
**Phase:** ADR-024 Phase 1
**Depends on:** EVT-6 (module must be stable before templates reference it).

## Overview

Update `templates/subsystem/events/` to emit the upgraded runtime files and the new `generated/` directory stub. Add an `events:` config block template. Update `docs/CONSUMER-SETUP.md`. Update `.claude/skills/events/` to reflect the shipped state: add `phase-roadmap.md`, remove stale "design in flight" caveats, update routing table.

## Context

**What exists.** `templates/subsystem/events/` (Hygen templates) scaffolds the current 8 runtime files. The templates were written before EVT-1..EVT-7 work. `docs/CONSUMER-SETUP.md` has no events-specific section. The events skill is marked as "design in flight" with 8 open questions.

**What this PR adds.** Brings templates and docs into sync with the shipped implementation. Also closes out the skill documentation — following the CLAUDE.md operating principle ("specs and skills are living documentation — update as you work").

## Architecture

```
just gen-subsystem events
  ├── emits runtime/subsystems/events/*.ts   (all existing files, now upgraded)
  ├── emits runtime/subsystems/events/generated/.gitkeep
  │     (stub so the generated/ dir exists; actual files come from just gen-all)
  └── injects events: config block into codegen.config.yaml

codegen.config.yaml events: block:
  events:
    backend: drizzle
    multi_tenant: false
    # pools: []  # optional: restrict this process to specific drain lanes

Skill updates:
  .claude/skills/events/SKILL.md          ← update routing table, remove "design in flight"
  .claude/skills/events/phase-roadmap.md  ← NEW: Phase 1 deliverables + what's deferred
  .claude/skills/events/event-codegen.md  ← update: resolved questions, stable file locations
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `templates/subsystem/events/*.ejs.t` | modify | Emit upgraded module, tokens, updated schema |
| `templates/subsystem/events/codegen-config-events-block.ejs.t` | new | `events:` config block |
| `templates/subsystem/events/generated-dir.ejs.t` | new | Emit `.gitkeep` stub for `generated/` dir |
| `src/cli/commands/subsystem.command.ts` | minor | Wire any new events templates |
| `docs/CONSUMER-SETUP.md` | modify | Add events-subsystem section |
| `.claude/skills/events/SKILL.md` | modify | Update routing table, current-state snapshot, remove "design in flight" |
| `.claude/skills/events/phase-roadmap.md` | new | Phase 1 deliverables + deferred work |
| `.claude/skills/events/event-codegen.md` | modify | Resolved questions, stable paths |

## Implementation Steps

1. Update Hygen template files for the events subsystem to emit `events.module.ts`, `events.tokens.ts`, and `domain-events.schema.ts` as they exist after EVT-1..EVT-6.
2. Add a `generated-dir.ejs.t` template that emits `runtime/subsystems/events/generated/.gitkeep` so the directory exists in scaffolds before `just gen-all` runs.
3. Write `codegen-config-events-block.ejs.t` — inject template for `codegen.config.yaml`:
   ```yaml
   events:
     backend: drizzle
     multi_tenant: false
   ```
4. Wire the new templates in `src/cli/commands/subsystem.command.ts` if not already connected.
5. Add "Events subsystem" section to `docs/CONSUMER-SETUP.md` covering:
   - Scaffold command: `just gen-subsystem events`
   - Authoring `events/*.yaml` files
   - Running `just gen-all` to regenerate typed artifacts
   - Atlas migration workflow for `domain_events` changes
   - `TypedEventBus` injection pattern
6. Update `.claude/skills/events/SKILL.md`:
   - Update "Current runtime snapshot" section to reflect new files and generated/ dir.
   - Add routing row: "Deciding what Phase 1 shipped vs. what's deferred (bridge, Phase B)" → `phase-roadmap.md`.
   - Remove "Status: design in flight" and "8 open questions" caveats from event-codegen.md reference.
7. Write `.claude/skills/events/phase-roadmap.md` — mirror jobs `phase-roadmap.md` structure:
   - Phase 1 deliverables list (EVT-1..EVT-8 outcomes).
   - What's deferred: ADR-023 bridge, Phase B selective broadcast, versioning coexistence.
   - "Do not build yet" table.
8. Update `.claude/skills/events/event-codegen.md`:
   - Change "Status: design in flight" to "Status: shipped (Phase 1)".
   - Replace the 8-open-questions section with the resolved answers.
   - Update generated file paths to `runtime/subsystems/events/generated/`.
9. Update `docs/specs/events-codegen-plan.md` status line: "Superseded by ADR-024."
10. Run `just test-baseline` — update snapshots as needed.

## Acceptance Criteria

- [ ] `just gen-subsystem events` produces the upgraded module, tokens, schema, and `generated/` stub.
- [ ] `just gen-subsystem events` injects an `events:` block into `codegen.config.yaml`.
- [ ] `just test-baseline` passes with updated snapshots.
- [ ] `docs/CONSUMER-SETUP.md` contains "Events subsystem" section as described above.
- [ ] `.claude/skills/events/phase-roadmap.md` exists and lists Phase 1 deliverables.
- [ ] `.claude/skills/events/SKILL.md` routing table has a row for `phase-roadmap.md`.
- [ ] `.claude/skills/events/event-codegen.md` no longer says "design in flight" or "8 open questions unresolved."
- [ ] `docs/specs/events-codegen-plan.md` has "Superseded by ADR-024" status.

## Testing Strategy

- Baseline snapshot: `just test-baseline` is the primary gate.
- Manual verification: run `just gen-subsystem events` against a clean scaffold fixture; confirm expected files are emitted.

## Open Questions

None blocking. EVT-Q2 (generated file location) resolution is already applied in the template paths.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` — the ADR this closes out
- `docs/specs/JOB-6.md` — Hygen scaffold template pattern
- `docs/specs/JOB-8.md` — Atlas docs section pattern
- `.claude/skills/jobs/phase-roadmap.md` — template for the new events phase-roadmap.md
- `docs/specs/events-codegen-plan.md` — superseded plan, update its status header
