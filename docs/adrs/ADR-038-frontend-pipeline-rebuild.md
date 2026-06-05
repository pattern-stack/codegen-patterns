# ADR-038 — Frontend Pipeline Rebuild on the pts / frontend-patterns Architecture

**Status:** Accepted
**Date:** 2026-06-04
**Owner:** Doug
**Related:** ADR-037 (runtime modes — the frontend factory layer deliberately does NOT ride them), ADR-035 (vendored runtime delivery), `pattern-stack/pattern-stack` → `tools/cli/src/pts/codegen/` (the original generator + `SPEC-unified-entity-store.md`), `pattern-stack/frontend-patterns` → `src/sync/` (the factory layer)

## 1. Context

The frontend pipeline (`templates/entity/new/frontend/`, 26 hygen templates) was ported from the output shape of **`pts generate`** — the Python/Jinja2 generator in `pattern-stack/pattern-stack` (`tools/cli/src/pts/codegen/frontend/`). The port kept the per-entity template *bodies* but dropped the three load-bearing decisions of the original's architecture:

1. **Whole-tree, single-pass generation.** The original discovers ALL models, then renders every file — including cross-entity files (`store/index.ts`, `entities/index.ts`, `query-client.ts`, `config.ts`, barrels) — from the full model list, idempotently, with no inject/anchor machinery. Because hygen runs one entity at a time, the port replaced this with inject-into-anchor templates… and never generated the anchor files.
2. **Runtime-package split.** Per `SPEC-unified-entity-store.md`: complex logic (`createEntityHooks`, `createStore`, resolvers, provider) lives in **`@pattern-stack/frontend-patterns`** (`src/sync/`, published to npm); generated files are ~30-line wiring. The port hand-rolls hooks/mutations/error-tracking inline per entity (~500-line `combined.ejs.t` plus four sibling templates duplicating it) while still referencing a factory (`./create-unified-entity`) that nothing generates or ships.
3. **Registry-resolved cross-entity naming + per-entity sync mode.** The original resolves FK target names against the discovered model registry (never re-derived in templates) and declares `sync_mode: 'api' | 'electric' | 'offline'` per entity, runtime-overridable via generated `config.ts`. The port re-pluralizes target names inline in templates (diverging three ways from the authoritative YAML `plural`) and flattened sync mode to one global config knob.

An empirical review (2026-06-04, scratch-project generation run) confirmed the consequences: on a fresh project the pipeline emits a `collections.ts` missing the first entity's collection (inject runs before its target file exists — hygen executes templates in `localeCompare` order), prompts `Overwrite? (y/N)` on every re-run (answering y wipes all accumulated collections), errors on 11 inject ops whose anchor files nothing creates, and emits imports of five modules that are never generated (`create-unified-entity`, `store/index`, `field-meta`, `query-client`, `collections/auth`). The generated frontend cannot compile outside the host app the templates were reverse-engineered from.

Meanwhile `pts` itself now dispatches `pts codegen *` to **this repo** as the engine (`tools/cli/src/pts/domains/codegen/`), so this pipeline is the designated successor — the original Python generator survives only behind `pts sync`.

## 2. Decision

Rebuild the frontend pipeline on the original architecture, with the factory layer consumed from `@pattern-stack/frontend-patterns` **as-is**:

1. **Whole-set emission, no anchors.** Frontend generation moves from hygen templates to a TypeScript emitter (the same pattern as the RFC-0001/0002/0003 integration emitters). Per-entity files AND cross-entity files (store, registry, barrels, `config.ts`, `query-client.ts`) are rendered complete from the full entity set (`entities/*.yaml`) on every run. The 11 inject/anchor templates and the first-run/overwrite failure class are deleted, not fixed.
2. **Thin wiring over the published factory.** Generated entity files wire `{collection, api, schema}` into `createEntityHooks` / `createStore` imported from `@pattern-stack/frontend-patterns`. All hand-rolled hook/mutation/error-tracking emission is deleted. The dependency lands in the **generated app's** frontend package.json — `@pattern-stack/codegen` itself gains no runtime dependency.
3. **Per-entity sync mode.** `sync: api | electric` is declared per entity in the entity YAML (global `frontend.sync.mode` becomes the default). `offline` (Electric + Dexie) is deferred until a consumer needs it.
4. **Registry-resolved naming.** FK target names (file, plural, class, collection var) come from the target entity's own YAML via the cross-entity registry prompt-side, never re-derived by pluralizing strings in templates.
5. **Generated REST API client.** The factory's `api` parameter is fed by a generated per-entity REST client targeting the NestJS controllers this codegen already emits (replacing the trpc-handler-only mutation path).
6. **Config consolidation.** The dead `pipelines:` block (validated, never consumed) is deleted. The frontend knobs that exist only to mimic hand-rolled output shapes (`structure`, `hookStyle`, `hookReturnStyle`, `collectionNaming`, `fileNaming`, `typeNaming`) are deleted with the templates that read them — the factory's shape is the shape. Surviving knobs are enumerated in Zod, not passthrough.

## 3. Options Considered

- **Fix in place** (patch hygen ordering, add `unless_exists`, scaffold anchor files, sync the duplicated templates). Rejected: treats symptoms. The anchor model fundamentally fights hygen's per-entity, sorted execution; the duplicated fat templates re-drift the moment anyone touches one of them (already happened: `sync.mode: 'api'` reached 2 of 3 collection templates).
- **Fold the factories into `runtime/`** (ship via ADR-037 package/vendored modes). Rejected: forks `createEntityHooks`/`createStore` from `frontend-patterns` into a second copy needing manual alignment, and makes consumer *frontends* depend on the backend-shaped `@pattern-stack/codegen` package.
- **Extract a lean `@pattern-stack/entity-store` package first** (split `src/sync/` out of frontend-patterns). Right long-term shape — frontend-patterns' hard deps (radix, mapbox, router, axios, …) are heavy for consumers that only want the entity store — but it blocks this rebuild on work in another repo. Deferred; noted as a frontend-patterns cleanup.
- **Depend on `@pattern-stack/frontend-patterns` as-is** — **accepted**. Published (`0.2.0-alpha.12` latest, `.18` alpha), org-owned, and pattern-stack-family apps already use the design system, so the dependency is effectively free for the actual consumer base.

## 4. Consequences

- The Critical failure cluster (first-run dropped collection, re-run overwrite wipe, orphaned anchors/imports) is dissolved structurally rather than patched.
- One source of truth for hook/mutation logic (the factory); generated code shrinks to wiring; the duplicated-template drift class disappears.
- Generated apps gain a dependency on an alpha-published kitchen-sink package. Accepted at the zero-user stage; the `sync/` split is flagged as future frontend-patterns work.
- **Version-alignment contract:** generated code and the factory must agree on `@tanstack/react-db` / `@tanstack/db` / collection-options packages (factory pins beta-era versions). The emitter pins what it emits; the spec records the pairing.
- New emission surface to own: REST API client, whole-set step, `config.ts`/`query-client.ts`. Net template/knob count drops sharply.
- `generate.frontend` remains the single gate. Per-entity `sync:` enters the entity YAML schema.
- Implementation spec: `docs/specs/2026-06-04-frontend-pipeline-rebuild.md`.
