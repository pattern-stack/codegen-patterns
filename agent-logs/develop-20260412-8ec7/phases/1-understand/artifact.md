# SPEC-002 Understanding Artifact

## Understanding

SPEC-002 extends the Zod-validated entity YAML schema to support v2 architecture concepts — entity families, declarative queries, sync configuration, event declarations, and pipeline config — so the codegen can emit the Clean-Lite-PS architecture with inheritance, integration awareness, and event infrastructure from the same YAML source.

### Context
- **Problem:** The existing `EntityDefinitionSchema` is a closed `.strict()` Zod object with four top-level keys (`entity`, `fields`, `relationships`, `behaviors`). It has no concept of entity families, query declarations, external sync, or domain events. Every v2 concept requires schema-level recognition before any template can consume it.
- **Users:** Doug / Dealbrain v2 rebuild team writing entity YAML files that drive generation of family-scoped repositories, sync adapters, and event handlers.
- **Systems:** Schema layer (Zod), YAML parser/loader, config loader, behaviors registry, Hygen templates, and the `ParsedEntity` / `ResolvedBehaviors` types propagated through the analyzer pipeline.

### Relevant Code

```
schema/
├── entity-definition.schema.ts   ← The gated Zod schema; all 5 new blocks land here
├── naming-config.schema.ts       ← Unaffected; reference only
└── relationship-types.schema.ts  ← Reference only

utils/
└── yaml-loader.ts                ← Calls EntityDefinitionSchema.safeParse(); validation gate

parser/
└── load-entities.ts              ← Transforms LoadResult → ParsedEntity; needs new fields mapped

behaviors/
├── index.ts                      ← behaviorRegistry Map; external_id_tracking must register here
└── types.ts                      ← ResolvedBehaviors interface; needs hasExternalIdTracking flag

config/
└── config-loader.mjs             ← Loads codegen.config.yaml as raw object; pipelines block here

test/fixtures/
├── opportunity.yaml              ← Needs updating with new blocks
└── codegen.config.yaml           ← Pipelines block goes here
```

### Current Schema Shape

`EntityDefinitionSchema` is a **strict Zod object** with exactly four top-level keys:

| Key | Type | Notes |
|---|---|---|
| `entity` | `EntityConfigSchema` | `name`, `plural`, `table`, `folder_structure`, etc. — no `family` |
| `fields` | `Record<string, FieldDefinitionSchema>` | Rich field definitions with UI metadata, constraints, FK |
| `relationships` | `Record<string, RelationshipSchema>` (optional) | `belongs_to / has_many / has_one` |
| `behaviors` | `BehaviorConfigSchema[]` | String or `{name, options}`; registry has 3: timestamps, soft_delete, user_tracking |

Both `EntityDefinitionSchema` and `EntityConfigSchema` use `.strict()` — any unknown key causes parse failure.

### Extension Points

| What | Where | Notes |
|---|---|---|
| `family` enum | `EntityConfigSchema` — add optional field | Consumed in `transformToEntity()`, propagated to `ParsedEntity` |
| `queries` block | `EntityDefinitionSchema` — new top-level optional array | New `QueryDeclarationSchema` |
| `sync` block | `EntityDefinitionSchema` — new top-level optional object | `electric?: boolean` + `providers` record |
| `events` block | `EntityDefinitionSchema` — new top-level optional array | `{name, queue, body, generate_handler}` |
| `external_id_tracking` | `behaviors/index.ts` — add to registry | New behavior file + `ResolvedBehaviors` flag |
| `pipelines` config | Project config (separate from entity schema) | No Zod gate on project config currently |

### Risks / Considerations

1. **`.strict()` is the blocker.** New keys must be added to the strict schemas or YAML with them will be rejected.
2. **`ParsedEntity` type gap.** The parsed type in `analyzer/types` must be extended alongside the schema.
3. **Cross-block validation.** `queries.by` and `sync.field_mapping` reference field names — can't validate at Zod parse time, needs post-parse consistency check.
4. **`via` junction queries** imply cross-entity knowledge the analyzer doesn't currently track.
5. **`external_id_tracking` + `sync.field_mapping` collision.** No conflict detection for behavior-added fields vs sync-mapped fields.
6. **Project config has no Zod validation.** Adding `pipelines` works but has no authoring-time validation. A schema would be consistent.
7. **Baseline tests will break** if schema changes affect template output — but this spec is schema-only, templates come later.
