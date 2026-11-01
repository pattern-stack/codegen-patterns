---
issue: pattern-stack/codegen-patterns#813
stack: gaps-batch1
plan_key: reserved-entity-names
stack_position: C (1 of 2; #815 lands on top and must reproduce this PR's regenerated snapshots single-pass)
layer: L0
gate: auto (gate:auto)
status: implemented
base: main @ a8629dfc
related:
  - .ai-docs/stacks/gaps-batch1/plan.yaml          # Gate 0, approved 2026-10-31 with every open_questions recommendation (branch dugshub/gaps-batch1-plan)
  - pattern-stack/codegen-patterns#715             # sibling: reserved FIELD names (not this PR)
  - pattern-stack/codegen-patterns#815             # stacked on top: single-pass `entity new --all`
  - pattern-stack/codegen-patterns#818             # release 0.32.0 (reads this PR's Changelog block)
---

# Spec — #813: entity names and plurals cannot collide with TypeScript globals or template locals

## Goal

A host application has entities named `record` and `item`, and renames them before generation because the output
does not compile. After this PR:

- An entity named `record` and one with plural `items` generate a tree that passes `tsc`, in both runtime modes.
- Generated code cannot be broken by any entity name or plural that validation accepts. Validation rejects the three
  names it cannot reasonably support (`promise`, `array`, `date`) with an error that names the entity and the global.

## Approach

### Why it breaks

An entity's PascalCase name is a **type** in every emitted file that reads the entity
(`export type Record = InferSelectModel<…>` in `entity.ejs.t:80`, then `import { …, type Record }` elsewhere). A
module-level type binding shadows the lib global of the same name for the whole file. The base templates use those
globals by their bare names, so an entity named `record` turns `Record<string, never>` (`repository.ejs.t:116`,
emitted unconditionally) into a reference to the entity row type, which is TS2315.

The plural is a **value**: it is the Drizzle table export (`export const items = pgTable(…)`, `entity.ejs.t:29`), and
`list.ejs.t:11` imports it. `list.ejs.t:100-101` reads it inside `execute`, and `list.ejs.t:131` declares
`const [items, total]` in the same function, which gives TS2448 and TS2454. Renaming only the reported locals is not
enough. With plural `options`, `list.ejs.t:64` declares an `options` parameter, and the `known` check reads that
parameter instead of the table. That **compiles**, but every caller `sort_by` is then ignored. A local that shadows a
table export is a silent bug as often as a loud one.

Measured at a8629dfc on TypeScript 5.9.3 and 6.0.3 (the smoke installs `typescript@5`; the repo pins `^6.0.2`):

- With `type Record`, `type Partial`, `type Map`, `type Date` and `type Promise` imported from an entity module,
  `globalThis.Record<…>`, `globalThis.Partial<…>`, `globalThis.Pick<…>`, `globalThis.Omit<…>`,
  `globalThis.Readonly<…>`, `globalThis.ReturnType<…>`, `globalThis.Parameters<…>`, `globalThis.ReadonlyMap<…>`,
  `globalThis.Map<…>`, `globalThis.PropertyKey`, `globalThis.NonNullable<…>` and `globalThis.Date` all resolve in type
  position. `async f(): globalThis.Promise<T>` is also accepted. The unqualified forms fail with TS2315 or TS2739.
- A type-only binding does **not** shadow the global's *value*. `new Map()`, `new Date()`, `Promise.all(…)`,
  `Object.keys(…)` and `new Error(…)` keep resolving to the globals. The entity name is emitted only as a type: every
  emission is `export type <Entity> =`, `import type { <Entity> }` or `import { …, type <Entity> }`, and no emitter
  declares a value named bare `<Entity>`. Only **type-position** references can break.
- The list use case's body, reproduced with a module-level `items` table, fails with TS2448 and TS2454 at the `known`
  line. With plural `options`, it compiles with no error and reads the parameter.

So qualifying with `globalThis.` works. No file-local alias is needed: an alias declared in the same file would itself
be shadowed.

### The rule (one statement, two halves)

**1. A file in which an entity type can be in scope never names a lib global type unqualified, except `Promise`,
`Array` and `Date`.** Every other lib type is written `globalThis.<Name>`. That covers `Record`, `Partial`,
`Readonly`, `Pick`, `Omit`, `ReturnType`, `Parameters`, `ReadonlyMap`, `Map`, `PropertyKey` today, and anything a later
template adds. "Can be in scope" means the file imports from an entity module (backend: a specifier ending in
`.entity`; frontend: `<frontend.dbEntitiesImport>/<entity name>`) or declares a row type itself
(`type X = InferSelectModel<…>`). Files that never bind an entity type are left alone: the relations manifest
(`import * as schema`), the semantic model, the frontend's `config.ts`, `api/client.ts` and `fields/field-meta.ts`,
and the subsystem templates. An entity name cannot reach those files, and churning them buys nothing.

**2. A function that reads a table export by its identifier declares no binding a plural can equal.** Plurals match
`^[a-z][a-z0-9_]*$` (`entity-definition.schema.ts:630`). Every parameter, local, destructured name and catch variable
in such a function therefore contains an uppercase letter. Today only the list and search `execute`s both read a table
export by identifier and declare bindings. The FK arrows in `entity.ejs.t:40`
(`.references((): AnyPgColumn => <table>.id)`) read one but declare nothing. Repositories go through `this.table` and
`this.db.query.<plural>`, which are property accesses and cannot be shadowed. Class-field initializers
(`readonly table = <plural>`) see no locals.

**Reserved names: `Promise`, `Array`, `Date`.** These three appear across emitted signatures: every async method returns
`Promise<…>`, every list result is `Array<…>`, and every date or timestamp column is typed `Date`
(`entity-locals.js:404-405`, `prompt.js:46-123`). Qualifying them would rewrite almost every emitted signature. Author
code next to the emitted files also writes them bare, so an entity named after one is a standing trap. Validation
rejects an entity or relationship name whose generated type name is one of the three. Everything else is made to work,
not reserved. That includes `record`, `item`, `map`, `set`, `error`, `event`, `object`, `number`, `symbol` and
`function`, because emitted code names those globals only as values (or, after this PR, qualified). This is narrower
than the plan's candidate list ("Promise, Date, Error, Map, Set, Array, Object, String, Number, Boolean, Symbol,
Function, JSON, Math, …"), and it follows the plan's own criterion: reserve only *globals generated code depends on and
cannot reasonably qualify*. `JSON` cannot be produced at all, because `pascalCase('json')` is `Json`.

The reserved list and the lint use **one constant**: the lint (Tests, G3) allows exactly
`RESERVED_ENTITY_TYPE_NAMES` unqualified. A later template that writes `Map<…>` bare fails the lint. Its author must
then either qualify it or add `Map` to the list, which turns `map` into a rejected entity name. That change is
deliberate and visible in the diff.

### Where the rule reaches

Validation is shared by every emitter, because one entity YAML feeds them all. If validation accepted `record` while
an emitter still broke on it, validation would be wrong. So the qualification covers every emitter that renders an
entity-scoped file:

- the backend hygen templates (`templates/entity/new/backend/**`), plus the type strings that `entity-locals.js` and
  `prompt.js` build;
- the junction service template (it imports both endpoint types and its own);
- the relationship prompt's `select:` return type;
- the frontend emitter's per-entity files (`api/<e>.ts`, `fields/<e>.ts`, `graph/<e>.ts`) and `store/lookups.ts`.
  These import row types from `@repo/db/entities/<name>`.

The integration generators (`sink-`, `adapter-`, `assembly-`, `change-emitter-emission-generator.ts`) import only
suffixed names (`<Entity>Repository`, `<Entity>IntegrationProjection`, …). They never bind a bare entity type, so rule
1 does not reach them and they need no change.

### Validation

`src/schema/reserved-entity-names.ts` holds the list, the PascalCase rule (identical to
`entity-locals.js:343-345`: `capitalize(camelCase(s))`, with `camelCase` replacing `_([a-z])`) and the message.
`EntityConfigSchema.name` (`entity-definition.schema.ts:624-629`) and `RelationshipConfigSchema.name`
(`relationship-definition.schema.ts:116-119`) gain a `superRefine` that adds one `custom` issue at
`['entity','name']` / `['relationship','name']`. Every path that validates a definition goes through these Zod
schemas: `entity new` and `entity validate` (`yaml-loader.ts:84`, `:207`), `just validate-entities`, and Studio's
schema-on-write (`studio/server/files.ts:140-185`, which already narrows issues to `{path, message, code}`). None of
them needs its own wiring. The result is an **error**, not a warning, as decided at Gate 0: a warned name still fails
`tsc`, later and less clearly.

A junction has no `name:`. Its name is `<left>_<right>` (`junction-definition.schema.ts:158-163`), so its type name has
at least two words and cannot equal a single-word global. The unit test asserts that every reserved global is a single
PascalCase word, so adding a multi-word global to the list fails that test until a junction check is written.

### PR body: `Changelog:` block

```markdown
Changelog:

### Fixed
- **Entity names and plurals no longer collide with TypeScript globals or template locals (#813).** An entity
  named `record` emitted a `Record` type that shadowed `Record<K, V>` in its own repository, controller and list
  use case (TS2315). A plural such as `items` collided with the list use case's `const [items, total]`
  (TS2448/TS2454), and a plural such as `options` compiled but silently ignored the caller's `sort_by`. Generated
  code now writes every TypeScript lib type it names as `globalThis.<Name>` (except `Promise`, `Array` and
  `Date`), and a function that reads a Drizzle table export by name declares only camelCase locals, which no
  plural can match. This covers the backend module tree, the junction service and the frontend emitter.

### Breaking
- **Entity and relationship names `promise`, `array` and `date` are rejected (#813).** Their generated type
  would shadow `Promise`, `Array` or `Date`, which generated code uses in nearly every signature. `entity validate`,
  `entity new`, `relationship new` and Studio report the entity and the global it shadows. Rename such an entity
  before regenerating.

Upgrade: regenerate with `codegen entity new --all --force` (and `codegen junction new --all --force` if you
declare junctions). Generated files change spelling only: `globalThis.`-qualified lib types, renamed locals in
the list and search use cases, and `service` instead of the plural-named member in EAV create/update use cases.
No schema, DDL or runtime change.
```

## File-level plan

Line numbers are at a8629dfc.

### Create

- `src/schema/reserved-entity-names.ts`: the reserved list, `generatedTypeName`, `reservedGlobalFor` and
  `reservedNameMessage` (see Interfaces). It is shipped (`src/schema/**` ships), so it imports nothing.
- `test/_emitted-name-hygiene.ts`: the lint helper `emittedNameViolations(files)` and `libGlobalTypeNames()` (see
  Interfaces). It is a test helper next to `test/smoke/_consumer-errors.ts` in spirit. It imports `typescript` (a
  runtime dependency, `package.json:102`) and `RESERVED_ENTITY_TYPE_NAMES`, so the validation list and the lint's
  allowance are the same constant.
- `src/__tests__/schema/reserved-entity-names.test.ts`: G2.
- `src/__tests__/templates/emitted-name-hygiene.test.ts`: G3.
- `src/__tests__/cli/reserved-entity-names-validate.test.ts`: G5. In-process Clipanion, using the harness from
  `src/__tests__/cli/pattern-load-errors.test.ts:22-60`.
- `test/smoke/fixtures/record.yaml`: `name: record`, `plural: records`, `table: records`, `pattern: Base`; fields
  `title` (string, required) and `notes` (string); `behaviors: [timestamps]`; `queries: [{ by: [title] }]`. It has no
  relationships, so it exercises the no-includes branch. The header comment names #813 and the base-commit failure
  (TS2315 in `record.repository.ts`, `record.controller.ts` and `list-records.use-case.ts`).
- `test/smoke/fixtures/item.yaml`: `name: item`, `plural: items`, `table: items`, `pattern: Base`; fields
  `record_id` (uuid, required, index, `foreign_key: records.id`), `name` (string, required) and `status` (enum
  `[open, closed]`, default `open`); `belongs_to: record`. A relationship makes it includable, so the includes branch
  of the list use case renders. `queries: [{ by: [record_id] }, { name: search, filters: [status], search: name }]`.
  The header comment names #813 and TS2448/TS2454 in `list-items.use-case.ts`. Both fixtures are also read by
  `run-smoke-subsystems.ts:39`, so they compile in vendored **and** package mode.

### Modify: backend templates (rule half 1, qualification)

Each site becomes `globalThis.<Name><…>`. Comments that only mention a type stay as they are. `service.ejs.t:125` is
inside an EJS comment and is not emitted.

| File | Lines | Global |
|---|---|---|
| `templates/entity/new/backend/repository.ejs.t` | 86, 116, 216, 440 · 132, 435 | `Record` · `Partial` (435 is `Array<globalThis.Partial<…>>`) |
| `templates/entity/new/backend/controller.ejs.t` | 74 · 144, 192 | `Readonly<Record<…>>` → both qualified · `Record` |
| `templates/entity/new/backend/service.ejs.t` | 136 · 137 · 252, 264, 288, 307 · 297 | `Parameters` · `ReturnType` · `Record` · `Partial` |
| `templates/entity/new/backend/integration-source.ejs.t` | 16, 27 · 28 | `Record` · `ReadonlyMap` |
| `templates/entity/new/backend/use-cases/{create,update}.ejs.t` | 47 / 46 | `Record` |
| `templates/entity/new/backend/use-cases/{find-by-id-with-fields,list-with-fields}.ejs.t` | 17 / 15 | `Record` |
| `templates/entity/new/backend/use-cases/list.ejs.t` | 101 | `Record` |
| `templates/entity/new/backend/entity-locals.js` | 1132 | `Pick<${entityNamePascal}, …>[]` (multi-field `select:` return type) |
| `templates/entity/new/prompt.js` | 439 | `json: 'Record<string, unknown>'` in the emits payload type map |
| `templates/junction/new/service.ejs.t` | 22, 99, 168 · 23 | `Partial` · `Pick` |
| `templates/relationship/new/prompt.js` | 313 | `Pick<…>[]` (multi-field `select:` return type) |

Checked and unchanged: `search-controller.ejs.t`, `dto/list-query.ejs.t` (the plan listed both), `module.ejs.t`,
`index.ejs.t`, `entity.ejs.t` and the other `dto/*` and `use-cases/*` templates. They name only `Promise`, `Array` or
`Date`, or only values. `templates/_shared/junction-fan-out.mjs` emits only `Promise<Array<…>>`.

### Modify: backend templates (rule half 2, bindings)

- `templates/entity/new/backend/use-cases/list.ejs.t`, `execute` (L60-152), both branches. Renames: `query` →
  `listQuery`, `options` → `listOptions`, the destructured `include` / `where` → `includeTree` / `whereClause` (via
  `const { include: includeTree, where: whereClause } = listOptions`), `resolved` → `resolvedQuery`, `known` →
  `isKnownColumn`, `sort` → `sortTerms`, `items` → `pageRows`, `total` → `rowTotal`. `sortColumn` keeps its name. The
  `.replace` callback's `(_m, c)` is its own scope and does not read the table, so it stays. The shorthand `where`
  (L134, L142) and `sort` (L137, L145) become `where: whereClause` and `sort: sortTerms`. L138 becomes
  `{ with: includeTree }`, and L148 becomes `count(whereClause)`. Behaviour does not change; only names do. The JSDoc
  mentions of the `Page` fields `total`/`pageCount` stay.
- `templates/entity/new/backend/use-cases/search.ejs.t`, `execute` (L35-48): `input` → `searchInput`, `conditions` →
  `whereTerms`.
- `templates/entity/new/backend/use-cases/create.ejs.t` L38/L54 and `update.ejs.t` L36/L53 (EAV branch): the
  constructor member `private readonly <%= entityNamePlural %>` becomes `private readonly service`, which is the name
  every other use case already uses. This is the same defect class: a plural used as a template-chosen member name
  next to `fields` and `db`, where plural `fields` or `db` is a duplicate member (TS2300).

### Modify: frontend emitter (rule half 1)

| File | Line | Emitted into | Change |
|---|---|---|---|
| `src/emitters/frontend/emit-api.ts` | 166 · 185, 188 | `api/<e>.ts` | `Omit` · `Partial` → `globalThis.` |
| `src/emitters/frontend/emit-fields.ts` | 328 | `fields/<e>.ts` | `Record<string, FieldMeta<…>>` → `globalThis.Record` |
| `src/emitters/frontend/emit-graph.ts` | 303, 444, 446, 543 · 465 | `graph/<e>.ts` | `Record` · `PropertyKey` → `globalThis.` |
| `src/emitters/frontend/emit-store.ts` | 383 | `store/lookups.ts` | `Map<string, ${className}>` (type position) → `globalThis.Map` |

Deliberately unchanged, because the target file binds no entity type: `emit-api.ts:40,44` (`api/client.ts`),
`emit-fields.ts:112,131` (`fields/field-meta.ts`), `emit-base.ts` (`config.ts`), and `emit-store.ts:255`
(`new Map<…>()` is a value).

### Modify: validation

- `src/schema/entity-definition.schema.ts:624-629`: `name` gains `.superRefine` → `reservedGlobalFor(name)` →
  `ctx.addIssue({ code: 'custom', message: reservedNameMessage('Entity', name, reserved) })`.
- `src/schema/relationship-definition.schema.ts:116-119`: the same, with `'Relationship'`.

### Modify: tests (G4, G6; and pins)

- `test/junction/opportunity-contact.test.ts`, `test/junction/opportunity-sales-activity.test.ts`: one new
  `test('emitted files pass the name-hygiene rule')` each. It feeds the files the suite already reads through
  `project.emittedFile(…)` to `emittedNameViolations` and expects `[]`.
- `src/__tests__/studio/files.test.ts` (`describe('validateContent — entity')`, L87): one case where
  `name: date` → `{ ok: false }` with exactly one issue `{ path: ['entity','name'], code: 'custom' }`, and the message
  contains `'date'` and `Date`. Add one `relationship` case.
- Assertions that pin the old spelling are updated to the new spelling and never loosened. The likely ones are
  `src/__tests__/backend/{list-default-sort,search-query-templates,eav-templates,eav-value-table-templates,repository-template,controller-hardening}.test.ts`,
  `src/__tests__/templates/{integration-source-rendering,junction-fan-out}.test.ts` and
  `src/__tests__/emitters/frontend/emit-{api,fields,graph,store}.test.ts`. `just test-unit` lists them.

### Modify: regenerated snapshots (G6)

- `test/baseline/**`: `bun test/run-test.ts generate && just baseline`. The diff must contain only `globalThis.`
  qualifications and the list/search renames. The baseline fixtures render no EAV entity, so the EAV member rename does
  not show here. The #680 named expectation (`run-test.ts:308-311`) is unaffected: contact-v2's `select:` is a single
  field, so its return type is `string[]`, not `Pick<…>`.
- `test/frontend-golden/snapshot/**`: `UPDATE_FRONTEND_GOLDEN=1 bun test src/__tests__/emitters/frontend/golden-tree.test.ts`.
- `test/frontend-graph-golden/snapshot/**`: `UPDATE_GRAPH_GOLDEN=1 bun test src/__tests__/emitters/frontend/graph-golden.test.ts`.
- `test/junction/__snapshots__/*.snap`: `bun test --update-snapshots test/junction/`.

### Modify: living docs

- `consumer-skills/entities/yaml-reference.md` §`entity:` (L7-16): one paragraph, "Reserved names". `promise`,
  `array` and `date` are rejected because their type would shadow `Promise`, `Array` or `Date`. Every other name
  works, `record`, `item`, `map` and `error` included, and no plural collides with a generated local (`items`,
  `options`, `conditions`). Also correct the `plural:` and
  `table:` comments (L12-13), which say "optional; inferred". The schema requires both
  (`entity-definition.schema.ts:630-631`).
- `consumer-skills/entities/SKILL.md:35-36` (the **Naming** bullet): add the three reserved names.
- `.claude/skills/codegen/SKILL.md:196`: the `name:` comment gains "not `promise` | `array` | `date` (#813)".
- `CLAUDE.md` § Key Patterns → Naming Conventions: add one bullet with the rule for template authors. Emitted
  TypeScript names lib globals as `globalThis.<Name>`, except `Promise`, `Array` and `Date`. Validation rejects those
  three names (`src/schema/reserved-entity-names.ts`). A function that reads a table export by name declares only
  camelCase locals. `test/_emitted-name-hygiene.ts` enforces both rules (#813).

## Interfaces

```typescript
// src/schema/reserved-entity-names.ts — shipped; imports nothing.

/** A lib global that emitted code writes unqualified, so no entity may take its name. */
export interface ReservedTypeName {
  /** The TypeScript global, e.g. 'Date'. Always one PascalCase word (asserted by test). */
  readonly global: string;
  /** Completes "…which generated code ___." e.g. 'uses for every date and timestamp column'. */
  readonly usedFor: string;
}

/** Exactly the lib globals emitted code may write bare. The hygiene lint allows these and nothing else. */
export const RESERVED_ENTITY_TYPE_NAMES: readonly ReservedTypeName[]; // Promise, Array, Date

/** The emitted type name for a snake_case definition name — same rule as entity-locals.js:343-345. */
export function generatedTypeName(snakeName: string): string;      // 'deal_state' → 'DealState'

/** The reserved global this name would shadow, or null. */
export function reservedGlobalFor(snakeName: string): ReservedTypeName | null;

/**
 * "Entity name 'date' is reserved: its generated type 'Date' would shadow the TypeScript global 'Date',
 *  which generated code uses for every date and timestamp column. Rename the entity."
 */
export function reservedNameMessage(
  kind: 'Entity' | 'Relationship',
  name: string,
  reserved: ReservedTypeName,
): string;
```

```typescript
// test/_emitted-name-hygiene.ts — test helper (G3, G4).

export interface EmittedFile { readonly path: string; readonly text: string }

export interface HygieneViolation {
  readonly path: string;
  readonly line: number;
  readonly rule: 'unqualified-lib-type' | 'plural-shaped-binding';
  readonly name: string;   // 'Record' | 'items'
  readonly detail: string; // 'write globalThis.Record, or reserve it in src/schema/reserved-entity-names.ts' | 'binding in a function that reads table export `items`'
}

/**
 * Every type symbol in scope of an empty file under lib ES2022 + DOM whose declarations all live in default-library
 * files (DOM because the frontend tree compiles with it). Computed once from the installed `typescript`, so it tracks
 * the compiler rather than a hand-kept list.
 */
export function libGlobalTypeNames(): ReadonlySet<string>;

/**
 * Syntactic only (ts.createSourceFile — no program, no module resolution).
 *  rule 1 — in a file that imports from a specifier matching /\.entity$/ or /\/entities\/[a-z][a-z0-9_]*$/, or that
 *           declares `type X = InferSelectModel<…>`: every TypeReference (and `implements` / interface-`extends`
 *           ExpressionWithTypeArguments) whose name is a bare Identifier in libGlobalTypeNames(), not bound at file
 *           level (import / type / interface / class / enum), and not in RESERVED_ENTITY_TYPE_NAMES.
 *           Qualified names (`globalThis.X`) and `typeof X` are never flagged.
 *  rule 2 — table exports = non-type value imports from a `.entity` specifier whose name matches ^[a-z][a-z0-9_]*$,
 *           plus `const x = pgTable(…)` declarations. For each function-like node whose body references one as an
 *           identifier (not as a property name), every binding it introduces in its own scope (parameters incl.
 *           destructuring, var/let/const, catch variables; not those of nested functions) must not match
 *           ^[a-z][a-z0-9_]*$.
 */
export function emittedNameViolations(files: readonly EmittedFile[]): HygieneViolation[];
```

```typescript
// Emitted shape after the change (list use case, includes branch; the non-includes branch drops includeTree):
async execute<TWith extends ItemInclude = ItemNoInclude>(
  listQuery?: ListQuery,
  listOptions: { include?: TWith; where?: SQL } = {},
): Promise<Page<ItemResult<TWith>>> {
  const { include: includeTree, where: whereClause } = listOptions;
  const resolvedQuery = resolveListQuery(listQuery);
  // … sortColumn …
  const isKnownColumn =
    (items as unknown as globalThis.Record<string, unknown>)[sortColumn] !== undefined;
  const sortTerms: SortTerm[] = isKnownColumn ? [/* … */] : [/* … */];
  const [pageRows, rowTotal] = await Promise.all([/* service.list({ where: whereClause, …, sort: sortTerms, with: includeTree }), service.count(whereClause) */]);
  return buildPage(pageRows, rowTotal, resolvedQuery);
}

// Search: async execute(searchInput: SearchItemsInput) { const whereTerms: SQL[] = []; … }
// Repository: export type RecordNoInclude = globalThis.Record<string, never>;
// Controller: allow: globalThis.Readonly<globalThis.Record<string, TFragment>> | undefined,
// Frontend fields/<e>.ts: export const recordFields: globalThis.Record<string, FieldMeta<Record>> = { … };
```

## Tests

Each gate below fails at a8629dfc on the thing it exists to prove.

| Gate | Where it runs | Subject | Fails at a8629dfc because |
|---|---|---|---|
| **G1** smoke fixtures `record` + `item` | `just test-smoke` (vendored) and `just test-smoke-subsystems` (vendored + package), both in `test-all` | the host's two names compile | `repository.ejs.t:116` (unconditional) and `controller.ejs.t:74` (unconditional) emit `Record<…>` in a file that imports the entity's type `Record`, and `list.ejs.t:101` does the same: TS2315. `list.ejs.t:100-101` reads `items` before `list.ejs.t:131` declares it: TS2448 + TS2454. Reproduced on TypeScript 5.9.3 and 6.0.3 with the emitted shapes. The full smoke was not run for this spec, because it installs from npm. |
| **G2** `src/__tests__/schema/reserved-entity-names.test.ts` | `just test-unit` | validation rejects the reserved names with a clear message | `EntityConfigSchema.name` is only a regex (`entity-definition.schema.ts:624-629`), so `name: date` parses. |
| **G3** `src/__tests__/templates/emitted-name-hygiene.test.ts` | `just test-unit` | emitted code obeys both halves of the rule, in every rendered branch | A prototype of the helper over the committed trees reports **83** unqualified lib types (Record 47, Partial 15, Readonly 9, PropertyKey 5, Omit 3, Map 3, ReadonlyMap 1) and **80** plural-shaped bindings (the list `execute` of all 9 baseline entities, plus `search-deals`). |
| **G4** junction hygiene test | `just test-junction` (`test-all`) | the junction service obeys rule 1 | `opportunity-contact.test.ts.snap:214-215,291,360` and `opportunity-sales-activity.test.ts.snap:196-197,273,342` hold bare `Partial<` / `Pick<` in a file that imports the junction type and both endpoint types. |
| **G5** CLI + Studio surfaces | `just test-unit` | the rule is visible through `entity validate` and Studio's schema-on-write | No rejection exists, so `entity validate --json` exits 0 and `validateContent('entity', …)` returns `{ ok: true }`. |
| **G6** byte snapshots | `just test-baseline`, frontend goldens (`test-unit`), `just test-junction` | the change is spelling-only | Regenerated. A reviewer reads the snapshot diff for anything that is not a qualification or a rename. |

**G2 cases.**
- `reservedGlobalFor`: `promise`→`Promise`, `array`→`Array`, `date`→`Date`. It returns `null` for `record`, `item`,
  `map`, `set`, `error`, `event`, `object`, `number`, `symbol`, `function`, `json`, `date_range` and `promise_item`.
- `generatedTypeName('deal_state') === 'DealState'`.
- `EntityDefinitionSchema` with `name: promise | array | date` gives exactly one issue at `['entity','name']`, with
  code `custom`, whose message contains the entity name and the global. `record`, `item`, `map` and `error` parse.
- `RelationshipDefinitionSchema` with `name: date` gives one issue at `['relationship','name']`.
- Every `RESERVED_ENTITY_TYPE_NAMES[i].global` matches `/^[A-Z][a-z0-9]*$/`, which is what keeps junctions safe.

**G3 cases.**
- Helper self-tests on literal snippets:
  - flags `Record<string, never>` in a file that imports from `./x.entity`;
  - passes `globalThis.Record<…>`;
  - passes `Promise<…>`, `Array<…>` and `Date`;
  - ignores a file with no entity import;
  - does not flag a name the file binds itself;
  - flags `const [items, total]` in a function that reads an imported `items`;
  - flags parameter `options` when the body reads table export `options`;
  - passes the same bindings in a function that does not read a table export;
  - passes camelCase bindings.
- The committed trees `test/baseline/packages/api/src/**/*.ts`, `test/frontend-golden/snapshot/**/*.ts` and
  `test/frontend-graph-golden/snapshot/**/*.ts` give `[]`.
- A branch matrix covers what the baseline fixtures do not render. Each template is rendered the way
  `strict-locals.test.ts:33-52` does it (`buildBackendLocals(def, withEntities())` + `ejs.render`), and every output is
  passed to the helper under its `outputPaths` name. The expected result is `[]` for each of:
  - an `eav: true` entity (definition as in `eav-templates.test.ts:58-72`);
  - an `eav_value_table: true` entity (as in `eav-value-table-templates.test.ts`);
  - an integration-surface entity with `detection:` (as in `integration-source-rendering.test.ts`);
  - an entity with a two-field `select:` query (`Pick`);
  - the service rendered with one capability forwarder injected into its locals (`ReturnType` / `Parameters`).
- A relationship YAML with a two-field `select:` query, run through the real relationship prompt the way
  `relationship-endpoint-naming.test.ts:31-52` does: the `returnType` is `globalThis.Pick<…>[]`.

**G5 cases.** `entity validate --json --cwd <tmp>` on a project whose `entities/date.yaml` is otherwise valid exits 1.
`errors` holds a loader header entry plus one entry per Zod issue; exactly one contains `is reserved`, `'date'` and `Date`. Text mode prints it as a validation error.
The Studio cases are listed under File-level plan → Modify: tests.

**Local checks before review** (no Docker): `nice -n 19 just typecheck`, `nice -n 19 just test-unit` and
`nice -n 19 just test-baseline`. The smokes, `test-junction` and the frontend smoke run in CI (`test-all`).

Not covered by a gate: the `json` entry of `prompt.js:439`'s payload type map is used only for a payload field that
is neither on the entity nor on the DTO (rules 2 and 5, `prompt.js:538-560`), and no fixture renders one. It is a
one-token change, made so the rule has no exceptions. The hygiene helper flags it the first time a fixture renders it.

## Out of scope

- **Field names** that collide with locals or globals: #715.
- **A plural equal to a module-level library import** (`eq`, `and`, `sql`, `text`, `index`, a Drizzle builder…).
  These give a loud TS2300 duplicate identifier, never a silent bug, and no English plural produces one. A separate
  reserved-plural list would be a second list to keep in step.
- **Files that bind no entity type** (the relations manifest, the semantic model, frontend `config.ts` / `client.ts` /
  `field-meta.ts`, subsystem and broadcast templates). An entity name cannot reach them.
- **A frontend smoke fixture named `record`.** The frontend tree is held by G3 over its goldens, and the frontend
  smoke would need a consumer-owned `@repo/db/entities/record` fixture as well. The backend compile proof (G1) is
  what the issue asks for.
- `src/schema/entity-definition.schema.json` (editor autocomplete). It is hand-kept and, per ARCH-1, cannot be
  regenerated from the Zod source. Validation does not read it.
- `test/run-test.ts` two-pass generation: that is #815, stacked on top of this PR.

## Open questions

None block implementation. These decisions were made at spec time because the plan did not settle them:

- **The reserved list is `Promise`, `Array`, `Date`**, narrower than the plan's candidate list. `Error`, `Map`, `Set`,
  `Object`, `String`, `Number`, `Boolean`, `Symbol`, `Function` and `Math` are made to work, because emitted code uses
  them only as values (or qualified), and a type-only entity binding cannot shadow a value. `JSON` cannot be produced
  as a type name at all.
- **`globalThis.<Name>` over a file-local alias.** Verified on TypeScript 5.9.3 and 6.0.3 for every global the rule
  touches. An alias declared in the same file would itself be shadowed.
- **The rule reaches the junction service template, the relationship prompt and the frontend emitter**, not only the
  backend templates the plan listed. Validation is shared by every emitter, so accepting `record` while the frontend's
  `fields/record.ts` fails on `Record<string, FieldMeta<Record>>` would make validation wrong.
- **Every binding in a table-reading function is renamed**, not only `items` / `total`. With plural `options`, the
  current list use case compiles and drops the caller's sort.
- **The EAV create/update member `this.<plural>` becomes `this.service`**: same defect class, two lines each.
- **Relationship names get the same check.** Junctions need none (two-word type names, asserted).
- **A new lint gate (G3/G4)** ties the reserved list to emitted code, so "latent until a template uses the global"
  (#813) cannot happen again without a test failure.

Merge note: #796 also rewrites most of `test/baseline/**`. On restack, resolve snapshot conflicts by regenerating,
never by hand-merging (plan `merge_order`).

---

<!--
The sections below this divider are the **phase execution log**. They are
written by phase agents (reviewer, specifier, implementer, validator) as the
issue progresses through gates. The static spec sections above are the
current implementation contract; the phase sections below are how we got
here. See `instructions.yaml.phases` for ownership and gate mapping.

When `instructions.yaml.implementer_view` is `clean`, sections below this
divider are stripped before the implementer reads the spec.
-->

## Spec Review
<!-- written by: reviewer · gate 1.5 · /sdlc:critique -->
_Awaiting spec critic._

## Design Addendum
<!-- written by: specifier · in response to REVISE verdict on Spec Review -->
_No addendum required._

## Implementation notes
<!-- written by: implementer · gate 2 · /sdlc:develop -->
Implemented as specified. Post-implementation truth:

- `entity validate` reports a header entry (`Validation failed for <file>`) followed by one entry per Zod issue, so G5
  asserts exactly one entry containing the reserved-name message rather than `errors.length === 1`.
- The hygiene helper treats any all-lowercase binding as plural-shaped, so a single-word local such as `known` or `k`
  in a table-reading function is flagged; tests use camelCase locals (`isKnown`).
- Pinned spellings updated (never loosened): `src/__tests__/backend/*`, `src/__tests__/emitters/frontend/emit-{api,fields,store}.test.ts`
  and `test/smoke/run-smoke-capability.ts` (the forwarder regexes now expect `globalThis.Parameters` / `globalThis.ReturnType`).
- Snapshots regenerated: `test/baseline`, `test/frontend-golden`, `test/frontend-graph-golden`, `test/junction`. The diffs
  contain only `globalThis.` qualifications and the list/search renames.
- Gates run locally: typecheck, test-unit, test-baseline, test-smoke, test-smoke-subsystems, test-smoke-relationship,
  test-smoke-junction, test-smoke-junction-cross-domain, test-smoke-capability, test-smoke-frontend, test-junction,
  test-integration-emit, test-smoke-integration, test-studio. `test-integration` (Docker) is left to CI.

## Diff Review — Adherence
<!-- written by: reviewer · gate 2.5 · /sdlc:review (lens=adherence) -->
_Awaiting adherence review._

## Diff Review — Quality
<!-- written by: reviewer · gate 2.5 · /sdlc:review (lens=quality) -->
_Awaiting quality review._

## Live Validate
<!-- written by: validator · gate 3 -->
_Awaiting validation._
