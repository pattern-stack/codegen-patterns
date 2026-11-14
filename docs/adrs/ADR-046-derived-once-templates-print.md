# ADR-046 — Generated API names are derived once; templates print them

**Status:** Proposed
**Date:** 2026-11-13
**Owner:** Doug
**Related:** ADR-038 (whole-set emitter), ADR-044 §5 (both sides project from one declared graph), ADR-041
(capability forwarders), ADR-045 (the *semantic model* — a different thing; this ADR does not use the word "model"
for its subject), `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` §4 (invariants I1, I7, I9),
`.ai-docs/stacks/api-surface-model/PLAN.md` (the plan this records), #711

---

## Context

What a generated entity can do — its repository methods, service methods, use cases, routes and include
allowlists — is decided in a 2,700-line locals builder (`templates/entity/new/backend/entity-locals.js`), inline in
EJS, and again in TypeScript wherever a second consumer needed the same answer. Five such decisions exist in two or
more copies today, three of them held together only by parity tests:

| Decision | Copies |
|---|---|
| `queries:` finder name | `entity-locals.js`, `src/schema/query-routes.ts`, `templates/relationship/new/prompt.js` (+ a parity test, #711) |
| `belongs_to` FK-finder name | `repository.ejs.t` twice, `entity-locals.js` |
| entity has a typed include | `entity-locals.js`, `src/emitters/relations/build-includes.ts` (+ a parity test) |
| include-allowlist constant name | `entity-locals.js`, `src/emitters/relations/emit-includes.ts` (+ a parity test) |
| `api` enabled | `entity-locals.js`, `src/schema/entity-definition.schema.ts` |

A third consumer, Studio, needs the same answers to show each entity's generated API — and Studio may not
reimplement generation (CLAUDE.md § Studio). The frontend already solved this shape of problem: `buildClientGraph`
projects REL-1's `buildRelationGraph`, and a golden holds the two edge for edge.

## Decision

1. Every name and every existence decision about the generated backend API surface is derived **once**, in
   `src/derived/api/`, as typed data with provenance: the YAML path, the pattern or the capability that caused it.
   When two declarations resolve to the same name, the entry records the one that won and the ones it shadows.
2. It is testable without rendering.
3. Templates **print**: loop over the derived surface, branch on its flags, emit text. They never build a name,
   never change a name's case, and never decide whether something is emitted.
4. It holds **names and existence only** — names, kinds, provenance, parameter *names* and result shape. Not in
   it: TypeScript type strings, method bodies, SQL, decorator text, import paths, file paths, DTO fields. Those stay
   where they are until a later slice takes them over with its own decision.
5. Per-entity facts come from that entity's inputs (`deriveEntityApiSurface`, the function hygen calls). Facts that
   need the graph — which declaration pairs with which, what a relation method delegates to — are derived whole-set
   (`deriveProjectApiSurface`), from REL-1's `buildRelationGraph`, never from a second walk of the YAML.
6. Other readers — Studio, `codegen project surface`, docs, tests — read it. None derives.
7. Adoption is by slice. A slice owns only what it has taken over; a refactor slice leaves the byte goldens
   unchanged.

The directory is `src/derived/`, not `src/surface/`: `surface` is already the integration-surface term
(`entity.surface:`, `buildIntegrationSurface`, `collectEntitySurfaces`) in the very files that import this one.
The YAML is *declared*; this is what is *derived* from it. Slice 1 is `src/derived/api/`; later slices add
`columns/` and `wiring/` beside it. In code nothing is named bare `surface`: types are `…ApiSurface`, the template
local is `apiSurface`.

| File | Holds |
|---|---|
| `types.ts` | the types — zero runtime imports (Studio's contract re-exports them) |
| `names.ts` | every name rule, as named exports |
| `entity.ts` | `deriveEntityApiSurface(input)` — one entity, pure; reachable from hygen |
| `project.ts` | `deriveProjectApiSurface(ctx)` — every entity, then the link pass; CLI only |

## Enforcement

- **Parity** (`src/__tests__/derived/api-surface-parity.test.ts`): the derived surface equals real generated
  output — the checked-in baseline plus a render matrix for the shapes the baseline lacks — as set equality in both
  directions over methods, use cases and routes. A template that emits a method the derivation does not list fails
  it.
- **Golden** (`test/api-surface-golden/`): pins provenance, kinds, flags and parameter names — what parity cannot
  see.
- **Lint** (`no-name-derivation-in-templates.test.ts`): templates are scanned for inline name derivation. What is
  not yet migrated is named in `no-name-derivation.allowlist.ts`, each entry counted and asserted exact; the list
  only shrinks.
- CLAUDE.md § Key Patterns, *Templates print (ADR-046)*, states the rule for every contributor.

## Consequences

One place to rename a method or add a method kind. A new generated method needs an entry first, enforced by the
parity gate; its provenance is pinned by a golden. The TypeScript ships in the package's `files` because templates
import it, so it may import only what already ships. During adoption the derivation and the old inline derivations
coexist under a gate — temporary by decision, not by hope: Phase B of the plan, which converts the templates, is
committed together with Phase A. The allowlist records what remains.

Behaviour the derivation makes visible but does not change in slice 1 (for example a shadowed ordered query losing
its `order:`) is recorded and fixed afterwards as a one-place edit, never inside a byte-identical refactor.

## Alternatives rejected

- *Studio parses generated code* — introspecting output to recover what the YAML says (I1).
- *Studio re-derives names* — the tenth copy.
- *Move the backend to TS emitters* — out of scope by I11, and unnecessary: the problem is who decides, not which
  engine prints.
- *Carry bodies, types and imports too* — a second locals blob.
- *Name the directory `surface`* — already the integration-surface term in the same files.

## Revision notes

(none yet — the last Phase B PR records what implementation changed)
