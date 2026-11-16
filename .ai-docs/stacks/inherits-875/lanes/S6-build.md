# Lane `inh-s6-build` — #875 slice S6: frontend graph, Studio, docs

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-875-s6-inherits-frontend`
- **Branch:** `dugshub/875-s6-inherits-frontend`, stacked on `dugshub/875-s5-inherits-http`. **Diff base:
  `dugshub/875-s5-inherits-http`** (use it in place of `main` everywhere COMMON.md says `main`).
- **Your scope:** RFC-0006 §13.2 **S6**, revision 3. Read §3.4 (the frontend), §13 and every "as built" note S1–S5
  left in the RFC, `docs/specs/FE-REL.md`, and CLAUDE.md's "Frontend Relation Graph" and "Studio" sections — their
  rules (one live query per to-many, the electric/non-electric error, the `api` deferral, junction rows not roots,
  depth 2, colour tables `{ light, dark }`) bind you.

## What to build

1. **Inner-joined child → base hop** (`src/emitters/frontend/graph-model.ts`, `emit-graph.ts` root joins): read the
   `inherits` marker S3 put on `RelationEdge`; the child-to-base hop is an **inner** join, so a child row does not
   exist on the client until its base does. The descriptor stays edge-for-edge equal to REL-1's.
2. **`<Child>WithBase` per `electric` child**, in its `graph/<child>.ts` (§3.4): the type (`Omit<Base, 'kind'> &
   Child` — check it matches the backend's flat output shape from S5), the query fragment `<plural>WithBase(q)`
   (`from` child `innerJoin` base on id — the caller adds where / orderBy / limit), and the hooks
   `use<Plural>WithBase()` and `use<Child>WithBase(id)`. Names through the existing naming helpers. A `sync: api`
   child gets no helper (its REST routes already return the flat shape).
3. **Fixtures:** `test/smoke/fixtures-frontend/entities/` gets `communication` and `meeting`, both `sync: electric`
   (plus whatever they reference, field-identical to the other copies — extend S2's fixture-agreement test to this
   location). The consumer-owned modules the frontend smoke needs come from `test/smoke/fixtures-frontend/consumer/`.
4. **Gates (A12, A13, A15):**
   - `src/__tests__/emitters/frontend/graph-golden.test.ts` and `test/frontend-graph-golden/`: both edges in the
     descriptor (A12 second half); re-bless only what this slice changes and say why.
   - `test/smoke/fixtures-frontend/usage/graph-usage.ts`: a real assignment from `useMeetingsWithBase()` to
     `MeetingWithBase[]`, a real field read across the base and the child, and a `@ts-expect-error` that only holds
     while the hop is non-optional (A13). `tsc` reports an unused `@ts-expect-error`, so it cannot rot.
   - **A15 second half:** turn the inner join into a left join, watch A13 go red under `just test-smoke-frontend`
     (or the golden), restore. Paste both runs.
5. **`generate.writes` on the frontend** (from S2's review): the frontend emitter does not read `generate.writes`, so
   an entity with writes off would get mutations aimed at routes that do not exist. Children have routes after S5,
   so check whether any case still applies; if it is a pre-existing, entity-general gap, **do not fix it here** —
   write it up for the coordinator (what, where, a repro) and record it in the RFC. One case S5's review found is
   this slice's own: a base whose every kind has a child (`communication_part`) has **no create route** after S5
   (`generateCreate: false`), yet the frontend still emits `useCreateCommunicationPart` aimed at the removed
   `POST /communication_parts`. Fix that one (the frontend must not emit a mutation for a route the backend does not
   generate — read the same derived fact, don't re-derive it), and add it to the frontend fixtures so a gate covers it.
6. **Studio** (`tools/studio/src/inspector/relationship-kinds.ts`, `tools/studio/src/graph/edge-kinds.ts`): one row
   each for `inherits` (label, cardinality, which options apply, where the YAML lands; colour/dash/width/arrowhead/
   legend copy as `{ light, dark }`). Every surface renders from those tables — no literal in a component. Check the
   Studio server's graph API (`src/studio/shared/api.ts`) carries the edge; if it needs a field, add it there.
   `just test-studio`; add a test that the legend shows the inherits row.
7. **Docs (A16):**
   - `CLAUDE.md`: a short section on `inherits:` / `discriminator:` / `match:` / `natural_key:` / `choices_of:`
     (what each emits, the rules that bite, where the code lives), and the generator-wide changes this stack made:
     enums in a leaf `<entity>.enums.ts`, one table-callback parameter `tCols`, composing modules import the home
     module, `upsertByNaturalKey` on every `natural_key` entity, the 63-byte name check. Keep it as dense as the
     rest of CLAUDE.md.
   - `consumer-skills/entities/yaml-reference.md` and `SKILL.md`: the new keys with one example each and the rules.
   - RFC-0006: status → **Implemented** (with the date and the PR stack), every "as built" note consistent, §11.2
     closed out (OQ-10/12/13/14 as built), and nothing in the body contradicting what was built.
   - **Issue comments for #780, #786, #787 — DRAFT ONLY.** Write them to
     `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/issue-comments.md` (one section per
     issue: what landed in #875, what remains there). Do **not** post them: the coordinator posts after Doug's word.
     #780's must say the single-row `upsertByNaturalKey` now exists on every `natural_key` entity with OQ-14's
     semantics; #786's that the `checks:` key and `min`/`max` stay there and an internal check builder exists;
     #787's that `match:` and the composite-FK emitter landed and the implicit same-tenant FK stays there.

## Must not touch

The backend templates (`templates/entity/new/backend/**`) and `runtime/`, except a doc comment.

## Gates (after your last edit; paste tails)

`bun run typecheck`, `just test-unit`, `just test-smoke-frontend`, `just test-studio`, and **`just test-all`**
(the whole CI suite), plus `just test-integration`.

## Report

Per COMMON.md. Include the generated `graph/meeting.ts` verbatim, the A15 red/green runs, and the path of the draft
issue comments.
