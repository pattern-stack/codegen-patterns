---
name: EOD Milestone Status
description: Status of the EOD milestone (issues #1-#6) and integration test harness, as of 2026-04-12
type: project
---

## EOD Milestone — Completed 2026-04-12

PR #21 (`claude/eod-milestone-92a711`) covers issues #1-#6. All validated and passing 232 tests.

| Issue | Title | Status |
|-------|-------|--------|
| #1 | A1: YAML schema evolution | Done (v2 blocks: family, queries, sync, events, pipelines) |
| #2 | A5: prompt.js evolution | Done — consumes v2 fields, routes architecture target |
| #3 | A9: BaseRepository<T> | Done — 9 CRUD methods, soft-delete, timestamps |
| #4 | A10: BaseService + read use cases | Done — pass-through service + BaseFindByIdUseCase/BaseListUseCase |
| #5 | A6: Clean-Lite-PS core templates | Done — 11 Hygen EJS templates under templates/entity/new/clean-lite-ps/ |
| #6 | A15: NestJS scaffold | Done — test/scaffold/ with Docker Postgres + validate.sh |

## Integration Test Harness — Added 2026-04-12

31 tests against real Docker Postgres. Validates BaseRepository (all 9 methods) and full NestJS HTTP stack.

### How to run

```bash
bun test:integration              # Full: docker up → codegen → schema push → tests → teardown
bun test:integration:quick        # Quick: skip codegen + push, reuse existing Postgres state
```

**Prerequisites:** Docker running. That's it — the orchestrator handles everything else.

**Manual step-by-step** (if orchestrator breaks):
```bash
docker compose -f test/scaffold/docker-compose.yml up -d --wait
cat > codegen.config.yaml << 'EOF'
generate:
  cleanLitePs: true
EOF
bun codegen entity test/scaffold/contact-scaffold.yaml
cd test/scaffold && bun install && bun run drizzle-kit push --config drizzle.config.ts && cd ../..
bun test test/scaffold/tests/
docker compose -f test/scaffold/docker-compose.yml down -v
rm codegen.config.yaml
```

**Verify Postgres directly:**
```bash
psql postgresql://postgres:postgres@localhost:5432/scaffold_test -c '\dt'
```

### Fixes made during harness build
- Added `family: base` to schema enum (was missing the un-specialized base case)
- Created root `tsconfig.json` extending scaffold's — enables `@shared/*` and `@gen/*` alias resolution for generated code at `modules/`
- Added `@nestjs/common@10`, `@nestjs/core@10`, `reflect-metadata`, `rxjs` as root devDeps for generated file import resolution
- NestJS boot requires running from repo root: `NODE_PATH=$PWD/test/scaffold/node_modules bun run $PWD/test/scaffold/src/main.ts`

### Test files
| File | Tests | Validates |
|------|-------|-----------|
| `tests/repository.test.ts` | 22 | BaseRepository: create, findById, findByIds, list, count, exists, update, delete (soft), upsertMany |
| `tests/http.test.ts` | 9 | NestJS DI wiring, controller routing, full CRUD lifecycle via supertest |
| `tests/setup.ts` | — | DB lifecycle: connect, truncate, close |
| `tests/helpers.ts` | — | Contact factory, unique email generation |
| `run-integration.ts` | — | Orchestrator: Docker → codegen → push → test → teardown |

## Known gaps

- **FK nullable** — `processBelongsTo` doesn't cross-reference field `required` for nullable inference.
- **Baseline test infra** — `bun test/run-test.ts full` broken by stale bunx hygen cache (pre-existing).

## Next up (v0.1 milestone)

Unblocked by EOD completion:
- #7 A9+: Family repositories (blocked by #3 done, #6 done)
- #8 A10+: Family services + WithAnalytics (blocked by #4, #7)
- #9 A16: Atlas migrations (blocked by #5)
- #10 A17: Declarative query codegen (blocked by #2, #5)
- #11 A7: Wiring templates (blocked by #5)

**Why:** v0.1 adds entity family specialization and the remaining template types needed for a complete codegen run.

**How to apply:** Issues #7-#11 can proceed once PR #21 is merged. #7 and #9/#10/#11 are independent and can be parallelized.
