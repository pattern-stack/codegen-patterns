# Handoff — 2026-06-05 — ADR-038 frontend pipeline rebuild shipped; consumer test next

**Branch:** local `feat/frontend-pipeline-rebuild` in worktree `reflective-yawning-clarke` — just an alias of main tip `67f817a`; its remote is deleted. Branch fresh from `main` for new work.
**Last action:** ADR-038 frontend pipeline rebuild merged to main via #468 (no-squash; carries the FE-1..FE-4 squash stack #462/#467/#465/#466) + bump to **0.18.0**. Hygen frontend templates deleted; whole-set TS emitter at `src/emitters/frontend/` runs as the `entity new` post-step (covers `gen-all`).
**Next action:** Consumer test of the emitter — in a consumer (swe-brain is bun-linked; or `codegen-pattern-demo-app`): get codegen 0.18.0, set `generate.frontend: true`, run `entity new --all`, install pairing deps (`@pattern-stack/frontend-patterns@alpha` + TanStack set — README "Frontend generation" table), typecheck the consumer frontend.
**Obstacles:**
- ~~publish~~ **0.18.0 is live on npm and tarball-verified** (2026-06-05): `latest` = 0.18.0, `dist/src/cli/index.js` carries the emitter, `templates/entity/new/` ships only backend + clean-lite-ps. No publish work remains.
- Two contracts only a real consumer can verify: (1) `@repo/db/entities` exports plain `<Class>` — emitter assumes plain; one-line flip in `emit-api.ts`/`emit-collections.ts` if it's `<Class>Entity` (parent spec FE-4 notes); (2) `frontend-patterns@0.2.0-alpha.18` + TanStack pairing installs and typechecks in practice.
- `EntityStoreProvider` mounting is documented, not scaffolded (parent spec OQ-4) — likely the first thing the consumer test trips on.

## Notes
- Prior handoff (May-31, Track D round-2/B + swe-brain migration) is superseded — RFC-0002 shipped in 0.13.x; see git history for that handoff.
- Key docs: `docs/adrs/ADR-038-frontend-pipeline-rebuild.md`; `docs/specs/2026-06-04-frontend-pipeline-rebuild.md` (status: implemented; carries per-stage implementation notes + the dbEntities contract decision); per-stage specs `ai-docs/specs/fe-{1..4}-*.md` (committed — archive once the consumer test passes).
- Coverage: `test/frontend-golden/` golden tree + `src/__tests__/emitters/frontend/` (111 emitter tests). E2E replay proof: fresh project, irregular plural person→people, byte-identical re-runs, zero naive-plural leakage.
- Pre-existing typecheck debt on main, unowned: `src/cli/commands/junction.ts:58,190`, `src/cli/shared/barrel-generator.ts:212` (TS2339 on Junction def fields).
- Parked follow-ups (parent-spec OQs): doctor dep-check, electric `where` scoping + soft-delete shape filter, declarative-query api-client finders, `offline`/Dexie mode, frontend-patterns `sync/` package split.
- Reference design lives at `pattern-stack/pattern-stack` → `tools/cli/src/pts/codegen/` (pts generator + SPEC-unified-entity-store.md); memory `original-frontend-generator-pts` has the map.
