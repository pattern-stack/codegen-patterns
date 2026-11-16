# S6 phase R2 + whole-stack review fixes — lane `inh-r2s6-fix`

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first. Branch
`dugshub/875-s6-inherits-frontend`, worktree
`/Users/dug/Projects/worktrees/codegen-patterns/dugshub-875-s6-inherits-frontend`. One new commit on top of 4034d806
(squash-merged stack; no history rewrite). **DECIDED** items are coordinator decisions.

1. **BLOCKER — restore RFC-0006 §13.2.** 4034d806's RFC diff is +14 / −620: one hunk deleted old lines 1247–1865 of
   `docs/rfcs/RFC-0006-joined-table-inheritance.md` (S1's phase R / R2 bullets, S2–S5 entire, S6's plan and as-built
   body). Restore them from `git show d4526db7:docs/rfcs/RFC-0006-joined-table-inheritance.md`, move S6's two R2
   bullets back under **S6 as built** (one ends "(above)"), and apply R2's changes **inside** the restored S6 note,
   rewriting what R2 made false: (a) the frontend now uses `writeRoutes` / `projectSurface`, pinned against
   `buildBackendLocals`' `apiSurface.http.routes` (not `createDisabledBy` / `hasCreateRoute`); (b) `generate.writes` on
   the frontend is closed (the `audit_entry` fixture, its gates, the `useDelete` limit); (c) the unique-FK spine tier is
   deleted; (d) the `inherits` relations re-bless three project goldens. Add one line to S2's "For S6: the frontend does
   not read `generate.writes`": closed in S6 R2. Then check every dangling reference resolves (`:661`, `:664`, `:741`,
   `:821`, `:1076`, A15 `:1111`) and that the status line and CLAUDE.md:99 ("as built notes, the truth") are true again.
   **Prove it:** `git diff d4526db7 HEAD -- docs/rfcs/RFC-0006-joined-table-inheritance.md` must show only R2's intended
   edits, no deletion of another slice's notes — paste its `--stat`.
2. **Delete on the frontend:** try `delete: (_id: never)` in `emit-api.ts` for a no-delete entity (`EntityApi.delete` is
   method syntax, so bivariant) so `<e>Api.delete('a')` is a compile error; add a `@ts-expect-error` for it in
   `graph-usage.ts`. Then fix CLAUDE.md:127-128 to say exactly what still compiles (`useDelete().mutate`, which has no
   type parameter in frontend-patterns) and what does not.
3. `src/derived/api/project.ts:296-300`: the comment says REL-1's graph has no edge for `inherits:` — false (the golden
   gives `email.inherits` `includeKeys`, and the base is a relation). Fix the comment only.
4. Living docs for the deleted spine tier: `docs/specs/STUDIO-0.md:140-145` (`fkUnique` on the graph payload),
   `docs/specs/STUDIO-2.md:160` (the `spine: unique FK (1:1)` example) and its `relationId` bullet (~`:162-166`: an
   `inherits` line carries `<child>.inherits`). Dated revision notes where the spec has a revisions section.
5. `emit-api.ts:167,174,177`: emit `new globalThis.Error(…)` (an entity named `error` breaks with TS1361 today); extend
   `test/_emitted-name-hygiene.ts` or add a test so a value-position global without `globalThis.` is caught.
6. **DECIDED — `writeRoutes` reads the derived HTTP routes** (`apiSurface.http.routes`), not `useCases`: the frontend
   calls REST routes, and an `api: false` entity has use cases but no routes, so today it still gets REST mutations
   aimed at routes that do not exist. Add a unit test for an `api: false` entity (no mutations). Record it in S6's
   as-built note.
7. `inherits-graph.test.ts:225` compares `writeRoutes` with the same `useCases` it reads — after item 6 point it at
   `http.routes` from the backend's printed surface, or delete it (the test above it is the real gate); say which.
8. **DECIDED — one owner for the `<child>.inherits` relation id:** Studio (`tools/studio/src/adapters/schema-adapter.ts:323`)
   reads the id from the derived surface (the relation entry `src/derived/api/project.ts:303` builds), not its own
   literal; add a Studio test over a real derived surface with a family (the demo has none — use a fixture surface built
   by `deriveProjectApiSurface`, not a hand-built one).
9. `src/studio/server/relationships.ts:226`: escaped backticks inside a line comment.
10. `consumer-skills/entities/yaml-reference.md:321`: add "a child of a keyless base has no upsert".

Gates after your last edit (paste tails): `bun run typecheck`, the whole `just test-all`, `just test-integration`.
Report with `SendMessage` to `codegen-patterns-73` (hc terminal `t1rf`), then stop.
