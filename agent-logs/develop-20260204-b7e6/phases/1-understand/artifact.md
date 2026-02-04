# Understanding: Frontend Entity Generator Restructure

Restructuring frontend code generation templates to fix 8 bugs, eliminate divergence between monolithic and standalone templates, and support three output structure modes (entity-first, concern-first, monolithic).

## Context

- **Problem:** The monolithic `entity.ejs.t` template duplicated code from standalone templates (`collection.ejs.t`, `hooks.ejs.t`) but diverged with bugs. Templates contain hardcoded patterns that don't match dealbrain's actual Electric SQL usage.
- **Users:** Developers using the codegen system who need flexible output structures and correct Electric SQL integration patterns
- **Systems:** Frontend code generation pipeline - specifically templates in `templates/entity/new/frontend/` and the config flow from `codegen.config.yaml` → `prompt.js` → templates

## Relevant Code

```
templates/entity/new/frontend/
├── collections/collection.ejs.t       ← Standalone, mostly correct (58 lines)
├── store/hooks.ejs.t                  ← Standalone, correct useLiveQuery (70 lines)
├── generated/entity.ejs.t             ← Monolithic, contains all 8 bugs (349 lines)
├── unified-entity.ejs.t               ← Composition layer
└── store/_inject-*.ejs.t              ← Store injection templates

config/
├── config-loader.mjs                  ← Loads codegen.config.yaml
├── locations.mjs                      ← Path + import alias mappings
└── paths.mjs                          ← Path computation helpers

templates/entity/new/
└── prompt.js                          ← Variable derivation (lines 948-972: frontend config)
```

## Current Patterns

### Config Flow
```
codegen.config.yaml → config-loader.mjs → prompt.js (lines 948-972) → template variables
```

### Template Organization
- **Standalone templates**: `collection.ejs.t`, `hooks.ejs.t` - smaller, more correct
- **Monolithic template**: `entity.ejs.t` - duplicated code, diverged with bugs
- **Conditional generation**: `skip_if: <%= !generate.collections %>` controls file generation

### Hook Styles
Two patterns exist in entity.ejs.t controlled by `generate.hookStyle`:
- `collection.useMany()` pattern (line 196) - incorrect
- `useLiveQuery` pattern (line 172) - correct (used in standalone hooks.ejs.t)

## Bug Evidence

| # | Bug | Evidence | Location |
|---|-----|----------|----------|
| 1 | Schema import appends /entity | `appendEntityName !== false` check exists but naming inconsistent | entity.ejs.t:16-22 |
| 2 | Auth header when null | `Authorization: <%= frontend.auth.function %>` - no null guard | entity.ejs.t:108-110 |
| 3 | Missing API_BASE_URL import | No import statement when using `${API_BASE_URL}` in URLs | entity.ejs.t:95-100 |
| 4 | URL needs constructor | URL construction pattern may need `new URL().toString()` | entity.ejs.t:95-100 |
| 5 | Parser arrows encoded | Uses `<%= fn %>` should be `<%- fn %>` for raw output | entity.ejs.t:47 |
| 6 | columnMapper needs () | Hardcoded `columnMapper()` call without config flag | entity.ejs.t:51,118 |
| 7 | Hooks use wrong API | entity.ejs.t uses `collection.useMany()`, hooks.ejs.t uses `useLiveQuery` | entity.ejs.t:196 vs hooks.ejs.t:22 |
| 8 | Mutations for read-only | Checks `generate.mutations` but not `expose` config | entity.ejs.t:207 |

## Template Divergence

The monolithic `entity.ejs.t` (349 lines) contains:
- Types/interfaces generation
- Collection setup (duplicated from collection.ejs.t)
- Hooks (duplicated from hooks.ejs.t but using wrong pattern)
- Mutations
- Field metadata

The standalone templates are more correct but less feature-complete.

## Config Extension Needed

Current config (prompt.js lines 948-972):
- `frontend.auth.function`
- `frontend.sync.shapeUrl`, `useTableParam`, `columnMapper`
- `frontend.parsers`
- `generate.fieldMetadata`, `collections`, `hooks`

New config needed:
- `locations.*.barrelExport` - skip entity name suffix in imports
- `frontend.sync.apiBaseUrlImport` - where to import API_BASE_URL
- `frontend.sync.wrapInUrlConstructor` - use `new URL().toString()`
- `frontend.sync.columnMapperNeedsCall` - output `mapper()` vs `mapper`
- `generate.structure` - "entity-first" | "concern-first" | "monolithic"
- `generate.mutations` - already exists, just need expose check

## Output Structure Modes (Not Yet Implemented)

Current: Fixed locations (collections/, store/entities/, generated/)

Needed: Dynamic path computation based on `generate.structure`:
- **entity-first**: `generated/{entity}/types.ts`, `collection.ts`, `hooks.ts`...
- **concern-first**: `generated/schemas/{entity}.ts`, `collections/{entity}.ts`...
- **monolithic**: `generated/{entity}.ts` (single file)
