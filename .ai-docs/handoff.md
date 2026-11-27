# Handoff — 2026-11-13 — 0.33.0 released; next: #871 → #865 → #870

**Branch:** `main` @ `074cce00`. No open PRs from this session.
**Last action:** landed the 11-PR stack #839 → #859 (atomic squash, `c1ceeefd`: tenancy column, table naming, TZ knob,
junction payload fields, `belongs_to` NOT NULL by default, `max_length` → `varchar(n)`, READ-1 read API) and released
**0.33.0** (#873, `074cce00`; on npm as `latest`).
**Next action, in this order** (one PR each, each through the SDLC review → fix → gates loop used this session):
1. **#871** — `MetadataEntityRepository.upsertMany` (`runtime/base-classes/metadata-entity-repository.ts`, `set: data[0]`)
   writes the first row's values into every conflicting row and overwrites `createdAt`. Fix: per-column
   `sql\`excluded.<col>\``, excluding the conflict target, `createdAt` and the tenant column; runtime spec with two
   conflicting rows of different values. Live data bug — first.
2. **#865** — `buildBackendLocals` (`templates/entity/new/backend/entity-locals.js`) silently falls back to defaults for
   `tenancyColumn` and `tablePrefix`. Make both required (throw naming the local), as #846 did for `behaviorsTimezone`;
   route the ~250 backend-test call sites through the shared `PROJECT_CONFIG_LOCALS` helper.
3. **#870** — the events subsystem hard-codes `tenant_id` (`text`) in `runtime/subsystems/events/domain-events.schema.ts`
   and `event-bus.drizzle-backend.ts`; make it follow `tenancy.column`. Check jobs/cache/storage/observability too.
**Obstacles:** none blocking. **#874 (variants) waits** for the API-surface model plan (another lane,
`.ai-docs/stacks/api-surface-model/PLAN.md`, approved 2026-11-12, not built) — variants belong in that model.

## Notes
- Standing rule (Doug, 2026-11-11): no host apps use codegen yet; a breaking change is allowed only if it's how we'd
  design it from scratch, and an equally clean non-breaking design wins. Silent breaks must be made loud.
- Design questions parked for Doug: #868 (emitted tenant column NOT NULL by default), #869 (non-uuid tenant type),
  #866 (`zod/v4`); #867 (relationship DTO types) may fold into #679.
- Untracked and **not this session's**: `.ai-docs/stacks/api-surface-model/` and
  `docs/rfcs/RFC-0006-joined-table-inheritance.md`. Leave them to their owners.
- Restack lesson: when fixers push mid-chain in parallel, restack once at the end with one agent and a written
  conflict rule (lower PR's change wins, upper PR keeps its own), then gate at the tip before any push.
