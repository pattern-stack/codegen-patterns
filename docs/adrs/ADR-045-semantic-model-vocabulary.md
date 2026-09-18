# ADR-045 — The semantic model is declared in the entity YAML, as field tags

**Status:** Accepted
**Date:** 2026-09-17
**Owner:** Doug
**Related:** ADR-040 (field-metadata vocabulary convergence — the same "one vocabulary, several homes" argument, for rendering rather than aggregation), ADR-044 (the relation graph is the core contract; §Decision 4 routes aggregation away from traversal), `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` §4 (invariants I1, I5, I7), PLAN §5, `docs/specs/SEM-1.md`

---

## Context

Aggregation does not ride the relation graph. ADR-044 §Decision 4 sends anything that sums, counts or averages over a
to-many path to the semantic-query layer (`@pattern-stack/query-surface`), which needs a **model**: per entity, its
table and key; per field, whether it is a measure or a dimension, how it may be aggregated, whether it may be summed,
and which field is the time axis.

That layer builds its model one of two ways. It can **introspect** — walk Drizzle's relation objects and guess field
roles from column types — or it can be **handed a declared model**. Introspection is what a host without a domain
declaration has to do. This generator's host is not that: the entity YAML already declares the graph, the field types,
the enums and the naming. Recovering any of it by inspecting generated code would violate I1 (declare once) — and
Drizzle 1.0 removed the v1 `relations()` objects the package's introspection walked, so the option is closing anyway.

Meanwhile the YAML already carried an `analytics:` vocabulary: `measure: true` + `analytics_aggregation`,
`dimension_type`, `time_granularity`, `agg_time_dimension`, `is_partition`, `non_additive_dimension`, `entity_type`,
`entity_role`, `semantic_expr`, `semantic_label`, `analytics_visibility`, plus entity-level `measure_packs`,
`cube_name` and four metric kinds. It was shaped for a cube.js/MetricFlow projection that was never built. Measured
before this decision: nothing outside the Zod schema read any of it, `ParsedEntity` had no field for the block at all,
no fixture or example declared one, and `generate.analytics: cube` gated nothing.

## Decision

**The entity YAML declares the semantic model, as field tags plus a small composite-metric block, and the old
vocabulary is replaced outright.**

1. **Field tags.** A field carries `role: measure | dimension`, `agg` or `aggs` (from
   `count | count_distinct | sum | avg | min | max`), `additivity: additive | semi | non`, and `time: true`.
   The field **is** the measure; aggregation is configuration on it. There is no separate measure declaration to keep
   in sync with the field it aggregates.

2. **`additivity` is required on every measure, per field.** It is not inferable from `type: decimal` — revenue is
   additive, a balance is semi-additive across time, a rate is never summable — and the consuming layer treats the
   field as the authority: a named measure may tighten a field's additivity but never loosen it. That rule only works
   if the field carries the truth. Per-field, not per-pack: `measure_packs` is deleted rather than retyped.

3. **Only what is not derivable is declared.** The field's semantic `type`, its physical column, and whether a
   dimension has a declared value domain are all computable from `type:`, the naming config and
   `choices` / `choices_from` / a pg-enum. They are derived at emit time, never authored (I1).

4. **The entity-level `analytics:` block holds composites only** — `ratio`, `derived`, `cumulative`. A "simple"
   metric is not a metric: it is a measure-tagged field, and the atomic catalog is derived from the tags. A derived
   metric's expression is an authored **tree** (`{ref} | {lit} | {op, left, right}`), not a string: that is the shape
   the consuming layer validates and lowers, so a string form would mean maintaining a parser whose only output is
   that tree.

5. **The block is an authoring home, not a scope.** The catalog is one flat namespace, so a metric may name legs on
   another entity — and measure keys and metric names must therefore be unique across the whole entity set. That
   check needs all entities at once and lives in the parser's cross-reference pass, not in the per-file schema.

6. **Replace, do not extend (I7).** Every key listed in §Context is removed, with no alias and no deprecation path.
   `FieldDefinitionSchema` becomes strict so a YAML still carrying one fails by name instead of parsing to a field
   with no tags. `generate.analytics: none | cube` becomes `generate.semantic: boolean`, mirroring
   `generate.frontend`. The cube-era runtime (`runtime/analytics/**`, `runtime/subsystems/analytics/**`) and the
   `@cubejs-client/core` optional peer go with it.

7. **Catalog home (charter Q4).** Atomic tags and composites that are pure functions of declared fields live in the
   YAML and are emitted. Anything **data-driven** — value domains harvested from live data, EAV overlays — stays in
   the consuming adapter, which merges its own catalog additively on top of the emitted one.

## Consequences

- The emitted model is a complete, static artifact: a reviewer reads one YAML file to know what an entity means to
  the semantic layer, and no part of it is recovered by inspecting generated code.
- An author must say `additivity` on every measure. That is the intended friction — the alternative is a default that
  is wrong for half of all money columns and silently produces double-counted sums.
- The generator now owns a rule the consuming layer also owns: how a field tag becomes an atomic measure key
  (`<field>.<agg>` when `aggs:` is declared, the bare field name when a single `agg:` is). It is replicated here only
  to resolve metric legs at parse time; the **emitter must not emit atomic catalog entries**, because the consuming
  layer derives them. One rule, one emitter of the result.
- Aggregations outside the six the consuming layer knows (`median`, `percentile`, …) cannot be declared. Adding one
  means adding it there first.
- Anything reached only through the deleted cube runtime is gone. Nothing did.

## Alternatives considered

- **Extend the existing vocabulary and map it at emit time.** Rejected: it keeps two vocabularies alive, and the
  mapping is lossy in both directions (`non_additive_dimension` names a column; `additivity` is a property of the
  measure). I7 forbids the parallel shape, and there are no users to protect.
- **Let the consuming layer introspect the generated Drizzle schema.** Rejected: it re-derives what the YAML already
  says (I1), cannot recover additivity at all, and the API it walked is gone in Drizzle 1.0.
- **Author `derived.expr` as an infix string.** Rejected: a parser whose only job is to produce a tree the consuming
  layer already defines, plus a second error surface for malformed expressions.
- **Additivity per measure pack.** Rejected: packs are a cube-era indirection, and the consuming layer's
  no-loosening rule is defined against the field.

## Follow-ups

- **SEM-2** implements the emitter (`AggregateModel`, the composite catalog, `generate.semantic`'s gate) and appends
  its decisions to this ADR as a dated revision note rather than minting a second one.
- **SEM-3** demonstrates the model end to end against a fan-out trap.
- EAV field tags (`AggFieldMeta.eav`) are deliberately unaddressed here; PLAN §5.3 defers them.
