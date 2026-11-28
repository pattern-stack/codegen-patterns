import { describe, expect, it } from 'bun:test';
import { jobRef } from '../../shapes/ops.ts';
import { z } from 'zod';
import { jobInputFormOf } from '../job-input-form.ts';

describe('jobInputFormOf', () => {
  it.each([
    ['z.void()', z.void()],
    ['z.undefined()', z.undefined()],
  ])('asks for no input from %s', (_name, input) => {
    expect(jobInputFormOf(input)).toEqual({ kind: 'none' });
  });

  it('builds a form from an object of supported properties, with their defaults', () => {
    const form = jobInputFormOf(
      z.object({
        mode: z.enum(['fast', 'full']),
        publish: z.boolean().default(false),
        sample: z.number().int().min(1).max(500),
        rate: z.number().min(0).max(1).optional(),
        versionId: z.uuid(),
        email: z.email().optional(),
        day: z.iso.date().nullable(),
        note: z.string().min(1).max(200).optional(),
        types: z.array(z.enum(['calls', 'emails'])).default(['calls']),
      }),
    );
    expect(form).toMatchObject({
      kind: 'form',
      defaults: { publish: false, types: ['calls'] },
      schema: {
        type: 'object',
        required: ['mode', 'sample', 'versionId', 'day'],
      },
    });
    if (form.kind !== 'form') throw new Error('not a form');
    expect(Object.keys(form.schema.properties as object)).toEqual([
      'mode',
      'publish',
      'sample',
      'rate',
      'versionId',
      'email',
      'day',
      'note',
      'types',
    ]);
  });

  it('builds a form for a list of ids a job looks up (z.array(jobRef(kind)))', () => {
    const form = jobInputFormOf(
      z.object({
        documentIds: z.array(jobRef('document')).min(1),
      }),
    );
    expect(form).toMatchObject({ kind: 'form' });
  });

  it('falls back to JSON for a property the form cannot show, with the defaults as an example', () => {
    const form = jobInputFormOf(
      z.object({
        window: z.object({ days: z.number() }),
        limit: z.number().default(10),
      }),
    );
    expect(form).toMatchObject({
      kind: 'json',
      schema: { type: 'object' },
      example: { limit: 10 },
    });
  });

  it('falls back to JSON with no example for a non-object input', () => {
    expect(jobInputFormOf(z.array(z.string()))).toMatchObject({
      kind: 'json',
      schema: { type: 'array' },
      example: null,
    });
  });
});
