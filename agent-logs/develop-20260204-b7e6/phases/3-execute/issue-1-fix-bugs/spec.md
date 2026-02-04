# Fix Critical Bugs in Monolithic Entity Template - Implementation Spec

**Status:** Draft
**Last Updated:** 2026-02-04

## Overview

This spec addresses 8 critical bugs in the monolithic `entity.ejs.t` template that prevent correct code generation. These bugs cause import errors, type errors, and runtime failures in generated frontend code. The fixes ensure the template generates production-ready TypeScript code that matches the patterns established in the standalone `hooks.ejs.t` and `collection.ejs.t` templates.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `templates/entity/new/frontend/generated/entity.ejs.t` | modify | Fix all 8 bugs |
| `templates/entity/new/prompt.js` | modify | Add new config flags |

## Bug Fixes

### Bug 1: Schema Import Appends /entity Incorrectly
**Location:** Line 22
**Fix:** Change `appendEntityName !== false` to `appendEntityName` (truthy check)

### Bug 2: Auth Header When null
**Location:** Line 109
**Fix:** Add `()` to call the function: `<%= frontend.auth.function %>()`

### Bug 3: Missing API_BASE_URL Import
**Location:** After line 33
**Fix:** Add conditional import based on `frontend.apiBaseUrl.enabled` config

### Bug 4: URL Needs new URL().toString()
**Location:** Lines 95-100
**Fix:** Wrap in conditional based on `wrapInUrlConstructor` config (default: true)

### Bug 5: Parser Arrows Encoded
**Status:** FALSE ALARM - template already uses `<%-` correctly

### Bug 6: columnMapper Needs () Call
**Location:** Lines 117-119
**Fix:** Add conditional based on `columnMapperIsFunction` config (default: true)

### Bug 7: Hooks Use Wrong API
**Location:** Lines 168-205
**Fix:** Update useLiveQuery implementation to match hooks.ejs.t pattern:
- Import `eq` from `@tanstack/react-db`
- Use `.where()` with `eq()` filter
- Add dependency array `[id]`

### Bug 8: Mutations for Read-Only Entities
**Location:** Lines 207, 123
**Fix:** Change conditional to `<% if (generate.mutations && (exposeTrpc || exposeRepository)) { -%>`

## New Config Options (prompt.js)

```javascript
frontend: {
  apiBaseUrl: {
    enabled: getProjectConfig()?.frontend?.apiBaseUrl?.enabled ?? false,
  },
  sync: {
    wrapInUrlConstructor: getProjectConfig()?.frontend?.sync?.wrapInUrlConstructor ?? true,
    columnMapperIsFunction: getProjectConfig()?.frontend?.sync?.columnMapperIsFunction ?? true,
  },
}
```

## Implementation Steps

1. Fix Bug 1 - Schema import truthy check (line 22)
2. Fix Bug 2 - Auth function call (line 109)
3. Fix Bug 3 - Add API_BASE_URL import (after line 33)
4. Fix Bug 4 - URL constructor conditional (lines 95-100)
5. Skip Bug 5 - Already correct
6. Fix Bug 6 - columnMapper conditional (lines 117-119)
7. Fix Bug 7 - Hooks useLiveQuery pattern (lines 168-205)
8. Fix Bug 8 - Mutations expose check (lines 207, 123)
9. Add config flags to prompt.js

## Testing

- Run `bun codegen entity entities/opportunity.yaml`
- Verify TypeScript compilation succeeds
- Run baseline comparison: `bun test/run-test.ts compare`
