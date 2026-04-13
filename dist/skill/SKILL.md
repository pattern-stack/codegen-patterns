---
name: codegen
description: Generate backend and frontend code from entity YAML definitions. Use when the user asks to create a new entity, add a database table, scaffold a module, generate CRUD, or add an API endpoint. Also use when they say "codegen", "generate entity", "scaffold", or "add entity".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
user-invocable: true
---

# Entity Codegen

Generate full-stack TypeScript code from declarative YAML entity definitions. Produces Clean Architecture scaffolding: domain entities, repositories, use cases, DTOs, Drizzle schemas, NestJS modules, controllers, and frontend collections.

## Setup Detection

Before first use, check the project has codegen-patterns installed:

1. Look for `codegen.config.yaml` in the project root
2. Look for an `entities/` directory
3. Check `package.json` for `@anthropic/codegen` or a `codegen` script

If not set up yet, guide the user through initial setup:

```bash
# Add codegen as a dependency (or clone alongside the project)
bun add -d @anthropic/codegen hygen

# Scan the project to auto-detect patterns and generate config
bun codegen scan .

# Review and edit the generated codegen.config.yaml
```

## Creating an Entity

### Step 1: Define the YAML

Create a file in `entities/` (or the configured entities directory). Use this structure:

```yaml
entity:
  name: {snake_case_singular}     # e.g., "contact", "deal_state"
  plural: {snake_case_plural}     # e.g., "contacts", "deal_states"
  table: {database_table_name}    # usually same as plural
  folder_structure: nested         # "nested" (recommended) or "flat"
  # family: crm-synced            # Optional: crm-synced | activity | metadata | knowledge

fields:
  {field_name}:
    type: {type}                  # string | integer | decimal | boolean | uuid | date | datetime | json | enum
    required: true                # Field cannot be null and must be provided on create
    # nullable: true              # Field can be null (mutually exclusive with required)
    # max_length: 255             # String length constraint
    # foreign_key: users.id       # FK reference: {table}.{column}
    # index: true                 # Create a database index
    # unique: true                # Unique constraint
    # default: false              # Default value
    # choices: [a, b, c]          # Enum choices (use with type: enum)

behaviors:
  - timestamps                    # Adds createdAt, updatedAt
  - soft_delete                   # Adds deletedAt, filters queries
  # - user_tracking               # Adds createdBy, updatedBy

relationships:
  {relation_name}:
    type: belongs_to              # belongs_to | has_many | has_one
    target: {entity_name}         # Target entity (singular snake_case)
    foreign_key: {fk_field}       # Field name in this entity

# Optional v2 blocks:
# queries:
#   - by: [field_name]           # Simple FK lookup
#   - by: [email]                # Unique lookup
#     unique: true
#   - by: [account_id]           # Ordered query
#     order: created_at desc
#   - by: [user_id, account_id]  # Multi-field compound query
```

### Step 2: Validate

```bash
bun codegen validate entities/
```

### Step 3: Generate

```bash
bun codegen entity entities/{name}.yaml
```

### Step 4: Verify

Check the generated output in the configured paths. For Clean Architecture output:
- Domain: entity class + repository interface
- Application: queries, commands, DTOs
- Infrastructure: Drizzle schema + repository implementation
- Presentation: REST controller
- Module: NestJS module wiring

For Clean-Lite-PS output (when `generate.cleanLitePs: true`):
- `modules/{plural}/{name}.entity.ts`
- `modules/{plural}/{name}.repository.ts`
- `modules/{plural}/{name}.service.ts`
- `modules/{plural}/{name}.controller.ts`
- `modules/{plural}/{plural}.module.ts`
- `modules/{plural}/dto/` and `modules/{plural}/use-cases/`

## Field Type Reference

| YAML Type | TypeScript | Drizzle | Database |
|-----------|-----------|---------|----------|
| `string` | `string` | `text` | `text` |
| `integer` | `number` | `integer` | `integer` |
| `decimal` | `number` | `numeric` | `numeric` |
| `boolean` | `boolean` | `boolean` | `boolean` |
| `uuid` | `string` | `uuid` | `uuid` |
| `date` | `Date` | `date` | `date` |
| `datetime` | `Date` | `timestamp` | `timestamptz` |
| `json` | `unknown` | `jsonb` | `jsonb` |
| `enum` | union literal | `text` | `text` |

## Entity Family Reference

Families provide pre-built base classes with common query patterns:

| Family | Use When | Inherited Methods |
|--------|----------|-------------------|
| `crm-synced` | CRM entities (contacts, accounts) | `findByExternalId`, `findAllByUserId`, `syncUpsert` |
| `activity` | Time-based events (emails, calls) | `findByDateRange`, `findByUserId`, `findByOpportunityId` |
| `metadata` | Key-value data (field values, tags) | `findByEntityIdAndType`, `listByEntityId`, `upsertMany` |
| `knowledge` | Vector-searchable content (stub) | — |
| *(none)* | Generic entities | Base CRUD only |

## Declarative Queries

The `queries:` block generates repository methods, interface signatures, injectable query classes, and NestJS module registration — all from config:

```yaml
queries:
  - by: [user_id]                    # → findByUserId(userId: string): Promise<Entity[]>
  - by: [email]                      # → findByEmail(email: string): Promise<Entity | null>
    unique: true
  - by: [account_id]                 # → findByAccountId(...): ordered by created_at desc
    order: created_at desc
  - by: [user_id, account_id]        # → findByUserIdAndAccountId(userId, accountId)
  - by: [opportunity_id]             # → junction table join
    via: opportunity_contact_link
  - by: [opportunity_id]             # → findEmailsByOpportunityId(...)
    via: opportunity_contact_link
    select: [email]
```

## Configuration

The `codegen.config.yaml` controls paths, naming, and generation toggles. Key sections:

```yaml
paths:
  backend_src: src                    # Backend source root
  frontend_src: apps/frontend/src

generate:
  cleanLitePs: true                   # Use Clean-Lite-PS architecture
  commands: true                      # Generate write commands
  queries: true                       # Generate read queries
  drizzleSchema: true                 # Generate Drizzle schema

naming:
  fileCase: kebab-case                # kebab-case | PascalCase | camelCase
  suffixStyle: dotted                 # dotted (.entity.ts) | suffixed (Entity.ts)
  terminology:
    command: use-case                 # command | use-case
    query: query                      # query | use-case
```

Run `bun codegen scan .` to auto-detect your project's conventions and generate a config.

## Common Workflows

### "Add a new entity to my app"
1. Ask what fields, relationships, and behaviors they need
2. Create the YAML in `entities/`
3. Run `bun codegen validate entities/` to check
4. Run `bun codegen entity entities/{name}.yaml` to generate
5. Show them what was generated

### "I need a new API endpoint for X"
1. Determine if this maps to a new entity or a query on an existing one
2. For new entity: create YAML + generate
3. For existing entity: add to `queries:` block and regenerate

### "Scaffold my whole domain"
1. Run `bun codegen scan .` to detect project patterns
2. Review `codegen.config.yaml`
3. Create YAML files for each entity
4. Run `bun codegen all` to generate everything
5. Run `bun codegen analyze entities/` to verify the domain graph
