# SPEC-A15: Minimal NestJS Scaffold for End-to-End Codegen Validation

**Status:** Approved  
**Date:** 2026-04-12  
**Scope:** `test/scaffold/` directory only — no changes to codegen source or templates

---

## Purpose

Prove that codegen output from `contact-v2.yaml` compiles, migrates, and serves real HTTP traffic. This is a test harness, not a production application. It imports the generated `ContactsModule` directly, connects to a real Postgres instance, and verifies each CRUD endpoint responds correctly via `curl`.

The scaffold lives in `test/scaffold/` so it is clearly separated from the codegen source. It is never deployed; it exists only to catch regressions between template changes and compilable, runnable NestJS output.

---

## Files to Create

| File | Action |
|------|--------|
| `test/scaffold/src/main.ts` | create |
| `test/scaffold/src/app.module.ts` | create |
| `test/scaffold/src/database/database.module.ts` | create |
| `test/scaffold/drizzle.config.ts` | create |
| `test/scaffold/schema.ts` | create |
| `test/scaffold/docker-compose.yml` | create |
| `test/scaffold/validate.sh` | create |
| `test/scaffold/package.json` | create |
| `test/scaffold/tsconfig.json` | create |

The codegen output lives at `gen/contacts/` (one level above the scaffold, at the repo root). The scaffold imports from there.

---

## Directory Structure

```
test/scaffold/
  src/
    main.ts                  ← NestJS bootstrap, listens on port 3000
    app.module.ts            ← Imports DatabaseModule + ContactsModule
    database/
      database.module.ts     ← Global module, provides DRIZZLE token
  drizzle.config.ts          ← Points at test Postgres, imports schema.ts
  schema.ts                  ← Re-exports contacts table from gen/contacts/
  docker-compose.yml         ← postgres:16, port 5432, db scaffold_test
  validate.sh                ← Full integration loop (see below)
  package.json               ← Local deps: @nestjs/core, drizzle-orm, etc.
  tsconfig.json              ← Extends repo root, path alias for gen/

gen/contacts/                ← Codegen output (generated, not hand-written)
  contacts.module.ts
  contact.entity.ts
  contact.repository.ts
  ...
```

---

## Interface Definitions

### DatabaseModule

```typescript
// test/scaffold/src/database/database.module.ts
import { Module, Global } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../schema';

export const DRIZZLE = 'DRIZZLE' as const;
export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL ??
            'postgresql://postgres:postgres@localhost:5432/scaffold_test',
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
```

The `DRIZZLE` token string must match exactly what codegen emits in the generated repository. Check `test/baseline/packages/api/src/constants/tokens.ts` or the generated `contacts.module.ts` to confirm the token name — adjust here if they differ.

### AppModule

```typescript
// test/scaffold/src/app.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { ContactsModule } from '../../gen/contacts/contacts.module';

@Module({
  imports: [DatabaseModule, ContactsModule],
})
export class AppModule {}
```

### main.ts

```typescript
// test/scaffold/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
```

### schema.ts

```typescript
// test/scaffold/schema.ts
// Re-export the contacts Drizzle table so drizzle-kit and DatabaseModule
// can reference it. Adjust the import path after running codegen.
export { contacts } from '../gen/contacts/contact.entity';
```

### drizzle.config.ts

```typescript
// test/scaffold/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/scaffold_test',
  },
});
```

### docker-compose.yml

```yaml
# test/scaffold/docker-compose.yml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: scaffold_test
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 5s
      retries: 10
```

---

## validate.sh — The Integration Loop

```bash
#!/usr/bin/env bash
# test/scaffold/validate.sh
# Exit immediately on any failure.
set -euo pipefail

SCAFFOLD_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCAFFOLD_DIR/../.." && pwd)"

echo "==> Starting Postgres"
docker compose -f "$SCAFFOLD_DIR/docker-compose.yml" up -d --wait

echo "==> Running codegen for contact-v2"
cd "$REPO_ROOT"
bun codegen entity test/fixtures/contact-v2.yaml

echo "==> Running drizzle-kit push"
cd "$SCAFFOLD_DIR"
bun drizzle-kit push

echo "==> Starting NestJS app in background"
bun run start &
APP_PID=$!
# Wait until port 3000 accepts connections (max 15s)
for i in $(seq 1 15); do
  if curl -sf http://localhost:3000/contacts > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> POST /contacts (create)"
CREATE_RESPONSE=$(curl -sf -X POST http://localhost:3000/contacts \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com"}')
echo "$CREATE_RESPONSE"
CONTACT_ID=$(echo "$CREATE_RESPONSE" | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log(d.id)")

echo "==> GET /contacts"
curl -sf http://localhost:3000/contacts | bun -e "
  const d = JSON.parse(await Bun.stdin.text());
  if (!Array.isArray(d) || d.length === 0) { console.error('Expected non-empty array'); process.exit(1); }
  console.log('list ok, count=' + d.length);
"

echo "==> GET /contacts/:id"
curl -sf "http://localhost:3000/contacts/$CONTACT_ID" | bun -e "
  const d = JSON.parse(await Bun.stdin.text());
  if (d.id !== '$CONTACT_ID') { console.error('ID mismatch'); process.exit(1); }
  console.log('get-by-id ok');
"

echo "==> PUT /contacts/:id (update)"
curl -sf -X PUT "http://localhost:3000/contacts/$CONTACT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Mathematician"}' | bun -e "
  const d = JSON.parse(await Bun.stdin.text());
  if (d.title !== 'Mathematician') { console.error('Update failed'); process.exit(1); }
  console.log('update ok');
"

echo "==> DELETE /contacts/:id"
curl -sf -X DELETE "http://localhost:3000/contacts/$CONTACT_ID" | bun -e "
  const d = JSON.parse(await Bun.stdin.text());
  if (d.id !== '$CONTACT_ID') { console.error('Delete response missing id'); process.exit(1); }
  console.log('delete ok');
"

echo "==> Teardown"
kill $APP_PID 2>/dev/null || true
docker compose -f "$SCAFFOLD_DIR/docker-compose.yml" down -v

echo "==> All checks passed"
exit 0
```

Make this executable: `chmod +x test/scaffold/validate.sh`

---

## package.json

```json
{
  "name": "scaffold",
  "private": true,
  "scripts": {
    "start": "ts-node -r tsconfig-paths/register src/main.ts",
    "drizzle-kit": "drizzle-kit"
  },
  "dependencies": {
    "@nestjs/common": "^10.0.0",
    "@nestjs/core": "^10.0.0",
    "@nestjs/platform-express": "^10.0.0",
    "drizzle-orm": "^0.30.0",
    "pg": "^8.11.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.21.0",
    "ts-node": "^10.9.0",
    "tsconfig-paths": "^4.2.0"
  }
}
```

Note: Exact versions should match what is already used in the repo root `package.json` or workspace. Prefer `bun` as the runtime if the repo already uses it — replace `ts-node` with `bun run` in that case.

---

## tsconfig.json

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "baseUrl": ".",
    "paths": {
      "@gen/*": ["../../gen/*"]
    }
  },
  "include": ["src/**/*", "schema.ts", "drizzle.config.ts"]
}
```

---

## Implementation Steps

1. **Confirm codegen output shape for contact-v2.yaml.** Run `bun codegen entity test/fixtures/contact-v2.yaml` against the current codebase and inspect what files land in `gen/`. Identify the exact filename of the generated module (e.g., `contacts.module.ts`), the repository class, and the DRIZZLE token import path. The scaffold imports must match exactly.

2. **Create `test/scaffold/src/database/database.module.ts`.** Use the DRIZZLE token string that matches the generated repository's `@Inject(DRIZZLE)` decorator. If the generated repo imports `DRIZZLE` from `'../constants/tokens'`, define that same constant in DatabaseModule and export it, or adjust the generated import path via `codegen.config.yaml` `locations` settings.

3. **Create `test/scaffold/schema.ts`.** Import and re-export only the tables needed by the scaffold (just `contacts` for this spec). This file is what `drizzle.config.ts` and `DatabaseModule` reference.

4. **Create `test/scaffold/drizzle.config.ts`.** Standard drizzle-kit config pointing at `schema.ts` and the local Postgres.

5. **Create `test/scaffold/src/app.module.ts`.** Import `DatabaseModule` first so the global DRIZZLE provider is available to `ContactsModule`.

6. **Create `test/scaffold/src/main.ts`.** Standard NestJS bootstrap on port 3000. Enable `enableShutdownHooks()` so `kill` in validate.sh terminates cleanly.

7. **Create `test/scaffold/docker-compose.yml`.** Postgres 16, healthcheck required — validate.sh uses `--wait` and depends on the container being ready.

8. **Create `test/scaffold/validate.sh`.** Follow the script in the Interface Definitions section above. The ID extraction step must be adjusted if the Bun one-liner syntax is incompatible — use `jq` as a fallback if Bun inline eval is unavailable.

9. **Create `test/scaffold/package.json` and `test/scaffold/tsconfig.json`.** Match existing repo tooling choices.

10. **Smoke test manually.** From `test/scaffold/`, run `docker compose up -d --wait`, run codegen, run `bun drizzle-kit push`, run `bun run start`, and hit `curl http://localhost:3000/contacts`. Fix any import path issues before writing validate.sh.

---

## Known Constraints and Decisions

**DRIZZLE token mismatch:** The generated repository imports `DRIZZLE` from a constants file (`'../constants/tokens'` in current baseline). The scaffold's `DatabaseModule` must provide that same token. Two options:
- Option A (preferred): Configure `codegen.config.yaml` so the generated repository's constants import path resolves into the scaffold. Add a path alias in `tsconfig.json`.
- Option B: Copy the tokens constant into `test/scaffold/src/constants/tokens.ts` and accept that codegen still generates the import — then shim the path.

The implementer should confirm which approach avoids changing codegen source, and document the decision in a comment in `database.module.ts`.

**contact-v2.yaml behaviors:** `contact-v2.yaml` includes `external_id_tracking` behavior and `family: crm-synced`. If the codegen does not yet handle these (they may be v2-only schema additions), the scaffold test should use a stripped-down entity YAML that exercises only what codegen currently supports. Document this in a comment at the top of `validate.sh`.

**No auth, no guards:** The scaffold controller must be reachable without authentication. Verify the generated controller does not apply `@UseGuards(AuthGuard)` — that pattern appears in Electric SQL controllers, not plain REST. If guards are present, they must be disabled or overridden in the scaffold AppModule.

**Soft delete:** `contact-v2.yaml` has `soft_delete` behavior. The DELETE endpoint will soft-delete (set `deleted_at`) rather than hard-delete. The validate.sh assertion for DELETE should check that the response contains the contact's `id`, not that the record disappears from the list query (it won't, unless the list query filters deleted records, which it should by default).

---

## Testing Strategy

The scaffold itself is the test. No unit test files are required for this spec.

**validate.sh exit code 0** is the acceptance criterion. Run it as:
```bash
bash test/scaffold/validate.sh
```

The script must:
- Start Postgres via Docker
- Run codegen (idempotent — reruns are safe)
- Push schema with drizzle-kit (creates `contacts` table)
- Start the NestJS app
- Execute POST → GET (list) → GET (by ID) → PUT → DELETE in sequence
- Assert correct HTTP responses at each step
- Tear down Docker and kill the app process

Each curl call must use `-f` (fail on non-2xx) so any server error causes an immediate exit 1.

---

## Acceptance Criteria

- [ ] `bun codegen entity test/fixtures/contact-v2.yaml` completes without error
- [ ] `tsc --noEmit` passes inside `test/scaffold/` (no TypeScript errors)
- [ ] `bun drizzle-kit push` creates the `contacts` table in the Docker Postgres
- [ ] NestJS app starts on port 3000 without runtime errors
- [ ] `POST /contacts` returns a JSON object with an `id` field
- [ ] `GET /contacts` returns a JSON array containing the created contact
- [ ] `GET /contacts/:id` returns the contact by ID
- [ ] `PUT /contacts/:id` returns the updated contact with modified field
- [ ] `DELETE /contacts/:id` returns the deleted contact record
- [ ] `bash test/scaffold/validate.sh` exits 0 end-to-end
