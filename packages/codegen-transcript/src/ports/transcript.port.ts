/**
 * Transcript L3 composing port.
 *
 * `TranscriptPort` is the single contract a transcript provider adapter
 * implements. It composes L1 strategies (auth + the entity-keyed change-source
 * registry) plus the runtime capability descriptor. Unlike `CrmPort` it carries
 * **no L2 sub-ports** — the transcript surface is incremental-read + a canonical
 * type (`CanonicalTranscript`), so the port is far thinner: reads go through the
 * registry, there is no field/picklist/association reader to compose.
 *
 * **Entity-agnostic by design** — no entity name appears in this type (the port
 * is named for the *context*, `transcript`; ADR-036 §11.3). Entity access goes
 * through `sources.get<CanonicalTranscript>('transcript')` at runtime;
 * per-consumer typed views are codegen-emitted (Track D), not encoded here.
 *
 * The Meet REST nested pull (list conference records → per-record transcripts →
 * per-transcript entries) is absorbed behind the adapter's `IChangeSource`
 * implementation — the opaque cursor encodes the nesting and the adapter drains
 * it internally; the port stays flat (ADR-0007 §3).
 *
 * `TranscriptPort` is **provisional** until a second adapter (Gong is the
 * planned vendor #2) passes the falsifier suite — that promotes it to stable.
 *
 * The L1 types are imported across the package boundary from
 * `@pattern-stack/codegen/subsystems` (the C6/C7 seam) — type-only, erased at
 * runtime; see the package tsconfig for in-workspace resolution.
 */

import type {
  IAuthStrategy,
  IEntityChangeSourceRegistry,
} from '@pattern-stack/codegen/subsystems';
import type { TranscriptCapabilities } from '../capabilities';

export interface TranscriptPort {
  /** L1 — auth strategy resolving credentials for this provider. */
  readonly auth: IAuthStrategy;

  /** L1 — entity-keyed registry of change sources for this provider's transcript entities. */
  readonly sources: IEntityChangeSourceRegistry;

  /** L2 — runtime capability descriptor (entity coverage). */
  readonly capabilities: TranscriptCapabilities;

  // Surface-only methods (transcript-specific) start empty: the port ships with
  // the L1 + canonical-type composition only and accretes a method here ONLY
  // when a consumer use case forces it (e.g. a RandomRead<T> fetch-by-meeting
  // role, deferred per ADR-0007 §3).
}
