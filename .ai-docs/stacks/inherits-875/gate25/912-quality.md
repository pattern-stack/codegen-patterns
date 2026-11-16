## Gate 2.5 — Quality (lens=quality) · PR #912 @ e6226cbc

**Against:** CLAUDE.md + quality canvas + reuse/layering
**Verdict:** REVISE

Diff: `git diff dugshub/875-s5-inherits-http...e6226cbc`. All findings verified at the tip. I ran the emitter, the hygiene
helper and the CLI read-only into a scratch directory; I did not run the test gates.

### Blockers
None.

### Should-fix

1. `src/emitters/frontend/emit-api.ts:165-177`: **the emitter guesses the reason a mutation is missing instead of printing
   it from the derivation.** `writeRoutes` reduces the derived surface to three booleans, and emit-api then hard-codes one
   reason per mutation: `create` always says "every kind of X is created through its child (RFC-0006 §4.1)", and
   `update` / `delete` always say "X is generated without writes". The derived surface already records *why* each one is
   missing (`createDisabledBy`, `writesDisabledBy`, `http.disabledBy`, each a `YamlRef` with a note). The emitter
   re-decides it (ADR-046 "templates print"; one owner).
   **Scenario (reproduced):** the frontend-smoke set's `audit_entry` (`generate: { writes: false }`, no family) emits
   `api/audit-entry.ts` with `/** No POST /audit_entries: every kind of audit_entry is created through its child (RFC-0006 §4.1). */`
   and `Promise.reject(new globalThis.Error('audit_entry has no create route: create a row of any kind through its child'))`.
   Both are false. An `api: false` entity such as the test's `ledger_note` still has its write use cases, but its update
   and delete messages say "generated without writes". That is also false: it has writes and no HTTP.
   **Fix:** have `writeRoutes` return the disabling ref per mutation
   (`createDisabledBy ?? writesDisabledBy ?? http.disabledBy`, and the same for update and delete without the first term).
   emit-api then prints that ref's note and YAML path in the docstring and in the rejection message.

2. `src/emitters/frontend/emit-utils.ts:62`: **an absent input defaults to permissive** (`convenient_fallback`; CLAUDE.md
   gate rule (c)). `if (!surface) return { create: true, update: true, delete: true }` runs both for a context with no
   `definitions` (the documented registry-only fixture) and for a context that *has* `definitions` but whose surface lacks
   the entity.
   **Scenario:** the registry and the definitions disagree, for example on an entity whose raw definition failed to load
   or was filtered. The frontend then emits all three mutations, and `capabilities` for routes the backend does not
   generate. That is the pre-S6 bug class this slice exists to close, coming back silently.
   **Fix:** keep the permissive answer only when `ctx.definitions` is absent, and throw, naming the entity, when
   definitions exist but the surface has no entry. Better still, make `definitions` required, since production
   (`load-context.ts:243-248`) always sets it.

3. `src/emitters/frontend/emit-utils.ts:96-116`, `emit-api.ts:148-156`, `emit-entities.ts:50-56` and
   `emit-graph.ts:296,598`: **`<Child>WithBase` / `<Child>FlatInput` have no single owner, and "is a child" is decided
   twice.** `flatChild`'s docstring says it is "the ONE owner of that naming", but it returns no name. The
   `${className}WithBase` template literal is written in emit-api and twice in emit-graph, and `${className}FlatInput` in
   emit-api and three times in emit-entities. Existence is also decided twice:
   - emit-api and emit-entities gate on `flatChild`, which needs `inheritsOf(def)`, the base present in `ctx.entities`,
     and a string discriminator;
   - emit-graph gates the type import and the helper on REL-1's edge marker (`isInnerHop`, `rel.inherits === 'base'`).

   **Scenario:** suppose `flatChild` returns `null` while the REL-1 marker is set (the base is missing from the registry,
   or the discriminator does not resolve). Then `graph/<child>.ts` emits
   `import type { <Child>WithBase } from '../api/<child>'`, which the api file does not export, and the emitted tree stops
   compiling. Renaming the type means editing five sites in three files.
   **Fix:** `flatChild` returns `{ base, discriminatorProp, withBaseType, flatInputType }`. emit-api, emit-entities and
   emit-graph read the names from it, and emit-graph gates both `withBaseTypeImport` and `buildWithBaseHelper` on
   `flatChild(entity, ctx) !== null`. If the REL-1 marker and `flatChild` must agree, assert that once.

4. `src/emitters/frontend/emit-collections.ts:54-62`: **a third copy of the "resolved behaviours" rule.** `rowCarriesDates`
   restates "declared + implied by a pattern", and its comment names the owner it copies (`resolvedBehaviorNames`,
   `templates/entity/new/backend/entity-locals.js:1606`). `src/emitters/relations/build-graph.ts:78` (`behaviorNames`) is
   already a second, documented copy.
   **Scenario:** a fourth behaviour source is added, say pattern-level `behaviors:` or a capability that implies one. The
   backend and the relations manifest pick it up, the frontend does not, and a collection loses its `Date` parser while
   its table still has a timestamp column. That is silent: the parser is dropped and the row reads strings where its type
   says `Date`.
   **Fix:** lift `resolvedBehaviorNames(def)` into `src/behaviors/` or `src/patterns/implied-behaviors.ts`. Call it from
   `entity-locals.js` and from the frontend. The relations emitter can keep its throwing variant as a documented wrapper
   over the same list.

5. `test/_emitted-name-hygiene.ts:134` and `src/__tests__/emitters/frontend/inherits-graph.test.ts:240`: **the new
   value-position rule is opt-in, and its only caller checks only `api/`.** With `{ values: true }` over the whole emitted
   frontend tree of the frontend-smoke set, I count **84** violations: `store/*` has `Map` ×67 and `collections/*` has
   `URL` ×17. These are files that import an entity type and then use a lib global as a bare value. The comment ("many
   older emitters still `new Map`/`new Set` bare") states the known violations but gives no issue number. In effect this
   is a directory-scoped rule, the shape CLAUDE.md says no gate may take.
   **Scenario:** an entity named `map` (`Map`, which `reserved-entity-names.ts` does not reject) makes `store/index.ts`
   use a type-only import as a value (TS1361), and no hygiene gate fails.
   **Fix (DECISION, scope beyond this PR):** either turn `values` on for the whole emitted frontend tree and emit
   `globalThis.Map` / `globalThis.URL` in the store and collections emitters, or file an issue and keep the scope as a
   named expectation per CLAUDE.md (exact files, exact names, issue number, asserted present and sole) rather than an
   opt-in flag plus a single-directory walk.

6. `src/emitters/frontend/emit-store.ts:147-157`: **`as unknown as EntityHooks<any, any, any>` works around
   `createStore`'s signature** (`convention_workaround`). The comment explains the variance problem but gives no removal
   trigger. The canvas counter-example accepts a workaround only with a link to the upstream issue and a target.
   `@pattern-stack/frontend-patterns` is our own package.
   **Scenario:** every entity without a create or update route is fully type-erased at the store boundary. A real
   mismatch in its collection, api or keys types at that line would compile.
   **Fix:** open an issue in frontend-patterns (have `createStore` accept `EntityHooks<T, never, never>`, or type its
   hooks map so mutation variance does not apply) and link it in the comment. Until then, cast only the mutation
   positions, for example `Omit<…, 'useCreate' | 'useUpdate'>`, rather than the whole object.

### Nits

7. `src/emitters/frontend/emit-fields.ts:324`: the comment says "What the backend generates (its derived use cases)",
   but `writeRoutes` reads the HTTP **routes** (e5ee84bd changed that). Say "its derived HTTP routes".
8. `src/emitters/frontend/emit-utils.ts:115`: a hand-rolled snake→camel regex. `camelCase` exists in
   `src/config/file-naming.ts:55`, the module the frontend already takes `emittedStem` from. Use it.
9. `src/emitters/frontend/emit-store.ts:152,157`: `writeRoutes(e, ctx)` is called four times per entity. Compute it once
   per entity, for example `const noFullWrites = entities.filter(...)`, and reuse it for both the entry and
   `needsHooksType`.
10. `src/analyzer/serialize-graph.ts:7`: the analyzer imports `src/derived/api/project.ts` (REL-1's graph builder,
    include allowlists, pattern composition, the YAML loaders) for a one-line string. And `inheritsRelationId`
    (`project.ts:177`) is a second spelling next to `originId` (`project.ts:181`, `[doc.name, ...path].join('.')` over
    `fromYaml(['inherits'])` at `entity.ts:416`). The two agree only by construction. Put `inheritsRelationId` in a leaf
    module and define it from the same `['inherits']` path constant that `entity.ts` uses.
11. `src/emitters/frontend/emit-api.ts:165-177`: route **existence** now comes from `http.routes`, but the **verb and
    path** are still written by hand (`'/${plural}'`, `` `/${plural}/${id}` ``). They agree today: I checked every
    write route of every entity in the frontend-smoke set and none differs. Since the route is already found, print
    `route.verb` / `route.path` from it (follow-up; the path building predates this PR).
12. `CLAUDE.md:128`: "The frontend types a missing mutation away … — not a stub that rejects." The emitted api object does
    still carry a `Promise.reject` stub; it is typed `never`, so it cannot be called. Reword to "typed `never`, so it
    cannot be called; the body that rejects exists only because `EntityApi` requires the key".
13. `tools/studio/src/__tests__/fixtures/family-{graph,surface}.json` (657 + 9,442 lines) are manual snapshots, and no
    gate checks them against live output. They are fresh at the tip: I regenerated `project graph --json` and
    `project surface --json` for `test/fixtures/inheritance/entities/` and deep-compared them (ignoring `sourcePath`),
    and they are equal. But a derivation change leaves `schema-adapter.test.ts` green on stale JSON. This follows the
    existing `demo-surface.json` convention, so it is optional: a root test that regenerates and compares would let it
    fail on its subject.
14. `src/emitters/frontend/emit-entities.ts:48-55`: building the type arguments through
    `typeArgList` → `filled` → `pop` is hard to follow. Build the three arguments directly, then drop the trailing
    defaults.

### Checked and fine
- `writeRoutes` agrees with the `apiSurface.http.routes` that the backend's real `buildBackendLocals` prints, for every
  entity of the frontend-smoke set. The test can fail: `noCreate === 2`, plus per-handler equality.
- `projectSurface` passes `relationships: []`. `relationships` feeds only `unmodelled`, so route existence is unaffected.
- The emitted api clients use `globalThis.Error` / `Omit` / `Partial`; value-mode hygiene over `api/` is clean.
- The `leaves` naming in `targetNaming` uses `emittedStem`. The cross-mode check still covers leaf targets
  (`byPlural` spans every entity).
- `inheritsRelationId` is the one helper that both the derivation and `serialize-graph` call. Studio takes `relationId`
  from the payload and holds no literal for it.
- Studio's `baseKinds` uses the generator's `discriminatorKindsOf`, so there is no second `choices_of` resolver; the
  `inheritsEdit` refusals name the base.
- The unique-FK spine tier is fully gone: no `fkUnique` / `fkColumnUnique` / `unique-fk` remains in `src/` or
  `tools/studio/src`, and the spec mentions are dated revision notes.
- `run-smoke-frontend.ts` checks the inner joins, that `communication_part` has no `POST`, and `audit_entry`'s write
  requests and hooks. `usage/graph-usage.ts` adds real assignments and `@ts-expect-error` lines, which fail on TS2578
  once unused.
- `inheritance-fixtures-agree.test.ts` covers the frontend-smoke copy, and asserts `sync: electric` is present before
  stripping it.
- `test/smoke/_consumer-errors.ts` is unchanged: no new predicate and no directory carve-out in the tsc scoping. There are
  no inject templates.
