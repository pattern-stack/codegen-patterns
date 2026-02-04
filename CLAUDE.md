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
- **config/** - Path configuration and project settings

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
```

Override with environment variables: `CODEGEN_TEMPLATES_DIR`, `CODEGEN_ENTITIES_DIR`, `CODEGEN_MANIFEST_DIR`

### Testing Approach
Baseline testing: generates entities from `test/fixtures/*.yaml`, compares output to `test/baseline/`. Run `bun test/run-test.ts baseline` after intentional template changes.
