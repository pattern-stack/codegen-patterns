# ADR-047 — The generation target: one config key per axis, renderers keyed by it

**Status:** Accepted
**Date:** 2026-11-25
**Owner:** Doug
**Related:** ADR-046 (derived once, templates print — the `columns/` slot), ADR-037 (runtime mode, the precedent
for a project-level switch resolved once), ADR-008 (core contract + opt-in extensions), CFG-0 (strict config)
**Specs:** `TGT-N` — TGT-0 (`docs/specs/TGT-0.md`) is the first

---

## Context

The generator writes one kind of app: NestJS modules over Drizzle on Postgres. Four separable choices are fused in
that output:

- **data access** — what tables, columns and repositories are written in (Drizzle `pg-core`);
- **composition** — how the pieces are wired (Nest's DI container and per-entity modules);
- **HTTP** — the request layer (Nest controllers);
- **JS runtime** — where the result runs (Node).

There is no switch for any of them. ARCH-0 and ARCH-1 deleted the last architecture switch
(`generate.architecture`, `database:`) because it selected a pipeline nobody maintained, not because a choice is wrong.
A second data-access target is now wanted: Drizzle on SQLite, for a host application with no Postgres and no HTTP.
Before anything can render a second target, the field model has to stop holding one target's text. `processFields`
returned a record mixing facts about a field with its Drizzle column builder (TGT-0 splits it). And the project needs
somewhere to say which target it is.

## Decision

1. **`target:` in `codegen.config.yaml`, one sub-key per axis.** Today:

   ```yaml
   target:
     data: drizzle-pg   # default, and the only value
   ```

   Parsed once and strictly (CFG-0): an unknown value, an unknown axis or a bare string is an error naming the key.
2. **An axis gets its key when it gets its second value, never before.**
   - `data` exists because TGT-0 splits the field model behind it.
   - `composition`, `http` and `runtime` are unknown keys until a second composition, HTTP layer or runtime exists and
     passes the same gates.
   - A value is added to an axis on the same condition.
3. **Not one combined string.** A name such as `nest-drizzle-pg` multiplies with every axis, and its parts can't be
   validated or defaulted separately. Axes vary independently (the SQLite host wants a different data access *and* a
   different composition), so each gets its own key.
4. **Renderers are keyed by the axis value.** `src/targets/columns.ts` holds `COLUMN_RENDERERS: Record<DataTarget,
   ColumnRenderer>`, so adding a `DataTarget` value without a renderer is a type error. Each target's text lives under
   `src/targets/<target>/`, and its facts input lives in `src/derived/` (ADR-046: names, existence and facts, never
   text).
5. **Resolved once, required everywhere.** The hygen prompts read `target` from the parsed config, as
   `behaviorsTimezone` is read, and pass it into the locals. Every consumer that needs a renderer
   (`buildBackendLocals`, the junction prompt) throws on an absent or unknown value. A missing target means the caller
   skipped the prompt, and is never a reason to fall back to the default renderer.
6. **The renderer interface is what the one renderer needs.** `RenderedColumn` carries `drizzleType` / `drizzleChain`
   / `tsType`, the keys the templates print. It is not generalised until a second renderer shows what two targets
   share. Guessing that shape now would be the uniform interface CLAUDE.md warns against.
7. **`project init` does not write the key.** The schema owns the default. A project names a target only when it
   wants a non-default one.

## Consequences

- A second data-access target is an enum value, a renderer under `src/targets/<target>/`, and the templates and base
  classes that renderer needs. It is never a fork of `entity-locals.js`.
- `src/derived/api` does not read the target yet; no derived name depends on it. When composition gets a second value,
  the `*Module` / `*Controller` class names (`src/derived/api/names.ts`) start to depend on it, and the derivation
  takes the resolved target as an **input**. The target is never a fact inside the derivation.
- The split is incremental. TGT-0 moves only the field column builder. The constraints (FK `.references`, indexes,
  uniques, checks), behavior columns, relations manifest, semantic model, repositories and base classes are still
  Drizzle-on-Postgres text outside `src/targets/`. Each moves in its own `TGT-N`.

## Alternatives rejected

- **A template-root switch** (a second `templates/entity/new-<target>/` tree). This duplicates every decision the
  locals builder makes; the problem is who renders text, not which tree prints it (ADR-046 rejected the same move for
  the same reason).
- **Detecting the target** from the project (the scanner already guesses a framework and an ORM). A guess is not a
  declaration, and the scanner's result feeds nothing today.
- **Keys for all four axes now**, each with one value. These would be keys that select nothing, and the shape of an
  axis is best decided when its second value is known.
