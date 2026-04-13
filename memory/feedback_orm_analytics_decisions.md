---
name: ORM and Analytics Architecture Decisions
description: Drizzle stays as ORM, Atlas for migrations, port MetricFlow pattern for analytics — decided 2026-04-12
type: feedback
---

Stay with Drizzle ORM. Don't switch.

**Why:** Drizzle's composable `sql` template literals + `groupBy` + `$with` CTEs are the right foundation for the analytics layer. Prisma's aggregation API is closed/non-composable. Kysely has no schema-as-code. TypeORM is viable but no clear win over Drizzle.

**How to apply:** Generate Drizzle schemas from YAML. Use Drizzle for queries and type inference. Decouple migrations to Atlas.

---

Atlas replaces drizzle-kit for migrations. Fast-follow after EOD.

**Why:** Atlas does Alembic-style declarative diffing, has an official Drizzle integration via `drizzle-kit export`, generates rollback SQL, and has 50+ analyzers for destructive change detection. drizzle-kit lacks rollback and destructive change detection.

**How to apply:** Pipeline: YAML → codegen → Drizzle schema → `atlas migrate diff` → migration SQL. For now use drizzle-kit, swap to Atlas as first fast-follow.

---

Port MetricFlow definitions AND thin runtime to TypeScript, not a Python bridge.

**Why:** Bridge approach has the same subprocess friction as the agent stdio bridge (Track C is killing that pattern). The four metric types Doug uses (Simple, Derived, Ratio, Cumulative) each map to a bounded Drizzle query builder pattern. ~300-400 lines of TS runtime, not a MetricFlow replacement.

**How to apply:** Semantic definitions in `*.semantics.yaml` (SPEC-007). Runtime in `shared/base-classes/base-analytics-service.ts`. MetricQueryBuilder generates Drizzle queries from definitions. This is post-EOD work.
