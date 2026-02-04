# Issue 3: Create Individual Component Templates - Spec

**Status:** Implemented
**Last Updated:** 2026-02-04

## Overview

Extracted the monolithic `entity.ejs.t` into 7 individual component templates, each handling a single concern. Templates adapt their output paths based on `generate.structure` config.

## Templates Created

| Template | Purpose | Lines |
|----------|---------|-------|
| `types.ejs.t` | Base + resolved types | ~60 |
| `collection.ejs.t` | Electric collection + resolution | ~140 |
| `hooks.ejs.t` | useMany/useOne hooks | ~70 |
| `mutations.ejs.t` | insert/update/delete | ~45 |
| `fields.ejs.t` | Field metadata | ~95 |
| `index.ejs.t` | Barrel export (entity-first only) | ~20 |
| `combined.ejs.t` | Full monolithic (monolithic mode) | ~350 |

## Output Structure Modes

### Entity-First (`structure: 'entity-first'`)
```
generated/
  opportunity/
    index.ts
    types.ts
    collection.ts
    hooks.ts
    mutations.ts
    fields.ts
```

### Concern-First (`structure: 'concern-first'`)
```
generated/
  types/opportunity.ts
  collections/opportunity.ts
  hooks/opportunity.ts
  mutations/opportunity.ts
  fields/opportunity.ts
```

### Monolithic (`structure: 'monolithic'`)
```
generated/
  opportunity.ts  # Everything in one file
```

## Key Implementation Details

1. Each template uses `skip_if` to respect `generate.structure`
2. Component templates import from siblings with relative paths
3. All original functionality preserved (FK resolution, tRPC mutations, parsers)
4. Conditional generation for mutations and fields based on config
