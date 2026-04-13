---
name: Next session bootstrap
description: Starting context for the next work session — what's done, what to do, key commands
type: project
---

## Where we are (as of 2026-04-12)

**Branch:** `claude/eod-milestone-92a711`
**PR:** pattern-stack/codegen-patterns#21 (open, mergeable, closes #2-#6)
**Uncommitted work:** Integration test harness (31 tests), `family: base` schema fix, root tsconfig, NestJS devDeps

## Immediate actions

1. **Commit the integration harness work** — new files in `test/scaffold/tests/`, `run-integration.ts`, root `tsconfig.json`, `package.json` changes, schema fix
2. **Push to PR #21** and merge it — everything downstream is blocked on this
3. **Pick v0.1 issues to start**

## v0.1 issues (all unblocked once PR #21 merges)

| Issue | Title | Parallelizable | Notes |
|-------|-------|---------------|-------|
| **#7** | A9+: Family repos (Crm, Activity, Knowledge, Metadata) | Yes | Highest value — extends BaseRepository with family-specific methods. Add integration tests per family. |
| **#8** | A10+: Family services + WithAnalytics | After #7 | Depends on family repos existing |
| **#9** | A16: Atlas migration integration | Yes | Independent — replaces drizzle-kit push with Atlas |
| **#10** | A17: Declarative query codegen | Yes | `queries:` YAML block → generated `findByX` methods |
| **#11** | A7: Wiring templates | Yes | Module inject, barrel exports — NestJS module auto-wiring |

**Recommended order:** #7 first (family repos extend the integration test pattern we just built), then #8 follows naturally. #9/#10/#11 can be done anytime in parallel.

## Key commands

```bash
# Smoke test
bun codegen entity test/fixtures/contact-v2.yaml

# Integration tests (31 tests, real Postgres)
bun test:integration              # Full: docker → codegen → push → test → teardown
bun test:integration:quick        # Skip codegen, reuse running Postgres

# Unit tests
bun test scanner/orm-detector.test.ts   # Individual scanner test

# Verify DB manually
psql postgresql://postgres:postgres@localhost:5432/scaffold_test -c '\dt'
```

## Architecture context

- `test/scaffold/` — NestJS app skeleton with Docker Postgres, BaseRepository/BaseService, hand-written write use cases
- Generated code lands at `modules/contacts/` via `@gen/*` path alias
- Root `tsconfig.json` extends scaffold's for Bun module resolution
- `contact-scaffold.yaml` uses `family: base` (simplest tier, no specialization)
- `contact-v2.yaml` uses `family: crm-synced` (specialized, requires CrmEntityRepository — not yet implemented, that's #7)
