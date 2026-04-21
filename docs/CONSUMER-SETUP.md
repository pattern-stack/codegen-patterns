# Consumer Setup

The contract a consumer project must satisfy for generated code to compile and run. If you just want to generate a first entity in this repo, read [GETTING-STARTED.md](./GETTING-STARTED.md) instead — this doc is for the second step: wiring `@pattern-stack/codegen` into a separate NestJS + Drizzle project you own.

A complete working example lives at [`codegen-pattern-demo-app/`](https://github.com/pattern-stack/codegen-pattern-demo-app) — every file referenced below has a real counterpart there.

## Who this is for

You are running `@pattern-stack/codegen` (installed as a sibling repo, workspace dep, or `npx @pattern-stack/codegen` binary — see [ADR-015](./adrs/ADR-015-cli-command-architecture.md)) against your own NestJS application. Generated code imports from `@shared/*` path aliases and injects a `DRIZZLE` token. This doc tells you what those import paths and tokens must resolve to.

## Prerequisites

- **Bun** 1.0+ or **Node** 20+
- **NestJS** 10+
- **Drizzle ORM** (currently `drizzle-orm@^0.30`; see [Troubleshooting](#troubleshooting) for the 0.45 caveat)
- **TypeScript** 5+ with `"strict": true` and decorator metadata enabled
- A running Postgres you can point at with a `DATABASE_URL`

## Project structure expected

Minimum layout the generator writes into and reads from:

```
<project-root>/
├── codegen.config.yaml            # generator config
├── tsconfig.json                  # must declare @shared/* and @modules/*
├── schema.ts                      # one-line re-export of generated schema barrel
├── drizzle.config.ts              # Drizzle Kit config (migrations)
├── entities/                      # your YAML entity definitions (input)
│   └── account.yaml
├── modules/                       # clean-lite-ps output lands here
│   └── accounts/
├── shared/                        # thin re-export shims (authored once)
│   ├── base-classes/
│   ├── constants/tokens.ts
│   ├── database/database.module.ts
│   └── types/drizzle.ts
└── src/
    ├── app.module.ts              # you author; wires DatabaseModule + GENERATED_MODULES
    ├── main.ts
    └── generated/                 # codegen owns this tree — don't edit
        ├── modules.ts             # GENERATED_MODULES barrel
        └── schema.ts              # Drizzle schema barrel
```

Only three paths are codegen-owned: `src/generated/*`, the per-entity `modules/<plural>/` tree (clean-lite-ps), and whatever lands under `backend_src/` (full clean). Everything else is yours.

## tsconfig path aliases

Generated code imports from `@shared/*` and `@modules/*`. Your `tsconfig.json` must declare both:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["./shared/*"],
      "@modules/*": ["./modules/*"]
    }
  },
  "include": [
    "src/**/*",
    "shared/**/*",
    "modules/**/*",
    "schema.ts",
    "drizzle.config.ts"
  ]
}
```

`@generated/*` is not currently a required alias — generated code imports from its own tree via relative paths. If you plan to reference the barrels from application code (e.g. `@generated/modules`), add `"@generated/*": ["./src/generated/*"]`.

## `DatabaseModule` contract

Every generated repository expects the `DRIZZLE` injection token to resolve to a Drizzle client. A `@Global()` `DatabaseModule` is the standard way to satisfy that. Minimum viable scaffold — author this once:

```ts
// shared/database/database.module.ts
import { Module, Global } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../schema';
import { DRIZZLE } from '../constants/tokens';

export { DRIZZLE };
export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * DatabaseModule — provides the DRIZZLE injection token globally.
 * Import once in AppModule, before any generated module.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
```

Requirements the generator relies on:

1. **`@Global()`** — generated repositories don't import `DatabaseModule` themselves; they inject `DRIZZLE` directly. Only a global provider satisfies that.
2. **Provides `DRIZZLE`** — must use the exact token re-exported from `@shared/constants/tokens`.
3. **Exports `DRIZZLE`** — so other modules can consume it.
4. **Client constructed with full schema** — `drizzle(pool, { schema })` where `schema` is `export * from './generated/schema'`. Passing the schema object enables typed relational queries.

## `DRIZZLE` injection token

Generated repositories do this:

```ts
constructor(@Inject(DRIZZLE) db: DrizzleClient) { super(db); }
```

`DRIZZLE` resolves to `@shared/constants/tokens`, which is a vendored copy of `codegen-patterns/runtime/constants/tokens`. The value is the string literal `'DRIZZLE'`. Do not declare a fresh token in your project — it must be the same identity as the runtime's, or `useFactory` will bind to one symbol and `@Inject()` will look for another.

## `src/shared/` vendored runtime files

Generated code imports from stable `@shared/*` paths. Those paths have to resolve to something — the "something" is a **vendored copy** of the relevant runtime files in your `src/shared/` tree. `codegen project init` writes these files for you on first run.

**Why vendor instead of re-export.** The naive approach is a one-line re-export from `codegen-patterns/runtime/...`. TypeScript treats identical types coming from different `node_modules` trees as distinct — two `PgTable<...>` values fail to unify even at identical `drizzle-orm` versions (the private `shouldInlineParams` field is the giveaway). A re-export shim compiles the consumer's generated code against two separate drizzle type graphs (its own and the runtime's), producing 20+ "Types have separate declarations of a private property 'shouldInlineParams'" errors. Vendoring bakes the runtime files into the consumer's own module graph, so only one drizzle-orm identity exists. See [ADR-017](./adrs/ADR-017-barrel-files-over-injects.md) for the broader "stable surface over inject" philosophy these vendored files extend.

`codegen project init` writes the following files. You do not need to hand-author them — this list exists so you know what's generated and can spot-check the output.

### Base classes + transitive deps

```
src/shared/base-classes/base-repository.ts
src/shared/base-classes/base-service.ts
src/shared/base-classes/synced-entity-repository.ts
src/shared/base-classes/synced-entity-service.ts
src/shared/base-classes/activity-entity-repository.ts
src/shared/base-classes/activity-entity-service.ts
src/shared/base-classes/metadata-entity-repository.ts
src/shared/base-classes/metadata-entity-service.ts
src/shared/base-classes/knowledge-entity-repository.ts
src/shared/base-classes/knowledge-entity-service.ts
src/shared/base-classes/with-analytics.ts
src/shared/base-classes/lifecycle-events.ts       # transitive dep of base-service
src/shared/base-classes/base-read-use-cases.ts
```

### Types + constants

```
src/shared/types/drizzle.ts
src/shared/constants/tokens.ts
```

### Event bus protocol

```
src/shared/subsystems/events/event-bus.protocol.ts  # transitive dep of base-service + lifecycle-events
```

### Runtime validation pipe

```
src/shared/pipes/zod-validation.pipe.ts             # @Body() validation for generated write routes
```

Generated controllers wrap their `@Body()` params with `new ZodValidationPipe(CreateXSchema)` — the pipe runs the DTO's Zod schema at request time, throws `BadRequestException` on failure, returns parsed data on success. No consumer wiring required.

### EAV helpers

```
src/shared/eav-helpers.ts                           # toEavRows + mergeEavRows for eav_value_table services
```

Pure helpers used by services generated for entities declaring `eav_value_table: true`. Caller supplies the field-definition id/key maps; helpers are sync + allocation-light.

**Keeping vendored files in sync with the runtime.** Re-running `codegen project init --force` will overwrite them with the current runtime contents. If you upgrade `@pattern-stack/codegen`, re-run init to pull the matching base classes. Treat the vendored files as generated output — don't hand-edit them; if you need to override behavior, subclass them in your own module instead.

## `schema.ts` wiring

Drizzle Kit and the `DatabaseModule` both need a single entry point for the schema. That entry point is a one-line re-export of the generated barrel:

```ts
// schema.ts
export * from './src/generated/schema';
```

The generator writes `src/generated/schema.ts` on every run — do not edit it, do not include additional tables there. If you have hand-authored tables outside the codegen entity set, `schema.ts` can combine both:

```ts
export * from './src/generated/schema';
export * from './shared/database/auth-tables'; // hand-authored
```

## Atlas migration workflow

Your schema lives in `schema.ts` (re-exporting `src/generated/schema.ts`). To promote schema changes into your database, use [Atlas](https://atlasgo.io/) — it inspects the Drizzle schema, diffs it against the database, and emits **versioned, reviewable** SQL migrations that you commit alongside the code change.

**Why Atlas, not `drizzle-kit push`.** `drizzle-kit push` is a dev-loop convenience — it applies schema changes directly, produces no migration file, leaves no reviewable artifact, and silently runs destructive operations. That is acceptable for throwaway iteration; it is **not** acceptable for shared databases, CI, or production. Atlas gives you:

- A `migrations/` directory of timestamped SQL files you review in PRs.
- Destructive-change detection (50+ analyzers for drops, data-loss renames, etc.).
- A forward-and-rollback workflow; migrations apply or fail atomically.
- CI-friendly `atlas migrate lint` that fails the build on risky diffs.

### Prerequisites

- **Atlas CLI** `>= 0.24.0` — install once per workstation / CI image:
  ```bash
  # macOS (Homebrew)
  brew install ariga/tap/atlas

  # Linux / CI / anywhere with curl
  curl -sSf https://atlasgo.sh | sh
  ```
  Verify with `atlas version`.
- A reachable `DATABASE_URL` (local Postgres is fine; the generated SQL is database-agnostic for the columns codegen emits).
- `drizzle-kit` already installed as a dev dependency — Atlas shells out to `drizzle-kit` to introspect your schema (no additional Drizzle plugin required).
- An `atlas.hcl` file at your project root (next to `drizzle.config.ts`).

### Example `atlas.hcl`

Drop this at the project root and commit it. Atlas reads the schema by running `drizzle-kit`'s external-schema introspection — no duplication of your Drizzle wiring.

```hcl
data "external_schema" "drizzle" {
  program = [
    "bunx",
    "drizzle-kit",
    "introspect:pg",
    "--config=drizzle.config.ts",
  ]
}
env "local" {
  src = data.external_schema.drizzle.url
  url = getenv("DATABASE_URL")
  migration {
    dir = "file://migrations"
  }
}
```

Swap `bunx` for `npx` if your project uses npm/pnpm. Add more `env "…"` blocks (e.g. `env "ci"`, `env "prod"`) as you grow — they all share the same `data "external_schema"` source.

### Workflow

1. **Author or update your Drizzle schema** (either by editing entity YAML and regenerating, or by authoring a hand-written table outside the codegen tree).
2. **Diff against the database** to produce a migration file:
   ```bash
   atlas migrate diff --env local --name add_account_flag
   ```
   This writes `migrations/<timestamp>_add_account_flag.sql` — one forward-only SQL file per change. The `--name` is a short human label; pick something a reviewer can grep for.
3. **Review the generated SQL.** Atlas is conservative but not omniscient — it cannot distinguish a column rename from a drop-and-add, so destructive changes always need a human look. Edit the file by hand if you need to preserve data (e.g. add a `UPDATE ... SET ...` before a `DROP COLUMN`).
4. **Apply the migration** against your target environment:
   ```bash
   atlas migrate apply --env local
   ```
   Atlas records every applied migration in an `atlas_schema_revisions` table so re-runs are no-ops. Failures roll back atomically.
5. **Commit the migration file** alongside the schema / YAML change in the same PR. The `migrations/` directory is part of your source tree; reviewers should see schema change and SQL change together.

In CI, add `atlas migrate lint --env local --latest=1` before merge to catch destructive diffs before they ship. In production, `atlas migrate apply --env prod` runs the same file set, ensuring dev and prod converge on identical schema.

## Events subsystem

The events subsystem (ADR-024) ships a transactional outbox, the `IEventBus`
protocol, Drizzle + Memory backends, and the generated `TypedEventBus` facade.
It is scaffolded into your project by the `subsystem install` command.

### Install

```bash
codegen subsystem install events
# or: bun /path/to/codegen-patterns/src/cli/index.ts subsystem install events
```

This copies the runtime files into `<paths.subsystems>/events/` (defaulting to
`shared/subsystems/events/`) and additionally:

- Injects an `events:` block into `codegen.config.yaml`:
  ```yaml
  events:
    backend: drizzle
    multi_tenant: false
    # pools: []  # optional: restrict this process's drain loop to specific lanes
  ```
- Writes `domain-events.schema.ts` via a Hygen template (the runtime file is
  skipped by `copyRuntime`). This template owns the scaffold-time `tenant_id`
  conditional — the column is emitted only when `events.multi_tenant: true`.
- Creates `<paths.subsystems>/events/generated/.gitkeep` so the directory
  exists in source control before `just gen-all` runs for the first time.

Switch the backend with `--backend memory` (useful in tests); the default is
`drizzle`. Only `drizzle | memory` are offered by the scaffold — the runtime
still includes a `RedisEventBus`, but Redis is not a scaffolded default in
Phase 1.

### Authoring events

Author one YAML file per event under `events/` at the repo root (sibling to
`entities/`):

```yaml
# events/contact_created.yaml
type: contact_created
direction: change
aggregate: contact
version: 1
payload:
  contact_id: { type: uuid }
  account_id: { type: uuid, nullable: true }
  created_by: { type: uuid }
```

See ADR-024 and `.claude/skills/events/event-codegen.md` for the full YAML
shape (directions, `source` / `destination`, pool overrides, entity `emits:`
integration). Regenerate the typed artifacts with:

```bash
just gen-all
```

This produces five files under `<paths.subsystems>/events/generated/`:
`types.ts` (the `AppDomainEvent` discriminated union), `schemas.ts` (Zod
payload schemas), `registry.ts` (the runtime metadata map), `bus.ts` (the
`TypedEventBus` facade), and `index.ts`.

### Register `EventsModule` in `AppModule`

```ts
import { EventsModule } from '@shared/subsystems/events/events.module';

@Module({
  imports: [
    DatabaseModule,
    EventsModule.forRoot({ backend: 'drizzle' }),
    // ... other subsystems, GENERATED_MODULES, etc.
  ],
})
export class AppModule {}
```

`EventsModule` is `global: true`, so entity modules do not need to import it
individually. Options:

- `backend: 'drizzle' | 'memory' | 'redis'` — matches `events.backend` in your
  config for the default install; tests typically override to `'memory'`.
- `multiTenant: true` — opt-in multi-tenancy (see below).
- `pools: ['events_change']` — restrict this process's drain loop to specific
  lanes. Typical split is one process per `events_inbound` / `events_change`
  / `events_outbound` so a slow outbound handler cannot stall change-event
  propagation. Undefined drains all pools.

### `TypedEventBus` vs. raw `EVENT_BUS`

Prefer injecting `TypedEventBus` in use cases — its `publish<T>()` overload
enforces the typed payload shape from the generated registry and stamps
`metadata.pool` / `metadata.direction` / `metadata.version` from the same
source.

```ts
import { TypedEventBus, TYPED_EVENT_BUS } from '@shared/subsystems/events';

constructor(
  @Inject(TYPED_EVENT_BUS) private readonly events: TypedEventBus,
  // ...
) {}

async execute(input: CreateContactInput): Promise<Contact> {
  return this.db.transaction(async (tx) => {
    const contact = await this.contacts.create(input, tx);
    await this.events.publish('contact_created', contact.id, {
      contactId: contact.id,
      accountId: contact.accountId,
      createdBy: input.actorId,
    }, { tx });
    return contact;
  });
}
```

The raw `EVENT_BUS` token (`IEventBus`) is still exported for use cases that
predate the typed facade or that need to publish types not in the registry
(e.g. a forwarder that proxies events from an external source). New code
should prefer `TypedEventBus`.

### Multi-tenancy opt-in

Flip `events.multi_tenant: true` in `codegen.config.yaml`, then re-run
`subsystem install events --force` to re-emit the schema with a `tenant_id`
column, and cut an Atlas migration (see [Atlas migration workflow](#atlas-migration-workflow)).
Also pass `multiTenant: true` to `EventsModule.forRoot(...)` so
`TypedEventBus.publish` enforces the column at publish time:

```ts
EventsModule.forRoot({ backend: 'drizzle', multiTenant: true });
```

When `multiTenant: true` and `opts.metadata.tenantId` is missing from a
`publish` call, the facade throws `MissingTenantIdError` naming the event
type. Explicit `null` is permitted for tenant-less background events.

The columns that land on `domain_events` (reviewed in the Atlas diff) are
`pool`, `direction`, and — when `multi_tenant: true` — `tenant_id`, plus the
supporting indexes. No runtime toggle exists for enabling tenancy after
initial install; always pair the config flip with a scaffold re-run and an
Atlas migration.

### Entity `emits:` integration

Entities can opt into typed auto-emission by declaring `emits: [...]` in
their YAML. Generated use cases then call `TypedEventBus.publish(type, ...)`
inside the domain transaction. See ADR-024 and the events skill
(`.claude/skills/events/event-codegen.md`) for the shape and constraints.

## Auth subsystem

The auth subsystem (ADR-031) ships `IAuthStrategy`, the abstract
`OAuth2RefreshStrategy` template-method base, `withAuthRetry`, token-at-rest
encryption (`IEncryptionKey` / `EnvEncryptionKey`), and an OAuth state-store
port. It is a runtime-only library — there is no `subsystem install auth`
command; consumers import the runtime directly and wire it into their
NestJS `AppModule`.

### Install

No scaffold. Import the module in `AppModule`:

```ts
import { AuthModule } from '@pattern-stack/codegen/runtime/subsystems/auth';

@Module({
  imports: [
    DatabaseModule,
    AuthModule.forRoot({
      encryptionKey: 'env',        // or: { useClass: MyKmsEncryptionKey }
      oauthStateStore: 'in-memory', // or: { useClass: RedisOAuthStateStore }
    }),
    // ... other subsystems + GENERATED_MODULES
  ],
})
export class AppModule {}
```

`AuthModule` is `global: true`. It provides `ENCRYPTION_KEY` and
`OAUTH_STATE_STORE` tokens. Defaults: `EnvEncryptionKey` (reads
`TOKEN_ENCRYPTION_KEY` from env) and `InMemoryOAuthStateStore`.

### Env vars

- `TOKEN_ENCRYPTION_KEY` — 32-byte base64 string. Required when
  `encryptionKey: 'env'`. Generate with `openssl rand -base64 32`.

### Environment setup

The `InMemoryOAuthStateStore` is dev-only (single-process). Production
deployments ship a Redis-backed implementation as a custom provider:

```ts
AuthModule.forRoot({
  oauthStateStore: { useClass: RedisOAuthStateStore },
});
```

Same for `EnvEncryptionKey` — production wants a KMS-backed impl
(`{ useClass: KmsEncryptionKey }`). The subsystem ships the env-backed
default for local dev + CI.

### Implement a provider strategy

Auth strategies are per-provider (Salesforce, HubSpot, Gmail, …) and live
in the integration module, not the subsystem. Each extends
`OAuth2RefreshStrategy` and overrides four hooks:

```ts
import {
  OAuth2RefreshStrategy,
  type ParsedRefreshResponse,
  type DecryptedIntegration,
  type AuthCredentials,
} from '@pattern-stack/codegen/runtime/subsystems/auth';

export class SalesforceAuthStrategy extends OAuth2RefreshStrategy {
  protected readonly provider = 'salesforce-crm';
  protected readonly defaultExpiresInSec = 7200;

  protected tokenEndpoint(): string {
    return `https://${this.config.authDomain}/services/oauth2/token`;
  }

  protected refreshBodyExtras(): Record<string, string> {
    return {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    };
  }

  protected parseRefreshResponse(raw: unknown): ParsedRefreshResponse {
    const r = raw as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresInSec: r.expires_in,
    };
  }

  protected buildCredentials(
    accessToken: string,
    integration: DecryptedIntegration,
    refreshRaw?: unknown,
  ): AuthCredentials {
    const raw = refreshRaw as { instance_url?: string } | undefined;
    return {
      accessToken,
      instanceUrl:
        raw?.instance_url ??
        (integration.providerMetadata?.['instanceUrl'] as string),
      apiVersion: this.config.apiVersion,
    };
  }
}
```

Register the strategy under a provider-specific token in your integration
module (there is no central `AUTH_STRATEGY` token):

```ts
export const SALESFORCE_AUTH_STRATEGY = Symbol('SALESFORCE_AUTH_STRATEGY');

@Module({
  providers: [
    {
      provide: SALESFORCE_AUTH_STRATEGY,
      useFactory: (reader, writer) =>
        new SalesforceAuthStrategy({
          integrationReader: reader,
          tokenWriter: writer,
          // ... provider config
        }),
      inject: [AUTH_INTEGRATION_READER, AUTH_INTEGRATION_TOKEN_WRITER],
    },
  ],
  exports: [SALESFORCE_AUTH_STRATEGY],
})
export class SalesforceAuthModule {}
```

### Integration-store ports — app-supplied

`OAuth2RefreshStrategy` depends on two narrow ports that read/write
integration rows. Consumers supply these as thin adapters over whatever
service owns the `integrations` entity:

```ts
@Injectable()
export class IntegrationStoreAdapter
  implements IIntegrationReader, IIntegrationTokenWriter
{
  constructor(
    private readonly service: IntegrationService,
    private readonly refreshUseCase: RefreshIntegrationUseCase,
  ) {}

  findByIdDecrypted(id: string) {
    return this.service.findByIdDecrypted(id);
  }

  persistRefresh(update: IntegrationTokenUpdate) {
    return this.refreshUseCase.execute(update);
  }
}

@Module({
  providers: [
    IntegrationStoreAdapter,
    { provide: AUTH_INTEGRATION_READER, useExisting: IntegrationStoreAdapter },
    { provide: AUTH_INTEGRATION_TOKEN_WRITER, useExisting: IntegrationStoreAdapter },
  ],
  exports: [AUTH_INTEGRATION_READER, AUTH_INTEGRATION_TOKEN_WRITER],
})
export class IntegrationStoreModule {}
```

A future `examples/auth-integrations/integration.yaml` starter will ship a
canonical `integration` entity whose generated service + use case satisfy
these ports out of the box — tracked alongside the sync subsystem roadmap.

### Retry-once on session-expired

`withAuthRetry` wraps an op with resolve → run → force-refresh-on-session-
expired → retry once → propagate. Provider error classes participate by
extending `SessionExpiredError` OR by setting
`isSessionExpired === true` on their instances (duck-typed marker):

```ts
import { withAuthRetry } from '@pattern-stack/codegen/runtime/subsystems/auth';

const result = await withAuthRetry(salesforceAuth, integrationId, (creds) =>
  salesforceClient.listOpportunities(creds),
);
```

A custom classifier is supported via the options third argument when the
marker isn't practical.

## `app.module.ts` wiring

`AppModule` imports the `DatabaseModule` first, then spreads the generated module barrel:

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/database/database.module';
import { GENERATED_MODULES } from './generated/modules';

@Module({
  imports: [DatabaseModule, ...GENERATED_MODULES],
})
export class AppModule {}
```

`DatabaseModule` must come before `GENERATED_MODULES` so the `DRIZZLE` provider exists when generated modules instantiate. Any non-codegen modules you author (`AuthModule`, `HealthModule`) go in the same `imports:` array — the barrel is additive, not exclusive. See [ADR-017](./adrs/ADR-017-barrel-files-over-injects.md) for why codegen writes a barrel instead of mutating this file.

## `codegen.config.yaml`

Minimum viable config for a backend-only clean-lite-ps project:

```yaml
# codegen.config.yaml

paths:
  backend_src: src                  # clean-lite-ps writes to <backend_src>/modules/<plural>/
  entities_dir: entities
  events_dir: events                # top-level events/*.yaml source for event codegen
  generated: src/generated          # ADR-017 barrels land here

generate:
  architecture: clean-lite-ps       # clean | clean-lite-ps
  frontend: false                   # emit Electric-SQL frontend pipeline?
  commands: true
  queries: true

naming:
  fileCase: kebab-case              # kebab-case | PascalCase | camelCase | snake_case
  suffixStyle: dotted               # dotted (.entity.ts) | suffixed (Entity.ts)
  terminology:
    command: use-case
    query: use-case

database:
  dialect: postgres
```

`paths.generated` must sit inside your `tsconfig.json` `"include"` globs — otherwise TS won't typecheck the barrel.

## EAV dual-write — opt-in per entity

Two YAML flags light up the EAV (entity-attribute-value) surface. Both default to `false` — entities that don't declare them get the non-EAV shape unchanged.

### `eav: true` on owning entities

Declare this on the entity that has a dynamic `fields` bag alongside its core columns (e.g. `opportunity`, `account`, `contact`).

```yaml
# entities/opportunity.yaml
entity:
  name: opportunity
  family: synced
eav: true
fields:
  name:
    type: string
    required: true
  # ... core columns
```

Codegen emits:

- `Create<Entity>UseCase` / `Update<Entity>UseCase` in transactional compound-write shape — splits `{ fields, ...core }` from the DTO and runs both halves in `db.transaction(async (tx) => ...)`.
- `Find<Entity>ByIdWithFieldsUseCase` / `List<Entity>sWithFieldsUseCase` — paired reads that merge the EAV `fields` bag onto the entity.
- `GET /<entity>/:id/with-fields` + `GET /<entity>/with-fields` routes on the controller.
- `findByIdWithFields` + `listWithFields` methods on the service.
- Module imports of the paired value-table module so DI resolves.

### `eav_value_table: true` on the value-table entity

Declare this on the entity that IS the value table (e.g. `field_value`). Paired with `eav_definition_table: <singular-entity-name>` pointing at the field-definitions entity.

```yaml
# entities/field_value.yaml
entity:
  name: field_value
  family: metadata
eav_value_table: true
eav_definition_table: field_definition
fields:
  entity_type:
    type: string
    required: true
  entity_id:
    type: uuid
    required: true
  field_definition_id:
    type: uuid
    required: true
  user_id:
    type: uuid
    required: true
  value:
    type: json
    required: true
```

Codegen emits:

- `upsertCurrentValues(rows, tx?)` on the repository — composite `(entity_type, entity_id, field_definition_id)` conflict target, so repeated upserts update a row in place rather than appending.
- `upsertFieldsTransactional(entityType, entityId, userId, fields, tx?)` on the service — resolves field keys to definition ids internally (via the injected definition repo) and delegates to the repo's upsert.
- `findMergedByEntity(entityType, entityId)` on the service — reads value rows + definitions in parallel, collapses via `mergeEavRows` into a flat `{ key: value }` bag.
- Auto-imports the paired field-definitions module so DI resolves.

**v1 assumption:** `eav_value_table: true` expects a NOT-NULL `user_id` column on the value table. A future `eav_user_scoped: false` flag will relax this for audit/system EAV with no user context.

### What the consumer has to author for EAV

Nothing beyond the YAML flags. Every consumer contract item — tx-aware base classes, the EAV helpers, the composite conflict-target upsert — ships via `codegen project init` (the vendored runtime files above) or via the generated templates.

The one thing consumers do own: creating `field_definition` rows before they reference them. `upsertFieldsTransactional` silently skips keys with no definition; auto-create is a later step.

## Verification

After authoring the shims, `DatabaseModule`, `schema.ts`, `app.module.ts`, and `codegen.config.yaml`:

```bash
# Regenerate the full entity set
bun /path/to/codegen-patterns/src/cli/index.ts entity new --all
# (or `just gen-all` / `npx @pattern-stack/codegen entity new --all` depending on install form)

# Typecheck — zero errors expected
bun run typecheck
# or: bunx tsc --noEmit
```

If typecheck is clean, the contract is satisfied. If there are errors, they'll almost always trace to one of the causes below.

## Troubleshooting

### `Cannot find module '@shared/constants/tokens'` (or any `@shared/*` path)

The `@shared/*` alias is missing from `tsconfig.json` `compilerOptions.paths`, or the shim file at the aliased location doesn't exist. Re-check the [shims list](#shared-re-export-shims) and the [path aliases block](#tsconfig-path-aliases).

### `Nest can't resolve dependencies of the <X>Repository (?)`

The `DRIZZLE` token isn't being provided. Either `DatabaseModule` isn't imported in `AppModule`, isn't `@Global()`, or you've declared a second `DRIZZLE` constant locally that shadows the runtime one. The token must be re-exported from `@shared/constants/tokens` (see above), not redefined.

### `AUTO-GENERATED` barrels never appear in `src/generated/`

You're likely using the legacy CLI (`bun src/cli.ts entity entities/foo.yaml`), which doesn't regenerate barrels. Use the noun-verb CLI: `codegen entity new --all` (or `src/cli/index.ts entity new --all`). See `DOGFOOD-LOG.md` entry about "Barrels are only regenerated by the noun-verb CLI".

### `Cannot find module 'config/paths.mjs'` when invoking the CLI

Stale import in `templates/entity/new/prompt.js`; fixed upstream. Update your `codegen-patterns` checkout to a recent commit.

### `Error: I can't find action 'new' for generator 'entity'`

The CLI can't locate its templates dir. Default path resolves relative to the CLI's own file — if you're invoking from outside the `codegen-patterns` repo, set:

```bash
export CODEGEN_TEMPLATES_DIR=/path/to/codegen-patterns/templates
```

### Type errors referencing `shouldInlineParams` or `PgColumn`

Two incompatible `drizzle-orm` versions in the resolved module graph. The generator's runtime base classes must typecheck against the same `drizzle-orm` version your generated entities do. Options:

1. Pin `drizzle-orm` to one version across consumer + runtime (workspace dedupe, or matching versions in two sibling repos).
2. Use `drizzle-orm@^0.30.x` for now — the runtime base classes aren't yet on the 0.45 API (tracked in `DOGFOOD-LOG.md`).

### `Types have separate declarations of a private property 'shouldInlineParams'`

You have two copies of drizzle-orm installed — one in your project and one in codegen-patterns. This happens when `shared/base-classes/*.ts` re-exports from `../../codegen-patterns/runtime/` via relative paths instead of containing vendored copies.

Fix: copy the runtime files into your project rather than re-exporting. Use `codegen init` to set up vendored copies, or copy `runtime/base-classes/` into `shared/base-classes/` manually. Each file should contain the actual code, not a `export * from '../../../codegen-patterns/runtime/...'` re-export.

### HTML-escaped entities in generated TypeScript (`&#39;` instead of `'`)

EJS template escape bug, fixed upstream. Pull the latest `codegen-patterns` and regenerate.

### Generator emits files outside `paths.generated`

It shouldn't — that's a bug. File an issue. The only files codegen writes are (a) per-entity module trees under your configured architecture and (b) the two barrels under `paths.generated`. If `app.module.ts` or a hand-authored file changed, something is wrong.

## References

- [ADR-017 — Barrel Files over Hygen Injects](./adrs/ADR-017-barrel-files-over-injects.md) — why `@shared/*` exists and why codegen never mutates your files
- [ADR-015 — CLI Command Architecture](./adrs/ADR-015-cli-command-architecture.md) — install forms and the noun-verb interface
- [ADR-005 — Entity Family Base Classes](./adrs/ADR-005-entity-family-base-classes.md) — which family shim you need per entity
- [GETTING-STARTED.md](./GETTING-STARTED.md) — entity YAML authoring and the generator lifecycle
