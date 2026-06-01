/**
 * Canonical `messaging`-surface vocabulary (ADR-036 §7; swe-brain ADR-0008 §1).
 *
 * `CanonicalChannel` and `CanonicalMessage` are the vendor-agnostic `T`s a
 * messaging provider adapter reads into — the records that flow through the L1
 * change-source pipeline (`IChangeSource<Canonical…>` → differ → sink). Every
 * vendor adapter maps its vendor DTO → External (Zod-validated) → these canonical
 * shapes; vendor DTO/External shapes never cross the port boundary (hard rule #4).
 * IDs are vendor-prefixed at the boundary (`slack:C…`, `slack:C…:ts`, `slack:U…`).
 *
 * Modeled from swe-brain ADR-0008 (MessagingDomain, Slack first), trimmed to the
 * cross-vendor load-bearing core so Teams/Discord (planned vendor #2) map cleanly.
 * Slack-specific encodings (`<@U…>` mentions, `<url>` links, `thread_ts`) are
 * de-encoded in the adapter mapper; only their resolved, generalized forms appear
 * here.
 *
 * `Conversation` is deliberately ABSENT: it is a *derived* grouping produced by
 * the domain segmentation step (ADR-0008 §8), not vendor-sourced — no adapter
 * reads it, so it has no canonical read type and no change source. It lives only
 * as a consumer entity + a domain-service output.
 *
 * Each record is declared as `type` (not `interface`) so it satisfies the
 * orchestrator's `T extends Record<string, unknown>` constraint — interfaces lack
 * the implicit index signature that constraint needs.
 */

/** A reaction on a message — emoji shortname + aggregate count. */
export type MessageReaction = {
  emoji: string;
  count: number;
};

/** A file attached to a message — reference only; binary content is deferred. */
export type MessageFileRef = {
  externalId: string;
  name?: string | null;
  mime?: string | null;
};

/**
 * A messaging container — Slack's "conversation", renamed `Channel` to dodge the
 * overload with the derived `Conversation` grouping (ADR-0008 §1).
 */
export type CanonicalChannel = {
  /** Vendor-prefixed id at the port boundary, e.g. `slack:C…`. */
  externalId: string;
  /**
   * Container kind, vendor-normalized: `public` | `private` | `dm` | `mpim`.
   * v1 ingests `public` + `private` only (ADR-0008 §1).
   */
  kind: string;
  /** Display name; null for DMs. */
  name: string | null;
  topic: string | null;
  purpose: string | null;
  isArchived: boolean;
  /** Externally-hosted shared channel (Slack Connect analog) — flagged, deferred. */
  isExtShared: boolean;
  createdAt: Date | null;
};

/**
 * An atomic, MUTABLE message (ADR-0008 §1). Edits/deletes arrive post-ingest and
 * are absorbed by `integrationUpsert` (dedup on `externalId`); `deletedAt` is a
 * soft-delete tombstone preserved as signal.
 *
 * `conversationExternalId` is intentionally ABSENT from the canonical read type:
 * conversation membership is assigned by the domain segmentation step, never by
 * the adapter (ADR-0008 §8). The consumer `message` entity carries it as a
 * nullable, segmentation-owned column.
 */
export type CanonicalMessage = {
  /** Vendor-prefixed id, e.g. `slack:C…:ts`. */
  externalId: string;
  /** Parent container (cross-entity join key, not a DB FK — ADR-0004). Vendor-prefixed. */
  channelExternalId: string;
  /** Author's vendor user id, e.g. `slack:U…`. */
  authorExternalId: string;
  /**
   * Author email when resolvable — routed through an `ExactEmailMatch` identity
   * matcher (hard rule #5), not an ad-hoc display-name map. Null for bots /
   * guests / external users without a first-party email.
   */
  authorEmail: string | null;
  /** Message timestamp (the vendor `ts` for Slack). */
  occurredAt: Date;
  /**
   * Native reply-thread link (Slack `thread_ts`, vendor-prefixed). A strong
   * *within*-Conversation signal, NOT a Conversation id (ADR-0008 §1/§8).
   */
  threadExternalId: string | null;
  /** Raw message body; vendor markup preserved. */
  text: string;
  /**
   * Mention target ids decoded from vendor markup (e.g. `<@U…>` → `slack:U…`).
   * De-encoding is the adapter's job; resolution to Person is the domain's.
   */
  mentionExternalIds: string[] | null;
  /** System/bot subtype preserved; the domain owns the signal-vs-noise policy. */
  subtype: string | null;
  reactions: MessageReaction[] | null;
  files: MessageFileRef[] | null;
  /** Edit time when the message was edited post-send (drives upsert). */
  editedAt: Date | null;
  /** Soft-delete tombstone (preserved as signal). */
  deletedAt: Date | null;
  /**
   * The visibility the message was observed at (`public` | `private`) — the
   * consent lattice's runtime currency; any actuator write's target visibility
   * must be ≤ this (RFC-0001 §4; ADR-0008 §7).
   */
  visibility: string;
  /**
   * The actuator's own posts — the echo-loop guard so ingestion skips/marks
   * self-authored messages (ADR-0008 §9).
   */
  isAppAuthored: boolean;
};
