# ADR-040 — Field-Metadata Vocabulary Convergence (FieldMeta ↔ qField ↔ EAV `field_definitions`)

**Status:** Accepted
**Date:** 2026-06-06
**Owner:** Doug
**Related:** ADR-038 (frontend pipeline rebuild — the FieldMeta emitter this enriches), `examples/eav/field_definition.yaml` (the EAV starter), swe-brain `query-surface-poc` (qField/CatalogField — the consumer driving parity)

---

## Context

Three systems describe "what a field means for rendering," each grown
independently:

1. **codegen FieldMeta** — emitted per entity into the generated frontend
   (`fields/<name>.ts`, ADR-038). Derived from YAML `ui_*` hints + heuristics.
2. **qField / CatalogField** (swe-brain query-surface-poc) — attribute-level
   metadata stamped on Drizzle columns: `label / description / selectOptions /
   isKeyField / keyFieldOrder / group / isVisible`. Deliberately mirrors the
   EAV `field_definitions` table so native columns and EAV fields share one
   metadata layer.
3. **EAV `field_definitions`** — a *runtime* schema row per custom or
   sync-discovered field, with a `data_type` enum (`string / integer / decimal /
   boolean / date / datetime / json / reference / picklist / multipicklist`).

Consumers building metadata-driven rendering (the swe-brain renderer kit) need
all three to speak ONE vocabulary: a renderer keyed on FieldMeta must render an
EAV field without a parallel code path, and curation flags authored in YAML
must mean the same thing as curation flags in a `field_definitions` row.

Before this ADR, codegen's FieldMeta dropped most of the parsed `ui_*` hints
(group/visible/placeholder/help/format never emitted), had no curation concept,
and had no stated relationship to the EAV `data_type` vocabulary.

## Decision

**One vocabulary, multiple homes.** The field-metadata property names are a
shared contract; each home stores them where it naturally lives:

| Concept | YAML (codegen) | FieldMeta (emitted) | qField (swe-brain) | EAV row |
|---|---|---|---|---|
| Display label | `ui_label` | `label` | `label` | `label` |
| Help/meaning | `ui_help` | `help` | `description` | `description` |
| Enum options | `choices` | `choices` | `selectOptions` | `picklist_values` |
| Curated field | `ui_key_field` | `isKeyField` | `isKeyField` | `isKeyField` |
| Curation order | `ui_key_field_order` | `keyFieldOrder` | `keyFieldOrder` | `keyFieldOrder` |
| Layout group | `ui_group` | `group` | `group` | `group` |
| Visibility | `ui_visible` | `visible` | `isVisible` | `isVisible` |

Concretely, in codegen:

1. **Full `ui_*` passthrough.** `ui_group` / `ui_visible` / `ui_placeholder` /
   `ui_help` / `ui_format` now survive parser → derivation → emission.
2. **Key-field curation.** New YAML keys `ui_key_field` / `ui_key_field_order`
   surface as `isKeyField` / `keyFieldOrder` (qField's names, chosen for
   catalog convergence) and roll up into `<camel>Metadata.keyFields` — the
   ordered curated-field list that drives card/preview selection.
3. **Family/behavior bundles** (timestamps precedent): `soft_delete` ⇒ a
   `deletedAt` row; the explicit `external_id` + `provider` shape ⇒
   `group: 'external_sync'` as a derivation default (authored `ui_group` wins).
4. **EAV `data_type` → `FieldType` contract.** `EAV_DATA_TYPE_TO_FIELD_TYPE`
   maps the EAV vocabulary onto the rendering vocabulary:
   `string→text, integer/decimal→number, boolean→boolean, date→date,
   datetime→datetime, json→json, reference→reference, picklist→enum,
   multipicklist→enum`. Multi-select rendering is consumer-side (the renderer
   checks the EAV row's cardinality, not the FieldType). The source of truth
   lives in `src/emitters/frontend/field-meta.ts`, is re-exported from the
   package root, and is emitted verbatim into every generated
   `fields/field-meta.ts` so consumer apps hold it locally — rendered from the
   same object, so the copies cannot drift.

## Consequences

- A renderer written against `FieldMeta` + `EAV_DATA_TYPE_TO_FIELD_TYPE`
  serves native columns and EAV fields with one code path (swe-brain renderer
  kit, Phase B).
- The names `isKeyField` / `keyFieldOrder` intentionally break codegen's own
  `ui_*`-to-camelCase symmetry (`ui_key_field` → `isKeyField`, not `keyField`)
  — cross-system parity beats local consistency.
- No EAV *serving* wiring ships here: this is the vocabulary contract only.
  How field_definitions rows reach the frontend catalog is the consumer's
  (or a future pattern's) concern — see the `EavPattern` TODO in
  `examples/eav/field_definition.yaml`.
- Columns contributed by the `external_id_tracking` BEHAVIOR are not in the
  parsed field map and still get no FieldMeta rows (only explicitly declared
  fields do). If the integrated family later needs emitted rows for
  behavior-contributed columns, extend the bundle mechanism in
  `emit-fields.ts` — never emit a row for a column the emitter cannot see.
