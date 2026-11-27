import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { jobRef, jobsOpsStartInputSchema } from '../../shapes/ops.ts';
import { z } from 'zod';
import { createRegistry, defineJob, step } from '../../index.ts';
import type { Executor } from '../../ports.ts';
import { fakeClock, MemoryJobStore, recordingSink } from '../../testing.ts';
import type { JobOperatorActor } from '../job-actor.ts';
import {
  JobInputRefRegistry,
  type JobInputRefSource,
  matchingRefOptions,
  refFieldsOf,
  refValuesOf,
} from '../job-input-refs.ts';
import { JobRefNotFoundError } from '../jobs.errors.ts';
import { assertRefSourcesRegistered } from '../lifecycle.ts';
import { jobsServiceOf } from './service-fixture.ts';

const TENANT_A = '0a000000-0000-4000-8000-00000000000a';
const MINE = '44444444-4444-4444-8444-444444444444';
const THEIRS = '55555555-5555-4555-8555-555555555555';
const operator: JobOperatorActor = {
  kind: 'operator',
  userId: '99999999-9999-4999-8999-999999999999',
};

const Input = z.object({
  documentId: jobRef('document'),
  plays: z.array(jobRef('playVersion')).default([]),
  nested: z.object({ signal: jobRef('signalVersion').nullable() }).optional(),
  note: z.string().optional(),
});

const refJob = defineJob({
  key: 'toy.refs',
  input: Input,
  output: z.number(),
  limits: { maxItems: 1, maxUsd: 1, maxCalls: 1, maxDurationMs: 60_000 },
  steps: (s) => s.add('only', step({ run: () => 1 })),
});

/** A source holding `held` ids in TENANT_A only. */
const sourceOf = (
  kind: JobInputRefSource['kind'],
  held: readonly string[] = [MINE],
): JobInputRefSource => ({
  kind,
  label: kind,
  listOptions: async () => [],
  resolve: async (tenantId, ids) =>
    tenantId === TENANT_A
      ? ids
          .filter((id) => held.includes(id))
          .map((id) => ({ id, label: id, hint: '' }))
      : [],
});

const allSources = () => {
  const refs = new JobInputRefRegistry();
  refs.register(
    sourceOf('document'),
    sourceOf('playVersion'),
    sourceOf('signalVersion'),
  );
  return refs;
};

describe('JobInputRefRegistry', () => {
  it('answers each kind its source, and refuses a second source for a kind', () => {
    const refs = new JobInputRefRegistry();
    const source = sourceOf('document');
    refs.register(source);
    expect(refs.sourceOf('document')).toBe(source);
    expect(refs.sourceOf('playVersion')).toBeUndefined();
    expect(() => refs.register(sourceOf('document'))).toThrow(
      /a second JobInputRefSource/,
    );
  });
});

describe('refFieldsOf', () => {
  it('reads every jobRef field of an input, nested and listed ones too, with its path', () => {
    expect(refFieldsOf(Input)).toEqual([
      { path: 'documentId', kind: 'document', many: false },
      { path: 'plays[]', kind: 'playVersion', many: true },
      { path: 'nested.signal', kind: 'signalVersion', many: false },
    ]);
    expect(refFieldsOf(z.object({ n: z.number() }))).toEqual([]);
    expect(refFieldsOf(z.void())).toEqual([]);
  });

  it('reads the ids a parsed input holds at each field, leaving out absent ones', () => {
    const values = refValuesOf(Input, {
      documentId: MINE,
      plays: [MINE, THEIRS, MINE],
    });
    expect(values.map((v) => [v.field.path, v.ids])).toEqual([
      ['documentId', [MINE]],
      ['plays[]', [MINE, THEIRS]],
      ['nested.signal', []],
    ]);
  });
});

describe('matchingRefOptions', () => {
  it('keeps names holding the words in any case, by name, cut to the limit', () => {
    const rows = ['Champion', 'beta', 'champ two', 'Alpha'];
    expect(matchingRefOptions(rows, (r) => r, 'CHAMP', 5)).toEqual([
      'champ two',
      'Champion',
    ]);
    expect(matchingRefOptions(rows, (r) => r, undefined, 2)).toEqual([
      'Alpha',
      'beta',
    ]);
  });
});

describe('the refs boot check', () => {
  it('stops the boot when a registered job names a kind no module registered', () => {
    const registry = createRegistry([refJob]);
    const refs = new JobInputRefRegistry();
    refs.register(sourceOf('document'));
    expect(() => assertRefSourcesRegistered(registry, refs)).toThrow(
      'job toy.refs names ref kind playVersion and no module registered a JobInputRefSource for it',
    );
    expect(() =>
      assertRefSourcesRegistered(registry, allSources()),
    ).not.toThrow();
  });

  it('stops the boot when an input names a kind only views name (no options to pick from)', () => {
    const observationJob = defineJob({
      key: 'toy.observation-input',
      input: z.object({ observationId: jobRef('observation') }),
      output: z.number(),
      steps: (s) => s.add('only', step({ run: () => 1 })),
    });
    const refs = new JobInputRefRegistry();
    refs.register({
      kind: 'observation',
      label: 'observation',
      resolve: async () => [],
    });
    expect(() =>
      assertRefSourcesRegistered(createRegistry([observationJob]), refs),
    ).toThrow(
      'job toy.observation-input names ref kind observation in its input, and that kind lists no options to pick from',
    );
  });
});

describe("a start's ref check", () => {
  const setup = () => {
    const registry = createRegistry([refJob]);
    const clock = fakeClock();
    const store = new MemoryJobStore({ now: clock.now });
    const submitted: string[] = [];
    const executor: Executor = {
      submit: async (id) => {
        submitted.push(id);
      },
      start: async () => {},
      stop: async () => {},
    };
    const service = jobsServiceOf({
      registry,
      store,
      executor,
      clock,
      events: recordingSink(),
      tenants: { findById: async (id) => (id === TENANT_A ? { id } : null) },
      refs: allSources(),
    });
    return { service, store, submitted };
  };
  const start = (input: unknown) =>
    jobsOpsStartInputSchema.parse({
      jobKey: 'toy.refs',
      tenantId: TENANT_A,
      input,
    });

  it("refuses an id the run's tenant doesn't hold, by the field's path, creating nothing", async () => {
    const { service, store, submitted } = setup();
    const err = await service
      .startForTenant(
        operator,
        start({ documentId: MINE, plays: [MINE, THEIRS] }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobRefNotFoundError);
    expect(err).toBeInstanceOf(BadRequestException);
    const response = (err as JobRefNotFoundError).getResponse();
    expect(response).toMatchObject({ code: 'ref_not_found', path: 'plays[]' });
    expect(JSON.stringify(response)).not.toContain(THEIRS);
    expect(await store.listRuns({ tenantId: TENANT_A, limit: 5 })).toEqual(
      [],
    );
    expect(submitted).toEqual([]);
  });

  it('starts when every id resolves in the tenant', async () => {
    const { service } = setup();
    const { created } = await service.startForTenant(
      operator,
      start({ documentId: MINE, plays: [MINE] }),
    );
    expect(created).toBe(true);
  });
});
