/**
 * Cross-workspace smoke test for @pattern-stack/codegen-mail (interaction lift).
 *
 * Resolves the package BY ITS PUBLISHED NAME from the codegen root workspace —
 * proving `bun install` linked the new workspace package and its public barrel
 * exports the canonical type, the MailPort contract, the capability descriptor,
 * and the DI tokens.
 */

import { describe, it, expect } from 'bun:test';
import {
  MAIL_CAPABILITIES,
  MAIL_PORT,
  NO_MAIL_CAPABILITIES,
  type CanonicalEmail,
  type MailCapabilities,
} from '@pattern-stack/codegen-mail';

describe('@pattern-stack/codegen-mail public barrel', () => {
  it('exports DI tokens as registered symbols', () => {
    expect(MAIL_CAPABILITIES).toBe(
      Symbol.for('@pattern-stack/codegen-mail.capabilities'),
    );
    expect(MAIL_PORT).toBe(Symbol.for('@pattern-stack/codegen-mail.port'));
  });

  it('CanonicalEmail is an implementable surface-shaped type', () => {
    const email: CanonicalEmail = {
      externalId: 'google:18f',
      threadId: 't1',
      messageId: '<abc@mail>',
      fromEmail: 'doug@findtempo.co',
      fromName: 'Doug',
      toEmails: ['team@findtempo.co'],
      ccEmails: null,
      subject: 'Re: ledger',
      snippet: 'looks good',
      bodyText: 'looks good',
      bodyHtml: null,
      isRead: true,
      isStarred: false,
      labels: ['INBOX'],
      receivedAt: new Date('2026-05-31T15:00:00Z'),
      sentAt: new Date('2026-05-31T14:59:00Z'),
    };
    expect(email.threadId).toBe('t1');
    expect(email.labels).toEqual(['INBOX']);
  });

  it('NO_MAIL_CAPABILITIES + spread declares entity coverage', () => {
    expect(NO_MAIL_CAPABILITIES).toEqual({ entities: [] });
    const caps: MailCapabilities = {
      ...NO_MAIL_CAPABILITIES,
      entities: ['email'],
    };
    expect(caps.entities).toEqual(['email']);
    expect(NO_MAIL_CAPABILITIES.entities).toEqual([]);
  });
});
