/**
 * Cross-workspace smoke test for @pattern-stack/codegen-transcript (interaction lift).
 *
 * Resolves the package BY ITS PUBLISHED NAME from the codegen root workspace —
 * proving `bun install` linked the new workspace package and its public barrel
 * exports the canonical type (incl. TranscriptSegment), the TranscriptPort
 * contract, the capability descriptor, and the DI tokens.
 */

import { describe, it, expect } from 'bun:test';
import {
  NO_TRANSCRIPT_CAPABILITIES,
  TRANSCRIPT_CAPABILITIES,
  TRANSCRIPT_PORT,
  type CanonicalTranscript,
  type TranscriptCapabilities,
  type TranscriptSegment,
} from '@pattern-stack/codegen-transcript';

describe('@pattern-stack/codegen-transcript public barrel', () => {
  it('exports DI tokens as registered symbols', () => {
    expect(TRANSCRIPT_CAPABILITIES).toBe(
      Symbol.for('@pattern-stack/codegen-transcript.capabilities'),
    );
    expect(TRANSCRIPT_PORT).toBe(
      Symbol.for('@pattern-stack/codegen-transcript.port'),
    );
  });

  it('CanonicalTranscript + TranscriptSegment are implementable surface-shaped types', () => {
    const segment: TranscriptSegment = {
      speaker: 'Doug',
      speakerEmail: 'doug@findtempo.co',
      text: 'Let us ship the ledger.',
      startMs: 0,
      endMs: 2400,
    };
    const transcript: CanonicalTranscript = {
      externalId: 'google:conf123:transcript1',
      meetingExternalId: 'google:event456',
      title: 'Sprint planning',
      occurredAt: new Date('2026-05-31T15:00:00Z'),
      duration: 3600,
      language: 'en-US',
      segments: [segment],
      fullText: null,
      summary: null,
      attendeeEmails: ['doug@findtempo.co'],
      organizerEmail: 'doug@findtempo.co',
      externalLink: 'https://meet.google.com/abc',
    };
    expect(transcript.segments[0]?.speaker).toBe('Doug');
    expect(transcript.meetingExternalId).toBe('google:event456');
  });

  it('TranscriptSegment.speakerEmail is optional (nullable, populated when resolvable)', () => {
    const segment: TranscriptSegment = { speaker: 'Unknown', text: 'hi' };
    expect(segment.speakerEmail).toBeUndefined();
  });

  it('NO_TRANSCRIPT_CAPABILITIES + spread declares entity coverage', () => {
    expect(NO_TRANSCRIPT_CAPABILITIES).toEqual({ entities: [] });
    const caps: TranscriptCapabilities = {
      ...NO_TRANSCRIPT_CAPABILITIES,
      entities: ['transcript'],
    };
    expect(caps.entities).toEqual(['transcript']);
    expect(NO_TRANSCRIPT_CAPABILITIES.entities).toEqual([]);
  });
});
