# PW-1: the class graph, derived once; `module.ejs.t` prints from it; no class cycles

**Status:** implemented · **Issue:** none · **Follows:** PW-0 · **Next:** PW-2 (`@pattern-stack/wiring`), PW-3
(`target: { wiring: pattern-stack, http: none }`)

## Problem

Pattern-stack wiring (PW-3) emits one flat composition that constructs every generated class in dependency order
(`new ContactRepository(db); new ContactService(contactRepository, …)`). That needs two things the generator didn't
have:

- **What each class's constructor takes, as data.** It lived only in the templates' constructor text and in
  `entity-locals.js`'s module lists (`repositoryDepModules`, the junction fan-out, the EAV blocks).
- **Proof that a dependency order exists.** Nest's module graph has cycles (a parent's module imports its junction's
  module, which imports the parent's for its repository), and `forwardRef` hides them. A flat composition can't
  construct a cycle, so the class level must have none.

## Decision

### `src/derived/wiring/` (ADR-046: derive once, templates print)

- `types.ts`: a `ClassNode` is `{ id (the class name), owner, ownerKind, role, useCaseKind?, systems }`, and a
  `ClassEdge` is `{ from, to, toOwner, toOwnerKind, reason }`. Reasons: `own`, `composes`, `inherits`,
  `junction_fan_out`, `junction_end`, `eav_field_values`, `eav_definition`, `list_use_case`, `route`. The system
  dependencies are `db` and `typed_event_bus`. Names and reasons only, with no import paths
  (ADR-046 §4).
- `classes.ts`, `entityClassGraph(input, surface)`. It reads the entity's **API surface** and its derivation input,
  and walks no YAML:
  - the repository takes `db`. A child's repository takes the base's repository (`inherits`), and an `eav: true`
    entity's takes `FieldValueService`. Those are its only edges: the graph's edges are constructor arguments;
  - the service takes its own repository, then EAV (`FieldValueService`, and an `eav_value_table`'s definition
    repository), then the delegate of each **relation** method (`relation_one` / `relation_many`) and **junction**
    method onto another owner. A repository delegate is a `composes` edge (a `belongs_to` / `has_many`, #632), or
    `inherits` when it reaches the base. A service delegate is a `junction_fan_out` when its owner is one of the
    set's junctions (named from `input.junctions`, never inferred from the layer). Its other delegates onto another
    entity (a child's flat reads onto its base) go through its own repository and are not edges (narrowed in
    PW-3a, so that a service's edges are exactly its constructor arguments). Nest's optional `EVENT_BUS` property
    is not a constructor argument, so it is not an edge;
  - the use cases come from `surface.useCases`. Each takes the service, except search, which takes the list use case
    (#744). Create and update take `FieldValueService` under EAV. A write takes `db` when it opens a transaction (to
    publish its `emits:` event, or for EAV) and the typed bus when it publishes;
  - the controllers come from `surface.http.routes`. Each takes the use cases its routes call.
- `junctionClassGraph({ name, left, right })`: the junction's repository takes `db`, and its service takes its
  repository plus both ends' repositories (`junction_end`).
- `moduleImports(graph, owner)`: the modules an owner's module imports. Each is listed once, under its strongest
  reason (`inherits` > `eav_definition` > `eav_field_values` > `junction_fan_out` > `junction_end` > `composes`).
  They are ordered base first, then compositions, junctions and the EAV blocks, and in first-appearance order
  within a reason. This is exactly the order `module.ejs.t` printed before: a child relating to its own base imports
  the base's module once, first; an EAV definition that a relationship also composes is imported by the EAV block,
  last.
- `order.ts`, `orderClasses(graph)`: every class after the classes it takes. A cycle throws `ClassCycleError`, naming
  it (`A → B → C → A`), the way crew's `orderByNeeds` names a module cycle. A class that takes one nobody in the set
  emits is an error naming both. `contextCycles(graph, contextOf)` reports the cycles between `context:`s (d27, d29),
  for PW-3's one module per context. A chain through an owner with no context (a junction) counts: crm → junction →
  billing is crm → billing. It walks the contexts once, depth first, and every link back onto a context still on
  the walk closes a cycle, so its time grows with the contexts and their links, never with the paths between them;
  every group of contexts that depend on each other is reported at least once, each cycle once, rotated to start at
  its smallest context. It is not on the `entity new` hot path: the step that composes one module per context calls it.
- `project.ts`, `deriveProjectClassGraph(relations)`: the whole set, merged (a class emitted twice is an error naming
  both owners and their kinds) and ordered. `projectEntityApiInputs` (`src/derived/api/project.ts`) is now the one place that builds each entity's
  derivation input over a set; `deriveProjectApiSurface` reads it too.

### `module.ejs.t` prints from it

`entity-locals.js` builds the entity's graph next to `apiSurface`, from the same input, and passes `wiring`:
- `moduleImports`: each `moduleImports` entry with its module class and import path. The paths stay in
  `entity-locals.js` (`moduleImportPath`); it throws if the graph names a module it can't place;
- `providers`: the entity's non-controller nodes, in order;
- `controllers`: the controller names.

The module still imports each class by its `classNames` name (built in `entity-locals.js` until #894) and registers
it by the graph's id. `entity-locals.js` throws if a graph id isn't one of `classNames`, so the two sources can't
drift apart unnoticed.

The template has one loop for the module imports, one for the `forwardRef` imports (with the "is a kind of" comment
on `inherits`), one for the providers (a run of declarative queries prints as `...declarativeQueryClasses`), and one
join for the controllers. `repositoryDepModules` is deleted. The output is byte-identical: `test-baseline`, the
render goldens (the EAV and EAV-value-table matrix legs included) and every smoke.

The junction's own `module.ejs.t` is unchanged. It is in #679's territory (`no-name-derivation.allowlist.ts`), and
its two imports are fixed.

### Checked at generation

`classGraphRejections` (`src/cli/shared/class-graph-check.ts`) runs in `entity new`'s pre-flight, after the app
patterns load and only when nothing else has already stopped the run. A class cycle is a run-level rejection, named, and so is a
class two owners emit (`DuplicateClassError`: an entity named like a junction). Any other error there (a junction end or composed entity with no YAML) is left to the pre-flight check that reports it
by name.

## The gate

`src/__tests__/derived/wiring/class-graph.test.ts` checks every generated fixture set (baseline, inheritance,
scaffold, the relations / semantic / frontend goldens, the junction, cross-domain-junction and frontend smokes). For
each set, the class graph orders with every edge pointing backwards, and the junction and inheritance sets carry
their edges. Synthetic graphs check the cycle message, the unknown-target refusal, the context cycles and
`moduleImports`' filing. `src/__tests__/cli/class-graph-check.test.ts` runs the pre-flight on real on-disk sets: an
EAV entity whose `field_value` belongs_to it (FieldValueService → ThingRepository → FieldValueService) and an entity
named like a junction are each one rejection naming the defect.

**Result: no class cycle in any fixture set**. The plan's guess holds, including for the family base classes and the
junction ↔ parent pairs. No fixture set has a cycle between contexts either. The plan asked for a run over the
platform's carried-over models (e2's list) before PW-3. That still needs those models; `contextCycles` is ready for it.

## Byte-identity

No generated byte changes.
