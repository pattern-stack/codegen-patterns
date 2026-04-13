---
name: Codegen testing requires actual generation
description: Unit tests alone are insufficient — must run actual hygen codegen and integration tests against real Postgres
type: feedback
---

Always test codegen changes by running actual generation, not just unit tests.

**Why:** During EOD milestone, all 232 unit tests passed but actual `bun codegen entity` revealed three bugs:
1. `.mjs` files importing `.ts` broke hygen (runs under Node.js, not Bun)
2. EJS `<%= %>` HTML-encoded single quotes in generated TypeScript (`&#39;` instead of `'`)
3. Duplicate FK fields — belongs_to loop and processedFields loop both emitted same columns

None of these were caught by unit tests. They only surfaced when running hygen end-to-end.

**How to apply:** After any template or prompt.js change:
1. Run `bun codegen entity test/fixtures/opportunity.yaml` (v1 regression check)
2. Run `bun codegen entity test/fixtures/contact-v2.yaml` (v2 generation check)
3. Read the generated files and verify no HTML entities, no duplicates, correct imports
4. Remember: `.mjs` files in `config/` are loaded by hygen under Node.js — they CANNOT import `.ts` files
5. EJS code output must use `<%- %>` (unescaped), not `<%= %>` (HTML-escaped), for any variable containing quotes
6. Run `bun test:integration` to validate generated code compiles, DI wires up, and CRUD works against real Postgres
7. For quick iteration (DB already running): `bun test:integration:quick`
