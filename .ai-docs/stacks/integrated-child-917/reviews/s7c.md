# Review — S7c (#917): the integration layer is family-blind

- **Branch:** `dugshub/917-s7c-integrated-emitter`, range `53471b30..f02d9c3a` (one commit, `f02d9c3a`).
- **Reviewer lane:** `s7c-review`. Read-only: every mutation below was restored with `git checkout --`. The tree is clean.

## Verdict: `ACCEPT_WITH_FIXES`

The implementation is correct. The flattened child deep-equals the parsed flat control: same keys, same field order
(`tenant_id, title, subject, sent_at`). I checked the emitted trees in four scratch variants beyond the committed fixture,
and in every one the family and flat trees are byte-identical:
- a `belongs_to` on the base;
- `calendar` served, so the second child renders;
- `emit_changes: true`;
- `delete: tombstone` with `exclude_fields: [subject]`.

The gate is real: making `flattenInheritedChild` a no-op turns it red, with exactly the 5 lines the RFC entry names.

Three findings need fixing:
1. The flat-shape rule is about to get a second field-level owner on S7b, and the two owners already disagree.
2. The gate's fixture leaves several emitter paths unrendered. An `inherits:` branch in those paths passes it.
3. One integration YAML knob is not family-blind.

Counts: **blocker 0 · should-fix 3 · nit 3.** No `DECISION`.

### Gates (run on `f02d9c3a` after all mutations were restored)

```
bun run typecheck         → tsc --noEmit -p tsconfig.build.json   (clean)
just test-unit            → 5036 pass, 3 skip, 0 fail (312 files)
just test-integration-emit→ 60 pass, 0 fail, 2 snapshots
just test-baseline        → ✅ All tests passed!
```
Hygiene grep over the diff and the commit message: no hits.

### Mutations run

| # | Mutation | Committed gate | Note |
|---|---|---|---|
| M1 | `flattenInheritedChild` returns `def` at the top | **red** (`same bytes`, snapshot): −5 lines `title`×2, `tenantId`, `createdAt`, `updatedAt` | matches the RFC's "what it caught" |
| M3 | flatten merges only the child's `relationships` (drops the base's) | **green** | with a base `belongs_to` (scratch), M3 drops `mailboxExternalId: null` from the write and `mailboxId: row.mailboxId` from the view |
| M4 | `emitChanges` is false when the raw def has `inherits:` (`adapter-emission-generator.ts:1167`) | **green** | with `emit_changes: true` on both fixtures (scratch), M4 drops the change-emitter, its import and its binding from the assembly |

---

## Findings

### 1. should-fix · Quality — the child's flat integration shape is getting two field-level owners, and they already disagree

`src/schema/inheritance.ts:418` (`flattenInheritedChild`); `src/cli/shared/adapter-emission-generator.ts:977`.

**The question asked: does the backend already derive a child's flat shape?** On this branch (S7a + S7c) it does, but only
at the **type level**, in emitted TypeScript. None of these can feed `buildSinkInput`, which needs a field list at
generation time:
- the Zod DTOs: `BaseCreateSchema.omit({ kind }).extend({…})` (`templates/entity/new/backend/dto/create.ejs.t:16-18`) and
  `BaseOutputSchema.extend({ ...Own.omit({ id }).shape })` (`dto/output.ejs.t:40-42`);
- `<Child>Flat = Flattened<Child & { base }, relKey>` and `<Child>FlatInput` (`repository.ejs.t:231-250`), plus the
  runtime `flattenBase(row, relKey)`;
- the frontend's `<Child>WithBase = Omit<Base, disc> & Child` (`src/emitters/frontend/emit-api.ts:153-156`). `flatChild()`
  (`emit-utils.ts:153`) returns names only.

`familyReads().child` (`templates/_shared/inheritance.mjs:330-360`) carries the base's schema names and import paths, never
a field list. So `flattenInheritedChild` is the **first** field-level owner, and does not duplicate anything on this branch.
Two parts of it overlap rules that do have owners, and both are output-equivalent today:
- `tenant_scoped` is copied from the base. `resolveChildTenancy` (`src/schema/tenancy.ts:222`, which calls itself "the ONE
  place a later slice reads it from") cannot replace the copy: the sink needs `tenancy.adopted`, and R10 guarantees the
  base adopts its column.
- The discriminator is omitted, as the DTOs omit it.

**The second owner is S7b.** The S7b worktree (uncommitted at review time, branch still at `53471b30`) is writing its own
field-level flattening for the **repository's** half of the integration surface:
- `templates/entity/new/backend/entity-locals.js:2705-2732` builds
  `integrationFields = [...baseFlat, ...nonFkFields]`, with `integrationTimestamps` and `integrationSoftDelete` from the
  base and the tenancy from `inheritedChild.tenant`;
- the result goes to `buildIntegrationSurface`.

The sink half is `buildSinkInput`. `src/__tests__/backend/490-sink-knobs-contract.test.ts` exists because the integration
surface is "derived TWICE … by two pieces of code that share no module". Each half is now getting its own flattening in
front of it.

**The two owners already disagree.** `flattenInheritedChild` merges the base's `relationships`, so a base `belongs_to`
becomes a sink FK key and a view column. S7b's version does two things instead:
- it filters the base's FK columns out of `baseFlat` (`baseFkColumns`, `entity-locals.js:2710`);
- it passes only the child's own `belongsTo`.

**Failure scenario.** Give `inbox_item` a `belongs_to: mailbox`. Then:
- the sink prints `mailboxExternalId: null` in the write and `mailboxId: row.mailboxId` in the view (verified, scratch
  variant);
- the S7b repository's `<Child>IntegrationWrite` / `Projection` would carry no `mailbox`, and its `fkResolvers` would have
  no entry for it;
- nothing gates the two halves for a child. `490-sink-knobs-contract` and `assembly-contract` use synthetic plain
  entities, and the committed fixture's base has no `belongs_to`.

The S7b half of this is **observed, not verified**: it is uncommitted work in progress.

**Fix (coordinator, across S7b/S7c):**
1. Make `flattenInheritedChild` the one owner, and have S7b's entity-locals take its field / relationship / behaviour /
   tenancy lists from it.
2. S7b runs `processFields` per field, and a base enum must resolve against the base. So the owner should also return each
   field's **owner**, e.g. `flatChildShape(def, defs) → { fields: [{ name, field, owner }], relationships: [...], behaviors,
   tenant_scoped }`. `flattenInheritedChild` then becomes the sink's thin projection of it.
3. Add the family child to the existing "derived twice" lock (`490-sink-knobs-contract.test.ts`), so the sink and
   repository surfaces are compared for a child.
4. The S7c as-built entry should say why a new owner was needed (the backend's flat shape is type-level only) and that S7b
   consumes it. Today it says "the one owner" without the reason.

### 2. should-fix · Quality — the gate cannot fail on several paths it claims to cover

`test/integration-emit/family-blind.test.ts`; `test/fixtures/integrated-child/definitions/providers/google.yaml:12`.

**The question asked: does the gate cover every integration emitter?** Structurally, mostly yes:
- `emitAdapters` flattens at its entry (`:977`);
- the downstream emitters (`sink-emission-generator`, `assembly-emission-generator`, `change-emitter-emission-generator`)
  receive precomputed inputs or names, never a definition, so they cannot see `inherits:`;
- `provider-module-generator` reads the raw set, but only `entity.surface`;
- `desugarEmitChangeEvents` reads only the name and `emit_changes`;
- `integration-scaffold-locals` reads no entity.

**But the gate's fixture leaves paths unrendered,** and an `inherits:` branch in any of them passes:
- **The second Integrated child (D3) is never rendered.** The provider serves only `[mail]`, so `calendar_event`
  (`surface: calendar`) emits nothing in either tree. The committed snapshot has 0 `calendar` references.
- **A base `belongs_to` is not in the fixture.** M3 stays green (see the table).
- **`emit_changes` is not in the fixture,** so the change-emitter is never rendered (0 hits in the snapshot). M4, an
  `inherits:` branch in `emitAdapters`, stays green.
- **`emitAdapters` still has `opts.entities` (the raw, unflattened set) in scope after `:977`.** Nothing stops a later
  edit from reading it, and M4 is exactly that edit.

The implementation is right on all of these: the combined scratch variant (base `belongs_to` + `calendar` served +
`emit_changes` + `delete: tombstone` + `exclude_fields: [subject]`) gives byte-identical trees, 24 files. So this is a gate
gap, not a defect.

**Fix:**
1. Serve `calendar` in the fixture's provider, and add the flat `calendar_event` to `integrated-child-flat`.
2. Give the base a `belongs_to`, with a target entity in both sets.
3. Set `integration.sink: { emit_changes: true, delete: tombstone, exclude_fields: [<own field>] }` on a child and on
   its flat twin.

The fixture is S7a's, and S7b copies it into the baseline set, so the coordinator should sequence this change. Optionally,
stop the body of `emitAdapters` from reaching `opts.entities`, for example by destructuring it once into the flatten call.

### 3. should-fix · Adherence — `integration.sink.exclude_fields` is not family-blind

`src/schema/entity-definition.schema.ts:1480`.

The S7 rule includes "the integration YAML". `exclude_fields` is checked against the entity's **own** `fields:` in a
single-file refine. So:
- a child cannot exclude a base field;
- its flat twin can;
- `buildSinkInput` would honour the exclusion, since it reads the flat fields.

**Verified.** The same `integration: { sink: { exclude_fields: [title] } }` was appended to both `mail_message` files:
- the flat control loads;
- the family child is refused with: `exclude_fields: 'title' is not a declared field. Declared fields: subject, sent_at at
  'integration.sink.exclude_fields.0'`.

**Fix:**
1. For a child, run the declared-field and FK-column checks in the cross-entity validator (`validate-inheritance.ts`)
   against `flattenInheritedChild`'s fields and relationships, and skip the single-file check when `inherits:` is set.
2. Add the case to the gate's fixture (finding 2).

This is schema code (S7a's territory, outside S7c's emitter-only scope), so it either goes into S7a's fix cascade or into
S7c with a named scope exception. I checked the other knobs: no other integration knob is validated single-file against
own fields (`delete:` has no behaviour check).

Not a `DECISION`: the S7 rule ("a provider sync has no opinion on the family hierarchy") already says a child accepts what
its flat twin accepts. It becomes one only if the coordinator would rather refuse with a message naming the base and list
it under §8. My recommendation is to accept.

### 4. nit · Adherence — the S7a fixture bullet in the RFC is now stale

`docs/rfcs/RFC-0006-joined-table-inheritance.md:1998` says "Validation tests only; no baseline, smoke, scaffold or
integration-emit set holds it." S7c makes the integration-emit gate read it, and adds `definitions/providers/google.yaml`
under it. Update the bullet in this PR (specs are living docs).

### 5. nit · Quality — `as never` casts hide the flatten's input contract

`src/cli/shared/adapter-emission-generator.ts:977` (`flattenInheritedChild(e as never, opts.entities as never) as typeof
e`); `src/schema/inheritance.ts:433` (`normalizeBehaviorConfig(b as never)`).

`EmitAdaptersEntity` declares neither `inherits` nor `discriminator`, and the flatten is typed over the full
`EntityDefinition`. So the compiler checks nothing between them. Two ways the casts would hide a break:
- if the CLI ever passed a projection without `inherits`, the flatten would silently become a no-op (it returns the def
  unchanged);
- if `EmitAdaptersEntity` changed shape, nothing would complain.

**Fix:**
- type the flatten over a structural input holding only the keys it reads (`entity`, `fields`, `behaviors`,
  `tenant_scoped`, `relationships`, `inherits`, `discriminator`);
- add `inherits?` and `discriminator?` to `EmitAdaptersEntity`, which states truthfully what the emitter receives.

### 6. nit · Quality — dead alias and stale comment in the gate

`test/integration-emit/family-blind.test.ts:33-34`: `const surfaced = entities;` sits under a comment about an `only` that
does not exist. Drop the alias and the comment.

---

### What I checked and found sound

- **`files()` + the two equality tests together assert full tree equality.** The snapshot pins the family tree, and it
  equals the flat tree. `snapshot.test.ts.snap` is unchanged.
- **The flatten handles name collisions safely.** R4 refuses a child field that shadows a base field
  (`R4 — 'mail_message' declares field 'title', and its base 'inbox_item' declares field 'title'…`), so the override
  order cannot matter.
- **The production call site passes the whole set,** as the test does (`src/cli/commands/entity.ts:869`, the full
  `entityDefs`), so the base is always found.
- **`assembly-contract.test.ts` takes synthetic inputs** and enumerates no fixture set, so brief item 4 needed no family
  case.
- **RFC claims verified:** the M1 result, the 5-line first diff, and "nothing else differed" (M1 changed only the sink).
