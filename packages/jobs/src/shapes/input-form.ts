import { z } from 'zod';

/**
 * A job's input as the operator's Start run asks for it. The backend builds it from the job's zod input
 * (`jobInputFormOf`): `none` for a job that takes nothing, `form` when every property of its object input is one this
 * reader can show as a field (`formFieldsOf`), else `json` with the schema and an example. The schema is JSON Schema
 * (2020-12, zod's input side): a superuser surface, so showing it is fine.
 */
const jsonSchemaObject = z.record(z.string(), z.unknown());

export const jobsOpsInputFormSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('form'),
    schema: jsonSchemaObject,
    defaults: z
      .record(z.string(), z.unknown())
      .describe("Each property's schema default, by name"),
  }),
  z.object({
    kind: z.literal('json'),
    schema: jsonSchemaObject.nullable(),
    example: z
      .unknown()
      .nullable()
      .describe('A starting value for the box: the defaults, when any'),
  }),
]);
export type JobsOpsInputForm = z.output<typeof jobsOpsInputFormSchema>;

/**
 * A kind of domain id a job names: in its input, where Start run looks one up by name (a field marked with one is a
 * searchable select of the tenant's records, `jobsOps.refOptions`, not a box for an id), and in its views, where a
 * section's `refs` show records by id (the run page reads their labels). A kind only views name has a source that
 * resolves and lists nothing; an input may not name it, which the boot check enforces. The app names its kinds
 * (codegen generates them from the entity YAML); the boot refuses a registered job naming a kind no module
 * registered a source for (`assertRefKindsRegistered`).
 */
export type JobRefKind = string;

/** A ref kind's spelling: a camelCase name, as an entity's is (`document`, `contactList`). */
export const JOB_REF_KIND_PATTERN = /^[a-z][A-Za-z0-9]*$/;

const isRefKind = (value: unknown): value is JobRefKind =>
  typeof value === 'string' && JOB_REF_KIND_PATTERN.test(value);

/**
 * A job input field naming a domain id: a uuid marked with its kind (plain zod metadata, carried by its JSON Schema
 * as `ref`). Write `documentId: jobRef('document')` in a job's input.
 */
export function jobRef(
  kind: JobRefKind,
  opts: { title?: string; description?: string } = {},
) {
  return z.guid().meta({ ref: kind, ...opts });
}

/** The string formats a text field checks. */
export const FORM_STRING_FORMATS = ['uuid', 'email', 'date'] as const;
export type FormStringFormat = (typeof FORM_STRING_FORMATS)[number];

export type FormControl =
  | {
      kind: 'text';
      format: FormStringFormat | null;
      minLength: number | null;
      maxLength: number | null;
      /** A domain id Start run looks up (`jobRef`); null for plain text, or a kind this build doesn't know. */
      ref: JobRefKind | null;
    }
  | {
      kind: 'number';
      integer: boolean;
      minimum: number | null;
      maximum: number | null;
    }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  | { kind: 'enum-array'; options: string[] }
  | {
      /** A list of domain ids (`z.array(jobRef(kind))`): a multi-select Start run looks up by name. */
      kind: 'ref-array';
      ref: JobRefKind;
      minItems: number | null;
      maxItems: number | null;
    };

/** One property of a job's object input, as a form field. */
export interface FormField {
  name: string;
  /** Its schema `title`, else its name in words. */
  label: string;
  /** Its schema `description`. */
  help: string | null;
  /** Named in the schema's `required` (on the input side: no default, not optional). */
  required: boolean;
  /** It may be null (`anyOf [X, null]`). */
  nullable: boolean;
  /** Its schema `default`, when it has one. */
  hasDefault: boolean;
  default: unknown;
  control: FormControl;
}

/** `tenantId` → "Tenant id", `max_items` → "Max items". */
export function labelOf(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A JSON Schema node as the form reads it: the keywords it looks at, named, beside any others it may carry. */
interface SchemaNode {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  enum?: unknown;
  format?: unknown;
  pattern?: unknown;
  ref?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  items?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  propertyNames?: unknown;
  patternProperties?: unknown;
  anyOf?: unknown;
  [keyword: string]: unknown;
}

const isRecord = (value: unknown): value is SchemaNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberOr = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The tighter of two optional bounds (`Math.max` for a minimum, `Math.min` for a maximum). */
function tighter(
  a: number | null,
  b: number | null,
  pick: (x: number, y: number) => number,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return pick(a, b);
}

const stringEnum = (value: unknown): string[] | null =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((v): v is string => typeof v === 'string')
    ? value
    : null;

/** The keys a supported property may carry beside the ones its control reads. */
const COMMON_KEYS = new Set(['title', 'description', 'default', 'examples']);

const onlyKeys = (node: SchemaNode, allowed: string[]) =>
  Object.keys(node).every(
    (key) => COMMON_KEYS.has(key) || allowed.includes(key),
  );

function booleanControlOf(node: SchemaNode): FormControl | null {
  return onlyKeys(node, ['type']) ? { kind: 'boolean' } : null;
}

function numberControlOf(node: SchemaNode): FormControl | null {
  if (
    !onlyKeys(node, [
      'type',
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
    ])
  )
    return null;
  const integer = node.type === 'integer';
  // zod's `.positive()`, `.gt()` and `.lt()` emit exclusive bounds. An integer's is the next whole number in; a
  // number's is kept as the field's bound, and the job's own schema refuses the edge itself when the form is sent.
  const step = integer ? 1 : 0;
  const exclusiveMin = numberOr(node.exclusiveMinimum);
  const exclusiveMax = numberOr(node.exclusiveMaximum);
  return {
    kind: 'number',
    integer,
    minimum: tighter(
      numberOr(node.minimum),
      exclusiveMin === null ? null : exclusiveMin + step,
      Math.max,
    ),
    maximum: tighter(
      numberOr(node.maximum),
      exclusiveMax === null ? null : exclusiveMax - step,
      Math.min,
    ),
  };
}

const formStringFormatOf = (value: unknown): FormStringFormat | null =>
  typeof value === 'string' &&
  (FORM_STRING_FORMATS as readonly string[]).includes(value)
    ? (value as FormStringFormat)
    : null;

function stringControlOf(node: SchemaNode): FormControl | null {
  const options = stringEnum(node.enum);
  if (options && onlyKeys(node, ['type', 'enum']))
    return { kind: 'enum', options };
  const format = formStringFormatOf(node.format);
  // A format the form checks brings its own pattern; any other pattern or format is not a field.
  const onlyCheckedFormat =
    format !== null ||
    (node.format === undefined && node.pattern === undefined);
  if (
    node.enum !== undefined ||
    !onlyCheckedFormat ||
    !onlyKeys(node, [
      'type',
      'format',
      'pattern',
      'minLength',
      'maxLength',
      'ref',
    ])
  )
    return null;
  return {
    kind: 'text',
    format,
    minLength: numberOr(node.minLength),
    maxLength: numberOr(node.maxLength),
    // A lookup only for a uuid of a kind this build knows; anything else is its plain input.
    ref: format === 'uuid' && isRefKind(node.ref) ? node.ref : null,
  };
}

function arrayControlOf(node: SchemaNode): FormControl | null {
  const items = node.items;
  if (!isRecord(items)) return null;
  const options = stringEnum(items.enum);
  if (
    onlyKeys(node, ['type', 'items']) &&
    items.type === 'string' &&
    options &&
    onlyKeys(items, ['type', 'enum'])
  )
    return { kind: 'enum-array', options };
  // A list of a known kind's ids, with nothing else said of each id.
  if (!onlyKeys(node, ['type', 'items', 'minItems', 'maxItems'])) return null;
  const item = controlOf(items);
  if (
    item?.kind !== 'text' ||
    item.ref === null ||
    item.minLength !== null ||
    item.maxLength !== null
  )
    return null;
  return {
    kind: 'ref-array',
    ref: item.ref,
    minItems: numberOr(node.minItems),
    maxItems: numberOr(node.maxItems),
  };
}

/** Each JSON Schema `type` the form can show, and how it reads a node of that type. */
const CONTROL_OF_TYPE: Record<
  string,
  (node: SchemaNode) => FormControl | null
> = {
  boolean: booleanControlOf,
  number: numberControlOf,
  integer: numberControlOf,
  string: stringControlOf,
  array: arrayControlOf,
};

/** One property's control, or null when it is not one the form can show. */
function controlOf(node: SchemaNode): FormControl | null {
  const read =
    typeof node.type === 'string' && Object.hasOwn(CONTROL_OF_TYPE, node.type)
      ? CONTROL_OF_TYPE[node.type]
      : undefined;
  return read ? read(node) : null;
}

/**
 * The fields of an object input's JSON Schema, in schema order, or null when any property is one the form cannot
 * show (then the input is edited as JSON). A property is supported when it is a string (format uuid, email or date,
 * min and max length), a number or integer (minimum, maximum), a boolean, a string enum or an array of one, a list of
 * `jobRef` ids (min and max items), or any of these nullable, optional or with a default.
 */
export function formFieldsOf(schema: unknown): FormField[] | null {
  if (!isRecord(schema) || schema.type !== 'object') return null;
  // A record (keys the form cannot name) is not a form.
  if (
    (schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false) ||
    schema.propertyNames !== undefined ||
    schema.patternProperties !== undefined
  )
    return null;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === 'string')
      : [],
  );
  const fields: FormField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) return null;
    let node = raw;
    let nullable = false;
    if (Array.isArray(raw.anyOf)) {
      const branches = raw.anyOf.filter(isRecord);
      const inner = branches.filter((b) => b.type !== 'null');
      if (
        branches.length !== raw.anyOf.length ||
        branches.length !== 2 ||
        inner.length !== 1 ||
        !inner[0]
      )
        return null;
      nullable = true;
      const { anyOf: _anyOf, ...outer } = raw;
      node = { ...outer, ...inner[0] };
    }
    const control = controlOf(node);
    if (!control) return null;
    fields.push({
      name,
      label: typeof node.title === 'string' ? node.title : labelOf(name),
      help: typeof node.description === 'string' ? node.description : null,
      required: required.has(name),
      nullable,
      hasDefault: Object.hasOwn(node, 'default'),
      default: node.default,
      control,
    });
  }
  return fields;
}

/** Each field's default, by name: what a form starts from. */
export function formDefaultsOf(
  fields: readonly FormField[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields.filter((f) => f.hasDefault).map((f) => [f.name, f.default]),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type ControlOfKind<K extends FormControl['kind']> = Extract<
  FormControl,
  { kind: K }
>;

/** A present value's problem under each control, in words, or null. */
const PROBLEM_OF_CONTROL: {
  [K in FormControl['kind']]: (
    control: ControlOfKind<K>,
    value: unknown,
  ) => string | null;
} = {
  boolean: (_control, value) =>
    typeof value === 'boolean' ? null : 'Must be true or false.',
  number: numberProblemOf,
  enum: (control, value) =>
    typeof value === 'string' && control.options.includes(value)
      ? null
      : `Must be one of ${control.options.join(', ')}.`,
  'enum-array': (control, value) =>
    Array.isArray(value) &&
    value.every((v) => typeof v === 'string' && control.options.includes(v))
      ? null
      : `Must be some of ${control.options.join(', ')}.`,
  'ref-array': refArrayProblemOf,
  text: textProblemOf,
};

function numberProblemOf(
  control: ControlOfKind<'number'>,
  value: unknown,
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 'Must be a number.';
  if (control.integer && !Number.isInteger(value))
    return 'Must be a whole number.';
  if (control.minimum !== null && value < control.minimum)
    return `Must be at least ${control.minimum}.`;
  if (control.maximum !== null && value > control.maximum)
    return `Must be at most ${control.maximum}.`;
  return null;
}

function refArrayProblemOf(
  control: ControlOfKind<'ref-array'>,
  value: unknown,
): string | null {
  if (
    !Array.isArray(value) ||
    !value.every((v) => typeof v === 'string' && UUID.test(v))
  )
    return 'Must be a list of ids.';
  if (control.minItems !== null && value.length < control.minItems)
    return `Choose at least ${control.minItems}.`;
  if (control.maxItems !== null && value.length > control.maxItems)
    return `Choose at most ${control.maxItems}.`;
  return null;
}

/** What each checked format refuses, in words. */
const FORMAT_CHECKS: Record<
  FormStringFormat,
  { test: RegExp; problem: string }
> = {
  uuid: { test: UUID, problem: 'Must be a uuid.' },
  email: { test: EMAIL, problem: 'Must be an email address.' },
  date: { test: DATE, problem: 'Must be a date, YYYY-MM-DD.' },
};

function textProblemOf(
  control: ControlOfKind<'text'>,
  value: unknown,
): string | null {
  if (typeof value !== 'string') return 'Must be text.';
  if (control.minLength !== null && value.length < control.minLength)
    return `Must be at least ${control.minLength} characters.`;
  if (control.maxLength !== null && value.length > control.maxLength)
    return `Must be at most ${control.maxLength} characters.`;
  if (control.format === null) return null;
  const check = FORMAT_CHECKS[control.format];
  return check.test.test(value) ? null : check.problem;
}

/**
 * What is wrong with one field's value, in words, or null. A light check before the server's: required, the type,
 * the bounds and the format. Undefined is a value not given; the server stays the authority.
 */
export function formValueProblemOf(
  field: FormField,
  value: unknown,
): string | null {
  if (value === undefined || value === '')
    return field.required ? 'Required.' : null;
  if (value === null) return field.nullable ? null : 'Required.';
  const { control } = field;
  const problemOf = PROBLEM_OF_CONTROL[control.kind] as (
    control: FormControl,
    value: unknown,
  ) => string | null;
  return problemOf(control, value);
}
