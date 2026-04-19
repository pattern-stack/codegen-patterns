# Scaffold Integration Tests

The suites under `test/scaffold/tests/` are end-to-end integration tests that
exercise a real, pre-generated consumer scaffold against a real Postgres
instance. They are **not** run by the default `bun test` and are instead
orchestrated by `test/scaffold/run-integration.ts`.

## Why they're gated

Each suite imports from `@gen/*` and `@shared/*` path aliases that resolve to
files produced by codegen (e.g. `modules/contacts/contact.repository.ts`,
`test/scaffold/shared/base-classes/*-entity-repository.ts`, event-bus Drizzle
backend). Those files only exist after running `bun codegen entity
test/scaffold/contact-scaffold.yaml`.

To prevent `bun test` from erroring on missing modules when no scaffold has
been generated, each file is gated by `SCAFFOLD_INTEGRATION=1` via
`./_skip-guard.ts`:

- When unset (default), every `describe` becomes `describe.skip` and all
  scaffold-dependent imports are short-circuited in `beforeAll`, so `bun test`
  simply reports these as skipped.
- When set, the suites run their real `beforeAll`, dynamic-import the
  generated modules, connect to Postgres, and run every test.

## Running locally

```bash
# Full orchestrated run: starts Docker Postgres, runs codegen, pushes schema,
# runs the suites with SCAFFOLD_INTEGRATION=1, tears down.
bun run test:integration

# Iterate after codegen + schema are already in place:
bun run test:integration:quick

# Manual invocation (Postgres + scaffold must already be generated):
SCAFFOLD_INTEGRATION=1 bun test test/scaffold/tests/
```

## Files

- `_skip-guard.ts` — exports `SHOULD_RUN_SCAFFOLD` and a gated `d = describe |
  describe.skip`. Every suite imports from here.
- `setup.ts` — Drizzle client lifecycle (pool, `truncateAll`, `closeDb`).
- `helpers.ts` — factories for test data.
- `*.test.ts` — the suites.
