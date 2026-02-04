# Issue 2: Add Frontend Config Options - Spec

**Status:** Implemented
**Last Updated:** 2026-02-04

## Overview

Add remaining config options for frontend generation flexibility.

## Changes Made

### 1. barrelExport Support (entity.ejs.t)

Updated template to use `barrelExport` instead of `appendEntityName`:
- Line 22: `<% if (!locations.dbEntities.barrelExport) { %>/<%= name %><% } %>`
- Line 58: Same for related entity imports

**Logic:**
- `barrelExport: true` → skip entity suffix (barrel exports all entities)
- `barrelExport: false/undefined` → append `/<entity>` (original behavior)

### 2. generate.structure (prompt.js)

Added output structure mode config:
```javascript
structure: getProjectConfig()?.generate?.structure ?? 'monolithic',
```

**Values:**
- `entity-first`: generated/{entity}/types.ts, collection.ts, hooks.ts...
- `concern-first`: generated/types/{entity}.ts, collections/{entity}.ts...
- `monolithic`: generated/{entity}.ts (single file per entity) - DEFAULT

## Files Modified

| File | Change |
|------|--------|
| `entity.ejs.t` | Use `barrelExport` for import path logic |
| `prompt.js` | Add `generate.structure` config |

## Config Summary

All frontend config options now available:
- `locations.dbEntities.barrelExport` - skip entity suffix
- `frontend.sync.apiBaseUrlImport` - API_BASE_URL import path
- `frontend.sync.wrapInUrlConstructor` - URL constructor toggle
- `frontend.sync.columnMapperNeedsCall` - columnMapper() call toggle
- `generate.structure` - output mode (entity-first/concern-first/monolithic)
