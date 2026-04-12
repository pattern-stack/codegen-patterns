# SPEC-002: Evolve Entity YAML Schema for v2 Architecture

Evolve the entity YAML schema (`schema/entity-definition.schema.ts`) to support v2 architecture:

1. `family` enum field on entity block (`crm-synced | activity | knowledge | metadata`)
2. `queries` block for declarative query generation (`by`, `unique`, `select`, `order`, `limit`, `via`)
3. `sync` block with `electric` boolean and `providers` map (remote_entity, direction, cdc, field_mapping, read_only_fields)
4. `events` block as array of {name, queue, body, generate_handler}
5. `pipelines` config for backend/frontend/shared pipeline separation

References:
- schema/entity-definition.schema.ts (existing schema)
- docs/CODEGEN-EVOLUTION-PLAN.md (evolution plan)
- docs/architecture/adrs/ADR-005-entity-family-base-classes.md (queries block spec)
- test/fixtures/*.yaml (test fixtures to update)
