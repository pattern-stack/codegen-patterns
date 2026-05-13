# Relationship pattern audit — wave-1 CRM coverage + cross-entity emission reference

**Audit issue:** [pattern-stack/dealbrain-integrations#62](https://github.com/pattern-stack/dealbrain-integrations/issues/62) ("Relationship pattern: audit + smoke test against crm-domain YAML")
**Spec:** [`.ai-docs/stacks/codegen-app-patterns/specs/cgp-62.md`](../.ai-docs/stacks/codegen-app-patterns/specs/cgp-62.md) (revision 4)
**Follow-up gap-closure:** [pattern-stack/codegen-patterns#358](https://github.com/pattern-stack/codegen-patterns/issues/358)
**Upstream commits audited:** `8a5bc13`, `ef5e898`, `269ab3f`, `01bb917`

This audit verifies the Relationship pattern (shipped in the four commits above) covers what the wave-1 `crm-domain` stack needs, and documents the cross-entity emission mechanism that `junction-association-codegen` (CGP sibling leaf) will reuse. It is verification-only — no template, parser, analyzer, or schema changes. The gap surfaced empirically is owned by `codegen-patterns#358`, not by this audit.

The audit is structured around the architecture defined in cgp-62 r4 — service-layer composition is the **core contract** for cross-entity access; Drizzle's `relations()` const is an **opt-in extension** for hand-written ad-hoc queries. The audit names what today's templates emit, what they don't, and how the planned junction codegen plugs into the contract.

---

## 1. Canonical API path (core) — service-layer composition via FK + repo

Cross-entity access in generated code goes through **service methods** that compose by calling multiple **single-table repos**. There is no SQL JOIN at this layer. The same composition pattern runs on the backend and on the ElectricSQL-replicated client (§2).

### Worked examples

**Inverse `has_many` traversal (paginated, two queries via FK + repo):**

```typescript
// AccountService.contacts(id) — paginated has_many over the inverse FK.
async contacts(
  accountId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<Contact[]> {
  return this.contactRepo.findByAccountId(accountId, opts);
}
```

**Forward `belongs_to` traversal (scalar):**

```typescript
// ContactService.account(contactId) — single FK dereference.
async account(contactId: string): Promise<Account | null> {
  const contact = await this.repository.findById(contactId);
  return contact ? this.accountRepo.findById(contact.accountId) : null;
}
```

**Junction-mediated `has_many` (paginated, composed join-shape DTO):**

```typescript
// OpportunityService.contacts.list(id) — many-to-many via junction.
async list(
  opportunityId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<Array<{ entity: Contact; link: OpportunityContactLink }>> {
  const links = await this.junctionRepo.findByOpportunityId(opportunityId, opts);
  const contacts = await this.contactRepo.findManyByIds(links.map((l) => l.contactId));
  return links.map((link) => ({
    entity: contacts.find((c) => c.id === link.contactId)!,
    link,
  }));
}
```

Two queries, no SQL JOIN. The repos are pure single-table CRUD. The composition lives in the service.

### Shape contract (locked by cgp-62 r4)

| Surface | Contract | Source |
|---|---|---|
| `has_many` traversal | Paginated by default; opts `{ cursor?: string; limit?: number }` | maintainer answer Q2 (cgp-62 r4) |
| Junction `.list()` return | `Array<{ entity: TargetEntity; link: JunctionLink }>`. Outer key `entity` | maintainer answer Q4 |
| Junction association placement | Mirrored on both parent services, delegating to one shared junction service | maintainer answer Q3 |
| `with: { ... }` joins in generated bodies | **Forbidden** — extension-path leak | cgp-62 r4 §"Drizzle `relations()`…" |

### Junction-association mirroring — heuristic for opt-out

Default: **always mirror.** Skip mirroring only when **both** hold:

1. The inverse method would have no natural caller (e.g. junction whose semantics are inherently directional and consumers never start from the passive side).
2. The inverse method would require a name that reads as misleadingly to anyone using it.

Both conditions are subjective; mirror unless the implementer can name a specific shorter, clearer name — and even then, prefer mirror. None of wave-1's pairings (`opportunity_contact`, `account_contact`) trigger the opt-out.

---

## 2. ElectricSQL-parity rationale

The project replicates tables to the client via ElectricSQL (table-shaped replication, not query-shaped). Joins cannot resolve prior to replication: the client receives `accounts`, `contacts`, `opportunities`, and each junction table as **separate replicated rowsets**, then composes locally.

If the backend composes the same way — service-layer methods calling single-table repos — then **one composition pattern exists across both sides**. Backend `OpportunityService.contacts.list()` and a client-side `OpportunityModel.contacts.list()` have identical shapes, identical query counts, identical pagination semantics, identical edge cases. Pagination, in particular, falls out naturally: cursor-based pagination over a junction-table query has the same shape on backend (Postgres cursor) and client (Electric local-replica cursor).

The alternative — backend uses Drizzle's `db.query.opportunities.findMany({ with: { contacts: true } })` while the client composes locally — forks the code paths *and* the mental model. The client never gets the join; only the backend does. Code review, debugging, and reasoning about query cost all bifurcate.

This is the project's CLAUDE.md **"core contract + opt-in extensions"** principle applied at the access-pattern boundary:

- **Core** — service-layer composition via FK + repo calls. Portable across backend and client. All generated cross-entity API methods MUST use this.
- **Extension** — Drizzle's `relations()` + `with: { ... }` query helper. Backend-only. Useful for hand-written ad-hoc queries that knowingly will not run client-side. Generated code MUST NOT use it.

---

## 3. Empirical state — what today's templates actually emit

The four cited commits ship two distinct things sharing the name "relationship". The wave-1 stack uses one of them; both are documented because `junction-association-codegen` will plug into the same emission layer.

### (A) First-class relationship definitions — wave-1 does NOT use

Top-level `definitions/relationships/<name>.yaml` parsed by `loadRelationshipFromYaml()` (`src/utils/yaml-loader.ts`). Produces its own junction entity via the `templates/relationship/new/` Hygen pipeline (entity + repo + service + DTOs + controller + module + use-cases). Shipped by `8a5bc13` (schema/parser/analyzer) and `ef5e898` (templates + CLI). Discovery + barrel inclusion via `collectRelationships()` in `src/cli/shared/barrel-generator.ts:156`.

### (B) Per-entity `relationships:` block — wave-1 USES this

`belongs_to` / `has_many` / `has_one` declared inside an entity YAML. Two pipelines process this differently.

#### (B-clean) Clean architecture — partial composition surface, FULL `relations()`

```
templates/entity/new/prompt.js:838-883
    → buckets relationships into `belongsToRelations` / `hasManyRelations` / `hasOneRelations`
    → derives Pascal/plural/foreign-key permutations once, reuses across templates

templates/entity/new/prompt.js:887-912
    → checkEntityExists() per relationship target
    → annotates rel.targetExists (why baseline tests two-pass)

templates/entity/new/backend/database/schema.ejs.t:224-244
    → emits <plural>Relations = relations(<plural>, ({ one, many }) => ({ ... }))
    → belongs_to → one(<targetPlural>, { fields: [...], references: [...] })
    → has_many   → many(<targetPlural>)
    → has_one    → one(<targetPlural>)

templates/entity/new/backend/domain/repository-interface.ejs.t:61-63
    → emits findBy<FK>Pascal(id, include?: <Class>With): Promise<<Class>[]>
    → the `include?: <Class>With` parameter is *extension-path shape*
      (Drizzle `with:` syntax) leaking into the repo *interface* — an
      anti-pattern under the reframe; the audit recommends dropping it
      (executed inside codegen-patterns#358, not here).

templates/entity/new/backend/database/repository.ejs.t:362-380
    → implementation: `db.query.<plural>.findMany({ where: eq(...accountId, id),
      with: this.buildWithClause(include) })`. Same `with:` extension-path leak.

templates/entity/new/backend/domain/entity.ejs.t:57-65, 95-103
    → optional eager-loaded readonly fields on the domain class
      (`public readonly contacts?: Contact[]`). Again `with:`-flavored shape.
```

**What's missing under the canonical contract (gap #358):** no template consumes `hasManyRelations` to emit a **service method** or a repo method on the inverse-side entity. `AccountService.contacts(accountId)` does not exist in the generated output.

#### (B-clean-lite-ps) Clean-Lite-PS — UNIDIRECTIONAL `relations()`, NO composition surface

```
templates/entity/new/clean-lite-ps/prompt-extension.js:312-362
    → processBelongsTo() — same partition pass as clean, but only `belongs_to`
    → there is NO processHasMany or processHasOne — `has_many` declarations
      pass through codegen with no emission anywhere.

templates/entity/new/clean-lite-ps/prompt-extension.js:820
    → hasRelationsBlock = belongsTo.length > 0
    → an entity with only has_many (no belongs_to) emits NO relations() const at all.

templates/entity/new/clean-lite-ps/entity.ejs.t:59-69
    → emits <plural>Relations = relations(<plural>, ({ one }) => ({ ... }))
    → iterator: clpBelongsTo (line 62). NO many() call. NO has_many iteration.

templates/entity/new/clean-lite-ps/{service,repository}.ejs.t
    → grep result: ZERO references to relationships / belongsTo / hasMany.
    → No findBy<FK>Id on the repo. No inverse-side service method on the target.
```

**Clean-lite-ps gap is the larger one** — it omits both the composition surface *and* half of the `relations()` table metadata.

### Where the gap is closed

[pattern-stack/codegen-patterns#358](https://github.com/pattern-stack/codegen-patterns/issues/358) — "Emit service-layer composition methods for per-entity `relationships:` block (FK-based, no Drizzle joins)". The issue body cites the templates above by file:line, names the gap on both pipelines, restates the canonical shape from this audit, and references this doc as the contract reference. The smoke test in this leaf ships against today's codegen output, not against the post-#358 surface — see §6 for the negative-assertion test surface that names the gap.

### Bug shipped in this PR — clean-lite-ps self-ref typecheck failure

Building the smoke surfaced an unrelated TypeScript bug in the clean-lite-ps self-ref emission. The `references(() => accounts.id, { onDelete: 'restrict' })` callback fails TypeScript strict-mode typecheck with TS7022/TS7024 (circular initializer / implicit any) when the FK target is the same table — `accounts` is being defined when the callback tries to read it.

The bug existed at commit `fe7b9c8` (cgp-62 r4 spec) and was not caught by `test-baseline` because baseline tests do snapshot comparison, not `tsc --noEmit`. The default smoke didn't catch it because its fixtures had no self-refs.

Fix shipped here (small, surgical, in the same PR — see CLAUDE.md "specs are living documentation"):

- `templates/entity/new/clean-lite-ps/prompt-extension.js` — surfaces a `clpHasSelfFk` flag (`belongsTo.some(r => r.isSelfFk)`).
- `templates/entity/new/clean-lite-ps/entity.ejs.t` — annotates the `references()` callback with `(): AnyPgColumn => …` when the FK is self-referential; imports `AnyPgColumn` as a type-only import from `drizzle-orm/pg-core` when needed.

The fix is gated on `isSelfFk` so non-self-FK output is unchanged. The `clean` pipeline's `schema.ejs.t` (lines 224-244 — `relations()` emission) emits a similar self-ref shape and is likely vulnerable to the same bug, but baseline coverage doesn't run `tsc` so it's unverified; **out of scope here** — file as a follow-up if a `clean`-arch smoke ever runs typecheck on a self-ref fixture.

### Why the wave-1 hand-written services are not blocked on #358

`crm-domain` wave-1 work hand-writes the canonical composition methods against the contract in §1. Hand-written code serves as the executable spec for #358; when #358 lands, generated services replace hand-written services mechanically (`.ai-docs/plans/codegen-app-patterns.yaml` → `architectural_notes.cross_entity_access.canonical_shape` → `external_dependencies` block).

---

## 4. Drizzle `relations()` as table metadata (opt-in extension)

The `<plural>Relations = relations(<plural>, ({ one, many }) => ({ ... }))` const ships from both pipelines (in different completeness — §3). What it provides:

- **Typed bidirectional navigation at the schema layer** (not the service layer).
- **Hand-written `db.query.X.findMany({ with: { Y: true } })`** for ad-hoc backend queries that knowingly will not replicate (admin tools, reports, migrations, debugging).
- **Zero runtime cost if unused** — it's a typed const, not a query plan.
- **Does not break ElectricSQL parity.** ElectricSQL replicates the underlying tables regardless of what consts the schema file exports; `relations()` is type information for hand-written queries, not a runtime requirement.

**Generated service methods MUST NOT use `with:` joins.** They go through the canonical composition path (§1). The `relations()` const is an extension the templates ship for free; consumers who reach past the service layer accept they're using a backend-specific path.

This mirrors CLAUDE.md's BullMQ-backend example: not pretending all backends are equivalent, just giving consumers the choice to opt into backend-specific capability.

### Resolution (cgp-62 r4 Q5): **keep `relations()` emission as-is**

It's free typed metadata. Dropping it would force every ad-hoc backend query to fall back to raw SQL or `db.select().from().leftJoin()` boilerplate. The cost-benefit clearly favors keeping. Generated code's discipline (no `with:`) is enforced at the audit/lint layer, not at the schema-emission layer.

---

## 5. CRM-domain coverage table

Each wave-1 `crm-domain` relationship shape, the entity that declares it, the upstream commit that supports it, and what's emitted today.

| Shape | Declared in | Supporting commit | Clean emit | Clean-Lite-PS emit |
|---|---|---|---|---|
| Self-ref `belongs_to` (`account.parent_account_id` → `account`) | `account.yaml` | `269ab3f` (clean-lite-ps self-ref relation key fix) + `8a5bc13` (parser/schema) | `parentAccount: one(accounts, { fields: [...], references: [...] })` in `<plural>.schema.ts` | `parentAccount: one(accounts, { fields: [...], references: [...] })` in `account.entity.ts` |
| Cross-entity `belongs_to` (`contact.account_id` → `account`) | `contact.yaml` | `8a5bc13` + `ef5e898` | `account: one(accounts, ...)` + `findByAccountId(...)` on repo | `account: one(accounts, ...)` in `contact.entity.ts`. No `findByAccountId`. |
| Cross-entity `belongs_to` (`opportunity.account_id` → `account`) | `opportunity.yaml` | `8a5bc13` + `ef5e898` | `account: one(accounts, ...)` + `findByAccountId(...)` on repo | `account: one(accounts, ...)` in `opportunity.entity.ts`. No `findByAccountId`. |
| Inverse `has_many` (`account.contacts`) | `account.yaml` | `8a5bc13` (schema bucketing) | `contacts: many(contacts)` in `accounts.schema.ts`. **No `AccountService.contacts()` method.** | **No emission.** `has_many` is dropped entirely. |
| Inverse `has_many` (`account.opportunities`) | `account.yaml` | `8a5bc13` | `opportunities: many(opportunities)` in `accounts.schema.ts`. **No `AccountService.opportunities()` method.** | **No emission.** |
| Barrel-import-depth resolution (cross-entity refs in `_Relations` consts) | All three | `01bb917` (barrel-generator schema-aware paths) | Resolved in `<plural>.schema.ts` cross-imports | Resolved in `<plural>/<name>.entity.ts` cross-imports (different depth, same mechanism) |

**Wave-1 uses clean-lite-ps**, so the canonical composition surface (`AccountService.contacts()`, `OpportunityService.contacts.list()`, etc.) is hand-written until #358 lands. The shape contract for the hand-written code is §1 above.

### Tracker location

`crm-domain` lives in `pattern-stack/dealbrain-integrations` (the wave-1 consumer repo), not in this codegen-patterns repo. The plan referenced here is `dealbrain-integrations/.ai-docs/stacks/crm-domain/plan.yaml`; the entity YAML lives in `dealbrain-integrations/definitions/crm/`.

---

## 6. Smoke test surface

Three CRM fixtures under `test/smoke/fixtures/crm/`:

- `account.yaml` — self-ref `belongs_to: parent_account` (on `parent_account_id`) + `has_many: contacts` + `has_many: opportunities`.
- `contact.yaml` — `belongs_to: account` (on `account_id`).
- `opportunity.yaml` — `belongs_to: account` + enum `stage`.

Invoked via `bun test/smoke/run-smoke.ts --scenario relationship` (`just test-smoke-relationship`). The harness body is unchanged from the default scenario; the `--scenario` flag swaps the `FIXTURES_DIR` and gates a single `assertRelationshipEmission()` call after `entity new --all`. Wired into `test-all`.

Assertions (in `test/smoke/run-smoke.ts`):

| Shape | Assertion |
|---|---|
| Self-ref `belongs_to` (regression of `269ab3f`) | `parentAccount: one(accounts, ...)` in `account.entity.ts` |
| `relations()` const presence | `export const <plural>Relations = relations(<plural>` in each of `account.entity.ts`, `contact.entity.ts`, `opportunity.entity.ts` |
| Cross-entity `belongs_to` (contact → account) | `account: one(accounts, { fields: [contacts.accountId], references: [...] })` in `contact.entity.ts` |
| Cross-entity `belongs_to` (opportunity → account) | `account: one(accounts, { fields: [opportunities.accountId], references: [...] })` in `opportunity.entity.ts` |
| Barrel-import-depth (regression of `01bb917`) | `bunx tsc --noEmit` succeeds (TS2307 would surface here) |
| **Gap-naming negative assertion** | `assertNotContains(/\bmany\(/, accountSchema)` — clean-lite-ps drops `has_many`; flip to positive after #358 |

The negative assertion is deliberate. Tests should fail if clean-lite-ps starts emitting `many(` for `has_many` — at which point #358 has landed and the test should be updated to a positive assertion in the same PR.

**Not asserted:** service-composition surface (`AccountService.contacts()`, etc.). Today's templates don't emit it. Follow-up smoke assertions live with #358.

---

## 7. The r2 "Option A vs Option B" framing dissolves

A prior strategy revision (cgp-62 r2, [comment 4432870852](https://github.com/pattern-stack/dealbrain-integrations/issues/62#issuecomment-4432870852)) asked: "Do both halves of a `relationships:` block need to be declared, or should codegen synthesise the inverse?" Recorded here for context — the question only mattered under a Drizzle-`with:`-centric framing.

`db.query.accounts.findMany({ with: { contacts: true } })` requires Drizzle's `relations()` graph to be bidirectional, which requires both halves declared. Under that framing, "synthesise the inverse" looked like an ergonomic win.

Under the service-layer composition reframe (cgp-62 r3+r4):

- `AccountService.contacts(id)` is implemented as `this.contactRepo.findByAccountId(id, opts)`. It needs **only the FK column on `contacts`** to exist. The `contact.yaml` `belongs_to: account` declaration is sufficient on the data side.
- The inverse `has_many` declaration on `account.yaml` is needed for two distinct reasons under the canonical pattern: (1) it tells codegen to emit `AccountService.contacts(id)` (a target entity has no way of knowing which other entities point at it without this hint); (2) it's also what makes the Drizzle extension path work bidirectionally.

So the original question collapses: **declare both halves** (already the convention in `crm-domain/plan.yaml`). The inverse declaration is no longer just for the extension path — it's the codegen signal for the inverse service method post-#358. Inverse synthesis is unnecessary work.

A reader who finds the r2 comment in the issue thread should see this section and stop being confused.

---

## Appendix — anatomy of the Drizzle emission layers (reference)

The 4-part Drizzle anatomy preserved from r2 as reference for implementers navigating the templates. **Demoted from "the architecture" to "the table-metadata implementation".** These four parts are how the templates emit `<plural>Relations` consts today; the canonical API path (§1) layers on top of them via service-layer composition that does NOT use `with:` joins.

| Part | Entry point | What it does |
|---|---|---|
| **Per-entity bucketing pass** | Clean: `templates/entity/new/prompt.js:838-883` (buckets all three rel types). Clean-Lite-PS: `templates/entity/new/clean-lite-ps/prompt-extension.js:312-362` (`processBelongsTo` only — no parallel `processHasMany`/`processHasOne`). | Reads `entity.relationships`, partitions into `belongsToRelations` / `hasManyRelations` / `hasOneRelations` (clean) or just `belongsTo` (clean-lite-ps), derives Pascal/plural/foreign-key permutations once and reuses across templates. |
| **Target-existence check** | `templates/entity/new/prompt.js:887-912` (`checkEntityExists` + `targetExists` marking) | Each relationship is annotated with whether the **target** entity's `<name>.entity.ts` already exists on disk. Templates use this to suppress imports/methods that would dangle. This is why baseline tests two-pass: pass 1 seeds entity files, pass 2 emits with `targetExists: true`. |
| **Drizzle `relations()` emission** | Clean: `templates/entity/new/backend/database/schema.ejs.t:224-244` — bidirectional (`one()` for belongsTo/hasOne, `many()` for hasMany). Clean-Lite-PS: `templates/entity/new/clean-lite-ps/entity.ejs.t:59-69` — **unidirectional**, only `one()` for `belongs_to`. Gated by `hasRelationsBlock = belongsTo.length > 0`. | Emits the `<plural>Relations` const. Enables hand-written `db.query.X.findMany({ with: { Y: true } })` only on clean (which ships the inverse); clean-lite-ps's `with:` path works only forward (target-side join). |
| **Schema-aware barrel** | `src/cli/shared/barrel-generator.ts:189-244` (`entityFilePaths`) | Computes module + schema file paths per architecture so cross-entity imports resolve at the right depth (the `01bb917` fix). Clean-lite-ps: `${prefix}modules/${plural}/${name}.entity.ts`. Clean: `${backendSrc}/infrastructure/persistence/drizzle/${pluralKebab}.schema.ts`. Junction modules from mechanism (A) merge with regular modules here — the integration seam `junction-association-codegen` extends. |

### What `junction-association-codegen` reuses from this anatomy

- **Bucketing + targetExists** — the same partition pass works for junction associations; the difference is the input shape (junction YAML or paired entity YAMLs) and the output (mirrored methods on both parents).
- **Barrel generator** — junction modules merge in via the same seam. The `01bb917` resolution logic doesn't change.

### What `junction-association-codegen` introduces (gap #358-dependent)

- **Service-method emission** — the **first leaf to emit cross-entity composition methods** in generated code. Today's templates emit `relations()` consts and (on clean only) declaring-side `findByFkId`; no template walks the target side to emit a service method. Junction codegen extends the bucketing pass to walk the pairing rather than a single entity, then emits paginated mirrored methods on both parent services that delegate to one junction service.

Once #358 is merged, the same emission machinery handles per-entity `has_many` (target-side service method) and junction `has_many` (mirrored across both parents). They share the canonical shape from §1; only the partition pass differs.
