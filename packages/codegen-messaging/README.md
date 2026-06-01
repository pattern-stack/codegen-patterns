# @pattern-stack/codegen-messaging

L2 **messaging** surface package for `@pattern-stack/codegen` (ADR-036). The
type-shaped home for the messaging context: the canonical `Channel` / `Message`
vocabulary, the `MessagingPort` composing contract, the bot-user write seam, the
capability descriptor, and DI tokens.

Designed against **swe-brain ADR-0008** (MessagingDomain, Slack first). Messaging
is an **interaction surface** — incremental-read, no L2 sub-ports — so this package
mirrors `codegen-transcript` rather than the CRM-shaped `codegen-crm`.

## What's here (L2)

- **`CanonicalChannel`, `CanonicalMessage`** (`canonical.ts`) — the vendor-agnostic
  `T`s a provider adapter reads into (`IChangeSource<Canonical…>` → differ → sink).
  Vendor DTO → External(Zod) → canonical; vendor shapes never cross the boundary
  (hard rule #4).
- **`MessagingPort`** (`messaging.port.ts`) — the single contract a messaging
  provider adapter implements: L1 `auth` + per-entity `changeSources` + the
  `capabilities` descriptor, plus an optional bot-user `write` seam. Entity-agnostic
  (named for the *context*, not an entity); reads go through the change-source
  registry.
- **`MessagingCapabilities` / `NO_MESSAGING_CAPABILITIES`** (`capabilities.ts`) —
  runtime coverage (`entities`) + optional write availability (`canWrite`).
- **tokens** (`tokens.ts`) — `MESSAGING_PORT`, `MESSAGING_CAPABILITIES`, `MESSAGE_WRITE`.
- **`assertMessagingAdapter`** (`@pattern-stack/codegen-messaging/testing`) — the
  conformance / falsifier helper, kept out of the runtime barrel.

## What's NOT here

- **`Conversation`** — a *derived* grouping produced by the domain segmentation
  step (ADR-0008 §8), not vendor-sourced. No canonical read type, no change source;
  it lives only as a consumer entity + a domain-service output.
- **Composition** — which providers/ports a given app wires is L3, in the consumer
  app, never in this package (ADR-036 §3).

## Status

`MessagingPort` and the `MessageWrite` capability are **provisional** until a
second vendor (Teams/Discord) passes `assertMessagingAdapter` — then they promote
to stable (hard rule #8). The write path **ships dark** in v1 (ADR-0008 §9): the
seam is built and wired, but `chat:write` is requested and no nudge fires only once
the actuator activates.
