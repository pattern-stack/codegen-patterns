/**
 * Cross-workspace smoke test for @pattern-stack/codegen-calendar (interaction lift).
 *
 * Resolves the package BY ITS PUBLISHED NAME from the codegen root workspace —
 * proving `bun install` linked the new workspace package and its public barrel
 * exports the canonical type, the CalendarPort contract, the capability
 * descriptor, and the DI tokens.
 */

import { describe, it, expect } from 'bun:test';
import {
  CALENDAR_CAPABILITIES,
  CALENDAR_PORT,
  NO_CALENDAR_CAPABILITIES,
  type CalendarCapabilities,
  type CanonicalMeeting,
} from '@pattern-stack/codegen-calendar';

describe('@pattern-stack/codegen-calendar public barrel', () => {
  it('exports DI tokens as registered symbols', () => {
    expect(CALENDAR_CAPABILITIES).toBe(
      Symbol.for('@pattern-stack/codegen-calendar.capabilities'),
    );
    expect(CALENDAR_PORT).toBe(Symbol.for('@pattern-stack/codegen-calendar.port'));
  });

  it('CanonicalMeeting is an implementable surface-shaped type', () => {
    const meeting: CanonicalMeeting = {
      externalId: 'google:abc123',
      title: 'Sprint planning',
      description: null,
      startAt: new Date('2026-05-31T15:00:00Z'),
      endAt: new Date('2026-05-31T16:00:00Z'),
      organizerEmail: 'doug@findtempo.co',
      attendeeEmails: ['doug@findtempo.co'],
      location: null,
      status: 'confirmed',
    };
    expect(meeting.externalId).toBe('google:abc123');
    expect(meeting.attendeeEmails).toEqual(['doug@findtempo.co']);
  });

  it('NO_CALENDAR_CAPABILITIES + spread declares entity coverage', () => {
    expect(NO_CALENDAR_CAPABILITIES).toEqual({ entities: [] });
    const caps: CalendarCapabilities = {
      ...NO_CALENDAR_CAPABILITIES,
      entities: ['meeting'],
    };
    expect(caps.entities).toEqual(['meeting']);
    // NO_CALENDAR_CAPABILITIES is not mutated by the spread.
    expect(NO_CALENDAR_CAPABILITIES.entities).toEqual([]);
  });
});
