import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  createRegistry,
  defineJob,
  JobDefinitionError,
  step,
} from '../../index.ts';
import {
  memoryRecorder,
  TOY_LIMITS,
  toyInternal,
  toyPublicDry,
  toyPublicReadOnly,
} from '../../testing.ts';
import {
  jobOpenApiSchemasOf,
  publicJobCatalogOf,
} from '../public-job-catalog.ts';

const publicWith = (key: string, input: z.ZodType) =>
  defineJob({
    key,
    audience: 'public',
    limits: TOY_LIMITS,
    input,
    output: z.object({ ok: z.boolean() }),
    inputRecorder: memoryRecorder(),
    steps: (s) =>
      s.add(
        'only',
        step({ run: () => ({ ok: true }), recorder: memoryRecorder() }),
      ),
  });

describe('publicJobCatalogOf', () => {
  it('lists only the public jobs, each with its description and component', () => {
    const catalog = publicJobCatalogOf(
      createRegistry([toyPublicDry(), toyPublicReadOnly(), toyInternal()]),
    );
    expect([...catalog.keys()]).toEqual([
      'toy.public-dry',
      'toy.public-read-only',
    ]);
    const dry = catalog.get('toy.public-dry');
    expect(dry?.component).toBe('JobsToyPublicDry');
    expect(dry?.description).toMatchObject({
      key: 'toy.public-dry',
      authority: { read: 'tenant-wide', dryRun: 'tenant-wide', start: 'admin' },
      limits: TOY_LIMITS,
      steps: [
        { name: 'items', kind: 'step', batchMax: null, limiters: [] },
        {
          name: 'score',
          kind: 'map',
          batchMax: 2,
          limiters: [{ name: 'toy', per: 'global' }],
        },
        { name: 'summary', kind: 'step', batchMax: null, limiters: [] },
      ],
    });
  });

  it('publishes the input and output JSON Schemas in snake_case', () => {
    const dry = publicJobCatalogOf(createRegistry([toyPublicDry()])).get(
      'toy.public-dry',
    );
    expect(Object.keys(dry?.description.input.properties as object)).toEqual([
      'type_key',
      'item_count',
    ]);
    expect(Object.keys(dry?.description.output.properties as object)).toEqual([
      'seen_key',
      'scored_items',
    ]);
  });

  it('refuses a public job whose input is not a camelCase object', () => {
    expect(() =>
      publicJobCatalogOf(
        createRegistry([publicWith('toy.array', z.array(z.string()))]),
      ),
    ).toThrow(JobDefinitionError);
    expect(() =>
      publicJobCatalogOf(
        createRegistry([
          publicWith('toy.snake', z.object({ type_key: z.string() })),
        ]),
      ),
    ).toThrow(JobDefinitionError);
    // An internal job's shapes are never published, so they are never checked.
    expect(() =>
      publicJobCatalogOf(
        createRegistry([
          defineJob({
            key: 'toy.internal-array',
            input: z.array(z.string()),
            output: z.number(),
            inputRecorder: memoryRecorder(),
            steps: (s) =>
              s.add('only', step({ run: () => 1, recorder: memoryRecorder() })),
          }),
        ]),
      ),
    ).not.toThrow();
  });

  it('refuses two keys with one component name', () => {
    expect(() =>
      publicJobCatalogOf(
        createRegistry([
          publicWith('toy.one-two', z.object({})),
          publicWith('toy.one.two', z.object({})),
        ]),
      ),
    ).toThrow('JobsToyOneTwo');
  });
});

describe('jobOpenApiSchemasOf', () => {
  it("names each public job's Input and Output, and nothing for an internal one", () => {
    const schemas = jobOpenApiSchemasOf(
      publicJobCatalogOf(createRegistry([toyPublicDry(), toyInternal()])),
    );
    expect(Object.keys(schemas)).toEqual([
      'JobsToyPublicDryInput',
      'JobsToyPublicDryOutput',
    ]);
    expect(
      schemas.JobsToyPublicDryInput?.safeParse({ type_key: 'x', item_count: 1 })
        .success,
    ).toBe(true);
  });
});
