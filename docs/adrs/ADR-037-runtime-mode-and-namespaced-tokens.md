# ADR-037 — Runtime Mode (`package` | `vendored`) + Namespaced `Symbol.for` Tokens

**Status:** Accepted
**Date:** 2026-06-01
**Owner:** Doug
**Related:** ADR-008 (subsystem architecture — token convention), ADR-036 (surface packages — the `Symbol.for` convention surfaces already use), RFC-0001 (integration codegen retarget — the emitter that emits the runtime imports), RFC-0003 (incremental read — introduced the load-bearing runtime VALUE import `STRATEGY_REGISTRY`), ADR-035 (vendored runtime delivery — `VENDORED_RUNTIME_FILES`)

## 1. Context

A codegen consumer can reach the framework runtime two ways:

- **Vendored** — `project init` copies the runtime closure into `src/shared/**`
  and the generated code imports it via the consumer's `@shared/*` tsconfig alias
  (ADR-035). This dodged a real *dual-drizzle* type-identity clash: identical
  Drizzle types coming from two different `node_modules` trees fail to unify, so
  baking the runtime into the consumer's own module graph keeps one drizzle-orm
  identity.
- **Package** — the consumer depends on `@pattern-stack/codegen` and imports the
  runtime from the package (`@pattern-stack/codegen/subsystems`,
  `@pattern-stack/codegen/runtime/*`).

These two were **mixed**, and that is the bug. The entity generators emit
`@shared/...` (vendored), but the integration generators (RFC-0001/0003 emitter)
emit `@pattern-stack/codegen/subsystems` (package). For *type-only* imports the
mix is harmless — types are erased at compile time, so it does not matter which
copy they came from. RFC-0003 R5 changed that: the emitter began emitting a
runtime **VALUE** — `STRATEGY_REGISTRY`, a DI-token `Symbol`, used in
`inject: [STRATEGY_REGISTRY]`. A plain `Symbol('STRATEGY_REGISTRY')` from the
*package* copy is a **different object** from the one in the *vendored* copy. The
consumer's `@Global` AuthBindings module provides under the vendored Symbol; the
generated provider module injects the package Symbol; NestJS finds no provider
and **crashes at boot**.

Two independent root causes, both fixed here:

1. **No single source of truth for which runtime copy the emitter targets.** Each
   generator hardcoded a specifier. There was no project-level switch and no one
   helper that every generator routes through.
2. **DI tokens were identity-fragile.** `Symbol('X')` is unique per evaluation,
   so it only matches when *exactly one* copy of the defining module is loaded.
   Surface packages already solved this with `Symbol.for('@scope/pkg.token')`
   (ADR-036) — a key in the global registry that matches by *value* across
   duplicated module instances. The subsystem tokens never adopted it.

## 2. Decision

### (a) A per-project `runtime: package | vendored` mode — default `package`

A new top-level `runtime` key in `codegen.config.yaml`:

```yaml
runtime: package   # default — generated code imports @pattern-stack/codegen/*
# runtime: vendored  # generated code imports @shared/* (project init vendors src/shared/**)
```

`package` is the default because it is the simpler, dependency-honest model and
the one new projects should adopt: depend on the package, import from the
package, no vendored tree to drift. `vendored` remains fully supported for
projects that need the single-drizzle-identity guarantee (or are already built
on `@shared/*`).

### (b) One helper emits every runtime import specifier

A single module — `src/cli/shared/runtime-import.ts` — owns the mapping from a
logical runtime subpath to the concrete import specifier, keyed off the resolved
mode:

| logical subpath | `package` | `vendored` |
|---|---|---|
| `subsystems` (barrel) | `@pattern-stack/codegen/subsystems` | `@shared/subsystems/<subsystem>` |
| `base-classes/<x>` | `@pattern-stack/codegen/runtime/base-classes/<x>` | `@shared/base-classes/<x>` |
| `constants/tokens`, `types/drizzle`, `eav-helpers`, `pipes/...` | `@pattern-stack/codegen/runtime/<x>` | `@shared/<x>` |

**Every** hardcoded runtime specifier in the generators routes through this
helper — both the integration generators (RFC-0001/0003 emitter) **and** the
entity generators (today via the pattern library's `repositoryImport` /
`serviceImport` and the Hygen template locals). Consumer-app files that are
*always* scaffolded locally and never owned by the package runtime
(`@shared/database/database.module`, `@shared/http/pagination`,
`@shared/openapi`, `@shared/connections/*`) stay `@shared/*` in both modes — they
are not part of the package runtime and have no package specifier.

`vendored` mode is **byte-for-byte unchanged from today** — the helper returns
exactly the `@shared/...` specifiers the generators already emitted.

### (c) `init` vendors only in `vendored` mode

`project init` writes `runtime: <mode>` into the emitted config and gates the
`VENDORED_RUNTIME_FILES` copy on `mode === 'vendored'`. In `package` mode the
consumer depends on the package, so there is nothing to vendor.

### (d) Subsystem DI tokens → namespaced `Symbol.for`, version deferred

Every subsystem injection token defined as `Symbol('X')` becomes
`Symbol.for('@pattern-stack/codegen.<subsystem>.<lower-kebab-token>')` — matching
the convention the surface packages already use
(`Symbol.for('@pattern-stack/codegen-messaging.message-write')`). The key is the
contract; the exported **name** and the barrels' re-exports are unchanged.
String-valued tokens (events, integration — already `'X' as const`) are **left
alone**: strings already match by value across import boundaries, so they have
no identity hazard.

Embedding a contract *version* in the key is **deferred** (a `// TODO(token-version)`
marks the site) until codegen/surface versioning is settled — pinning a version
now would just churn keys on every bump.

## 3. Consequences

**Positive**
- The dual-package Symbol-identity boot crash is structurally eliminated: package
  mode never mixes copies, and `Symbol.for` tokens match by value even if a copy
  is duplicated.
- One switch, one helper. Adding a runtime import to a generator is a helper call,
  not a per-mode literal.
- New projects get the simpler package model by default.

**Negative / migration**
- **The default flips to `package`.** An existing vendored project that re-inits or
  upgrades without pinning will start emitting package specifiers it can't
  resolve. **Existing vendored projects must set `runtime: vendored` explicitly**
  at migration. This is called out in CONSUMER-SETUP and the init output; it is a
  one-line config add.
- Two emission shapes to keep green. The integration-emit snapshot suite asserts
  **both** modes so neither regresses.

**Neutral**
- Token *names* and barrels are untouched, so no consumer import changes for the
  token sweep — only the underlying Symbol identity strengthens.

## 4. References
- `src/cli/shared/runtime-import.ts` — the mode→specifier helper
- `src/config/config-loader.ts` + `src/schema/pipelines-config.schema.ts` — the `runtime` config knob
- `src/cli/shared/init-scaffold.ts` — the gated `VENDORED_RUNTIME_FILES` vendoring
- `runtime/subsystems/**/*.tokens.ts` — the `Symbol.for` token sweep
- ADR-036 §"tokens" / `packages/codegen-*/src/tokens.ts` — the `Symbol.for` convention this adopts
