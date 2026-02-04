# Plan: Frontend Entity Generator Restructure

## Issue Tree

```
frontend-entity-generator-restructure/
├── [issue] Fix critical bugs in monolithic entity template                    (layer:codegen, type:bug)
│   ├── [subtask] Fix schema import path (barrelExport config)
│   ├── [subtask] Fix auth header null safety
│   ├── [subtask] Fix missing API_BASE_URL import
│   ├── [subtask] Fix URL constructor pattern
│   ├── [subtask] Fix parser encoding (raw output)
│   ├── [subtask] Fix columnMapper call pattern
│   ├── [subtask] Fix hooks API (useLiveQuery pattern)
│   └── [subtask] Fix mutations for read-only entities
├── [issue] Add frontend config options to prompt.js                           (layer:codegen, type:feature)
│   └── blocks: "Fix critical bugs"
├── [issue] Create individual component templates in entity/ folder            (layer:codegen, type:feature)
│   ├── [subtask] Create types.ejs.t
│   ├── [subtask] Create collection.ejs.t
│   ├── [subtask] Create hooks.ejs.t
│   ├── [subtask] Create mutations.ejs.t
│   ├── [subtask] Create fields.ejs.t
│   └── blocks: "Add frontend config options"
├── [issue] Add output mode path computation logic                             (layer:codegen, type:feature)
│   └── blocks: "Create individual templates"
└── [issue] Deprecate monolithic entity.ejs.t template                         (layer:codegen, type:chore)
    └── blocks: "Add output mode path computation"
```

## Dependency Graph

```
[Fix bugs] ───> [Add config] ───> [Create templates] ───> [Add path logic] ───> [Deprecate old]
     │                                     │
     └─ 8 parallel fixes ─────────────────┴─ 5 parallel templates
```

## Issue Details

### 1. Fix critical bugs in monolithic entity template
**Files:** `templates/entity/new/frontend/generated/entity.ejs.t`
**Size:** ~80 lines (8 fixes)

Fixes:
1. Schema import uses barrelExport config
2. Auth header wrapped in conditional
3. API_BASE_URL import added
4. URL uses `new URL().toString()`
5. Parser functions use `<%-` for raw output
6. columnMapper invoked with `()` when configured
7. Hooks use `useLiveQuery` pattern
8. Mutations respect expose config

### 2. Add frontend config options to prompt.js
**Files:** `prompt.js`, `config-loader.mjs`
**Size:** ~50 lines
**Blocks:** Issue 1

New configs:
- `barrelExport` - skip entity suffix in imports
- `apiBaseUrlImport` - API_BASE_URL import path
- `wrapInUrlConstructor` - URL constructor pattern
- `columnMapperNeedsCall` - columnMapper() invocation
- `generate.structure` - output mode enum

### 3. Create individual component templates
**Files:** New templates in `templates/entity/new/frontend/entity/`
**Size:** ~250 lines (5 templates)
**Blocks:** Issue 2

Templates:
- `types.ejs.t` - base + resolved types
- `collection.ejs.t` - Electric SQL collection
- `hooks.ejs.t` - useMany/useOne hooks
- `mutations.ejs.t` - insert/update/delete
- `fields.ejs.t` - field metadata

### 4. Add output mode path computation logic
**Files:** `prompt.js`, `config/paths.mjs`
**Size:** ~80 lines
**Blocks:** Issue 3

Modes:
- `entity-first`: `/entities/{name}/types.ts`
- `concern-first`: `/types/{name}.ts`
- `monolithic`: `/generated/{name}.ts`

### 5. Deprecate monolithic entity.ejs.t
**Files:** `entity.ejs.t`, `CLAUDE.md`, test baseline
**Size:** ~40 lines
**Blocks:** Issue 4

Tasks:
- Add deprecation comment
- Skip when `structure !== 'monolithic'`
- Migration guide
- Update baseline tests
