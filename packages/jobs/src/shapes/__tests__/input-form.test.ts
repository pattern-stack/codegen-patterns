import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  type FormField,
  formDefaultsOf,
  formFieldsOf,
  formValueProblemOf,
  jobRef,
  labelOf,
} from '../input-form.ts';

const schemaOf = (input: z.ZodType) =>
  z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' });

const calibration = z.object({
  mode: z.enum(['fast', 'full']).describe('How hard to look'),
  publish: z.boolean().default(false),
  sample: z.number().int().min(1).max(500),
  versionId: z.uuid().meta({ title: 'Indicator version' }),
  types: z.array(z.enum(['calls', 'emails'])).default(['calls']),
  note: z.string().max(200).nullable().optional(),
  day: z.iso.date().optional(),
});

const field = (fields: FormField[] | null, name: string) => {
  const found = fields?.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name}`);
  return found;
};

describe('formFieldsOf', () => {
  it('reads every supported property, in schema order, with its label, help, requirement and default', () => {
    const fields = formFieldsOf(schemaOf(calibration));
    expect(fields?.map((f) => [f.name, f.control.kind, f.required])).toEqual([
      ['mode', 'enum', true],
      ['publish', 'boolean', false],
      ['sample', 'number', true],
      ['versionId', 'text', true],
      ['types', 'enum-array', false],
      ['note', 'text', false],
      ['day', 'text', false],
    ]);
    expect(field(fields, 'mode')).toMatchObject({
      label: 'Mode',
      help: 'How hard to look',
      control: { kind: 'enum', options: ['fast', 'full'] },
    });
    expect(field(fields, 'versionId')).toMatchObject({
      label: 'Indicator version',
      control: { kind: 'text', format: 'uuid' },
    });
    expect(field(fields, 'sample').control).toEqual({
      kind: 'number',
      integer: true,
      minimum: 1,
      maximum: 500,
    });
    expect(field(fields, 'note')).toMatchObject({
      nullable: true,
      control: { kind: 'text', maxLength: 200 },
    });
    expect(formDefaultsOf(fields ?? [])).toEqual({
      publish: false,
      types: ['calls'],
    });
  });

  it.each([
    ['a date', z.object({ at: z.date() })],
    ['a nested object', z.object({ window: z.object({ days: z.number() }) })],
    ['a free pattern', z.object({ key: z.string().regex(/^a/) })],
    ['another format', z.object({ url: z.url() })],
    ['a union', z.object({ id: z.union([z.string(), z.number()]) })],
    ['an array of numbers', z.object({ ids: z.array(z.number()) })],
    ['a record', z.record(z.string(), z.number())],
    ['not an object', z.number()],
  ])('reads %s as no form', (_name, input) => {
    expect(formFieldsOf(schemaOf(input))).toBeNull();
  });

  it('reads an object with no properties as a form with no fields', () => {
    expect(formFieldsOf(schemaOf(z.object({})))).toEqual([]);
  });

  it('reads exclusive bounds (positive, gt, lt): an integer moves in by one, a number keeps the bound', () => {
    const fields = formFieldsOf(
      schemaOf(
        z.object({
          maxObservations: z.number().int().positive().max(500),
          share: z.number().gt(0).lt(1),
        }),
      ),
    );
    expect(fields?.map((f) => f.control)).toEqual([
      { kind: 'number', integer: true, minimum: 1, maximum: 500 },
      { kind: 'number', integer: false, minimum: 0, maximum: 1 },
    ]);
  });
});

describe('formValueProblemOf', () => {
  const fields = formFieldsOf(schemaOf(calibration));

  it('asks for a required value and lets an optional one go', () => {
    expect(formValueProblemOf(field(fields, 'mode'), undefined)).toBe(
      'Required.',
    );
    expect(formValueProblemOf(field(fields, 'day'), '')).toBeNull();
    expect(formValueProblemOf(field(fields, 'note'), null)).toBeNull();
  });

  it('checks types, bounds and formats', () => {
    const sample = field(fields, 'sample');
    expect(formValueProblemOf(sample, 2.5)).toBe('Must be a whole number.');
    expect(formValueProblemOf(sample, 0)).toBe('Must be at least 1.');
    expect(formValueProblemOf(sample, 501)).toBe('Must be at most 500.');
    expect(formValueProblemOf(sample, 20)).toBeNull();
    expect(formValueProblemOf(field(fields, 'versionId'), 'abc')).toBe(
      'Must be a uuid.',
    );
    expect(formValueProblemOf(field(fields, 'day'), '2026-11-23')).toBeNull();
    expect(formValueProblemOf(field(fields, 'mode'), 'slow')).toBe(
      'Must be one of fast, full.',
    );
    expect(
      formValueProblemOf(field(fields, 'types'), ['calls', 'emails']),
    ).toBeNull();
  });
});

describe('labelOf', () => {
  it('reads a name in words', () => {
    expect(labelOf('tenantId')).toBe('Tenant id');
    expect(labelOf('max_items')).toBe('Max items');
  });
});

describe('ref fields', () => {
  it('reads a jobRef as a uuid field that names its kind, and keeps its title', () => {
    const fields = formFieldsOf(
      schemaOf(
        z.object({
          versionId: jobRef('document', { title: 'Indicator version' }),
          playVersionId: jobRef('playVersion').optional(),
        }),
      ),
    );
    expect(field(fields, 'versionId')).toMatchObject({
      label: 'Indicator version',
      control: { kind: 'text', format: 'uuid', ref: 'document' },
    });
    expect(field(fields, 'playVersionId').control).toMatchObject({
      ref: 'playVersion',
    });
  });

  it('reads a ref whose kind is not a kind name as its plain input', () => {
    const fields = formFieldsOf(
      schemaOf(z.object({ id: z.uuid().meta({ ref: 'not a kind' }) })),
    );
    expect(field(fields, 'id').control).toMatchObject({
      kind: 'text',
      format: 'uuid',
      ref: null,
    });
  });
});

describe('a list of refs', () => {
  const publish = z.object({
    documentIds: z
      .array(jobRef('document'))
      .min(1)
      .max(3)
      .describe('The versions to publish'),
    also: z.array(jobRef('playVersion')).default([]),
  });

  it('reads z.array(jobRef(kind)) as a ref-array field with its bounds', () => {
    const fields = formFieldsOf(schemaOf(publish));
    expect(fields?.map((f) => [f.name, f.control])).toEqual([
      [
        'documentIds',
        {
          kind: 'ref-array',
          ref: 'document',
          minItems: 1,
          maxItems: 3,
        },
      ],
      [
        'also',
        {
          kind: 'ref-array',
          ref: 'playVersion',
          minItems: null,
          maxItems: null,
        },
      ],
    ]);
    expect(fields?.[0]?.help).toBe('The versions to publish');
  });

  it('leaves a list of plain uuids, or of a malformed kind, to JSON', () => {
    expect(
      formFieldsOf(schemaOf(z.object({ ids: z.array(z.uuid()) }))),
    ).toBeNull();
    expect(
      formFieldsOf(
        schemaOf(z.object({ ids: z.array(z.uuid().meta({ ref: 'not a kind' })) })),
      ),
    ).toBeNull();
  });

  it('checks the ids and the bounds', () => {
    const [field] = formFieldsOf(schemaOf(publish)) ?? [];
    if (!field) throw new Error('no field');
    const id = '6f1c1f0e-4a52-4c1e-9a0b-0f5b1b7d2a10';
    expect(formValueProblemOf(field, [id])).toBeNull();
    expect(formValueProblemOf(field, [])).toBe('Choose at least 1.');
    expect(formValueProblemOf(field, [id, id, id, id])).toBe(
      'Choose at most 3.',
    );
    expect(formValueProblemOf(field, ['nope'])).toBe('Must be a list of ids.');
  });
});
