# PW-0: Nest-free runtime seams — a logger port, plain errors, Nest-free subsystem entries

**Status:** implemented · **Issue:** none · **Next:** PW-1 (the class graph), then PW-2 (`@pattern-stack/wiring`),
PW-3 (`target: { wiring: pattern-stack, http: none }`)

The first step of pattern-stack wiring: generated apps without NestJS. Nothing generated changes. The runtime gains the three
seams that pattern-stack output (PW-3) imports through, and the base classes stop loading `@nestjs/common`.

## Problem

Generated repositories, services and use cases are plain classes under thin Nest decorators, but the runtime they
import reaches Nest in three places a pattern-stack app can't avoid:

- **The base classes.** `runtime/base-classes/lifecycle-events.ts` imported Nest's `Logger`, so `BaseService`, every
  family service and `base-classes/index.ts` loaded `@nestjs/common`. It was the only leak in the base classes.
- **Errors.** The use-case templates throw `NotFoundException` / `BadRequestException`. A plain use case needs an
  error that says "not found" without naming an HTTP framework, and an HTTP layer that isn't Nest needs to answer it
  exactly as Nest would (the REST parity gate, H-1).
- **Subsystem barrels.** `runtime/subsystems/{events,auth,integration}/index.ts` (and the package's single
  `./subsystems` barrel) re-export the Nest modules, so importing a protocol or a token through them loads Nest.

## Decision

### The logger port: `runtime/logger.ts`

- `Logger` is `{ debug, log, warn, error }`, Nest's method names (`log` is info), so code moved off Nest's `Logger`
  keeps its call sites.
- `createLogger(context)` returns a logger that looks up the bound factory **on each call** (and caches the made logger
  per factory). A module-level `const logger = createLogger('…')` is evaluated before any app binds anything; it still
  prints through whatever is bound later.
- `setLoggerFactory(factory)` binds; the default is `consoleLoggerFactory` (`console.*`, prefixed `[context]`; `debug`
  prints only under `LOG_LEVEL=debug` or `verbose`, the same threshold `createAppLogger` reads, so the lifecycle-events
  stack trace stays out of default output as it did under Nest).
- **The Nest binding** is `runtime/nest-logger.ts`: `useNestLogger()` binds `(ctx) => new Logger(ctx)`. The Nest modules
  that own the port's callers call it when they load: `events.module.ts` (lifecycle events need an event bus, which a
  Nest app gets from `EventsModule`; the event scheduler; the outbox's `PgNotifyListener`) and `jobs-domain.module.ts`
  (the jobs listener; `job-worker.module.ts` imports it). `useNestLogger` binds only over the console default, so a
  factory the app bound on purpose, before or after, wins over the module load order. A Nest app's lines keep Nest's format and `app.useLogger`
  routing. The one gap: a Nest app that binds `EVENT_BUS` by hand without `EventsModule` and whose bus throws gets the
  console default for that warning, not Nest's logger.
- Moved onto the port: `lifecycle-events.ts`, `event-scheduler.ts` and `jobs/pg-notify.ts`, the plan's "Logger only"
  files. The decorated files (backends, workers, the bridge, the integration use case) keep Nest's `Logger`; they lose
  Nest wholesale in S-1..S-3, and the jobs files are replaced by `@pattern-stack/jobs` (J).
- Vendored mode: `logger.ts` and `nest-logger.ts` join `VENDORED_RUNTIME_FILES` at `<shared>/logger.ts` and
  `<shared>/nest-logger.ts`, the same relative position as in `runtime/`, so the relative imports from
  `<shared>/base-classes/` and `<shared>/subsystems/<name>/` resolve.

### Plain errors: `runtime/errors.ts`

- `AppError` (abstract: `status`, optional `code`, optional `details`, `cause`; a detail named `statusCode`, `error`,
  `code` or `message` is a `TypeError`, since the body owns those keys), `NotFoundError` (404) and
  `BadRequestError` (400). Only the two statuses the templates throw today; a third joins when a template needs it.
- `errorBody(err)` renders **the body Nest's exception of the same status sends, key for key and in Nest's key order**:
  - a bare message is `{ message, error, statusCode }`, which is what `new NotFoundException('…').getResponse()`
    gives (Nest builds a message-only body in that order);
  - with a code it is `{ statusCode, error, code, ...details, message }`, the object the generated code passes to
    `BadRequestException` (the list use case's `sort_not_combinable`, the controller's `include_not_allowed` with its
    `path`), which Nest sends as given.
  `errors.spec.ts` compares `JSON.stringify` of both sides against Nest's own exceptions, so a parity gate comparing
  bodies byte for byte holds.
- The Nest target keeps Nest's exceptions, byte for byte. PW-3's pattern-stack templates throw these; H-1's error middleware
  sends `errorBody`.

### Nest-free subsystem entries: `runtime/subsystems/<name>/core.ts`

- `events/core.ts`: the protocols, the augmentable registry types, the read port, the tokens, the errors, the event
  scheduler (Nest-free now that it logs through the port) and the outbox schema. Not in it: `TypedEventBus`
  (`generated/bus.ts`, decorated; PW-3 emits it without decorators under pattern-stack), the module and the two decorated
  backends.
- `auth/core.ts`: the protocols, tokens, the OAuth2 refresh strategy and `withAuthRetry`, the errors, the OAuth-state
  schema and the three backends. Not in it: the controller, the guard, `@Public`, the requester-context middleware
  (typed against `INestApplication`; its Hono twin is H-2) and the module.
- `integration/core.ts`: the protocols, the change-source registry, the detection schema, the middleware, the poll /
  incremental-read / webhook primitives, `buildChangeSource`, the tokens, the errors and the audit schemas. Not in it:
  the memory and Drizzle backends, the differ, the use case (all decorated; S-3) and the module.
- Each `index.ts` is now `export * from './core'` plus its Nest half, so the public API is unchanged and each export
  has one home. The package's `./subsystems` barrel is unchanged.
- No `jobs/core.ts`: the jobs subsystem is replaced, not de-Nested (d24, J-0b brings `@pattern-stack/jobs`).
- `subsystemCoreImport(mode, name)` (`src/cli/shared/runtime-import.ts`, twin in `src/config/runtime-mode.mjs`) gives
  the specifier: `@pattern-stack/codegen/runtime/subsystems/<name>/core` (the package's existing `./runtime/*` export)
  or `@shared/subsystems/<name>/core` (vendored). `NEST_FREE_SUBSYSTEMS` lists the names. Pattern-stack output imports
  subsystems through this, never through `subsystemsImport`.
- **Known gap, for PW-3:** the generated `events/types.ts` augments `DomainEventRegistry` through
  `declare module '…/runtime/subsystems/events/index'` (`event-codegen-generator.ts`), and resolving that module loads
  the Nest half's types. The pattern-stack target's event codegen must augment `…/events/core` instead (the interface is the
  same symbol). Changing it here would change Nest output, so it waits for the pattern-stack branch of that generator.
- The barrel split (each `index.ts` into a Nest-free `index.ts` and a `nest.ts` entry for the Nest half)
  would change Nest import lines in generated code. Not done here; if wanted, it's its own PR.

## The gate

`src/__tests__/runtime/nest-free.test.ts` walks the relative-import closure of every Nest-free entry (`logger.ts`,
`errors.ts`, `base-classes/index.ts`, `types/drizzle.ts`, `constants/tokens.ts`, `eav-helpers.ts`,
`http/{pagination,includes}.ts`, `shared/openapi/index.ts` and each `subsystems/<name>/core.ts`) with
`ts.preProcessFile` (a relative specifier it can't resolve fails the gate rather than being skipped) and fails on any `@nestjs/*` or `reflect-metadata` import, **type-only imports included**: a pattern-stack
app installs no `@nestjs`, so even `import type` from it fails to compile there. The failure prints the chain
(`base-classes/index.ts → base-classes/base-service.ts → base-classes/lifecycle-events.ts → @nestjs/common`). A control
case checks the walk does see Nest in `events/index.ts` and `nest-logger.ts`. The same file holds the `.mjs` twin of
`subsystemCoreImport` to the TypeScript one.

The proof that a pattern-stack app really compiles and boots without `@nestjs` installed is `test-smoke-pattern-stack` (PW-3); this
gate is the static half that PW-3 builds on.

## Byte-identity

No template, emitter or generator output changes. The Nest goldens (`test-baseline`, every smoke, `test-junction`,
`test-integration-emit`) are unchanged; vendored projects gain two runtime files (`logger.ts`, `nest-logger.ts`), and each installed events, auth or
integration subsystem gains its `core.ts`. `codegen update` writes every file of an installed subsystem's own folder,
new ones included (`refreshInstalled` in `runtime-copier.ts`), so a project installed on an older version gets
`core.ts` when its `index.ts` starts importing it; a dependency outside that folder is still only refreshed.
