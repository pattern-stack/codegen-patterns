# S6 review fixes — lane `inh-s6-build`

The Opus review of `dugshub/875-s6-inherits-frontend` @ `f633680b` returned **ACCEPT_WITH_FIXES**: gates green, nine
should-fix findings, three nits. Fix on the same branch as new commits; COMMON.md still binds you. The reviewer's
scratch repros are under
`/private/tmp/claude-501/-Users-dug-Projects-worktrees-codegen-patterns-dugshub-875-s6-inherits-frontend/b4ba4593-5dda-4652-9c54-0ec231f3c530/scratchpad`
(`disc/` for 1, `v787/` for 9). Re-verify each finding before fixing it. **DECIDED** items are coordinator decisions.

1. **`<Child>WithBase` hard-codes `'kind'`** (`emit-graph.ts:602`). With a discriminator named `category` and an
   ordinary base field `kind`, the real `kind` drops out of the type. Omit camelCase(the base's **discriminator**),
   read from the definitions (or drop the Omit if the intersection already narrows — say which). Fix the doc comment
   and RFC §3.4's sketch. Test with a non-`kind` discriminator.
2. **"No create route" derived a second time** (`src/schema/inheritance.ts:280-306` vs `familyReads` in
   `templates/_shared/inheritance.mjs:368-398`), plus a third `choices_of` resolver. `templates/_shared/` is not
   fenced. Put `baseOnlyKinds(def, defs)` (and the predicate) in `src/schema/inheritance.ts`, have `familyReads` call
   it, and reuse the existing `choices_of` resolver rather than adding one. Make the parity test read the backend's
   real `generateCreate` (so a change at `entity-locals.js:2266` turns it red), and fix the comment citing a
   non-existent `no-create-route.test.ts`. Note: ADR-046 (now on `main`) will move existence facts into
   `src/derived/api/` in the next phase — keep this one owner simple so that move is one edit.
3. **The create stub still lies in three places.** **DECIDED:** type it away — emit `createEntityHooks<Base, never>`
   (frontend-patterns' second type parameter is `TCreate`), type the api stub `create: (_data: never)`, set
   `capabilities.create: false` in `fields/<entity>.ts`, and route all three through `hasCreateRoute` so its doc
   comment is true. Gate: a `@ts-expect-error` on `communicationPartHooks.useCreate().mutate({})` and on
   `communicationPartApi.create({})` in `graph-usage.ts`. Correct CLAUDE.md:123.
4. **Date parsers dropped from declared behaviours only** (`emit-collections.ts:51-55`): use the resolved behaviours
   (declared + pattern-implied, the backend's rule) and `timestampBehaviorNames()` from `src/behaviors/index.ts`
   instead of a hard-coded list. Unit test with a pattern that implies a timestamp behaviour.
5. **A child's REST client is typed as the table row, not the flat HTTP contract** (`api/meeting.ts`: `create(data:
   Partial<Meeting>)` cannot carry `occurredAt` / `source` / `externalId`; `get` / `list` typed `Meeting` while the
   body is flat). **DECIDED: type it** — the child's api client (both sync modes) uses the flat type for reads and a
   flat create/update input without `kind` (derive it from the same types the `WithBase` helper uses; one owner).
   Gate in `graph-usage.ts`: a flat create literal with base fields compiles; reading a base field off `get` compiles.
6. **Studio** (`src/studio/server/relationships.ts:181-182`): fix the comment (`doc.setIn` appends); refuse at
   preview/write time an `as:` the base does not list and a base without `discriminator:` (the base file is already
   read at `:179`), naming the base — test both.
7. **consumer-skills/entities/yaml-reference.md:310**: the nullable-match CHECK is one-directional
   (`<fk> IS NULL OR <derived> IS NOT NULL`); fix the wording (and the drafts, 9).
8. **RFC:** tick A1–A11 with S1–S5 evidence (test names); un-tick A16 (comments not posted — the coordinator posts
   after Doug's word); A12's evidence is `inherits-graph.test.ts`; §6's child `upsertByNaturalKey` returns
   `{ row, created, baseCreated }`; correct RFC:1656; §10 rows 9–10 list the files actually touched.
9. **Issue-comment drafts** (`.ai-docs/stacks/inherits-875/issue-comments.md`): #787 — `match:` covers only a
   **derived** local column; #787's shared-declared-column case (its own `section`/`revision` example, refused by M2)
   **remains**; also list `cross_tenant:` and the use-case 422 as remaining; Q3 is answered. #786 and #787 — the CHECK
   is one-directional. #780 — the update policies are overwrite / coalesce / keep-first (not invented names), and
   `findByNaturalKey` remains. "for every entity that declares an enum". #786 — describe the internal check as
   `tableConstraints` entries with `builder: 'check'`.
10. **SKILL.md** "Inheritance in one example": two yaml blocks, one per file.
11. **Record only** (RFC S6 note): the nested-import loop in `emit-graph.ts:279` imports unused collections/types
    (TS6133 under a consumer `noUnusedLocals`) — pre-existing FE-REL behaviour; do not fix.
12. `hasCreateRoute`'s comment: `generateCreate` also reads `generateWrites` — fix the comment (or the function, if
    it should).

Gates after your last edit (paste tails): `bun run typecheck`, **the whole `just test-all`**, `just test-integration`.
Report per COMMON.md with a finding → commit / test table. After that, stop: the next phase (rebase onto `main` and
ADR-046) gets its own brief.
