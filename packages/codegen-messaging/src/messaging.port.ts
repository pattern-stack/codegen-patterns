/**
 * Messaging L3 composing port.
 *
 * `MessagingPort` is the single contract a messaging provider adapter implements.
 * It composes L1 strategies (auth + the entity-keyed change-source registry) plus
 * the runtime capability descriptor, and — unique to messaging among the
 * interaction surfaces — an optional bot-user `write` seam (ADR-0008 §9). Like
 * `TranscriptPort` it carries **no L2 sub-ports**: the messaging surface is
 * incremental-read + canonical types (`CanonicalChannel`, `CanonicalMessage`), so
 * reads go through the change-source registry; there is no field/picklist/
 * association reader to compose.
 *
 * **Entity-agnostic by design** — no entity name appears in this type (the port
 * is named for the *context*, `messaging`; ADR-036 §11.3). The adapter contributes
 * `changeSources['channel']` / `changeSources['message']`; the surface aggregator
 * folds every provider's `changeSources` into the `<SURFACE>_ENTITY_SOURCES`
 * registry consumers read at runtime. `conversation` is NOT a change source — it
 * is produced by the domain segmentation step (ADR-0008 §8).
 *
 * `MessagingPort` (and `MessageWrite`) are **provisional** until a second adapter
 * (Teams/Discord is the planned vendor #2) passes the falsifier suite — that
 * promotes them to stable (hard rule #8).
 *
 * The L1 types are imported across the package boundary from
 * `@pattern-stack/codegen/subsystems` (the C6/C7 seam) — type-only, erased at
 * runtime; see the package tsconfig for in-workspace resolution.
 */

import type {
  IAuthStrategy,
  IChangeSource,
} from '@pattern-stack/codegen/subsystems';
import type { MessagingCapabilities } from './capabilities';

/**
 * A draft message the actuator posts as the app's bot user (ADR-0008 §9). The
 * brain speaks *as itself* (APP badge) — posting as an end user is out of scope.
 */
export type MessageDraft = {
  /** Target container (vendor-prefixed), e.g. `slack:C…`. */
  channelExternalId: string;
  /** Reply in a thread when set (vendor-prefixed thread id); else a top-level post. */
  threadExternalId?: string | null;
  text: string;
};

/**
 * The bot-user write capability (ADR-0003 `Writeback`-shaped; ADR-0008 §3/§9).
 * **Ships dark** in v1 — built and wired, but gated by an `act` `ConsentGrant` ×
 * the visibility bound × the escalation-rung policy before any write fires.
 */
export interface MessageWrite {
  /**
   * Post a new message (or a threaded reply when the draft carries a thread id).
   * Returns the new message's vendor-prefixed id, which the caller persists to
   * enable later edit/delete AND to set `isAppAuthored` (the echo-loop guard).
   */
  post(draft: MessageDraft): Promise<string>;
  /** Edit a previously-posted message by its vendor-prefixed id. */
  update(externalId: string, text: string): Promise<void>;
  /** React to a message with an emoji shortname. */
  react(externalId: string, emoji: string): Promise<void>;
}

export interface MessagingPort {
  /** L1 — auth strategy resolving credentials for this provider. */
  readonly auth: IAuthStrategy;

  /**
   * L1 — per-entity change sources this adapter contributes, keyed by entity
   * name (`channel`, `message`); the surface aggregator folds these into the
   * entity-keyed registry.
   */
  readonly changeSources: Record<string, IChangeSource<unknown>>;

  /** L2 — runtime capability descriptor (entity coverage + write availability). */
  readonly capabilities: MessagingCapabilities;

  /**
   * Surface-only — the bot-user write capability (ADR-0008 §9). Optional and
   * **dark** in v1: present on a fully-wired adapter, but no write fires until an
   * `act` grant + visibility bound + rung policy permit it. Absent on a
   * read-only adapter (then `capabilities.canWrite` is unset / `false`).
   */
  readonly write?: MessageWrite;
}
