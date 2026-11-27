## Gate 2.5 fixes on #912: all in e72508dc

| Lens / # | Sev | Outcome |
|---|---|---|
| adherence 1 | should-fix | **fixed (a)**: the `emit-graph` comments and RFC §3.4 / §8 now say what the inner join hides: a child whose base is *absent from the client*. A soft-deleted base is hidden only if the shape proxy filters `deleted_at`. **Pending decision:** (b), emitting a `deleted_at` filter on the join |
| adherence 2 / quality 1 | should-fix | **fixed**: `writeRoutes` returns the reason for each mutation (`createDisabledBy ?? writesDisabledBy ?? http.disabledBy`), and the stubs print it. Mutation-checked: red without the fix, green with it |
| adherence 3 | should-fix | **fixed**: the frontend's project tenancy column is `tenant_id`; the fixture headers are reworded |
| quality 2 | should-fix | **fixed**: `writeRoutes` throws, naming the entity, when the definitions exist but the surface has no entry. The permissive answer applies only to a context with no definitions. Both are tested |
| quality 3 | should-fix | **fixed**: `flatChild` returns the type names. `emit-api`, `emit-entities` and `emit-graph` read them, and `emit-graph` throws if REL-1's marker and `flatChild` disagree |
| quality 4 | should-fix | **fixed**: `resolvedBehaviorNames` moved to `src/patterns/implied-behaviors.ts`; `entity-locals.js` and `emit-collections` both call it (a pure refactor, baseline unchanged) |
| quality 5 | should-fix | **pending decision**: value-position hygiene across the whole emitted frontend tree |
| quality 6 | should-fix | **deferred**: the store's `as unknown as EntityHooks<any, any, any>` needs an upstream change in `@pattern-stack/frontend-patterns` (`createStore` accepting `TCreate = never`). It will be linked from the comment once filed |
| adherence nits 1–7 | nit | **fixed**: RFC evidence and §10 rows; CLAUDE.md stub wording; one owner for the `<child>.inherits` id (`inheritsRelationId` + `INHERITS_PATH` in `src/schema/inheritance.ts`); stale wording, test header and RFC note |
| adherence nit 8 | nit | **fixed**: the PR body says "Closes A12–A16" |
| quality nits 7–10, 12, 14 | nit | **fixed** |
| quality nit 11 | nit | **not fixed**: printing the route's verb and path from the derived route is a follow-up; the path building predates this PR, and no route differs today |
| quality nit 13 | nit | **not fixed**: the Studio fixture snapshots follow the existing `demo-surface.json` convention, and they were fresh at the tip |

Gates on the branch: typecheck clean; `test-unit` 4941 pass / 0 fail; `test-baseline`, `test-smoke-frontend` and `test-studio` pass. The full `test-all` and `test-integration` run follows the cascade.
