# Entity Code Generation System

Generate full-stack entity scaffolding from YAML definitions. Creates domain entities, repositories, use cases, queries, DTOs, Drizzle schemas, REST controllers, and NestJS modules.

## Installation

```bash
# Install dependencies
bun install

# Peer dependency
bun add -d hygen
```

## Quick Start

```bash
# 1. Create codegen.config.yaml in your project root (see Configuration below)

# 2. Define your entity in YAML
cat > entities/opportunity.yaml << 'EOF'
entity:
  name: opportunity
  plural: opportunities
  table: opportunities

fields:
  id:
    type: uuid
    required: false
  name:
    type: string
    required: true
    max_length: 255
  amount:
    type: decimal
    nullable: true

relationships:
  account:
    type: belongs_to
    target: account
    foreign_key: account_id
EOF

# 3. Generate the entity
bun codegen entity entities/opportunity.yaml

# 4. Run database migration (project-specific)
bun run db:generate --name add-opportunity
bun run db:migrate
```

## Configuration

Create `codegen.config.yaml` in your project root to configure output paths:

```yaml
# Database dialect
database:
  dialect: postgres  # postgres | sqlite

# Output paths (relative to project root)
paths:
  # Backend source directory
  backend_src: app/backend/src

  # Frontend source directory (set to null to skip frontend generation)
  frontend_src: app/frontend/src

  # Shared packages directory
  packages: packages

  # Schema directory (relative to backend_src)
  schema_dir: infrastructure/persistence/drizzle

  # Entity definitions directory
  entities_dir: entities

  # Manifest output directory
  manifest_dir: .codegen
```

### Locations (Path + Import Mapping)

Each location defines both where files are written and how to import them:

```yaml
# Override default locations in codegen.config.yaml
locations:
  # Shared packages
  dbEntities:
    path: packages/db/src/entities        # filesystem path
    import: "@repo/db/entities"           # TypeScript import alias

  # Frontend
  frontendCollections:
    path: apps/frontend/src/lib/collections
    import: "@/lib/collections"

  frontendStore:
    path: apps/frontend/src/lib/store
    import: "@/lib/store"

  # Add any location to override defaults
```

See `config/locations.mjs` for all available locations and their defaults.

### Backend Naming Conventions

Control file and class naming patterns for generated backend code:

```yaml
naming:
  fileCase: kebab-case       # kebab-case | camelCase | snake_case | PascalCase
  suffixStyle: dotted        # dotted (.entity.ts) | suffixed (Entity.ts) | worded (-entity.ts)
  entityInclusion: always    # always | never | flat-only
  terminology:
    command: use-case        # command | use-case
    query: query             # query | use-case
```

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `fileCase` | `kebab-case`, `camelCase`, `snake_case`, `PascalCase` | `kebab-case` | File name casing |
| `suffixStyle` | `dotted`, `suffixed`, `worded` | `dotted` | How suffixes are applied |
| `entityInclusion` | `always`, `never`, `flat-only` | `flat-only` | When entity name appears in filenames |
| `terminology.command` | `command`, `use-case` | `command` | Write operation naming |
| `terminology.query` | `query`, `use-case` | `query` | Read operation naming |

**Example outputs by configuration:**

| Config | Entity File | Command File | Query File |
|--------|-------------|--------------|------------|
| Default | `opportunity.entity.ts` | `create.command.ts` | `get-by-id.query.ts` |
| `entityInclusion: always` | `opportunity.entity.ts` | `create-opportunity.command.ts` | `get-opportunity-by-id.query.ts` |
| `terminology.command: use-case` | `opportunity.entity.ts` | `create-opportunity.use-case.ts` | `get-opportunity-by-id.query.ts` |
| `suffixStyle: suffixed` + `PascalCase` | `OpportunityEntity.ts` | `CreateOpportunityCommand.ts` | `GetOpportunityByIdQuery.ts` |

### Full Example: Clean Architecture (Dealbrain-style)

A complete configuration matching Clean Architecture with UseCase terminology:

```yaml
database:
  dialect: postgres

naming:
  fileCase: kebab-case
  suffixStyle: dotted
  entityInclusion: always
  terminology:
    command: use-case    # → create-user.use-case.ts, CreateUserUseCase
    query: query         # → get-user-by-id.query.ts, GetUserByIdQuery

locations:
  # Application layer uses "applications" (plural) with use-cases folder
  backendCommands:
    path: src/applications/use-cases
    import: '@backend/applications/use-cases'
  backendQueries:
    path: src/applications/queries
    import: '@backend/applications/queries'
  backendSchemas:
    path: src/applications/schemas
    import: '@backend/applications/schemas'

  # Modules under infrastructure
  backendModules:
    path: src/infrastructure/modules
    import: '@backend/infrastructure/modules'

paths:
  backend_src: src
```

This generates:
```
src/
├── applications/
│   ├── use-cases/
│   │   ├── create-user.use-case.ts      # CreateUserUseCase
│   │   ├── update-user.use-case.ts      # UpdateUserUseCase
│   │   └── delete-user.use-case.ts      # DeleteUserUseCase
│   ├── queries/
│   │   ├── get-user-by-id.query.ts      # GetUserByIdQuery
│   │   └── get-all-users.query.ts       # GetAllUsersQuery
│   └── schemas/
│       └── user.dto.ts
├── domain/
│   └── user/
│       ├── user.entity.ts               # User class
│       └── user.repository.interface.ts # IUserRepository
├── infrastructure/
│   ├── modules/
│   │   └── users.module.ts              # UsersModule
│   └── database/
│       └── repositories/
│           └── user.repository.ts       # UserRepository
└── presentation/
    └── rest/
        └── users.controller.ts          # UsersController
```

### Environment Variables

Override config at runtime:

| Variable | Purpose | Default |
|----------|---------|---------|
| `CODEGEN_TEMPLATES_DIR` | Path to Hygen templates | `<codegen>/templates` |
| `CODEGEN_ENTITIES_DIR` | Path to entity YAML files | `entities/` |
| `CODEGEN_MANIFEST_DIR` | Directory for manifest.json | `.codegen/` |

## CLI Commands

```bash
# ═══════════════════════════════════════════════════════════════
# CODE GENERATION
# ═══════════════════════════════════════════════════════════════
bun codegen entity entities/opportunity.yaml   # Generate single entity
bun codegen all                                # Generate all entities
bun codegen all --entities-dir path/to/yaml    # Custom entities directory
bun codegen broadcast                          # Generate WebSocket infrastructure

# ═══════════════════════════════════════════════════════════════
# PROJECT SCANNING
# ═══════════════════════════════════════════════════════════════
bun codegen scan .                          # Scan project, generate config
bun codegen scan . -v                       # Verbose output with evidence

# ═══════════════════════════════════════════════════════════════
# DOMAIN ANALYSIS
# ═══════════════════════════════════════════════════════════════
bun codegen validate entities/              # Validate YAML files only
bun codegen analyze entities/               # Full analysis with graph & issues
bun codegen stats entities/                 # Statistics only
bun codegen doc entities/ -o domain.md      # Generate documentation

# ═══════════════════════════════════════════════════════════════
# MANIFEST & TRANSITIVE SUGGESTIONS
# ═══════════════════════════════════════════════════════════════
bun codegen manifest entities/              # Update .codegen/manifest.json
bun codegen manifest entities/ --force      # Force re-scan even if fresh
bun codegen suggestions                     # Review pending suggestions
bun codegen suggestions --accept <id>       # Accept a suggestion
bun codegen suggestions --skip <id>         # Skip a suggestion
bun codegen suggestions --accept-all        # Accept all pending

# Options
-f, --format <format>     # Output: console (default), json, markdown
-o, --output <file>       # Write to file instead of stdout
-s, --strict              # Treat warnings as errors (exit 1)
-e, --entity <name>       # Focus on specific entity
-v, --verbose             # Show detailed detection results
--entities-dir <path>     # Override entities directory
--force                   # Force re-scan (manifest command)
```

## YAML Schema

```yaml
# Entity metadata
entity:
  name: opportunity          # Singular name (snake_case)
  plural: opportunities      # Plural form
  table: opportunities       # Database table name
  folder_structure: nested   # 'nested' or 'flat'

# Field definitions
fields:
  id:
    type: uuid
    required: false

  account_id:
    type: uuid
    required: true
    foreign_key: accounts.id  # FK reference (table.column)
    index: true               # Create database index

  name:
    type: string
    required: true
    max_length: 255           # String length constraint

  amount:
    type: decimal
    nullable: true            # Allow NULL in database

  probability:
    type: integer
    nullable: true
    min: 0                    # Validation constraint
    max: 100

  status:
    type: enum
    choices: [open, won, lost]
    required: true

# Relationship definitions
relationships:
  account:
    type: belongs_to          # belongs_to, has_many, has_one
    target: account           # Target entity name
    foreign_key: account_id   # FK field in this entity

  deals:
    type: has_many
    target: deal
    foreign_key: opportunity_id  # FK in the related entity
```

## Field Types

| YAML Type  | TypeScript | Drizzle          | Zod                 |
|------------|------------|------------------|---------------------|
| `string`   | `string`   | `varchar`        | `z.string()`        |
| `integer`  | `number`   | `integer`        | `z.number().int()`  |
| `decimal`  | `number`   | `doublePrecision`| `z.number()`        |
| `boolean`  | `boolean`  | `boolean`        | `z.boolean()`       |
| `uuid`     | `string`   | `uuid`           | `z.string().uuid()` |
| `date`     | `Date`     | `date`           | `z.coerce.date()`   |
| `datetime` | `Date`     | `timestamp`      | `z.coerce.date()`   |
| `json`     | `unknown`  | `jsonb`          | `z.unknown()`       |
| `enum`     | union      | `varchar`        | `z.enum()`          |

## UI Metadata

Fields can include optional UI metadata for automatic admin panel generation:

```yaml
fields:
  name:
    type: string
    required: true

    # UI metadata (all optional - sensible defaults inferred)
    ui_label: "Opportunity Name"     # Display label
    ui_type: text                    # Input type
    ui_importance: primary           # primary | secondary | tertiary
    ui_group: identification         # Logical grouping for forms
    ui_sortable: true                # Enable column sorting
    ui_filterable: true              # Enable column filtering
    ui_visible: true                 # Show in UI
    ui_placeholder: "Enter name..."  # Input placeholder
    ui_help: "The display name"      # Help text
```

## Generated Output Structure

Running codegen generates files following Clean Architecture:

```
{backend_src}/
├── domain/{entity}/
│   ├── {entity}.entity.ts              # Domain entity
│   └── {entity}.repository.interface.ts # Repository contract
├── application/
│   ├── commands/{entity}/              # Create, Update, Delete
│   ├── queries/{entity}/               # GetById, List
│   └── schemas/{entity}.dto.ts         # Zod DTOs
├── infrastructure/persistence/
│   ├── {schema_dir}/{entity}.schema.ts # Drizzle schema
│   └── repositories/{entity}.repository.ts
├── presentation/rest/
│   └── {plural}.controller.ts          # REST endpoints
└── modules/
    └── {plural}.module.ts              # NestJS module

{frontend_src}/
├── lib/collections/{entity}.ts         # Electric collection
├── lib/store/entities/{entity}.ts      # Entity hooks
└── lib/entities/{entity}.ts            # Entity metadata

{packages}/db/src/entities/
└── {entity}.ts                         # Shared Zod schema
```

## WebSocket Broadcast Infrastructure

Generate real-time broadcast infrastructure for entity updates:

```bash
bun codegen broadcast
```

Creates a NestJS module with WebSocket gateway, channel abstraction, and pluggable backends (memory, WebSocket). Useful for pushing entity changes to connected clients.

## Project Scanning

The `scan` command auto-detects your project's patterns and generates a config file:

```bash
bun codegen scan .
```

Detects:
- **Framework**: NestJS, Express, Fastify, etc.
- **ORM**: Drizzle, Prisma, TypeORM, etc.
- **Architecture**: Clean Architecture, MVC, layered, etc.
- **Naming conventions**: File casing, suffixes, etc.

Outputs a `codegen.config.yaml` with confidence scores for each detection.

## Transitive Relationship Suggestions

The manifest tracks your domain model and suggests "through" relationships when it detects multi-hop paths between entities.

```bash
# Scan entities and update manifest
bun codegen manifest entities/

# Review suggestions (e.g., if Person → Organization → Opportunity exists,
# suggests Person → Opportunity through Organization)
bun codegen suggestions

# Accept or skip suggestions
bun codegen suggestions --accept "person->opportunity"
bun codegen suggestions --skip-all
```

Suggestions include YAML snippets to add to your entity files.

## Architecture

The generator follows layered Clean Architecture:

```
Presentation → Application → Domain ← Infrastructure
     │              │           │            │
 Controllers    Commands    Entities    Repositories
     │          Queries    Interfaces   Drizzle Schemas
     └──────────────┴───────────┴────────────┘
                        ↓
                  NestJS Module
```

## Testing

```bash
# Capture current output as baseline
bun test/run-test.ts baseline

# Run full test (generate + compare to baseline)
bun test/run-test.ts full

# Generate only (without comparison)
bun test/run-test.ts generate

# Compare gen/ to baseline/ (without regenerating)
bun test/run-test.ts compare
```

## Customization

### Adding a new field type

Edit `templates/entity/new/prompt.js` and add mappings to `tsTypes`, `drizzleTypes`, and `zodTypes`.

### Modifying generated code

Edit the relevant `.ejs.t` template:

| Layer | Template Location |
|-------|------------------|
| Domain entities | `templates/entity/new/backend/domain/` |
| Database schemas | `templates/entity/new/backend/database/` |
| Commands (CRUD) | `templates/entity/new/backend/application/commands/` |
| Queries | `templates/entity/new/backend/application/queries/` |
| DTOs | `templates/entity/new/backend/application/schemas/` |
| Controllers | `templates/entity/new/backend/presentation/` |
| NestJS modules | `templates/entity/new/backend/modules/` |
| Frontend | `templates/entity/new/frontend/` |
| Shared schemas | `templates/entity/new/shared/` |

Templates prefixed with `_inject-` modify existing files. Others create new files.

## License

MIT
