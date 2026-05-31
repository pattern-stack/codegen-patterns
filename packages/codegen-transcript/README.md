# @pattern-stack/codegen-transcript

The **L2 transcript surface package** for [`@pattern-stack/codegen`](https://www.npmjs.com/package/@pattern-stack/codegen).

A *surface package* ships the type-shaped vocabulary, **ports**, and **DI
tokens** for one integration surface — a swe-brain *bounded context* in
ADR-0006's vocabulary (ADR-036 §11.3). Here: `transcript` (entity `transcript`).
The package is named for the **context noun** — the port stays entity-agnostic.
The full rationale is in
**[ADR-036 — Surface packages](../../docs/adrs/ADR-036-surface-packages.md)**;
the canonical model is lifted from swe-brain
**[ADR-0007 — TranscriptDomain](https://github.com/) (Google Meet first)**.

This surface is **far thinner than CRM**: it has no field/picklist/association
readers (that vocabulary is CRM-shaped). A transcript adapter is incremental-read
+ a canonical type — so the package ships exactly the canonical `Transcript`
vocabulary (with `TranscriptSegment`), the composing `TranscriptPort`, a
capability descriptor, and tokens.

## Layers

```
L1  @pattern-stack/codegen           — codegen subsystems (IChangeSource, IEntityChangeSourceRegistry, IAuthStrategy)
L2  @pattern-stack/codegen-transcript — THIS PACKAGE: CanonicalTranscript vocab + TranscriptPort + tokens
L3  generated TranscriptPort wiring   — composes auth + the change-source registry (Track D)
    consumer adapters                — implement the port per provider (Google Meet, Gong, …)
```

## Exports

| Export | Kind |
|---|---|
| `CanonicalTranscript`, `TranscriptSegment` | canonical type — the vendor-agnostic `T` a transcript adapter reads into (ADR-036 §7 vocabulary) |
| `TranscriptCapabilities`, `NO_TRANSCRIPT_CAPABILITIES` | per-adapter capability descriptor (entity coverage) |
| `TRANSCRIPT_CAPABILITIES` | DI token (`Symbol.for`) |
| `TranscriptPort` | L3 composing port — the contract an adapter implements (entity-agnostic) |
| `TRANSCRIPT_PORT` | DI token (`Symbol.for`) |
| `assertTranscriptAdapter` (from `@pattern-stack/codegen-transcript/testing`) | conformance helper / falsifier-suite entry |

```ts
import {
  type CanonicalTranscript,
  type TranscriptPort,
  TRANSCRIPT_PORT,
} from '@pattern-stack/codegen-transcript';
```

## The read primitive — registry, not a bespoke `pull`

`TranscriptPort` composes the L1 `sources: IEntityChangeSourceRegistry` (the
C6/C7 seam). Incremental reads go through
`sources.get<CanonicalTranscript>('transcript')`, which resolves an
`IChangeSource<CanonicalTranscript>` — the generic L1 read with cursor-by-value.
The port carries **no** entity-specific `pull*` method; the Meet REST nested pull
(conference records → transcripts → entries) is absorbed inside the adapter's
change source, with the nesting encoded in the opaque cursor (ADR-0007 §3).

## The composing port — `TranscriptPort`

```ts
export interface TranscriptPort {
  readonly auth: IAuthStrategy;                    // L1
  readonly sources: IEntityChangeSourceRegistry;   // L1
  readonly capabilities: TranscriptCapabilities;   // L2
}
```

Entity-agnostic — no entity name appears in its type; entity access goes through
`sources.get<T>(entityName)`. Per-consumer typed views are codegen-emitted
(Track D), not encoded here.

> **Provisional.** `TranscriptPort` stays provisional until a second adapter
> (Gong is the planned vendor #2) passes `assertTranscriptAdapter` — that
> promotes it to stable.

## Declaring capabilities

```ts
import {
  type TranscriptCapabilities,
  NO_TRANSCRIPT_CAPABILITIES,
} from '@pattern-stack/codegen-transcript';

export const GOOGLE_TRANSCRIPT_CAPABILITIES: TranscriptCapabilities = {
  ...NO_TRANSCRIPT_CAPABILITIES,
  entities: ['transcript'],
};
```

## Conformance testing

```ts
import { assertTranscriptAdapter } from '@pattern-stack/codegen-transcript/testing';

it('google meet adapter conforms to TranscriptPort', () => {
  assertTranscriptAdapter(googleMeetAdapter); // throws AggregateError listing every gap
});
```

Verifies the required L1 slots resolve and every `capabilities.entities` entry
resolves via `sources.has(name)` — so an adapter declaring an entity it can't
source fails the test rather than failing at runtime.

## License

MIT
