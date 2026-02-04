# Original Request

Frontend Entity Generator Restructure - Full Spec

## Problem Statement

The current generator has:
- Monolithic template (entity.ejs.t) that diverged from individual templates
- Bugs in collection/hooks patterns that don't match dealbrain's actual usage
- No flexibility in output structure

## Part 1: Bug Fixes (apply to all templates)

| # | Issue | Fix |
|---|-------|-----|
| 1 | Schema import appends /<entity> | Add barrelExport: true config to skip suffix |
| 2 | Auth header when null | Wrap in <% if (frontend.auth.function) { %> |
| 3 | Missing API_BASE_URL import | Add apiBaseUrlImport config |
| 4 | URL needs new URL().toString() | Add wrapInUrlConstructor: true config |
| 5 | Parser arrows encoded as =&gt; | Use <%- for raw output |
| 6 | columnMapper needs () call | Add columnMapperNeedsCall: true config |
| 7 | Hooks use wrong API | Use useLiveQuery pattern (already in hooks.ejs.t) |
| 8 | Mutations for read-only entities | Check expose before generating |

## Part 2: Template Restructure

From:
```
frontend/
├── collections/collection.ejs.t    # Standalone
├── generated/entity.ejs.t          # Monolithic (duplicated, buggy)
├── store/hooks.ejs.t               # Standalone
└── unified-entity.ejs.t
```

To:
```
frontend/
├── entity/
│   ├── types.ejs.t        # Types + resolved interfaces
│   ├── collection.ejs.t   # Electric collection
│   ├── hooks.ejs.t        # useLiveQuery hooks
│   ├── mutations.ejs.t    # insert/update/delete (conditional)
│   ├── fields.ejs.t       # Field metadata (conditional)
│   ├── index.ejs.t        # Barrel export
│   └── combined.ejs.t     # For monolithic mode only
└── unified-entity.ejs.t   # Keep for composition
```

## Part 3: Three Output Modes

```yaml
generate:
  structure: "concern-first"  # Default
```

- **entity-first**: Group by entity (opportunity/, user/, etc.)
- **concern-first**: Group by concern (schemas/, collections/, hooks/, etc.)
- **monolithic**: Single file per entity

## Part 4: New Config Options

```yaml
locations:
  dbEntities:
    barrelExport: true              # NEW: Don't append entity name

frontend:
  auth:
    function: null                  # null = skip auth header entirely
  sync:
    columnMapperNeedsCall: true     # NEW: Output snakeCamelMapper()
    apiBaseUrlImport: "@/lib/config" # NEW: Where to import API_BASE_URL
    wrapInUrlConstructor: true      # NEW: Use new URL().toString()

generate:
  structure: "concern-first"        # NEW: entity-first | concern-first | monolithic
  mutations: true                   # NEW: Can disable separately
```

## Implementation Order

1. Fix bugs in existing templates (immediate value)
2. Add config options to prompt.js
3. Create individual templates in entity/ folder
4. Add path computation for three modes
5. Deprecate old monolithic entity.ejs.t
6. Test with dealbrain config
