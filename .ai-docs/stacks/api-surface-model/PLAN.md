# PLAN — backend API-surface derivation (slice 1) + Studio API view

**Status:** approved (Doug, 2026-11-13; N1 decided: `src/derived/api/`) · **Revision 1** folded in · A0–A4 built · S1 signed off 2026-11-14
**Basis:** `main` @ `c1ceeefd`. READ-1 merged 2026-11-12 (#859 and the ten PRs under it). Every `path:line`
below was taken at the READ-1 tip `e9fe6f5f`; every cited file is byte-identical on `main` (checked one by one
with `git diff --quiet e9fe6f5f c1ceeefd -- <file>`), so the line numbers hold.

---

## 1. One-screen summary

**What.** One typed TypeScript derivation that says, per entity, which repository methods, service methods,
use-case classes, HTTP routes and include allowlists the generator emits, what each is called, and which YAML
line caused it. The backend templates print from it. Studio shows it: an **API tab** per entity and a **method
list per edge**.

**Why.** Those names are decided in at least nine places today (§3.2), three of them held together only by a
parity test (#711). Studio may not add a tenth.

**Size: about 10 working days, in two committed phases.** Both are approved; the duplicate that exists between
them is temporary by decision.

| Phase | Delivers | Size |
|---|---|---|
| **A — derivation + Studio** (`templates/` untouched) | the derivation, a gate holding it equal to real generated output, `codegen project surface --json`, the Studio API tab and edge view | ~5.5 days on the critical path (API tab at ~4.5) |
| **B — templates print** | repository / controller / service templates read the derivation; every inline name derivation deleted; byte-identical at each step | ~4 days |

| # | PR | Scope | Size |
|---|---|---|---|
| A0 | ADR-046 + CLAUDE.md rule | docs only | S · 0.5d |
| A1 | The derivation + parity gate + golden + lint | `src/derived/api/**`, three unit gates. Names, kinds, provenance, param **names**, shape. No types. | M–L · 2d |
| A2 | Whole-set pass + `codegen project surface --json` | pairing / `inverseOf`, the F7 warning, the verb | M · 1d |
| A3 | Studio server: `GET /api/surface` | route + contract types + e2e stage | S · 0.5d |
| A4 | Studio UI: API tab | new inspector tab, provenance → YAML line | M · 1d |
| A5 | Studio UI: methods on edges | edge selection (new), edge panel | S–M · 1d |
| B1 | Render-matrix goldens | byte snapshots for shapes the baseline misses | S–M · 0.5–1d |
| B2 | `repository.ejs.t` prints | finders, FK finders, precedence; closes #711 | M · 1d |
| B3 | controller / search controller / flags print | routes, `apiEnabled`, typed-include, const name | M · 1d |
| B4 | `service.ejs.t` + use cases print | forwarders, relation methods, fan-out, EAV. **Does not wait for REL-3.** | M · 1–1.5d |

**Decided (2026-11-12):** Phase A then Phase B, both committed · Studio shells `project surface --json` ·
junction- and `relationship:`-owned modules are `unmodelled` until #679 · oddities are recorded, not fixed ·
B4 does not wait for REL-3 · no param or return *types* in slice 1.

**Directory name — decided 2026-11-13: `src/derived/api/`.** You asked for `src/surface/api/` unless there was a
concrete reason it is worse. There is (§4.2): `surface` is already the integration-surface term in the very
files that would import it.

**How it runs:** one orchestration session, PR by PR, against §14 — exact exit commands per PR, anti-cheat
rules with their detection commands, four sign-off stops (after A1, A4, B1, B4), and stop conditions.

**F7 confirmed by running it** (§14.4): a `has_many` whose target has no matching `belongs_to` validates clean,
generates clean, and fails `tsc` — in three distinct shapes.

---

## 2. What I found that differs from the brief

| # | Finding | Evidence | Effect on the plan |
|---|---|---|---|
| F1 | `GET /api/graph` **shells the CLI**; it is not in-process. | `src/studio/server/graph.ts:55-66`. `docs/specs/STUDIO-0.md:53-55` says in-process — stale. | §6.1. A0 corrects the sentence. |
| F2 | **"Baseline byte-identical" proves less than assumed.** No EAV, capability forwarder, composed base, `api: false`, `api.includes` wiring or `generate.writes: false` in the baseline snapshot. | `grep` over `test/baseline/**` for `findByIdWithFields`, `upsertCurrentValues`, `Capability forwarders`, `ComposedBase`, `_API_INCLUDES.` finds nothing. Junction fan-out is byte-covered by `just test-junction`. | B1 adds byte goldens **before** any template is edited. |
| F3 | **Existence depends on disk, not only on YAML.** A `has_many` service method is emitted only when the target is in the run's render set or its entity file exists. | `entity-locals.js:685-692` | "Which targets are wired" is an explicit input (§4.3). |
| F4 | READ-1 is **merged**. | `main` @ `c1ceeefd` | Nothing waits on it any more (§10). |
| F5 | The finder name is derived in **four** files, the FK-finder name in **three** places, "has a typed include" in **two**, the allowlist constant in **two**, `api` enabled in **two**. | §3.2 | Slice 1's deletions. |
| F6 | The **frontend emitter** hard-codes the same five routes and reads neither `generate.writes` nor `api: false`. | `src/emitters/frontend/emit-api.ts:156-192` | Follow-up consumer, not slice 1 (§12). |
| F7 | **Confirmed by execution.** A `has_many` whose target does not emit a matching FK finder passes `entity validate`, generates with exit 0, and fails `tsc`. | §14.4; `f7-preflight/f7-report.txt` | A2's link pass reports it as a warning with exact text. |

---

## 3. Inventory — every API-surface fact, and where it is decided today

### 3.1 The facts

`EL` = `templates/entity/new/backend/entity-locals.js`.

| Fact | Decided today at | Slice 1? |
|---|---|---|
| **Base reads** `findById`, `findByIds`, `list`, `count` | literal in `repository.ejs.t:286-349`; again in `service.ejs.t:94-112` | **Yes** — names, read-option shape |
| The read generics / options / result **type strings** | built twice: `repository.ejs.t:39-44`, `service.ejs.t:15-20` | **No** — type text; slice 2. The flag they branch on (`includes`) is slice 1 |
| `with` only when the entity has own relations | `EL:1652-1655`; duplicated at `src/emitters/relations/build-includes.ts:95-97` ("MUST stay identical", `:89-93`) | **Yes** — one reader |
| **`queries:` finder name** | `EL:1255-1267`; `src/schema/query-routes.ts:37-45`; `templates/relationship/new/prompt.js:303-314` | **Yes** (#711) |
| `queries:` finder shape: param names, unique, order, `via:` / `select:` | `EL:1273-1349`; `repository.ejs.t:368-399`; `service.ejs.t:128-141` | **Yes** — kind + flags + param names |
| `queries:` param and return **types** | `EL:1291-1317` | **No** — stay in locals, keyed by the derived name (§4.3) |
| **`queries:` × `belongs_to` precedence** | inline in the template: `repository.ejs.t:10-30`, `:359`, `:404` | **Yes** — the single most valuable decision to move |
| **`belongs_to` FK finder** `findBy<Fk>` | name built three times: `repository.ejs.t:12-13`, `:415`, `EL:2502-2504` | **Yes** |
| `name: search` query → use case, filters schema, controller | `EL:1371-1423` (names `:1419-1421`) | **Yes** — class names, route. Filter fields stay (slice 2) |
| **Service to-one relation method** | name `relationKey`: `EL:799-811`; id-param name camel-cased inline: `service.ejs.t:176-177` | **Yes** — name, param names, `delegatesTo` |
| **Service to-many relation method** | name is the raw YAML key: `service.ejs.t:204`; existence `EL:685-692`, `:2689`; callee name: `service.ejs.t:206-208` | **Yes** |
| Service `queries:` forwarders (no precedence skip, unlike the repository) | `service.ejs.t:127-142` | **Yes** |
| **Capability forwarders** (ADR-041) | `EL:1871-1873`, printed `service.ejs.t:155-163` | **Yes** |
| Pattern / capability **inherited** methods | pattern definitions (`src/patterns/library/base.pattern.ts:21-26`); `EL:285-314`; printed `repository.ejs.t:472-475`; collisions `EL:2478-2528` | **Yes** — `emitted: false`; the gate checks them against the runtime classes |
| **Junction fan-out** on parents | `templates/_shared/junction-fan-out.mjs:128-176` (names `:165-168`); `service.ejs.t:228-267` | **Yes** — names, param names, `junction <name>` origin. Import paths stay (slice 3) |
| **EAV** service methods + `upsertCurrentValues` | flags `EL:1731`, `:1757`; literal `service.ejs.t:275-340`, `repository.ejs.t:443` | **Yes** — existence + names |
| **Use-case classes** | `EL:2317-2343`; existence via `outputPaths` nulls `EL:2251-2307`; per-query class `EL:1322-1323` | **Yes** — class, kind, callee. File paths stay |
| **HTTP routes** (verb, path, handler, operationId) | hard-coded: `controller.ejs.t:47`, `:86`, `:119-120`, `:143-144`, `:164-165`, `:189-190`, `:204-205`, `:218-219`, `:233-234`; `search-controller.ejs.t:44-48` | **Yes** |
| `api: false` / `api: { enabled }` | `EL:1627-1633` **and** `src/schema/entity-definition.schema.ts:1583` | **Yes** — one reader |
| `generate.writes: false` | `EL:1726-1727` | **Yes** |
| **Include allowlist**: which routes have one | `EL:1637-1639`; valid keys `build-includes.ts:79-84` | **Yes** |
| Include allowlist: compiled paths | `build-includes.ts:132-282` — already whole-set TS, one owner | **Attach, don't move** |
| Allowlist constant name | `EL:2633-2635` **and** `src/emitters/relations/emit-includes.ts:36-38` | **Yes** — one owner |
| Family base classes | pattern registry → `EL:285-314` | **Recorded** (`baseClass`) |
| **Junction's own module** (`junction new`) | `templates/junction/new/**` | **Deferred** → #679 |
| **`relationship:` definition module** | `templates/relationship/new/**` | **Deferred** → #679 |
| DTO shapes, Drizzle columns, every TS type string | `EL:564-630`, `:2345-2389` | Slice 2 |
| Module providers / imports / tokens | `EL:847-866`, `module.ejs.t:61-113` | Slice 3 |
| REL-3 navigator; READ-1 §2.5 variants | not built | Designed for (§4.4) |

Deferred pipelines appear in the output under `unmodelled` with a reason, so Studio shows "not modelled yet
(#679)" rather than an empty tab — an absent answer must never read as "no API" (CLAUDE.md § Testing, rule (c);
FE-REL's "a deferral, printed and written into the descriptor" is the precedent).

### 3.2 The duplicates slice 1 removes

| Decision | Copies today | After |
|---|---|---|
| `queries:` finder name | `EL:1255`, `query-routes.ts:37`, `relationship/new/prompt.js:303` (+ a parity test) | 1 |
| FK finder name | `repository.ejs.t:12`, `:415`, `EL:2502` | 1 |
| Entity has a typed include | `EL:1652`, `build-includes.ts:95` (+ a parity test) | 1 |
| Allowlist constant name | `EL:2633`, `emit-includes.ts:36` (+ a parity test) | 1 |
| `api` enabled | `EL:1627`, `entity-definition.schema.ts:1583` | 1 |
| snake → camel | `src/config/file-naming.ts:55`; inline `service.ejs.t:176,177,196,197`; local copies `prompt.js:367`, `junction-fan-out.mjs:32` | 1 for the entity pipeline |

### 3.3 A worked example (the Studio demo's `contact`)

`src/studio/demo/entities/contact.yaml` declares `relationships.account` (belongs_to) **and** `queries[0]: by
[account_id]`. Both resolve to `findByAccountId`. Today the repository emits one method — the FK finder —
because the template decides the plain query is covered (`repository.ejs.t:359`); the service emits the query
forwarder anyway (`service.ejs.t:127-142`) plus `account()`; and a `FindContactByAccountIdUseCase` class comes
from the query (`EL:1322-1323`).

The derivation states it once: `findByAccountId` — origin `relationships.account`, shadows `queries[0]`. That
is the row the API tab shows and the record the template prints from.

### 3.4 Oddities the derivation makes visible (recorded, not fixed — decided)

- To-many service methods and junction fan-out carry the raw snake_case YAML name (`service.ejs.t:204`; #697).
- `operationId` pluralises by appending `s` (`controller.ejs.t:86`), not from `plural:`.
- Two `camelCase` rules: `file-naming.ts:55` matches letters only, `src/emitters/relations/types.ts:128` also
  digits — a name containing `_2` gets different keys in the manifest and the service.
- **A shadowed ordered query loses its `order:`.** The baseline's own fixture declares `by: [account_id]` with
  `order: created_at desc` (`test/fixtures/entities/contact-v2.yaml`), and the emitted `findByAccountId` is the
  FK finder with no such ordering (`test/baseline/packages/api/src/modules/contacts/contact.repository.ts:284-297`).
  The skip rule ignores `hasOrder` (`repository.ejs.t:359`).
- F7 (§14.4).
- **The Metadata pattern names two service methods its base class does not have** (found by A1's parity gate).
  `src/patterns/library/metadata.pattern.ts` lists `findByEntityIdAndType, listByEntityId, listHistoryByEntityId`
  as `serviceInheritedMethods`; `runtime/base-classes/metadata-entity-service.ts` declares `findByEntityIdAndType`,
  `listByEntity`, `listHistory`, `upsertValues` (the two `…ById` names live on `MetadataEntityRepository`). It
  compiles — only the generated "inherited" comment and the ADR-041 collision vocabulary are wrong. Recorded as a
  named expectation in the parity test (`METADATA_INHERITED_EXPECTATION`: case `matrix-eav-value-table`, exactly
  two messages, asserted present and sole), which fails once the pattern is corrected and must then be deleted.
- **D4 — an F7-class shape, confirmed by running it (2026-11-14, `d4-preflight/`):** an `eav_value_table: true`
  entity whose pattern is not `Metadata` validates clean, generates with exit 0, and fails `tsc`:
  `field-value.service.ts: error TS2339: Property 'findByEntityIdAndType' does not exist on type
  'FieldValueRepository'` (+3 cascades). Its service's `findMergedByEntity` calls a method only the Metadata
  repository supplies. Parity compares names, not delegate targets, so it cannot see this; A2's link pass warns on
  it with F7's V1 rule. Issue drafted at S2, not filed.
- **A `cardinality: one` role has no edge in REL-1's relations manifest** (the CAP-2 seam in `build-graph.ts` is
  unbuilt), although hygen emits the role's FK finder and to-one service method. So `?include=` cannot reach a
  role; the derived role relation shows `includeKeys: []`.
- A `has_many … through:` would derive a `relation_many` whose delegate the link pass checks; no fixture declares
  one, so that path is untested.

Byte-identical output is Phase B's gate, so none of these change in slice 1. Each becomes a one-place edit
afterwards; file one issue per oddity at S4.

---

## 4. The derivation

### 4.1 Shape (sketch)

No TypeScript type strings anywhere — names, kinds, provenance, param names and shape only. Types arrive with
slice 2.

```ts
// src/derived/api/types.ts — types only, zero runtime imports (Studio's contract re-exports it)

export type YamlPath = (string | number)[];                    // ['relationships','account'], ['queries',1]
export interface YamlRef { doc: { kind: 'entity' | 'junction'; name: string }; path: YamlPath; note?: string }

/** Why an entry exists. `yaml.at` is the declaration that won; `shadows` resolved to the same name and lost. */
export type Origin =
  | { from: 'base' }                                           // every generated entity has it
  | { from: 'pattern'; pattern: string }                       // the spine's base class
  | { from: 'capability'; capability: string }
  | { from: 'yaml'; at: YamlRef; shadows?: YamlRef[] };

export interface Param { name: string; field?: string }        // `field` = the YAML field it binds; no TS type
                                                               // a capability forwarder's params: one, `...args`
export type Shape = 'one' | 'many' | 'count' | 'projection' | 'none'   // `none`: detach / setPrimary return nothing
                  | 'forwarded';   // A1: a capability forwarder / inherited entry returns what its callee does,
                                   // which codegen does not see — an explicit answer, never an omitted one
export interface MethodRef { entity: string; layer: 'repository' | 'service'; method: string }

export interface RepositoryMethod {
  name: string;
  kind: 'find_by_id' | 'find_by_ids' | 'list' | 'count'
      | 'finder' | 'finder_projection'      // queries: plain | via:/select:
      | 'fk_finder'                         // belongs_to
      | 'eav_upsert' | 'inherited';
  emitted: boolean;                         // false = lives on the base class / a mixin
  params: Param[];
  returns: Shape;
  readOptions: 'none' | 'columns' | 'columns+with';   // READ-1 §2.3
  limit?: boolean;                          // fk_finder takes { limit }
  unique?: boolean;
  order?: { column: string; direction: 'asc' | 'desc' };
  origin: Origin;
}

export interface ServiceMethod {
  name: string;
  kind: 'read' | 'finder' | 'capability_forwarder' | 'relation_one' | 'relation_many'
      | 'junction_attach' | 'junction_detach' | 'junction_list' | 'junction_set_primary'
      | 'eav_read' | 'eav_write' | 'inherited';
  emitted: boolean;
  params: Param[];
  returns: Shape;
  delegatesTo?: MethodRef;                  // resolved against the target in the whole-set pass
  origin: Origin;
}

export interface UseCase {
  className: string;
  kind: 'find_by_id' | 'list' | 'create' | 'update' | 'delete'
      | 'find_by_id_with_fields' | 'list_with_fields' | 'query' | 'search';
  calls: MethodRef;
  origin: Origin;
}

export interface Route {
  verb: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;                             // '/contacts/:id'
  controller: string; handler: string; operationId?: string;
  useCase: string;
  includeRoute?: 'list' | 'find_by_id';     // the api.includes key this handler resolves
  origin: Origin;
}

export interface EntityApiSurface {
  entity: string; plural: string; className: string;
  repository: { className: string; baseClass: string; typedInclude: boolean; methods: RepositoryMethod[] };
  service:    { className: string; baseClass: string; methods: ServiceMethod[] };
  useCases: UseCase[];
  http: {
    enabled: boolean; disabledBy?: YamlRef;                    // api: false
    routes: Route[];
    includeRoutes: string[];                                   // keys only — this entity's own YAML
    includes?: { route: string; maxDepth: number; paths: { path: string; depth: number }[] }[];  // whole-set pass
    includesConst: string;
  };
}

/** The edge view. `id` is REL-1's own origin string (`build-graph.ts:232`, `:306`). */
export interface RelationApiSurface {
  id: string;                               // 'contact.relationships.account' | 'junction opportunity_contact'
  from: string; to: string;
  kind: 'belongs_to' | 'has_many' | 'has_one' | 'role' | 'junction';
  inverseOf?: string;                       // the paired declaration on the other entity
  generates: MethodRef[];                   // every method, either side, whose origin names this declaration
  includeKeys: { table: string; key: string }[];
}

export interface ProjectApiSurface {
  entities: Record<string, EntityApiSurface>;
  relations: RelationApiSurface[];
  unmodelled: { name: string; kind: 'junction' | 'relationship'; reason: string }[];
  warnings: string[];
}
```

Deliberately **not** here: TS types, import paths, file paths, method bodies, SQL, decorator text, DTO fields.

### 4.2 Where it lives — `src/derived/api/`, not `src/surface/api/`

`src/model/` is dropped as you asked (it collides with the charter's semantic model, ADR-045). I looked at
`src/surface/api/` and found three concrete reasons it is worse:

1. **`surface` already means the integration surface, in the same files.** `entity.surface:` is a YAML key
   (`src/schema/entity-definition.schema.ts:711-720`); `entity-locals.js` uses the word 26 times for it
   (`buildIntegrationSurface`, `hasIntegrationSurface`); the CLI's `entity new` calls `collectEntitySurfaces`
   (`src/cli/shared/entity-render.ts:29`). A new `EntitySurface` type and a `surface` template local would sit
   beside all three.
2. **It does not fit slices 2 and 3.** Columns and module wiring are not surfaces; `src/surface/wiring/` names
   the opposite of what is in it.
3. **In "one owner, many surfaces", surfaces are the readers** — the templates, the Studio tab, the docs. This
   directory holds the owner.

**Proposed: `src/derived/`** — `api/` now, `columns/` and `wiring/` later. The YAML is *declared*; this is what
is *derived* from it, and the rule reads straight off the path: a name is derived here and nowhere else. The
repo already uses the verb this way (`src/roles/derive.ts`, shared by the parser and the hygen prompt for the
same one-owner reason: `prompt.js:333-341`).

In code nothing is named `Model`, and nothing is named bare `surface`: types are `…ApiSurface`, the template
local is `apiSurface`. The approved verb stays `codegen project surface`.

| File | Holds | Imported by |
|---|---|---|
| `types.ts` | the types above | everything, incl. `src/studio/shared/api.ts` (type re-export, as `api.ts:13-14` does for the graph) |
| `names.ts` | every name rule, as named exports §14.2 refers to: `finderName`, `fkFinderName`, `relationMethodName`, `useCaseClassName`, `includesConstName`, plus fan-out names and route paths | the two derivations; `build-includes.ts`; `templates/relationship/new/prompt.js` |
| `entity.ts` | `deriveEntityApiSurface(input)` — one entity, pure | **hygen** (`entity-locals.js`, from B2) and `project.ts` |
| `project.ts` | `deriveProjectApiSurface(ctx)` — every entity, then the link pass | the CLI only |

### 4.3 Input: one entity for hygen, the whole set for the CLI

**Per entity (`deriveEntityApiSurface`)** takes what `buildBackendLocals` already has in hand: the entity
definition (post role-merge, `prompt.js:346-351`), the junction set (`prompt.js:425`), the resolved pattern
composition (`EL:285-314`), and `wiredTargets` — the `has_many` targets that will exist (render set ∪ on disk;
F3). No new file reads, no second input channel into hygen.

*As built (A1):* one more input, `entityLookup(name) → entity: block | null` — the cross-entity lookup
(NAME-0) the locals already hold, so a junction counterparty's plural comes from its own YAML through
`entityModuleNaming` and `src/derived` never pluralises. And the derivation merges `roles:` into
`relationships` itself, with `src/roles/derive.ts`'s own `deriveRoleRelationships` — idempotent on an
already-merged definition — so the CLI's zod path cannot skip it; a role-derived edge's origin is
`['roles', <role>]`. Imports: `config/file-naming`, `config/module-tree`, `config/junction-naming`,
`roles/derive` — all in `files`.

**Whole set (`deriveProjectApiSurface`)** calls the per-entity function for every entity with
`wiredTargets = all` — the answer is "what `entity new --all` emits" — then:

1. calls **REL-1's own** `buildRelationGraph` (`src/emitters/relations/build-graph.ts:200`) and
   `buildIncludeAllowlists` (`build-includes.ts:132`) through `loadRelationsEmitContext` (`load-context.ts:98`)
   — no second walk of the YAML (charter I1; the frontend's `graph-model.ts` is the precedent);
2. resolves every `delegatesTo` against the target's surface — a `relation_many` whose delegate is missing, or
   is not an `fk_finder`, is F7 and becomes a warning;
3. pairs declarations into `RelationApiSurface`s (`A.belongs_to(B, fk)` ↔ `B.has_many|has_one(A, foreign_key:
   fk)`, or an explicit `inverse:`) and indexes `generates` from the origins;
4. lists junction and `relationship:` definitions under `unmodelled`.

*As built (A2):*
- **Input.** `deriveProjectApiSurface({ relations, relationships })`: `relations` is REL-1's
  `RelationsEmitContext`; `relationships` the `relationship:` definitions by name (REL-1's context does not load
  them). `loadProjectApiContext(cwd, config, { entitiesDir?, junctionsDir, relationshipsDir })` builds both; the
  two dirs are required arguments (`path-defaults.test.ts` rejects a defaulted path), and the CLI passes
  `junctionsDirFor(cwd)` and `<cwd>/relationships`, as `entity new` does.
- **Pattern composition is restated** in `project.ts` (~15 lines over the same `composePatterns` / `getPattern`):
  `src/` cannot import `templates/…/entity-locals.js`. A test holds it equal to the hygen function for every
  baseline and matrix entity. Temporary: B2 moves `resolvePatternComposition` into `src/` and deletes the copy.
- **Two delegate rules.** Rule 1: every service `delegatesTo` resolves to a method its target lists, emitted or
  inherited, else a warning ``<origin>: `<Service>.<method>` calls `<Target>.<method>`, which <target> does not
  emit`` (F7 V1 and D4). Rule 2: a `relation_many` must reach an `fk_finder` (F7 V2/V3). A delegate into a
  junction is skipped, keyed on exactly the junctions listed in `unmodelled` (#679): any other missing target still
  warns.
- **Relations.** Every relation comes from REL-1's edge origins except roles: REL-1 has no role edge, so a role
  relation (`<entity>.roles.<role>`, kind `role`, `includeKeys: []`) comes from the definitions' `roles:` blocks,
  already loaded in REL-1's context. Junction relations are `junction <name>`, with REL-1's keys and the fan-out
  from both parents in `generates`. `through:` relationships and targets with no YAML are skipped, as REL-1 skips
  them; REL-1's own warnings are not copied. Pairing: an explicit `inverse:` (either side) wins; otherwise
  `belongs_to` ↔ `has_many` / `has_one` on the same foreign key, only when exactly one candidate matches.
- **The verb.** `--entity` narrows only `entities`; `relations`, `warnings`, `unmodelled` stay project-wide. It
  finds the project like `project graph` (`--cwd`).

**Types stay where they are.** Finder param types and return types keep coming from `processQueries`
(`EL:1291-1317`). In Phase B that output is re-keyed by the derived method name (a `queryTypes` local), so a
template prints `m.params[i].name` from the derivation and the type beside it from `queryTypes[m.name]`. The
key is the derivation's name, so the template still derives nothing. Slice 2 absorbs `queryTypes`.

**One input hazard, with a gate.** Hygen passes **raw** YAML; the CLI passes **zod-parsed** definitions. The
function takes a narrow structural input type, and a unit test asserts `derive(raw) ≡ derive(parsed)` for every
fixture. A concrete instance: the schema's `apiEnabled` (`entity-definition.schema.ts:1583-1587`) relies on
zod's default and throws on a raw document with no `api:` key — which is why `entity-locals.js` has its own
copy today. The single reader must accept both.

### 4.4 How hygen reaches it (from B2)

The way it reaches `file-naming.ts` today: `entity-locals.js` imports TypeScript source by a `.js` specifier
that bun resolves (`EL:29`, `EL:22-48`), and the file ships because `package.json` `files` lists it
(`package.json:51-83`).

- `entity-locals.js` imports `deriveEntityApiSurface` from `src/derived/api/entity.js` and returns one new
  local, `apiSurface`.
- `package.json` `files` gains `src/derived/api/{types,names,entity}.ts`. **Not** `project.ts` — it imports the
  relations emitter and the zod registry, whose graph does not ship (`templates/_shared/entity-naming.mjs:12-15`).
- `entity.ts` and `names.ts` may import only modules already in `files`. Two existing tests fail otherwise:
  `src/__tests__/templates/template-src-imports.test.ts`, `files-manifest-coverage.test.ts`.
- `just test-post-publish` is the tarball proof, run on B2 and again on B4.

Phase A does not touch `templates/` or `package.json` at all.

**Designed for, not built:** REL-3's navigator is one more `ServiceMethod.kind` and a changed `delegatesTo`;
READ-1 §2.5 variants are one more `RepositoryMethod.kind`.

---

## 5. Template conversion (Phase B)

"Print" means: loop over `apiSurface.*`, branch on `kind` and flags, emit text. What stays in a template is
method **bodies**, type text, decorator boilerplate and imports. What leaves is every name, every camel-casing,
every "is this emitted" test.

| Template | Inline derivation today | Becomes |
|---|---|---|
| `repository.ejs.t` | FK-finder name set, the shadowing set, `_skipFkMethod` (`:10-30`); `_skipClpDq` (`:359`); FK name again (`:404`, `:415`); `processedQueries` loop (`:355-402`); inherited comment (`:472-475`) | one loop over the emitted `apiSurface.repository.methods`, a `switch (m.kind)` choosing the body partial; types from `queryTypes[m.name]` |
| `service.ejs.t` | query forwarders (`:127-142`); capability forwarders (`:155-163`); inline camel-casing and callee name (`:176-177`, `:196-197`, `:206-208`); fan-out names (`:235-264`); EAV blocks gated on locals (`:268`, `:300`) | one loop over `apiSurface.service.methods`; `delegatesTo.method` printed, never built |
| `use-cases/declarative-queries.ejs.t` | `q.useCaseClassName`, `q.methodName` (`:19-34`) | `apiSurface.useCases` of kind `query` |
| `controller.ejs.t` | `skip_if` on `apiEnabled` (`:3`); routes and operationIds literal; include wiring on `apiIncludeRoutes.includes(...)` (`:97`, `:126`, `:158`, `:173`) | `skip_if` on `apiSurface.http.enabled`; route facts read from `apiSurface.http.routes`; the Swagger text stays |
| `search-controller.ejs.t` | `skip_if` (`:3`), literal `@Get('search')` (`:48`) | from the `search` route |
| `module.ejs.t`, `index.ejs.t` | `apiEnabled`, `hasSearchQuery`, `generateWrites`, `eavEnabled` (`module.ejs.t:33-58`, `:80-104`; `index.ejs.t:11-16`) | flags read from `apiSurface`; the provider *list* is slice 3 |

The read-generics strings (`repository.ejs.t:39-44`, `service.ejs.t:15-20`) stay in both templates, branching
on `apiSurface.repository.typedInclude` instead of `includes`. They are type text; the duplicate is slice 2's.

**Locals deleted as their last reader converts:** `processedQueries[].methodName` / `.useCaseClassName`,
`declarativeQueryClasses`, `apiEnabled`, `apiIncludeRoutes`, `includes`, `apiIncludesConst`,
`capabilityForwarders`, `repositoryInheritedMethods`, `serviceInheritedMethods`, the fan-out `*Method` and
`*IdParam` keys.

**The silent-drop rule applies to every deletion** (CLAUDE.md § Testing). Each PR body lists, per deleted
local, every reader found by `grep` across `templates/**`, `src/__tests__/**` and `prompt.js` — which itself
reads `backendLocals.*` (`prompt.js:542-550`). `assertNoUndefinedLocals` (`EL:2716`) and the unguarded-locals
rule (#638) turn a missed reader into a thrown error rather than an empty emission.

---

## 6. Studio

### 6.1 Server — shell the verb (decided)

`codegen project surface [--entity <name>] --json` prints `{ command, entities, surface: ProjectApiSurface }`.
Without `--json` it prints a table per entity.

`GET /api/surface` in `src/studio/server/surface.ts` calls `runCliJson(['project','surface'], { cwd })`
(`cli-runner.ts:174`), as `graph.ts:55-66` does, registered beside `/api/graph` (`index.ts:473`). A fresh
process per call also means an edited `.pattern.ts` is never served stale — the registry is process-global and
filled by dynamic imports (`prompt.js:289-308`). A separate route, so a surface failure (an invalid allowlist
is a generation error) cannot blank the canvas.

### 6.2 Contract

`src/studio/shared/api.ts` adds, types only (`api.ts:9-10`):

```ts
export type { ProjectApiSurface, EntityApiSurface, RelationApiSurface, Origin, YamlRef } from '../../derived/api/types.js';
export interface SurfaceResponse { surface: ProjectApiSurface }
```

### 6.3 UI

| Piece | Change | Where |
|---|---|---|
| **API tab** | `InspectorTab` gains `'api'`; enabled for an entity node. Sections: Repository, Service, Use cases, HTTP, Includes. Each row: name, param names, shape (`findByAccountId(id, opts) → many`), flags, an origin chip (`← relationships.account`, `← queries[1] (unique)`, `base`, `pattern Integrated`, `capability Actor`, `junction opportunity_contact`). A shadowed declaration shows under the row. A relationship/junction node shows the `unmodelled` reason. | `tools/studio/src/inspector/Inspector.tsx:20`, `:131-146`; new `inspector/ApiTab.tsx` |
| **Provenance → line** | clicking a YAML origin opens the YAML tab at that line. The path→position walker exists for Zod issues (`inspector/yaml-issues.ts:311`); export it as `locatePath(source, path)`. `YamlEditor` gains `revealLine`. | `inspector/yaml-issues.ts`, `YamlEditor.tsx` |
| **Edge selection** (new — selection is node-only today) | selection becomes `{ kind: 'node' \| 'edge'; id }`; `onEdgeClick`; dimming for an edge computed in Studio. | `App.tsx:45`, `:158-172`; `graph/SchemaCanvas.tsx:128-131`, `:176-177`, `:99-126` |
| **Methods on an edge** | each drawn edge carries `relationId` = `<from>.relationships.<name>`, set where the id is built (`adapters/schema-adapter.ts:187`) — never parsed back out. The panel lists `relations[id].generates` by side, then `inverseOf`'s, then `includeKeys`. | `graph/edge-kinds.ts:17-21`; new `inspector/EdgePanel.tsx` |
| **One vocabulary table** | `inspector/surface-kinds.ts`: per method kind and origin kind — label, section, order. Tab and edge panel render from it, as `relationship-kinds.ts` and `edge-kinds.ts` do. REL-3 and #679 become edits to this table. | new |
| **Colour** | existing tokens only (`index.css:50-86`). A relation-origin chip reuses `edgeColor(edgeStyle(kind))` (`edge-kinds.ts:99-109`). No literal in a component. | — |

*As built (A4), detail in STUDIO-2 §4:* uniqueness is a row flag, not chip text (`← queries[1]`); rows sort by the
kind table's order; inherited entries sit in a collapsed group; the tab stays open across selections; an error
outranks "Nothing selected"; `locatePath` falls back to the nearest ancestor (`exact: false`); the inspector
re-syncs the open file only when the selection changes. The canvas stays intact when the surface route fails on its
own; with the whole server down a header Reload empties it too, so S2's failure shot fails the route alone.

v1 edge view covers inline relationship edges. Junction-origin methods appear on both parents' API tabs.
Whether a `pattern: Junction` pairing is a selectable edge is an open item for STUDIO-2.

Not gated, stated plainly: no test renders the tab (STUDIO-0 §7.1 — nothing in CI renders any pane). S2 is
where a person looks at it.

---

## 7. The gates

Three unit gates, all in `just test-unit`, therefore in `test-all` and CI. Their failure messages are part of
the spec — §14 greps for them.

### 7.1 Parity — the derivation equals real generated output

`src/__tests__/derived/api-surface-parity.test.ts`; the comparator in `_parity-compare.ts`, unit-tested itself.

**Subject A — the checked-in baseline.** Derive from `test/fixtures/entities` with
`test/fixtures/codegen.config.yaml` (the config the baseline uses). Parse
`test/baseline/packages/api/src/modules/**` with `ts-morph` (already a dependency). Per entity, **set equality
in both directions**:

| Compared | Generated side | Derived side |
|---|---|---|
| repository / service methods | public methods declared in the class body | `methods` where `emitted` |
| inherited methods | exist on the runtime base chain (`runtime/base-classes/**`) or the mixin | `emitted: false` |
| use cases | exported classes under `use-cases/` | `useCases` |
| routes | `@Controller` prefix + verb decorator + handler | `http.routes` |
| HTTP off | no controller file | `http.enabled === false` |

`just test-baseline` already guarantees `test/baseline` is what the generator emits, so this is a unit-speed
check against real output.

**Subject B — the shapes the baseline lacks (F2).** A render matrix — EAV, EAV value table, one capability,
two capabilities, `api: false`, `api.includes`, `generate.writes: false`, self-FK, role, the precedence
collision, junction fan-out — rendered in-process with `ejs.render` as
`src/__tests__/backend/eav-templates.test.ts:53-57` does, then the same comparison.

| Condition | Message (exact; `<…>` filled in) |
|---|---|
| generated method not derived | ``api-surface parity: <Class> declares `<method>`, which the derived API surface does not list`` |
| derived method not generated | ``api-surface parity: the derived API surface lists `<Class>.<method>`, which <file> does not declare`` |
| generated route not derived | ``api-surface parity: <Controller> declares route `<VERB> <path>`, which the derived API surface does not list`` |
| derived route not generated | ``api-surface parity: the derived API surface lists route `<VERB> <path>`, which <file> does not declare`` |
| inherited method missing | ``api-surface parity: <Class> lists `<method>` as inherited, but no class in its base chain (<A → B>) declares it`` |
| absent input | ``api-surface parity: no generated file for `<entity>` at <file>`` |
| empty parse | ``api-surface parity: <file> parsed to 0 classes`` |
| generated use case not derived *(A1)* | ``api-surface parity: <file> declares use case `<Class>`, which the derived API surface does not list`` |
| derived use case not generated *(A1)* | ``api-surface parity: the derived API surface lists use case `<Class>`, which <use-cases dir> does not declare`` |
| HTTP off but a controller exists *(A1)* | ``api-surface parity: the derived API surface has HTTP off for `<entity>`, but <file> exists`` |

Inherited methods are checked against the capability mixins first (rightmost capability outermost), then the
spine's runtime chain; an inherited entry leaves out anything the class body emits, so `findById` is not listed
twice. A use case of kind `search` records `calls` = `service.list` (it pages through the list path; `MethodRef`
has no use-case layer).

How it fails when someone adds a method in a template without the derivation: the template edit changes the
baseline output, `just test-baseline` is red until the snapshot is regenerated, and once it is the parity test
fails on the first row above. The reverse fails on the second.

Against the three #726 shapes: **(a)** it is an ordinary `bun test` file and its comparator has its own tests;
**(b)** file locations come from the derivation's own module naming and the fixture config; **(c)** rows 6–7.

### 7.2 Golden — provenance is pinned

Parity compares names and routes. Nothing else would pin `origin`, `shadows`, `kind`, `delegatesTo`, param
names — the fields Studio shows. `test/api-surface-golden/snapshot/<entity>.json` holds the derived surface of
every baseline fixture entity and every matrix case; `src/__tests__/derived/api-surface-golden.test.ts`
compares. Same shape as `test/relations-golden`.

Message: ``api-surface golden: `<entity>` differs from test/api-surface-golden/snapshot/<entity>.json``

*As built (A1):* 20 files — the 9 baseline fixture entities, and 11 matrix cases as `matrix-<case>.json`
(`{ case, covers, entities }`; the prefix keeps a case from colliding with an entity name). Regenerate only with
`UPDATE_API_SURFACE_GOLDEN=1`. The matrix itself is `src/__tests__/derived/_render-matrix.ts`, which B1 reuses.

*As built (A2):* the extension is a sibling directory, `test/api-surface-golden/project/` (`baseline.json` + one
per matrix case, each `{ relations, unmodelled, warnings, includes }`), so `snapshot/` and its test are untouched.
A test also holds every `project.entities[e]` (less `http.includes`) equal to `deriveEntityApiSurface`.

The golden is created in A1, extended in A2 (`relations`, `warnings`), and **frozen for all of Phase B** —
templates move, the derivation does not.

### 7.3 Lint — templates do not derive names

`src/__tests__/templates/no-name-derivation-in-templates.test.ts`, the shape of the existing
`no-basequery-where.test.ts`. It scans `templates/**/*.ejs.t` and template-side `.js` / `.mjs`, comments
skipped, for: `.replace(/_([a-z])/g`; `.charAt(0).toUpperCase()` in an `.ejs.t`; a string-built finder
(`` `findBy${ `` or `findBy<%`); a local `camelCase` / `pascalCase` definition.

The allowlist is its own file, `no-name-derivation.allowlist.ts`, entries `{ file, pattern, count, issue }`,
asserted **present and exact** like the #680 expectation (`test/run-test.ts:307`).

| Condition | Message (exact) |
|---|---|
| a site not in the allowlist | `no-name-derivation: <file> — <n> <pattern> not in the allowlist` |
| an entry that no longer matches | `no-name-derivation: allowlist entry <file> · <pattern> expects <n>, found <m> — shrink or delete the entry` |

Raw `grep` counts at `c1ceeefd` (comment lines included; the test computes the real starting list):

| Pattern | Entity backend (Phase B empties these) | Elsewhere (stays, with its issue) |
|---|---|---|
| inline camel-case | `service.ejs.t` ×4; `prompt.js:367` | `junction/new/prompt.js:44`, `relationship/new/prompt.js:52`, `_shared/junction-fan-out.mjs:32` → #679 |
| `charAt(0).toUpperCase()` | `repository.ejs.t` ×3 | `broadcast/new/bridge-listener.ejs.t` ×2 → own issue |
| string-built `findBy` | `repository.ejs.t` ×3, `service.ejs.t` ×2 | `junction/new/service.ejs.t` ×9, `junction/new/repository.ejs.t` ×2 → #679 |

*As built (A1):* pattern ids `inline-camel-case`, `charat-upper-case`, `string-built-finder`,
`local-case-helper`; 18 entries. A comment line containing `<%` is emitted text and is scanned (that is what
makes the counts above come out). Beyond the table: `entity-locals.js` ×2 string-built finders (the second is
`deriveQueryMethodName`'s) and ×1 local case helper, `prompt.js` ×1 local case helper (Phase B); the
`relationship/new/prompt.js` finder copy is tagged Phase B (B2 deletes it), its other two sites #679.

Its limit, stated: a regex catches the known spellings (#864 says the same of READ-1's line-based gates). The
parity gate catches what the regex misses.

---

## 8. The enforcement rule

**CLAUDE.md, new subsection `### Templates print (ADR-046)` under Key Patterns** (A0 writes it; B4 removes the
last sentence's "not yet migrated" clause for the entity backend):

> A fact about the generated API surface — a method name, a class name, a route, or whether something is
> emitted at all — is derived once, in `src/derived/api/`, and carries the YAML path that caused it. A template
> loops over `apiSurface` and branches on its flags. It never builds a name, never changes a name's case, and
> never decides existence. A new generated method starts as an entry there; the parity gate
> (`api-surface-parity.test.ts`) fails a template that emits one it does not list, and the golden
> (`test/api-surface-golden/`) pins its provenance. Studio and `codegen project surface` read the same
> derivation. Derivations not yet migrated are named in `no-name-derivation.allowlist.ts`; that list only
> shrinks.

---

## 9. PR breakdown

Two `gh stack`s; each lands as one atomic merge, by you (§14.8). Sizes are rough. Exit criteria are in §14.2.

| PR | Scope | Files | Size |
|---|---|---|---|
| **A0** | ADR-046; CLAUDE.md rule; STUDIO-0 §2 sentence corrected (F1) | `docs/adrs/ADR-046-derived-once-templates-print.md`, `CLAUDE.md`, `docs/specs/STUDIO-0.md` | S · 0.5d |
| **A1** | Types, name rules, `deriveEntityApiSurface`; parity gate (A + B) and its comparator tests; golden; lint + allowlist; raw ≡ parsed test. **No types, no template edit, no `package.json` edit.** | `src/derived/api/{types,names,entity}.ts`, `src/__tests__/derived/**`, `src/__tests__/templates/no-name-derivation*`, `test/api-surface-golden/**` | M–L · 2d |
| **A2** | `deriveProjectApiSurface`: link pass, pairing / `inverseOf`, `unmodelled`, the F7 warning; `project surface` verb; golden extended | `src/derived/api/project.ts`, `src/cli/commands/project.ts`, tests, golden | M · 1d |
| **A3** | `GET /api/surface`, contract types, e2e stage, STUDIO-2 spec | `src/studio/server/surface.ts`, `index.ts`, `src/studio/shared/api.ts`, `test/studio/run-studio-e2e.ts`, `docs/specs/STUDIO-2.md` | S · 0.5d |
| **A4** | API tab, `surface-kinds.ts`, provenance → YAML line | `tools/studio/src/inspector/**`, `api/client.ts`, tests | M · 1d |
| **A5** | Edge selection + edge method panel | `tools/studio/src/App.tsx`, `graph/**`, `adapters/schema-adapter.ts`, `inspector/EdgePanel.tsx`, tests | S–M · 1d |
| **B1** | Byte goldens over the render matrix (reuses A1's cases) | `test/render-golden/**`, one test file | S–M · 0.5–1d |
| **B2** | `repository.ejs.t` prints. `deriveQueryMethodName` deleted from `entity-locals.js`, `query-routes.ts` (file deleted), `relationship/new/prompt.js`; `build-includes.ts` reads `names.ts`; `queryTypes` local; `package.json` `files`; `resolvePatternComposition` moves into `src/` and `project.ts`'s restated copy is deleted (A2). Closes #711. | templates, `EL`, `src/schema/query-routes.ts`, the finder half of `route-name-parity.test.ts` | M · 1d |
| **B3** | Controller, search controller, `index` / `module` flags print. One reader each for `apiEnabled`, typed-include, includes const. | templates, `EL`, `emit-includes.ts`, `build-includes.ts`, the rest of `route-name-parity.test.ts` | M · 1d |
| **B4** | `service.ejs.t` + `declarative-queries.ejs.t` print; fan-out names from `names.ts`; entity-backend allowlist empty; CLAUDE.md clause removed; ADR and specs to post-implementation truth | templates, `EL`, `_shared/junction-fan-out.mjs`, `prompt.js` | M · 1–1.5d |

Order: A0 → A1 → A2 → A3 → A4 → A5, then B1 → B2 → B3 → B4. Phase A critical path 5.5 days (A0 is half a day
of docs beside it); Phase B 3.5–4.5 days.

---

## 10. Sequencing against other work

- **READ-1** is merged. Nothing waits. A1 starts from `main` @ `c1ceeefd` or later. (`main` moved to `074cce00`, the
  0.33.0 release, before A0; P0 re-checked that nothing under `templates/`, `src/studio`, `tools/studio`,
  `src/emitters`, `src/schema`, `runtime/base-classes`, `test/baseline` or `test/fixtures` changed.)
- **REL-3 (#588) does not gate B4** (decided). B4 moves names and existence into the derivation; REL-3 later
  rewrites the method bodies and edits one derivation entry (`delegatesTo`, plus a navigator kind). If REL-3
  lands on `main` *while* this stack is open and touches `templates/entity/new/backend/service.ejs.t`, that is
  a stop condition (§14.6), not a reason to wait up front.
- **#679** owns the two deferred pipelines. **#697** and **#680** are fixed *through* the derivation after
  Phase B. **#711** closes in B2.

---

## 11. Slices 2 and 3 — outline only

| | Slice 2 — columns / fields / types | Slice 3 — module wiring |
|---|---|---|
| Home | `src/derived/columns/` | `src/derived/wiring/` |
| Takes over | Drizzle column chain, nullability, enums, indexes and constraints, DTO field sets and Zod chains, **every TS type string** (incl. `queryTypes` and the read-generics duplicate) | providers, imports, exports, `forwardRef`, cross-module repository deps, import specifiers |
| Decided today | `EL:396-630`, `:912-1243`, `:2084-2249`, `:2345-2389`; a second, inline behaviour registry in `prompt.js:41-145` | `EL:847-866`, `:1698-1815`, `:2251-2314`; `module.ejs.t`; `junction-fan-out.mjs:152-164` |
| Shares with slice 1 | the directory, the parity harness, the golden pattern, the `files` plumbing, the lint, a "Columns" tab | the same, plus `delegatesTo` (it already says which repositories a service needs) |
| Risk | **Highest** — this is the DDL; a silent change is a migration | **Lowest** — mechanical, and REL-3 deletes a third of it |
| Rough size | 6–8 days | 3–4 days, less after REL-3 |

Decide on slice 2 after Phase B. Do slice 3 only after REL-3.

---

## 12. Risks and questions

**Risks**

| # | Risk | Response |
|---|---|---|
| R1 | Phase A leaves two derivations. | Temporary **by decision**: Phase B is committed with Phase A. Parity makes drift a red build; the allowlist names what is unmigrated. |
| R2 | The byte-identical proof is weaker than it looks (F2). | B1 lands first in Phase B, with its own sign-off (S3). |
| R3 | Raw-YAML and zod-parsed inputs disagree, so Studio shows what the generator does not emit. | `derive(raw) ≡ derive(parsed)` over every fixture; the Studio e2e asserts against a really generated project. |
| R4 | An unattended run satisfies a gate by weakening it. | §14.3 — frozen paths, a shrink-only allowlist, mechanical detection commands; §14.6 stops instead. |
| R5 | REL-3, #679 or anything else lands under the open stack. | Stop condition (§14.6). No up-front wait. |
| R6 | The derivation grows into a second locals blob. | §4.1's exclusion list is in the ADR; a `grep` for type strings in `types.ts` is an A1 exit check. |
| R7 | Works from checkout, broken from tarball (#266 class). | Manifest tests in `test-unit`; `just test-post-publish` on B2 and B4. |
| R8 | `ts-morph` parsing slows `test-unit`. | Measured in A1; reported in the PR body. Over ~3s → its own recipe inside `test-all`. |

**Resolved (2026-11-12)**

| | Decision |
|---|---|
| Q1 | Phase A then Phase B; both committed. |
| Q2 | Studio shells `codegen project surface --json`. |
| Q3 | Junction- and `relationship:`-owned modules deferred to #679, listed as `unmodelled`. |
| Q6 | Oddities recorded, not fixed, in slice 1. |
| REL-3 | B4 does not wait. |
| Types | None in slice 1; the field-type function does not move. |

**Open — defaults applied unless you say otherwise**

| # | Question | Default |
|---|---|---|
| N1 | Directory name: `src/derived/api/` instead of `src/surface/api/` (§4.2). | **Decided 2026-11-13: `src/derived/api/`.** |
| Q4 | What `project surface` answers for a `has_many` whose target was never generated (F3). | "What `entity new --all` emits." Single-entity `entity new` keeps today's disk check, passed in explicitly. |
| Q5 | F7 is real (§14.4). Warning or error? | **Warning in A2**, as you framed it — and D4 (§3.4) warns by the same rule. All three shapes already fail the consumer's `tsc`, so promoting it to an `entity validate` error would break no working project — file that as its own issue at S4; REL-3 probably removes the need. |
| Q8 | Should the frontend client (`emit-api.ts`) read `http.routes` (F6)? | Follow-up issue filed at S4; no derivation change. |
| Q9 | `pattern: Junction` pairings as selectable edges? | Not in v1; revisit with #679. |

---

## 13. Charter invariants (PROJECT.md §4)

| | How this plan holds it |
|---|---|
| I1 declare once | A projection of the YAML; the whole-set half calls REL-1's `buildRelationGraph`. The parity gate reads generated output only to *check*. Five duplicated decisions removed (§3.2). |
| I2 generated means regenerated | Unchanged: every file still complete-file, `@generated`. |
| I6 HTTP closed by default | Studio displays the compiled allowlist; nothing widens it. |
| I7 no backwards compatibility | Old locals and the three finder-name copies are deleted, not aliased. Phase A's gated duplicate is temporary by decision (R1). |
| I9 gates are honest | Exact-set parity both ways, mutation-checked; allowlist entries named, counted, asserted present; §14.3 forbids every weakening and says how each is detected. |
| I10 public repository | Only fixture and demo names here, in the ADR and in the spec. |
| I11 scope discipline | Per-entity backend files stay hygen; the whole-set derivation is TypeScript. No hygen → emitter migration. |

---

## 14. Execution protocol

For one orchestration session working the PRs in order. Every check is a command plus an expected exit code or
literal output. "Looks right" is not a check.

### 14.1 Conventions and standing gates

```sh
ROOT=$(git rev-parse --show-toplevel)
U() { bun test "$ROOT/src/__tests__/$1"; }   # bun treats a path as a substring filter — always absolute
```

- **The builder lane does not certify itself.** The orchestrator re-runs every exit command on the PR head and
  pastes *that* output into the PR body.
- Outputs are from the run **after the last edit** (charter I9).
- `$BASE_A` / `$BASE_B` = the commit each phase starts from; `$A1` … `$B4` = each PR's head.

**P0 — once per phase, before the first PR.** Record `git rev-parse HEAD`; `just test-all` → exit 0;
`just test-integration` → exit 0; `just test-unit 2>&1 | tail -4` → record `N pass` as the unit-count floor.
Any red here is a stop — it is not this work's to fix.

| Gate | Command | Expected |
|---|---|---|
| G1 | `just typecheck` | exit 0 |
| G2 | `just test-unit` | exit 0; ` 0 fail`; `N pass` ≥ the previous PR's `N` (minus only the deletions §14.3 enumerates) |
| G3 | `just test-baseline` | exit 0; last line `✅ All tests passed!`; no line starting `❌`; contains `Typecheck passed (only the named #680 expectation` |
| G3′ | `git status --porcelain test/baseline` | empty |
| G4 | `just test-junction` | exit 0; ` 0 fail`; `git status --porcelain test/junction/__snapshots__` empty |
| G5 | `just test-all` | exit 0 |
| G6 | `just test-integration` (Docker) | exit 0; ` 0 fail` |
| G7 | `just test-studio` | exit 0 |
| G8 | `just test-post-publish` | exit 0 |
| G9 | `gh pr checks <n> --required` | exit 0 (both CI jobs) |

Which gates per PR: A0 — G2. A1, A2 — G1–G5, G9. A3–A5 — G1, G2, G5, G7, G9. B1 — G1–G5, G9. B2, B3 — G1–G6,
G9; B2 also G8. B4 — G1–G9.

### 14.2 Per-PR exit criteria

A mutation check is: apply the exact edit → run the named command → see the exact text → revert with
`git checkout -- <file>` → `git status --porcelain` is what it was before. A mutation is never committed. Every
`perl` / `printf` edit below was dry-run on copies of the real files at `c1ceeefd` and changes exactly the line
it names. After a Phase B mutation (which regenerates), re-run G3 once reverted so the generated tree is clean.

`C` = `test/baseline/packages/api/src/modules/contacts`.

**A0**

| Check | Expected |
|---|---|
| `git diff --name-only $BASE_A..HEAD` | exactly `CLAUDE.md`, `docs/adrs/ADR-046-derived-once-templates-print.md`, `docs/specs/STUDIO-0.md`, plus this plan's own post-implementation corrections (`.ai-docs/stacks/api-surface-model/PLAN.md`) |
| `grep -c '^### Templates print (ADR-046)$' CLAUDE.md` | `1` |
| `git show $BASE_A:docs/specs/STUDIO-0.md \| grep -c 'serializeDomainGraph. in-process'`, then the same `grep -c` on `HEAD` | `1`, then `0`. (The first draft of this row grepped the whole sentence, which wraps across two lines, so it printed `0` at the base too and could not fail.) |

**A1**

| Check | Expected |
|---|---|
| `git diff --stat $BASE_A..HEAD -- templates package.json test/baseline test/junction/__snapshots__` | empty |
| `U derived/` | exit 0; ` 0 fail` |
| `U templates/no-name-derivation-in-templates.test.ts` | exit 0; ` 0 fail` |
| `grep -nE 'tsType\|returnType\|type: string' src/derived/api/types.ts` | no output (no type strings) |
| `grep -nE '^import ' src/derived/api/types.ts \| grep -v 'import type'` | no output |
| `grep -nE "from '\.\./\.\./(emitters\|parser\|cli\|analyzer\|studio)/" src/derived/api/{types,names,entity}.ts` | no output (hygen-safe import graph) |
| `ls test/api-surface-golden/snapshot \| wc -l` | ≥ 9 (the baseline fixture entities) + the matrix cases |
| `time U derived/` | wall time reported in the PR body (R8) |

| # | Mutation (exact) | Command | Expected: exit 1 and this text |
|---|---|---|---|
| M1 | `perl -0pi -e 's/\n\}\n\z/\n  async findSpurious(): Promise<void> {}\n}\n/' $C/contact.repository.ts` | `U derived/api-surface-parity.test.ts` | ``ContactRepository declares `findSpurious`, which the derived API surface does not list`` |
| M2 | `perl -pi -e 's/override async findByIds</override async findByIdz</' $C/contact.repository.ts` | same | ``ContactRepository declares `findByIdz` `` **and** ``the derived API surface lists `ContactRepository.findByIds` `` |
| M3 | `perl -pi -e "s/\@Get\(':id'\)/\@Get(':key')/" $C/contact.controller.ts` | same | ``ContactController declares route `GET /contacts/:key` `` **and** ``lists route `GET /contacts/:id` `` |
| M4 | `perl -pi -e 's/  async exists\(id: string\)/  async existz(id: string)/' runtime/base-classes/base-repository.ts` | same | ``ContactRepository lists `exists` as inherited, but no class in its base chain (IntegratedEntityRepository → BaseRepository) declares it`` |
| M5 | `rm $C/contact.service.ts` | same | ``no generated file for `contact` at test/baseline/packages/api/src/modules/contacts/contact.service.ts`` |
| M6 | `perl -0pi -e 's/  - by: \[email\]\n    unique: true/  - by: [email]/' test/fixtures/entities/contact-v2.yaml` | `U derived/api-surface-golden.test.ts` | ``api-surface golden: `contact` differs from test/api-surface-golden/snapshot/contact.json`` |
| M7 | `printf '<%%_ const x = entityName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); _%%>\n' >> templates/entity/new/backend/index.ejs.t` | `U templates/no-name-derivation-in-templates.test.ts` | `no-name-derivation: templates/entity/new/backend/index.ejs.t — 1 inline-camel-case not in the allowlist` |
| M8 | `perl -pi -e 's/entityName\.replace\(\/_\(\[a-z\]\)\/g, \(_, c\) => c\.toUpperCase\(\)\)/camelCase(entityName)/' templates/entity/new/backend/service.ejs.t` | same | `allowlist entry templates/entity/new/backend/service.ejs.t · inline-camel-case expects 4, found 2 — shrink or delete the entry` |

M6 is the one parity cannot see (the method name is unchanged; only `unique` and the shape move) — it is why
the golden exists.

**A2**

Run `just studio-demo` first (no Docker, no network; writes the git-ignored `.studio-demo/`), then
`S() { bun src/cli/index.ts project surface --json --cwd .studio-demo | jq -r "$1"; }`.

| Check | Expected |
|---|---|
| `git diff --stat $BASE_A..HEAD -- templates package.json test/baseline test/junction/__snapshots__` | empty |
| `S '.surface.entities.contact.repository.methods[] \| select(.emitted) \| .name' \| LC_ALL=C sort \| tr '\n' ' '` | `count findByAccountId findByEmail findById findByIds list ` |
| `S '.surface.entities.contact.repository.methods[] \| select(.name=="findByAccountId") \| .origin.at.path \| join(".")'` | `relationships.account` |
| `… \| .origin.shadows[0].path \| map(tostring) \| join(".")'` | `queries.0` |
| `S '.surface.entities.contact.repository.methods[] \| select(.name=="findByEmail") \| "\(.origin.at.path\|map(tostring)\|join(".")) \(.unique) \(.returns)"'` | `queries.1 true one` |
| `S '.surface.entities.contact.http.routes[] \| "\(.verb) \(.path)"'` | five lines: `GET /contacts`, `GET /contacts/:id`, `POST /contacts`, `PATCH /contacts/:id`, `DELETE /contacts/:id` |
| `S '.surface.relations[] \| select(.id=="contact.relationships.account") \| .inverseOf'` | `account.relationships.contacts` |
| `S '.surface.relations[] \| select(.id=="contact.relationships.account") \| .generates[] \| "\(.entity).\(.layer).\(.method)"' \| LC_ALL=C sort \| tr '\n' ' '` | `contact.repository.findByAccountId contact.service.account ` |
| `S '.surface.entities.account.service.methods[] \| select(.name=="contacts") \| "\(.kind) \(.delegatesTo.entity).\(.delegatesTo.method)"'` | `relation_many contact.findByAccountId` |
| `S '.surface.warnings \| length'` and `S '.surface.unmodelled \| length'` | `0` and `0` |
| `bun src/cli/index.ts project surface --cwd .studio-demo; echo $?` | a table per entity; `0` |
| **F7 regression** — `U derived/has-many-delegate.test.ts`, four in-memory cases matching `f7-preflight/run-f7.ts`, plus D4's three (`d4-preflight/run-d4.ts`: W0 Metadata → `[]`; W1 no pattern and W2 Integrated → ``field_value.eav_value_table: `FieldValueService.findMergedByEntity` calls `FieldValueRepository.findByEntityIdAndType`, which field_value does not emit``) | V0: `warnings` is `[]`. V1: ``account.relationships.contacts: `AccountService.contacts` calls `ContactRepository.findByAccountId`, which contact does not emit``. V2 and V3: ``…calls `ContactRepository.findByAccountId`, which is a `queries:` finder, not an FK finder`` |
| F7 on the CLI: V1's two YAMLs in a scratch dir, `project surface --json` | exit **0** (a warning, not an error); `.surface.warnings \| length` → `1` |
| `U derived/api-surface-golden.test.ts` | exit 0 — the golden now also holds `relations` and `warnings` |

**A3**

| Check | Expected |
|---|---|
| `git diff --stat $BASE_A..HEAD -- templates package.json test/baseline` | empty |
| `just test-studio` | exit 0; the e2e's stage list includes the new `GET /api/surface` stage |
| the e2e asserts, by exact value | every A2 row above, over HTTP; **and** after the demo relationship is written, `unmodelled` contains `{ name: 'contact_opportunity', kind: 'relationship' }`. *As built:* stages `2b` and `9b` (existing numbers unchanged); `9b` asserts `unmodelled` projected to `{ name, kind }` **equals** that one entry (stricter than contains; `reason` is free text and not pinned). `getSurface` reuses `CliFailureError` (a 502 with the CLI's detail) and also fails a payload without `surface`. STUDIO-0 §3's route table gains the row. |
| `grep -nE '^import ' src/studio/shared/api.ts \| grep -v 'import type'` | no output (contract stays types-only) |
| `grep -n "spawn(" src/studio/server/surface.ts` | no output (only `cli-runner.ts` spawns) |

**A4**

| Check | Expected |
|---|---|
| `git diff --stat $BASE_A..HEAD -- templates package.json test/baseline src/derived` vs `$A3` | no change to `src/derived` since `$A3` (the UI does not reshape the derivation; if it must, stop) |
| `just test-studio` | exit 0; ` 0 fail` in the UI unit run; new `surface-view.test.ts` present |
| `grep -rnE "['\"]#[0-9a-fA-F]{3,8}['\"]\|rgba?\(\|hsla?\(" tools/studio/src/inspector/ApiTab.tsx tools/studio/src/inspector/surface-kinds.ts` | no output (no colour literal; a quoted form, so an issue number in a comment does not match) |
| `grep -rnE "'(fk_finder\|finder\|relation_one\|relation_many)'" tools/studio/src --include='*.tsx'` | no output (kinds are read from `surface-kinds.ts`, never branched on in a component) |
| screenshots for S2 captured | the five in §14.5 |

**A5**

| Check | Expected |
|---|---|
| `just test-studio` | exit 0; `schema-adapter.test.ts` still asserts 4 nodes · 6 edges for the demo graph |
| `grep -n "relationId" tools/studio/src/adapters/schema-adapter.ts` | ≥ 1; and `grep -rn "\.id\.split(" tools/studio/src` → no output (the id is never parsed) |
| colour-literal and kind-literal greps from A4, over `EdgePanel.tsx` | no output |
| Phase A frozen paths: `git diff --stat $BASE_A..HEAD -- templates package.json test/baseline test/junction/__snapshots__ test/relations-golden test/frontend-golden test/frontend-graph-golden test/semantic-golden test/integration-emit test/smoke/_consumer-errors.ts test/run-test.ts` | empty |

**B1**

| Check | Expected |
|---|---|
| `git diff --stat $BASE_B..HEAD -- templates src/derived test/api-surface-golden` | empty (snapshots are taken of today's output, before any template edit) |
| `U backend/render-golden.test.ts` | exit 0; ` 0 fail` |
| each F2 gap is now byte-covered: `grep -rl <needle> test/render-golden` for `findByIdWithFields`, `upsertCurrentValues`, `Capability forwarders`, `ComposedBase`, `_API_INCLUDES.list` | ≥ 1 file each |
| `api: false` case: `ls test/render-golden/<case>/` | no `*.controller.ts` |
| `generate.writes: false` case | no `create-*.use-case.ts` |
| Mutation: `perl -pi -e 's/async findByIdWithFields/async findByIdWithFieldz/' templates/entity/new/backend/service.ejs.t` → `U backend/render-golden.test.ts` | exit 1; the EAV case named in the failure |

**B2**

| Check | Expected |
|---|---|
| Frozen: `git diff --stat $B1..HEAD -- test/baseline test/junction/__snapshots__ test/render-golden test/api-surface-golden src/__tests__/derived src/__tests__/templates/no-name-derivation-in-templates.test.ts test/run-test.ts test/smoke/_consumer-errors.ts` | empty |
| `grep -cE 'charAt\(0\)\.toUpperCase\(\)\|processedQueries\|_fkMethodNames\|_skipFkMethod\|_skipClpDq\|repositoryInheritedMethods' templates/entity/new/backend/repository.ejs.t` | `0` |
| `test -e src/schema/query-routes.ts; echo $?` | `1` |
| `grep -rn 'function deriveQueryMethodName' templates src` | no output |
| `git diff --numstat $B1..HEAD -- src/__tests__/templates/no-name-derivation.allowlist.ts \| cut -f1` | `0` (no added line) |
| `grep -c 'repository.ejs.t' src/__tests__/templates/no-name-derivation.allowlist.ts` | `0` |
| G8 `just test-post-publish` | exit 0 |
| **Mutation — the template now reads the derivation.** In `finderName()` in `src/derived/api/names.ts`, change the prefix `findBy` to `findByX`; `git diff --stat` shows that file only, `1 insertion(+), 1 deletion(-)`. Then `bun test/run-test.ts generate && bun test/run-test.ts compare` | exit 1; output contains `❌ Content differs: packages/api/src/modules/contacts/contact.repository.ts` and `❌ Content differs: packages/api/src/modules/deals/deal.repository.ts` |

**B3**

| Check | Expected |
|---|---|
| Frozen paths as B2 (from `$B1`) | empty |
| `grep -c 'apiEnabled' templates/entity/new/backend/*.ejs.t` | every file `:0` |
| `grep -c 'apiIncludeRoutes\|apiIncludesConst' templates/entity/new/backend/controller.ejs.t` | `0` |
| `grep -rnE '^export function (apiEnabled\|declaresOwnRelation\|includesConstName)\b' src \| wc -l` | `3`, all three under `src/derived/api/` |
| `grep -n '_API_INCLUDES' templates/entity/new/backend/entity-locals.js` | no output |
| `test -e src/__tests__/emitters/relations/route-name-parity.test.ts; echo $?` | `1` (nothing left to compare) |
| **Mutation.** In `src/derived/api/entity.ts`, change the `find_by_id` route path suffix `/:id` to `/:key` (one line). `bun test/run-test.ts generate && bun test/run-test.ts compare` | exit 1; `❌ Content differs: packages/api/src/modules/contacts/contact.controller.ts` |

**B4**

| Check | Expected |
|---|---|
| Frozen paths as B2 (from `$B1`) | empty |
| `grep -cE '\.replace\(/_\(\[a-z\]\)/g\|findBy<%\|capabilityForwarders\|processedQueries' templates/entity/new/backend/service.ejs.t` | `0` |
| `grep -c 'useCaseClassName\|methodName' templates/entity/new/backend/use-cases/declarative-queries.ejs.t` | `0` |
| `grep -cE 'templates/entity/new/(backend/\|prompt\.js)' src/__tests__/templates/no-name-derivation.allowlist.ts` | `0` |
| `git diff --numstat $B1..HEAD -- src/__tests__/templates/no-name-derivation.allowlist.ts \| cut -f1` | `0` |
| `grep -c 'not yet migrated' CLAUDE.md` | `0` |
| **Mutation.** In `relationMethodName()` in `src/derived/api/names.ts`, append `X` to the returned name (one line). `bun test/run-test.ts generate && bun test/run-test.ts compare` | exit 1; `❌ Content differs: packages/api/src/modules/contacts/contact.service.ts` |
| G6, G8 | exit 0 |
| ADR-046 has a dated revision note; `docs/specs/STUDIO-2.md` status is not "Design" | `grep -c '^\*\*Revision' docs/adrs/ADR-046-*.md` ≥ 1 |

### 14.3 Anti-cheat rules

The orchestrator may never do any of these to get green. Each has a detection command, run at every PR and
again by the reviewer; a non-empty result is a stop (§14.6), not something to explain away.

| Never | Detection (must print nothing unless noted) |
|---|---|
| Edit a snapshot to match. Phase A changes no existing snapshot; Phase B changes none at all after B1. | Phase A: `git diff --stat $BASE_A..HEAD -- test/baseline test/junction/__snapshots__ test/relations-golden test/frontend-golden test/frontend-graph-golden test/semantic-golden test/integration-emit`. Phase B: the same list plus `test/render-golden test/api-surface-golden`, from `$B1`. |
| Run `just baseline` or `bun test --update-snapshots` in Phase B. | same diff; plus `git status --porcelain test/` empty after every gate run |
| Add to the lint allowlist. It only shrinks. | `git diff --numstat <A1>..HEAD -- src/__tests__/templates/no-name-derivation.allowlist.ts \| cut -f1` → `0` |
| Loosen the lint or the parity comparison after S1 signed them off. | `git diff --stat <A1>..HEAD -- src/__tests__/derived/api-surface-parity.test.ts src/__tests__/derived/_parity-compare.ts src/__tests__/templates/no-name-derivation-in-templates.test.ts` |
| Skip or narrow a test. | `git diff $BASE..HEAD \| grep -nE '^\+.*\b(it\|test\|describe)\.(skip\|todo\|only)\b\|^\+.*\b(xit\|xdescribe)\('` |
| Delete or weaken an assertion in an existing test. | `git diff $BASE..HEAD -- src/__tests__ test tools/studio/src/__tests__ \| grep -c '^-.*expect('` → `0`, **except** in the two enumerated deletions: `src/__tests__/emitters/relations/route-name-parity.test.ts` (B2 its finder half, B3 the rest); and one enumerated update: `src/__tests__/cli/project.test.ts`'s `expect(projectNoun.commandClasses.length).toBe(<n>)`, whose count changes only when a command is added and is never deleted or loosened (A2: `8` → `9` for `project surface`; approved by Doug 2026-11-14 after it tripped this detection) |
| Delete a test file not enumerated above. | `git diff --diff-filter=D --name-only $BASE..HEAD -- src/__tests__ test tools/studio/src/__tests__` → only that file, plus `src/schema/query-routes.ts`'s own test if one exists |
| Add a predicate to the smoke filter, or touch the #680 expectation. | `git diff --stat $BASE..HEAD -- test/smoke/_consumer-errors.ts test/run-test.ts` |
| Silence the type checker. | `git diff $BASE..HEAD -- src/derived src/studio tools/studio/src \| grep -nE '^\+.*(@ts-ignore\|@ts-expect-error\|as any\|as unknown as)'` |
| Edit `templates/` or `package.json` in Phase A. | `git diff --stat $BASE_A..HEAD -- templates package.json` |
| Change the derivation in Phase B to make a template pass. | `git diff --stat $B1..HEAD -- test/api-surface-golden` (frozen); any change to `src/derived/api/` in Phase B must leave it green **and** be named in the PR body |
| Leave a mutation behind. | after each mutation check, `git status --porcelain` equals its pre-mutation output; and `git diff $BASE..HEAD -- test/baseline test/fixtures runtime templates src/derived \| grep -nE '^\+.*(findSpurious\|findByIdz\|existz\|findByX\|:key)'` prints nothing. (Scoped at S1, 2026-11-14: the whole-diff grep matched this plan's own mutation table and a `:key` route fixture in the comparator's unit test. M1 first added `findRecent`, a real Activity-pattern method in three matrix goldens; renamed in A1.) |
| Let the unit count fall. | G2's `N pass` never below the previous PR's, less only the enumerated deletions |
| Report a gate from before the last edit. | each PR body states `git rev-parse HEAD` beside every gate output; it must equal the PR head |

### 14.4 F7 pre-flight — done, 2026-11-12

Run against `main` @ `c1ceeefd` in a scratch project outside the repo: `bun init`, the smoke harness's pinned
deps, `project init --yes --with-tsconfig --runtime vendored`, then four variants of an `account` (declares
`contacts: has_many, foreign_key: account_id`) / `contact` pair. Script and full output:
`.ai-docs/stacks/api-surface-model/f7-preflight/`.

| Variant | `contact` declares | `entity validate` | `entity new` | `tsc` |
|---|---|---|---|---|
| V0 control | `belongs_to account` | valid | exit 0 | **0 errors** |
| **V1 — F7** | `account_id` as a plain field only | valid, 0 warnings | exit 0 | `account.service.ts(83,29): error TS2339: Property 'findByAccountId' does not exist on type 'ContactRepository'.` |
| V2 | plain field + `queries: by [account_id]` | valid, 0 warnings | exit 0 | `account.service.ts(83,56): error TS2345: Argument of type '{ limit?: number \| undefined; } \| undefined' is not assignable to parameter of type 'ReadOptions<never, undefined> \| undefined'.` |
| V3 | `belongs_to` + a **unique** `queries: by [account_id]` | valid, 0 warnings | exit 0 | `account.service.ts(83,5): error TS2322: Type '{ … } \| null' is not assignable to type '{ … }[]'.` and the same TS2345 |

In every variant the service emits `return this.contactRepo.findByAccountId(accountId, opts);`. So the rule A2
checks is not "the delegate exists" but **"a `relation_many` delegates to an `fk_finder`"** — V2 and V3 have a
method of the right name and the wrong kind. V3 also shows the precedence rule (§3.1) leaking across entities:
the target's own `queries:` entry changes what another entity's service can call.

### 14.5 Sign-off checkpoints

The orchestrator stops, publishes the packet, and waits. Four stops; the Phase A merge rides on S3 rather than
adding a fifth.

| Stop | When | What you look at | "Approve" unlocks |
|---|---|---|---|
| **S1** | after A1 (A0 included) | A story page: the derived surface of the demo `contact` and `account` as tables with origin chips, rendered from the golden JSON; `types.ts` (one file); ADR-046 and the CLAUDE.md rule; the eight mutation checks with their red output; the oddities list (§3.4); the unit-time number (R8). Also the place to settle N1 if not already. | A2, A3, A4. From here the parity test, comparator and lint are frozen. |
| **S2** | after A4 | Screenshots of Studio on `.studio-demo`, one per row, full width, light and dark: (1) `contact` API tab; (2) a shadowed row — `findByAccountId` ← `relationships.account` over `queries[0]`; (3) click an origin chip → the YAML tab at that line; (4) a relationship node's "not modelled yet (#679)" state; (5) the surface route failing (server stopped) — the tab's error state, canvas intact. | A5, then the Phase A stack is submitted (not merged). |
| **S3** | after B1 | (a) Phase A: CI green on all six PRs; two edge-view screenshots. (b) Goldens: one table — matrix case → shape covered → files snapshotted → the F2 `grep` that now finds it. | You merge Phase A. The orchestrator rebases B1 onto `main`, re-runs B1's exit criteria, then B2–B4. No template has been edited before this point. |
| **S4** | after B4 | A one-page diff summary: per template, scriptlet-logic lines before → after; every deleted local with its reader list; the allowlist diff (deletions only); every frozen-path diff (empty); gate outputs; the tarball smoke; issues drafted for the oddities, F6 and Q5. | You merge Phase B. #711 closes. |

### 14.6 Stop conditions

Halt and ask. Do not push on.

| Condition | Why it is a stop |
|---|---|
| A byte diff in `test/baseline`, `test/junction/__snapshots__` or `test/render-golden` that cannot be explained in one sentence | Phase B's whole claim is "no behaviour change" |
| Any byte diff at all in those paths during Phase B, explained or not | the explanation is yours to accept, not the orchestrator's |
| Any §14.3 detection prints something | a gate was weakened, or the plan was wrong |
| A gate would have to change to pass — parity, comparator, golden, lint, allowlist, smoke filter, #680 expectation | same |
| Two failed fix attempts on the same gate | a third attempt is how gates get loosened |
| A design decision the plan and ADR-046 do not cover — a new method kind, a provenance case with no `Origin` variant, a type string that seems needed in slice 1 | not the orchestrator's call |
| The UI needs the derivation's shape changed after S1 | S1 signed the shape off |
| `main` moves under the open stack in `templates/entity/new/**`, `templates/_shared/**`, `src/emitters/relations/**`, `src/studio/**` or `tools/studio/**` (REL-3 #588, #679, anything) | rebasing a byte-identity proof across someone else's template change is a judgment call |
| P0 is red | pre-existing; not this work's |
| `just test-post-publish` fails on B2 or B4 | a tarball break is a release break |
| A new F7-class finding — generated code that validates and does not compile | record it, do not fix it inside a byte-identical PR |
| Docker or the network is unavailable for a required gate | a skipped gate is not a passed gate |

### 14.7 Evidence every PR body carries

1. **Head:** `git rev-parse HEAD`, and "all outputs below are from this commit".
2. **Gates:** each required gate's command, exit code and last lines.
3. **Exit table:** §14.2's table for this PR, each row with its actual output.
4. **Mutation checks:** each one's command, the red output containing the expected text, and the
   `git status --porcelain` after the revert.
5. **Anti-cheat:** every §14.3 detection command with its (empty) output.
6. **Silent-drop list** (Phase B): for every local deleted, the `grep` command and every reader it found, each
   marked converted or deleted.
7. **Byte identity** (Phase B): the frozen-path `git diff --stat`, empty.
8. **Differs from plan:** what was built differently and why, or "nothing". The spec and ADR are corrected in
   the same PR.

### 14.8 Landing

| | Rule |
|---|---|
| Stacks | Two. **Phase A** = A0–A5. **Phase B** = B1–B4, based on Phase A's tip until Phase A merges, then rebased onto `main`. |
| Submit | `gh stack submit --auto --open` once the top PR's exit criteria pass (`--auto` is auto-generated titles, not auto-merge). |
| Auto-merge | **Never enabled** on any PR. |
| Merge | You. Phase A at S3, Phase B at S4, each `gh stack merge --yes --squash` — atomic, all or none. A builder lane never merges. |
| After the Phase A merge | rebase B1 onto `main`; re-run B1's exit criteria and P0 for Phase B before B2 starts. |

---

## Appendix A — ADR-046 (draft; lands in A0 as `docs/adrs/ADR-046-derived-once-templates-print.md`)

**Title:** Generated API names are derived once; templates print them
**Status:** Accepted (S1, 2026-11-14) · **Owner:** Doug · **Related:** ADR-038 (whole-set emitter), ADR-044 §5 (both sides project
from one declared graph), ADR-041 (capability forwarders), ADR-045 (the *semantic model* — a different thing;
this ADR does not use the word "model" for its subject), charter I1 / I7 / I9, #711

**Context.** What a generated entity can do — its repository methods, service methods, use cases, routes and
include allowlists — is decided in a 2,700-line locals builder, inline in EJS, and again in TypeScript wherever
a second consumer needed the same answer (five such pairs, three held together by parity tests). A third
consumer, Studio, may not reimplement generation. The frontend already solved this shape of problem:
`buildClientGraph` projects REL-1's `buildRelationGraph`, and a golden holds them edge for edge.

**Decision.**

1. Every name and every existence decision about the generated backend API surface is derived once, in
   `src/derived/api/`, as typed data with provenance (the YAML path, the pattern or the capability that caused
   it).
2. It is testable without rendering.
3. Templates print: loop, branch on flags, emit. They never build a name, change case or decide existence.
4. It holds names and existence only. Types, bodies, import paths, file paths and DTO shapes are not in it.
5. Per-entity facts come from that entity's inputs; facts that need the graph are derived whole-set, from
   REL-1's builder, never from a second walk of the YAML.
6. Other readers (Studio, `codegen project surface`, docs, tests) read it. None derives.
7. Adoption is by slice. A slice owns only what it has taken over; a refactor slice leaves the byte goldens
   unchanged.

**Consequences.** One place to rename a method or add a method kind. A new generated method needs an entry
first, enforced by the parity gate; its provenance is pinned by a golden. The TypeScript ships in `files`
because templates import it. During adoption the derivation and the old inline derivations coexist under a gate;
the allowlist records what remains, and only shrinks.

**Alternatives rejected.** *Studio parses generated code* — introspecting output to recover what the YAML says
(I1). *Studio re-derives names* — the tenth copy. *Move the backend to TS emitters* — out of scope by I11, and
unnecessary: the problem is who decides, not which engine prints. *Carry bodies, types and imports too* — a
second locals blob. *Name the directory `surface`* — already the integration-surface term in the same files.

**Revision notes.** (none yet — B4 records what implementation changed)

---

## Appendix B — `docs/specs/STUDIO-2.md` (outline; lands in A3, corrected to post-implementation truth in A5)

**STUDIO-2 — the API view: what each entity and each relationship generates**
**Depends on:** STUDIO-0 (#698), ADR-046 · **Coupled to:** #679, REL-3 (#588), STUDIO-1 (#717)

1. **What it must make possible.** Select `contact` → every repository method, service method, use case and
   route it generates, each with the YAML line that caused it. Select the `contact → account` edge → what that
   one relationship generates on both sides.
2. **Architecture.** The derivation is the generator's (ADR-046). The server shells `project surface --json`;
   why not in-process. A separate route from `/api/graph`, and why.
3. **Contract.** `SurfaceResponse`; the types are re-exports, never mirrored.
4. **The API tab.** Sections, row anatomy (name, param names, shape — no types until slice 2), origin chips,
   the shadowing display, provenance → YAML line, the `unmodelled` state.
5. **The edge view.** Edge selection; `relationId`; pairing and `inverseOf`; include keys; what a junction
   shows.
6. **Vocabulary table.** `surface-kinds.ts` — #679 and REL-3 are table edits.
7. **Theming.** Tokens only; relation chips reuse the edge-kind colour.
8. **Gates.** The e2e stage and its exact expectations; the UI unit tests; what is not proven (no pane is
   rendered in CI).
9. **Not in this spec.** Reachability view; executing a path (STUDIO-1 / REL-3); a Columns tab (slice 2).
10. **Open questions.** Junction pairings as selectable edges; whether a shadowed declaration deserves a
    warning in the YAML editor; a link from the tab to the generated file in the diff drawer.
11. **Charter invariants.** I1, I6, I9, I10.
