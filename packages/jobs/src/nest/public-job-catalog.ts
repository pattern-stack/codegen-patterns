import { type JobDescriptionValue, jobComponentBase } from '../shapes/index.ts';
import { defineShape, type Shape } from '../shapes/define-shape.ts';
import { z } from 'zod';
import {
  type AnyJob,
  JobDefinitionError,
  type JobLimits,
  type Registry,
} from '../index.ts';

/** A public job as the API serves it: its definition, its snake_case shapes and its description, built once. */
export interface PublicJob {
  job: AnyJob;
  input: Shape<z.ZodObject>;
  output: Shape<z.ZodObject>;
  /** The description `GET /jobs` lists (camelCase, its input and output the public JSON Schemas). */
  description: JobDescriptionValue;
  /** The OpenAPI component base: `Jobs<Key>`, with `Input` and `Output` after it. */
  component: string;
}

export type PublicJobCatalog = ReadonlyMap<string, PublicJob>;

function shapeOf(job: AnyJob, which: 'input' | 'output'): Shape<z.ZodObject> {
  const schema = job[which];
  if (!(schema instanceof z.ZodObject))
    throw new JobDefinitionError(
      `${job.key}: a public job's ${which} must be a zod object`,
    );
  try {
    return defineShape(schema);
  } catch (err) {
    throw new JobDefinitionError(
      `${job.key}: a public job's ${which} cannot be published (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

const jsonSchemaOf = (shape: Shape<z.ZodObject>, io: 'input' | 'output') =>
  z.toJSONSchema(shape.public, { io }) as Record<string, unknown>;

/**
 * Every public job of the registry. Throws `JobDefinitionError` for a public job whose input or output is not a
 * camelCase zod object, or two whose keys give one component name: the boot stops, rather than publish a job its
 * callers cannot read.
 */
export function publicJobCatalogOf(registry: Registry): PublicJobCatalog {
  const catalog = new Map<string, PublicJob>();
  const byComponent = new Map<string, string>();
  for (const job of registry.list()) {
    if (job.audience !== 'public') continue;
    const component = jobComponentBase(job.key);
    const clash = byComponent.get(component);
    if (clash)
      throw new JobDefinitionError(
        `${job.key} and ${clash} publish one component name, ${component}`,
      );
    byComponent.set(component, job.key);
    const input = shapeOf(job, 'input');
    const output = shapeOf(job, 'output');
    const described = registry.describe(job.key);
    // defineJob refuses a public job without limits.
    const limits = described.limits as JobLimits;
    catalog.set(job.key, {
      job,
      input,
      output,
      component,
      description: {
        key: described.key,
        version: described.version,
        steps: described.steps.map((s) =>
          s.kind === 'map'
            ? {
                name: s.name,
                kind: 'map',
                batchMax: s.batchMax,
                limiters: s.limiters,
              }
            : {
                name: s.name,
                kind: s.kind,
                batchMax: null,
                limiters: s.limiters,
              },
        ),
        input: jsonSchemaOf(input, 'input'),
        output: jsonSchemaOf(output, 'output'),
        authority: { ...described.authority },
        limits: { ...limits },
      },
    });
  }
  return catalog;
}

/** Each public job's two components: `Jobs<Key>Input` and `Jobs<Key>Output`, its shapes' snake_case schemas. */
export function jobOpenApiSchemasOf(
  catalog: PublicJobCatalog,
): Record<string, z.ZodType> {
  const schemas: Record<string, z.ZodType> = {};
  for (const { component, input, output } of catalog.values()) {
    schemas[`${component}Input`] = input.public;
    schemas[`${component}Output`] = output.public;
  }
  return schemas;
}
