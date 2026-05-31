# @pattern-stack/codegen-mail

The **L2 mail surface package** for [`@pattern-stack/codegen`](https://www.npmjs.com/package/@pattern-stack/codegen).

A *surface package* ships the type-shaped vocabulary, **ports**, and **DI
tokens** for one integration surface — a swe-brain *bounded context* in
ADR-0006's vocabulary (ADR-036 §11.3). Here: `mail` (entity `email`). The
package is named for the **context noun** (`mail`), not the entity (`email`) —
the port stays entity-agnostic. The full rationale is in
**[ADR-036 — Surface packages](../../docs/adrs/ADR-036-surface-packages.md)**.

This surface is **far thinner than CRM**: it has no field/picklist/association
readers (that vocabulary is CRM-shaped). A mail adapter is incremental-read + a
canonical type — so the package ships exactly the canonical `Email` vocabulary,
the composing `MailPort`, a capability descriptor, and tokens.

## Layers

```
L1  @pattern-stack/codegen        — codegen subsystems (IChangeSource, IEntityChangeSourceRegistry, IAuthStrategy)
L2  @pattern-stack/codegen-mail   — THIS PACKAGE: CanonicalEmail vocab + MailPort + tokens
L3  generated MailPort wiring     — composes auth + the change-source registry (Track D)
    consumer adapters             — implement the port per provider (Gmail, …)
```

## Exports

| Export | Kind |
|---|---|
| `CanonicalEmail` | canonical type — the vendor-agnostic `T` a mail adapter reads into (ADR-036 §7 vocabulary) |
| `MailCapabilities`, `NO_MAIL_CAPABILITIES` | per-adapter capability descriptor (entity coverage) |
| `MAIL_CAPABILITIES` | DI token (`Symbol.for`) |
| `MailPort` | L3 composing port — the contract an adapter implements (entity-agnostic) |
| `MAIL_PORT` | DI token (`Symbol.for`) |
| `assertMailAdapter` (from `@pattern-stack/codegen-mail/testing`) | conformance helper |

```ts
import {
  type CanonicalEmail,
  type MailPort,
  MAIL_PORT,
} from '@pattern-stack/codegen-mail';
```

## The read primitive — `changeSources`, not a bespoke `pull`

`MailPort` composes the L1 `changeSources: Record<string, IChangeSource<unknown>>`
(the C6/C7 seam) — the per-entity change sources the adapter *contributes*, keyed
by entity name. Each entry resolves an `IChangeSource<CanonicalEmail>` — the
generic L1 read with cursor-by-value. The surface aggregator (a surface-module
concern, not the adapter's) folds every provider's `changeSources` into the
`MAIL_ENTITY_SOURCES` registry (an `IEntityChangeSourceRegistry`) that
entity-agnostic consumers read at runtime. The port carries **no** entity-specific
`pull*` method. (The swe-brain prototype used a transitional flat
`pullMessages({ historyId })` because L1 `IncrementalRead<T>` wasn't minted yet;
the codegen package skips that and uses the `changeSources` pattern directly,
consistent with `CrmPort`.)

Codegen reshapes the read body inside each `changeSources` entry to an
`IncrementalReadBase<CanonicalEmail, ResolvedFilter[]>` subclass (RFC-0003) — the
enumerate/hydrate read primitive. The author fills only `enumerate` / `hydrate` /
`toCanonical`; the base owns streaming, filter-before-hydrate, bounded-concurrency
hydration, and per-ref cursor emission.

## The composing port — `MailPort`

```ts
export interface MailPort {
  readonly auth: IAuthStrategy;                                  // L1
  readonly changeSources: Record<string, IChangeSource<unknown>>; // L1
  readonly capabilities: MailCapabilities;                       // L2
}
```

Entity-agnostic — no entity name appears in its type. The adapter contributes
`changeSources['email']`; the surface aggregator folds every provider's
contributions into the entity-keyed `MAIL_ENTITY_SOURCES` registry that consumers
read at runtime. Per-consumer typed views are codegen-emitted (Track D), not
encoded here.

## Declaring capabilities

```ts
import {
  type MailCapabilities,
  NO_MAIL_CAPABILITIES,
} from '@pattern-stack/codegen-mail';

export const GOOGLE_MAIL_CAPABILITIES: MailCapabilities = {
  ...NO_MAIL_CAPABILITIES,
  entities: ['email'],
};
```

## Conformance testing

```ts
import { assertMailAdapter } from '@pattern-stack/codegen-mail/testing';

it('gmail adapter conforms to MailPort', () => {
  assertMailAdapter(gmailAdapter); // throws AggregateError listing every gap
});
```

Verifies the required L1 slots resolve and every `capabilities.entities` entry
has a registered `changeSources` entry — so an adapter declaring an entity it
can't source fails the test rather than failing at runtime.

## License

MIT
