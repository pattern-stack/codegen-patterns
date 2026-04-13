# A16: Atlas Migration Integration

**Status:** Draft
**Last Updated:** 2026-04-12
**Depends on:** A6 (core templates generate Drizzle schemas)
**References:** ORM research (2026-04-12), Drizzle stay decision

## Overview

Replace drizzle-kit push with Atlas (atlasgo.io) for database migrations. Atlas does Alembic-style declarative schema diffing with official Drizzle integration. Adds rollback support, destructive change detection (50+ analyzers), and CI-enforced migration linting that drizzle-kit lacks.

The codegen pipeline doesn't change — it still generates Drizzle schemas. Atlas sits between schemas and DB.

## Architecture

```
Entity YAML → codegen → Drizzle schema files (unchanged)
                              │
                              ▼  drizzle-kit export
                        Atlas schema source
                              │
                              ▼  atlas migrate diff
                        migrations/*.sql (with rollback)
                              │
                              ├── atlas migrate apply (dev/prod)
                              └── atlas migrate lint (CI)
```

## Configuration

### `atlas.hcl` (Dealbrain monorepo root)

```hcl
data "external_schema" "drizzle" {
  program = ["npx", "drizzle-kit", "export", "--config", "./packages/db/drizzle.config.ts"]
}

env "dev" {
  src = data.external_schema.drizzle.url
  dev = "docker://postgres/16/dev"
  migration { dir = "file://packages/db/migrations" }
}

env "prod" {
  src = data.external_schema.drizzle.url
  url = getenv("DATABASE_URL")
  migration { dir = "file://packages/db/migrations" }
}
```

## Workflow

```bash
# Generate migration after codegen produces new Drizzle schemas
atlas migrate diff add_contacts --env dev

# Apply locally
atlas migrate apply --env dev

# Apply to prod
DATABASE_URL="..." atlas migrate apply --env prod

# Rollback
atlas migrate down --env prod --amount 1

# Lint in CI
atlas migrate lint --env dev --git-base main
```

## CI Integration

```yaml
# .github/workflows/atlas-lint.yml
name: Atlas Migration Lint
on:
  pull_request:
    paths: ['packages/db/src/**', 'packages/db/migrations/**']
jobs:
  lint:
    runs-on: ubuntu-latest
    services:
      postgres: { image: 'postgres:16' }
    steps:
      - uses: ariga/setup-atlas
      - run: atlas migrate lint --env dev --git-base origin/main
```

## Comparison with drizzle-kit

| Capability | drizzle-kit push | Atlas |
|---|---|---|
| Versioned migration files | No | Yes |
| Rollback | No | Yes |
| Destructive change detection | Basic warning | 50+ analyzers, CI-enforced |
| Migration lint in CI | No | Yes (GitHub Action) |
| Shadow DB diffing | No | Yes |

## Package.json Scripts

```json
{
  "db:migrate:diff": "atlas migrate diff --env dev",
  "db:migrate:apply": "atlas migrate apply --env dev",
  "db:migrate:apply:prod": "atlas migrate apply --env prod",
  "db:migrate:lint": "atlas migrate lint --env dev --git-base main"
}
```

## Files (in Dealbrain monorepo, not codegen-patterns)

| File | Action | Purpose |
|------|--------|---------|
| `atlas.hcl` | create | Atlas project config |
| `packages/db/migrations/` | create dir | Migration SQL files |
| `.github/workflows/atlas-lint.yml` | create | CI lint workflow |
| `package.json` | modify | Add db:migrate:* scripts |

## Acceptance Criteria

- [ ] `atlas migrate diff` produces valid SQL from Drizzle schemas
- [ ] `atlas migrate apply` applies migrations to local Postgres
- [ ] `atlas migrate down` rolls back last migration
- [ ] Atlas detects DROP COLUMN as destructive and blocks without annotation
- [ ] CI workflow runs on PRs touching schema/migration files
- [ ] `atlas.sum` integrity file committed and validated
- [ ] drizzle-kit push removed from scripts
