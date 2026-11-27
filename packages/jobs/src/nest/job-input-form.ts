import {
  formDefaultsOf,
  formFieldsOf,
  type JobsOpsInputForm,
} from '../shapes/ops.ts';
import { z } from 'zod';

const NO_INPUT = new Set(['void', 'undefined']);

/**
 * How Start run asks for a job's input, from its zod input: `none` for `z.void()` / `z.undefined()`; `form` when its
 * JSON Schema (zod's input side) is an object whose every property the shared reader can show (`formFieldsOf`), with
 * each property's default; `json` for anything else, with the schema (null when zod cannot describe it) and the
 * defaults as an example when there are any. The one place the backend reads an input for the form.
 */
export function jobInputFormOf(input: z.ZodType): JobsOpsInputForm {
  if (NO_INPUT.has(input.def.type)) return { kind: 'none' };
  let schema: Record<string, unknown>;
  try {
    schema = {
      ...z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }),
    };
  } catch {
    // A shape JSON Schema can't hold at all (a cycle zod refuses): the box, with nothing to show.
    return { kind: 'json', schema: null, example: null };
  }
  const fields = formFieldsOf(schema);
  if (fields) return { kind: 'form', schema, defaults: formDefaultsOf(fields) };
  return { kind: 'json', schema, example: exampleOf(schema) };
}

/** An object schema's property defaults, when it has any; else null. */
function exampleOf(schema: Record<string, unknown>): unknown {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return null;
  const defaults = Object.entries(properties).flatMap(([name, node]) =>
    typeof node === 'object' && node !== null && 'default' in node
      ? [[name, node.default] as const]
      : [],
  );
  return defaults.length ? Object.fromEntries(defaults) : null;
}
