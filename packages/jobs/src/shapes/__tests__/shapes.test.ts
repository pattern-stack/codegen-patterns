import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  jobComponentBase,
  jobDescriptionShape,
  jobListShape,
  runListQueryShape,
  runPageShape,
  runShape,
  runSummaryShape,
  runWaitQueryShape,
  startRunRequestShape,
  startRunResponseShape,
} from '../index.ts';

const SHAPES = {
  jobDescriptionShape,
  jobListShape,
  runListQueryShape,
  runPageShape,
  runShape,
  runSummaryShape,
  runWaitQueryShape,
  startRunRequestShape,
  startRunResponseShape,
};

/** Every property name of a JSON Schema, records' own data aside (they have none). */
function propertyNames(schema: unknown, into: string[] = []): string[] {
  if (Array.isArray(schema)) for (const s of schema) propertyNames(s, into);
  else if (schema && typeof schema === 'object')
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value && typeof value === 'object')
        into.push(...Object.keys(value));
      propertyNames(value, into);
    }
  return into;
}

const T = '2026-11-15T12:00:00.000Z';
const ID = '6f1c1f0e-4a52-4c1e-9a0b-0f5b1b7d2a10';
const zeros = { total: 0, done: 0, cached: 0, failed: 0, skipped: 0 };

const summary = {
  id: ID,
  jobKey: 'toy.public',
  jobVersion: 'abc',
  status: 'completed' as const,
  pauseReason: null,
  trigger: 'agent' as const,
  dryRun: true,
  requestedBy: null,
  dedupeKey: 'tune:x',
  budget: { maxItems: 10, maxUsd: 1, maxCalls: 2, deadlineAt: T },
  spend: { calls: 1, inputTokens: 100, costUsd: 0.01 },
  error: null,
  createdAt: T,
  startedAt: T,
  completedAt: T,
};

const run = {
  ...summary,
  counts: { ...zeros, total: 3, done: 3 },
  steps: [
    {
      name: 'judge',
      index: 0,
      kind: 'map' as const,
      status: 'completed' as const,
      attempts: 1,
      counts: { ...zeros, total: 3, done: 3 },
      speculation: null,
      wait: null,
      error: null,
      startedAt: T,
      completedAt: T,
    },
  ],
  output: { lineAt: 0.5, perType: { someKey: 1 } },
  revision: 'r1',
};

describe('the jobs wire shapes', () => {
  it('publish every field name in snake_case', () => {
    for (const [name, shape] of Object.entries(SHAPES))
      for (const prop of propertyNames(z.toJSONSchema(shape.public)))
        expect({ name, prop }).toEqual({
          name,
          prop: prop.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`),
        });
  });

  it('round-trip a run through toPublic and fromPublic, never renaming the output', () => {
    const published = runShape.toPublic(run);
    expect(published).toMatchObject({
      job_key: 'toy.public',
      pause_reason: null,
      budget: { max_items: 10, deadline_at: T },
      steps: [{ started_at: T }],
      output: { lineAt: 0.5, perType: { someKey: 1 } },
    });
    expect(runShape.public.parse(published)).toEqual(published);
    expect(runShape.fromPublic(published)).toEqual(run);
    const page = { runs: [summary], nextCursor: 'c' };
    expect(runPageShape.fromPublic(runPageShape.toPublic(page))).toEqual(page);
  });

  it("never renames a start's input keys", () => {
    const body = startRunRequestShape.public.parse({
      input: { typeKey: 'x', some_key: 1 },
    });
    expect(startRunRequestShape.fromPublic(body).input).toEqual({
      typeKey: 'x',
      some_key: 1,
    });
  });

  it('default a start to a dry run by an agent, under the limits', () => {
    expect(
      startRunRequestShape.fromPublic(startRunRequestShape.public.parse({})),
    ).toEqual({ input: {}, dryRun: true, trigger: 'agent', budget: {} });
    expect(
      startRunRequestShape.public.safeParse({ trigger: 'schedule' }).success,
    ).toBe(false);
    expect(
      startRunRequestShape.public.safeParse({ dedupe_key: 'has space' })
        .success,
    ).toBe(false);
    expect(
      startRunRequestShape.public.safeParse({ budget: { max_items: 0 } })
        .success,
    ).toBe(false);
  });

  it('default and bound the list and wait queries', () => {
    expect(runListQueryShape.public.parse({})).toEqual({ limit: 20 });
    expect(runListQueryShape.public.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(runWaitQueryShape.public.parse({})).toEqual({ timeout_ms: 30_000 });
    expect(
      runWaitQueryShape.public.safeParse({ timeout_ms: 45_001 }).success,
    ).toBe(false);
  });

  it('describe a job with its facts in snake_case', () => {
    const description = {
      key: 'toy.public',
      version: 'abc',
      steps: [
        {
          name: 'judge',
          kind: 'map' as const,
          batchMax: 5,
          limiters: [{ name: 'toy', per: 'tenant' as const }],
        },
      ],
      input: { type: 'object' },
      output: { type: 'object' },
      authority: {
        read: 'tenant-wide' as const,
        dryRun: 'tenant-wide' as const,
        start: 'admin' as const,
      },
      limits: { maxItems: 10, maxUsd: 1, maxCalls: 2, maxDurationMs: 60_000 },
    };
    expect(jobDescriptionShape.toPublic(description)).toMatchObject({
      steps: [
        { batch_max: 5, limiters: [{ name: 'toy', per: 'tenant' }] },
      ],
      authority: { dry_run: 'tenant-wide' },
      limits: { max_duration_ms: 60_000 },
    });
  });
});

describe('the authority levels as the API describes them', () => {
  it('names tenant-wide as a tenant key and admin as a named tenant admin, never a tenant admin as tenant-wide', () => {
    const json = z.toJSONSchema(jobDescriptionShape.public) as unknown as {
      properties: { authority: { description: string } };
    };
    const text = json.properties.authority.description;
    expect(text).toContain('tenant-wide (a tenant key acting as itself');
    expect(text).toContain('admin (a named member with tenant-admin authority)');
    expect(text).not.toContain('a tenant admin or a tenant key');
  });
});

describe('jobComponentBase', () => {
  it('is Jobs and the key in PascalCase', () => {
    expect(jobComponentBase('document.reindex')).toBe(
      'JobsDocumentReindex',
    );
    expect(jobComponentBase('play.catch-up')).toBe('JobsPlayCatchUp');
    expect(jobComponentBase('toy.public')).toBe('JobsToyPublic');
  });
});
