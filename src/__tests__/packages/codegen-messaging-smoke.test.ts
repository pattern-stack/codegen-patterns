/**
 * Cross-workspace smoke test for @pattern-stack/codegen-messaging (interaction lift).
 *
 * Resolves the package BY ITS PUBLISHED NAME from the codegen root workspace —
 * proving `bun install` linked the new workspace package and its public barrel
 * exports the canonical types (CanonicalChannel, CanonicalMessage, and the
 * append-only CanonicalReaction delta — swe-brain ADR-0009 Amendment B §B2), the
 * MessagingPort contract's capability descriptor, and the DI tokens.
 */

import { describe, it, expect } from 'bun:test';
import {
  MESSAGE_WRITE,
  MESSAGING_CAPABILITIES,
  MESSAGING_PORT,
  NO_MESSAGING_CAPABILITIES,
  type CanonicalChannel,
  type CanonicalMessage,
  type CanonicalReaction,
  type MessagingCapabilities,
} from '@pattern-stack/codegen-messaging';

describe('@pattern-stack/codegen-messaging public barrel', () => {
  it('exports DI tokens as registered symbols', () => {
    expect(MESSAGING_CAPABILITIES).toBe(
      Symbol.for('@pattern-stack/codegen-messaging.capabilities'),
    );
    expect(MESSAGING_PORT).toBe(
      Symbol.for('@pattern-stack/codegen-messaging.port'),
    );
    expect(MESSAGE_WRITE).toBe(
      Symbol.for('@pattern-stack/codegen-messaging.message-write'),
    );
  });

  it('CanonicalChannel + CanonicalMessage are implementable surface-shaped types', () => {
    const channel: CanonicalChannel = {
      externalId: 'slack:C123',
      kind: 'public',
      name: 'eng',
      topic: null,
      purpose: null,
      isArchived: false,
      isExtShared: false,
      createdAt: new Date('2026-05-31T15:00:00Z'),
    };
    const message: CanonicalMessage = {
      externalId: 'slack:C123:1717000000.000100',
      channelExternalId: 'slack:C123',
      authorExternalId: 'slack:U456',
      authorEmail: 'doug@findtempo.co',
      occurredAt: new Date('2026-05-31T15:00:00Z'),
      threadExternalId: null,
      text: 'ship the ledger',
      mentionExternalIds: null,
      subtype: null,
      reactions: [{ emoji: 'thumbsup', count: 2 }],
      files: null,
      editedAt: null,
      deletedAt: null,
      visibility: 'public',
      isAppAuthored: false,
    };
    expect(channel.externalId).toBe('slack:C123');
    expect(message.channelExternalId).toBe('slack:C123');
    expect(message.reactions?.[0]?.emoji).toBe('thumbsup');
  });

  it('CanonicalReaction is an append-only delta: ±1 per (actor, emoji), counts derived at read', () => {
    const added: CanonicalReaction = {
      externalId: 'slack:Ev0PV52K25',
      messageExternalId: 'slack:C123:1717000000.000100',
      channelExternalId: 'slack:C123',
      emoji: 'thumbsup',
      actorExternalId: 'slack:U456',
      actorEmail: 'doug@findtempo.co',
      delta: 1,
      occurredAt: new Date('2026-05-31T15:01:00Z'),
      visibility: 'public',
    };
    const removed: CanonicalReaction = {
      ...added,
      externalId: 'slack:Ev0PV52K9Z',
      actorEmail: null, // null for bots / guests / unresolved (ExactEmailMatch)
      delta: -1,
      occurredAt: new Date('2026-05-31T15:02:00Z'),
    };
    // Each add/remove is its own immutable fact keyed by the vendor EVENT id.
    expect(added.externalId).not.toBe(removed.externalId);
    // Aggregate count is DERIVED — SUM(delta) per (message, emoji) — never stored.
    const derivedCount = added.delta + removed.delta;
    expect(derivedCount).toBe(0);
  });

  it('NO_MESSAGING_CAPABILITIES + spread declares entity coverage', () => {
    expect(NO_MESSAGING_CAPABILITIES).toEqual({ entities: [] });
    const caps: MessagingCapabilities = {
      ...NO_MESSAGING_CAPABILITIES,
      entities: ['channel', 'message', 'reaction'],
    };
    expect(caps.entities).toEqual(['channel', 'message', 'reaction']);
    expect(NO_MESSAGING_CAPABILITIES.entities).toEqual([]);
  });
});
