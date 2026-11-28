# PW-2: `@pattern-stack/wiring`, crew's wiring lifted into a package, with ordered start and stop

**Status:** implemented · **Issue:** none · **Follows:** PW-1 · **Next:** PW-3 (`target: { wiring: plain, http: none }`)

## Problem

Plain wiring needs a composition root, and a DI container isn't wanted. Crew already has one:
`src/core/kernel/wiring/wiring.ts`, 183 lines, no dependencies. In it, typed manifests (`defineModule`,
`defineSystem`) declare what they need, and `compose` builds everything in dependency order. d4 settled that it
becomes its own small package. Crew's calls are short-lived (every hook is a new process), so its wiring has no
lifecycle. Codegen's apps have loops: the event outbox drain, the scheduler, the job workers. Those need starting
after everything is built and stopping in reverse.

## Decision

- **`packages/wiring`, published as `@pattern-stack/wiring` 0.1.0** (plan §5 default: in codegen-patterns, through
  the existing per-package publish job, with `publishConfig.access: public`). It has no runtime dependencies.
  - Source: `src/wiring.ts`, which is crew's file with one addition. The API is `createWiring`, `orderByNeeds`,
    `WiringError`, `MODULE_KINDS` and the manifest types, and `src/index.ts` exports them.
  - The `bun` export condition points at the source, so Bun consumers (crew) need no build.
- **Start and stop are hooks on the manifest**: `start?(api)` and `stop?(api)`, given what that part's `create`
  returned. The hooks are typed: `Lifecycle<M[N]>` (or `S[N]`).
  - The plan said "on a manifest's result". Putting them beside `create` keeps every module's and system's API type
    free of lifecycle methods, so a consumer of the `events` system can't call `stop()` on it. The order and
    semantics are the plan's.
  - `wired.start()` runs every `start` after every `create`, in composition order, one at a time and awaited:
    systems first, then modules. A hook that a part attaches during `create` is therefore in place before any part
    starts a loop. This is the swe-brain 0.20.1 scheduler bug (`events.module.ts:197-214`) fixed by construction,
    and `lifecycle.test.ts` holds it.
  - If a `start` fails, the parts already started are stopped in reverse. The failure is rethrown as
    `starting <kind> <name>: …`, with any stop failures appended. The app can then start again.
  - `wired.stop()` stops every part that started, in reverse, including one with a `stop` but no `start`. Every
    `stop` runs even if another throws; the failures are thrown together, each named. Stopping twice, or stopping
    something never started, does nothing. A `stop()` made while another is running returns that one's promise, so
    overlapping stops (a signal that arrives twice) never stop parts out of order and none resolves early.
    Starting twice throws.
  - A `stop()` during a `start()` (a SIGTERM at boot) waits for the part starting now, starts nothing more, and
    stops everything that started.
  - Each failure keeps the original error as its `cause`, a settings checker's included.
  - `compose` refuses a module and a system that share a name, because the settings map is keyed by name.
  - `compose` stays synchronous, and nothing listens for a signal: the app entry owns SIGTERM (plan §5).
- **Crew is untouched.** It switches its import in a crew PR once the package is published (GAP step 7). Its code
  ignores the optional hooks.

## The gate

`just test-wiring`, in `test-all`, has two parts:
- `bun test packages/wiring/src/__tests__/`:
  - `compose.test.ts`: crew's runtime tests, ported unchanged but for the import;
  - `lifecycle.test.ts`: order, rollback on a failed start, every stop running, idempotence, restart, parts without
    hooks, a stop during a start, the shared-name refusal and error causes;
- `tsc` over the package, tests included, which checks `types.test.ts` (crew's type assertions) and the hook typing.
  Each assertion is an expect-error directive, so a type that stops refusing fails the gate with TS2578.

The tarball smoke (`test/post-publish/run-tarball-smoke.ts`, which gates every CI publish) used to import
`<pkg>/testing` from every public package. It now imports each key of the package's own `exports` map, so a package
without a `./testing` export passes instead of failing the publish job for every package.

`npm pack --dry-run` ships `dist/`, `src/` (without the tests), the README and `package.json`.

## Publishing

Merging this PR to main publishes `@pattern-stack/wiring@0.1.0`. The CI `publish` job publishes every opted-in
`packages/*` whose version isn't on npm yet.
