# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Entity-driven code generation system for full-stack TypeScript applications. Generates Clean Architecture scaffolding from YAML entity definitions, including domain entities, repositories, use cases, DTOs, Drizzle schemas, NestJS modules, and frontend collections.

## Commands

```bash
# Install
bun install
bun add -d hygen  # peer dependency

# Code generation
bun codegen entity entities/opportunity.yaml   # Generate single entity
bun codegen all                                # Generate all entities
bun codegen broadcast                          # Generate WebSocket infrastructure

# Project scanning (auto-detect patterns, generate config)
bun codegen scan .                             # Scan project, generate config
bun codegen scan . -v                          # Verbose with detection evidence

# Domain analysis
bun codegen validate entities/                 # Validate YAML files
bun codegen analyze entities/                  # Full analysis with graph
bun codegen stats entities/                    # Statistics only
bun codegen doc entities/ -o domain.md         # Generate documentation

# Manifest & transitive suggestions
bun codegen manifest entities/                 # Update .codegen/manifest.json
bun codegen manifest entities/ --force         # Force re-scan
bun codegen suggestions                        # Review pending suggestions
bun codegen suggestions --accept <id>          # Accept a suggestion
bun codegen suggestions --skip-all             # Skip all pending

# Testing
bun test/run-test.ts full      # Full test (generate + compare to baseline)
bun test/run-test.ts baseline  # Capture current output as baseline
bun test/run-test.ts compare   # Compare gen/ to baseline/

# Run individual scanner tests
bun test scanner/orm-detector.test.ts
```

## Architecture

### Core Pipeline
```
YAML Entity Definition → Parser → Analyzer → Hygen Templates → Generated Code
```

### Module Structure

- **cli.ts** - Main CLI entry point with all command handlers
- **index.ts** - Public API exports (`analyzeDomain`, `validateEntities`, etc.)
- **parser/** - Loads and parses entity YAML files, resolves cross-references
- **analyzer/** - Graph building, consistency checking, statistics, transitive relationship suggestions, manifest management
- **scanner/** - Detects project patterns (framework, ORM, architecture, naming conventions)
- **output/** - Formatters for console, JSON, and markdown output
- **schema/** - Zod schemas for entity definitions and relationship types
- **behaviors/** - Shared entity behaviors (timestamps, soft-delete, user-tracking)
- **templates/** - Hygen EJS templates for code generation
- **config/** - Shared config loader (`config-loader.mjs`), path configuration (`paths.mjs`), location mapping (`locations.mjs`)

### Template System

Templates use Hygen and are located in `templates/`. Two types:
- Regular templates (e.g., `entity.ejs.t`) create new files
- Inject templates (prefixed `_inject-`) modify existing files

Template entry point: `templates/entity/new/prompt.js` - derives camelCase from snake_case fields, maps field types to TypeScript/Drizzle/Zod.

### Generated Code Layers (Clean Architecture)

```
Presentation → Application → Domain ← Infrastructure
Controllers    Commands     Entities    Repositories
               Queries      Interfaces  Drizzle Schemas
```

## Key Patterns

### Naming Conventions
- YAML fields: `snake_case` (matches database columns)
- TypeScript properties: `camelCase` (derived from snake_case in templates)
- Entity names in YAML: singular snake_case (`opportunity`)
- Generated folders: match entity name

### Configuration
Project config in `codegen.config.yaml`:
```yaml
database:
  dialect: postgres
paths:
  backend_src: app/backend/src
  frontend_src: app/frontend/src
locations:
  dbEntities:
    path: packages/db/src/entities
    import: "@repo/db/entities"
locations:
  dbEntities:
    barrelExport: true  # Skip entity suffix in imports (default: false)
frontend:
  auth:
    function: getToken  # Auth function name, or null to skip auth header entirely
  sync:
    shapeUrl: '/v1/shape'  # Base URL for Electric SQL shapes (default: /v1/shape)
    useTableParam: true    # true = ?table=X (Electric pattern), false = /plural appended
    columnMapper: snakeCamelMapper  # For snake_case DB columns → camelCase JS (default: null)
    columnMapperNeedsCall: true     # true = mapper(), false = mapper (default: true)
    wrapInUrlConstructor: true      # Wrap shapeUrl in new URL().toString() (default: true)
    apiBaseUrlImport: '@/lib/config' # Import path for API_BASE_URL (default: null)
  parsers:
    timestamptz: '(d: string) => new Date(d)'
    date: '(d: string) => new Date(d + "T00:00:00")'
generate:
  structure: 'monolithic'  # Output structure: monolithic | entity-first | concern-first
```

**Frontend Parsers**: Custom parser functions for Electric SQL shape data. Each key is a PostgreSQL type, and the value is a JavaScript function string that will be output directly in generated code. Default: `{ timestamptz: '(date: string) => new Date(date)' }`.

**Frontend Sync Patterns**: The `frontend.sync` config controls how shape URLs are generated:
- `useTableParam: true` (default): Electric SQL pattern - `/v1/shape?table=opportunities`
- `useTableParam: false`: REST-style pattern - `${shapeUrl}/opportunities`
- `columnMapper`: Set to `snakeCamelMapper` to convert snake_case DB columns to camelCase JS properties. Leave unset (default: `null`) if your DB columns already match your JS property names.
- `columnMapperNeedsCall`: Set to `true` if mapper is a function (`mapper()`), `false` if it's an object (`mapper`).
- `wrapInUrlConstructor`: Wraps shapeUrl in `new URL(url, origin).toString()` for proper URL resolution.
- `apiBaseUrlImport`: Import path for `API_BASE_URL` constant (e.g., `'@/lib/config'`). Set to `null` to skip.

**Generation Toggles**: Control which outputs are generated:
```yaml
generate:
  fieldMetadata: true      # Generate field metadata (default: true)
  collections: true        # Generate standalone collection files (default: true)
  hooks: true              # Generate standalone hooks files (default: true)
  mutations: true          # Generate mutation functions (default: true)
  structure: 'monolithic'  # Output structure mode (default: monolithic)
  typeNaming: 'plain'      # 'plain' = Opportunity, 'entity' = OpportunityEntity (default: plain)
  fkResolution: true       # Import related collections for FK resolution (default: true)
  collectionNaming: 'singular'  # 'singular' = opportunityCollection, 'plural' = opportunitiesCollection
  fileNaming: 'singular'   # 'singular' = opportunity.ts, 'plural' = opportunities.ts
  hookReturnStyle: 'generic'  # 'generic' = { data }, 'named' = { opportunities }
```
Set any toggle to `false` to skip generating that output. Useful when you have manual `fields.tsx` files or custom hook implementations you want to preserve.

**Naming Convention Options** (Frontend):
- `typeNaming`: Controls the type name imported from source and exported locally. `'plain'` (default) expects source to export `Opportunity`, `'entity'` expects source to export `OpportunityEntity`
- `collectionNaming`: Controls the collection variable name. `'singular'` (default) = `opportunityCollection`, `'plural'` = `opportunitiesCollection`
- `fileNaming`: Controls the output file names. `'singular'` (default) = `opportunity.ts`, `'plural'` = `opportunities.ts`
- `hookReturnStyle`: Controls hook return shape. `'generic'` (default) = `{ data, isLoading }`, `'named'` = `{ opportunities, isLoading }`
- `fkResolution`: When `false`, skips importing related collections and simplifies `resolveRelations()` to identity function. Useful when related collections don't exist yet.

**Backend Naming Configuration** (`naming:`):
Controls file and class naming patterns for backend code generation:
```yaml
naming:
  fileCase: kebab-case       # kebab-case | camelCase | snake_case | PascalCase
  suffixStyle: dotted        # dotted (.entity.ts) | suffixed (Entity.ts) | worded (-entity.ts)
  entityInclusion: always    # always | never | flat-only
  terminology:
    command: use-case        # command | use-case
    query: query             # query | use-case
```

- `fileCase`: How file names are cased. Default: `kebab-case`
- `suffixStyle`: How type suffixes are applied. Default: `dotted`
- `entityInclusion`: When entity name appears in command/query filenames. Default: `flat-only`
- `terminology.command`: Class suffix for write operations. `command` → `CreateOpportunityCommand`, `use-case` → `CreateOpportunityUseCase`
- `terminology.query`: Class suffix for read operations. `query` → `GetOpportunityByIdQuery`, `use-case` → `GetOpportunityByIdUseCase`

**Example: Dealbrain-style configuration**:
```yaml
naming:
  fileCase: kebab-case
  suffixStyle: dotted
  entityInclusion: always
  terminology:
    command: use-case    # → create-user.use-case.ts, CreateUserUseCase
    query: query         # → get-user-by-id.query.ts, GetUserByIdQuery

locations:
  backendCommands:
    path: src/applications/use-cases
    import: '@backend/applications/use-cases'
  backendQueries:
    path: src/applications/queries
    import: '@backend/applications/queries'
  backendModules:
    path: src/infrastructure/modules
    import: '@backend/infrastructure/modules'
```

**Output Structure Modes** (`generate.structure`):
- `monolithic` (default): Single file per entity - `generated/{entity}.ts`
- `entity-first`: Group by entity - `generated/{entity}/types.ts`, `collection.ts`, `hooks.ts`, etc.
- `concern-first`: Group by concern - `generated/types/{entity}.ts`, `collections/{entity}.ts`, etc.

**Locations** (`config/locations.mjs`): Each location defines both `path` (where files go) and `import` (TypeScript alias). Templates use `locations.X.path` for output and `locations.X.import` for imports.

Override with environment variables: `CODEGEN_TEMPLATES_DIR`, `CODEGEN_ENTITIES_DIR`, `CODEGEN_MANIFEST_DIR`

### Testing Approach
Baseline testing: generates entities from `test/fixtures/*.yaml`, compares output to `test/baseline/`. Run `bun test/run-test.ts baseline` after intentional template changes.
