# FE-4: CLI Wiring + Docs + Coverage

**Parent:** docs/specs/2026-06-04-frontend-pipeline-rebuild.md (FE-4) · ADR-038
**Branch:** `fe-4/cli-wiring-docs-coverage` off `fe-3/emitter-entities-store-fields`
**Status:** approved (parent spec gated; e2e run authorized)

## Overview

Make the emitter real: wire `emitFrontendSet` into the `entity new` post-step (covers `gen-all` = `entity new --all`), validate the `frontend:` config block with Zod, teach `project init` the consumer deps, document everything, and add snapshot coverage. Closes the stack.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/pipelines-config.schema.ts` → `src/schema/codegen-config.schema.ts` | **rename** + modify | fix the FE-1 misnomer; add `FrontendConfigSchema` |
| all importers of the renamed module | modify | mechanical path update (grep `pipelines-config.schema`) |
| `src/emitters/frontend/load-context.ts` | create | config+registry+parsed → `FrontendEmitContext` (single place CLI calls) |
| `src/cli/commands/entity.ts` | modify | post-step: `generate.frontend === true` → emit whole set |
| `src/cli/shared/init-scaffold.ts` | modify | consumer deps when `generate.frontend` |
| `README.md` | modify | `frontend:` + `entity.sync` reference section; update "What Gets Generated" |
| `CLAUDE.md` | modify | Two Template Pipelines + Project Layout reflect emitter (templates/frontend gone, `src/emitters/`) |
| `test/baseline/**` + `test/run-test.ts` (or dedicated golden test) | create/modify | frontend emission snapshots |
| `src/__tests__/emitters/frontend/load-context.test.ts` | create | config mapping incl. null-disables + defaults |
| `docs/specs/2026-06-04-frontend-pipeline-rebuild.md` | modify | final implementation notes; flip status when done |
| `ai-docs/specs/fe-{1..4}-*.md` | none | leave; archive happens post-merge |

## Details

**1. `FrontendConfigSchema`** (in the renamed `codegen-config.schema.ts`): validates the `frontend:` block — `auth.function` (string | null; ABSENT → default `'getAuthorizationHeader'`, explicit null → disabled — preserve the old hasOwnProperty semantics), `parsers` (record of code strings; default `{ timestamptz: '(date: string) => new Date(date)' }`), `sync.{mode('api'|'electric', default electric), shapeUrl('/v1/shape'), useTableParam(true), columnMapper(string|null, default 'snakeCamelMapper'), columnMapperNeedsCall(true), apiBaseUrlImport(string|null, null), apiUrl('/api')}`. Wire into config-loader like the `generate` block (always-parse for defaults). `ProjectConfig.frontend` typed.

**2. `load-context.ts`**: `loadFrontendEmitContext(cwd, config): { ctx, outDir } | { skip: reason }` — entities via `loadEntityRegistry(entitiesDir)` + `loadEntities` (parsed map); `FrontendEmitConfig` mapped from validated config + `generate.architecture` + `LOCATIONS` (dbEntitiesImport, authImport, outDir = `locations.frontendGenerated.path`). Zero entities → skip with notice.

**3. entity.ts post-step**: follow the existing post-step contract (try-wrapped, non-fatal, surfaced in output — see the integration emitters' pattern in the same file). Runs ONCE per invocation (after the loop in `--all` mode), not per entity. Gate: `config.generate.frontend === true`. Print emitted-file count + outDir like sibling post-steps do.

**4. init-scaffold**: when the proposed config has `generate.frontend: true` — if `apps/frontend/package.json` exists, idempotently merge `FRONTEND_EMITTED_DEPS` into its `dependencies` (preserve existing version choices — only add missing keys; follow the `mergeTsconfig` idempotent-merge precedent in the same file); else add a plan-entry notice listing the required deps verbatim. Never fail init over this.

**5. Baseline coverage** — examine `test/run-test.ts` first. Preferred: flip the fixture `generate.frontend: true`, extend the runner's generated-dirs set with the frontend out dir (fixture already sets `paths.frontend_src`), check in snapshots under `test/baseline/apps/frontend/src/generated/`. The fixture set already includes `person.yaml` (`plural: persons` explicit) — assert its FK consumers use `persons*` names from the registry. Fallback (only if runner integration is genuinely invasive): a dedicated golden-tree test (emit into tmp, compare to a checked-in snapshot dir) wired into `just test-unit` — record the reasoning. Either way: re-run twice to prove byte-stable snapshots.

**6. Docs**: README — new `### Frontend generation` config section (gate, `frontend:` block knobs incl. null-disables, `entity.sync`, version-pairing table + note that the consumer installs `@pattern-stack/frontend-patterns`; the FE-2 plain-`<Class>` assumption documented as the dbEntities contract). CLAUDE.md — pipelines paragraph now: backend templates (hygen) + frontend emitter (`src/emitters/frontend/`, whole-set, ADR-038); add `emitters/` to the src layout listing.

## Gates

`just test-unit` 0 fail · `just test-baseline` pass (now WITH frontend snapshots if preferred path taken) · `bun run typecheck` no NEW errors (3 known pre-existing) · `just test-smoke` pass (fresh-project smoke must stay green — its scaffold is backend-only/`frontend: false`; if smoke fails on anything frontend-related, that's a real wiring bug) · `grep -rn "pipelines-config.schema" src/ templates/ test/` → no matches post-rename.

## Constraints

- Post-step must be non-fatal (sibling contract) but NOT silent — failures print.
- Do not add `@pattern-stack/frontend-patterns` to THIS repo's package.json.
- Init merge must be idempotent (re-running init doesn't duplicate/clobber).
- Conventional commit, Co-Authored-By trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do not push.
