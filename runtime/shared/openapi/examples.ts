/**
 * Read a generated DTO schema's OpenAPI example (its `.meta({ example })`), minus some keys.
 *
 * An inheritance child's DTO extends its base's (RFC-0006 §5), and the base's schema owns the base fields' example
 * values; the child's example is composed from it at load time instead of restating them:
 *
 *   CreateMeetingSchema = CreateCommunicationSchema.omit({ kind: true }).extend({ … })
 *     .meta({ example: { ...exampleOf(CreateCommunicationSchema, 'kind'), title: 'Example title' } });
 */
import type { z } from 'zod';

export function exampleOf(schema: z.ZodType, ...omit: string[]): Record<string, unknown> {
  const example = schema.meta()?.example;
  if (example === null || typeof example !== 'object' || Array.isArray(example)) return {};
  const out: Record<string, unknown> = { ...(example as Record<string, unknown>) };
  for (const key of omit) delete out[key];
  return out;
}
