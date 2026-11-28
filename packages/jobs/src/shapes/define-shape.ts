import { z } from 'zod';

/**
 * One definition per public shape. A shape is a zod object whose field names
 * are the public concepts in camelCase (`observationText`, never a column's
 * name); every public surface (REST, MCP) publishes it in snake_case. The
 * snake_case schema and the conversions are derived here, once, so a field is
 * named, bounded and described in one place and no surface restates it.
 *
 * The conversion is mechanical: each upper-case letter of a field name becomes
 * `_` and its lower-case (`lastBuyerTouchAt` → `last_buyer_touch_at`), with no
 * exceptions, through nested objects, arrays, records' values and the
 * optional, nullable and default wrappers. A record's own keys are data and
 * are never renamed. Zod schemas cannot be subclassed (every `.pick`, `.omit` or
 * `.extend` returns a plain `ZodObject`), so a composed shape is defined again
 * by calling `defineShape` on the composed schema.
 */

/** A camelCase field name in snake_case, as the type checker sees it. */
type SnakeCase<
  Name extends string,
  Done extends string = '',
> = Name extends `${infer Head}${infer Tail}`
  ? SnakeCase<
      Tail,
      `${Done}${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}`
    >
  : Done;

type PublicShapeOf<Shape extends z.core.$ZodShape> = {
  [Key in keyof Shape & string as SnakeCase<Key>]: PublicSchema<Shape[Key]>;
};

/** The snake_case schema of a camelCase one, as the type checker sees it. */
export type PublicSchema<Schema extends z.core.$ZodType> =
  Schema extends z.ZodObject<infer Shape, infer Config>
    ? z.ZodObject<PublicShapeOf<Shape>, Config>
    : Schema extends z.ZodOptional<infer Inner>
      ? z.ZodOptional<PublicSchema<Inner & z.core.$ZodType>>
      : Schema extends z.ZodNullable<infer Inner>
        ? z.ZodNullable<PublicSchema<Inner & z.core.$ZodType>>
        : Schema extends z.ZodDefault<infer Inner>
          ? z.ZodDefault<PublicSchema<Inner & z.core.$ZodType>>
          : Schema extends z.ZodArray<infer Item>
            ? z.ZodArray<PublicSchema<Item & z.core.$ZodType>>
            : Schema extends z.ZodRecord<infer Key, infer Value>
              ? z.ZodRecord<Key, PublicSchema<Value & z.core.$ZodType>>
              : Schema;

/** A shape: its camelCase schema, the snake_case one every surface publishes, and the two conversions. */
export type Shape<Schema extends z.ZodObject> = Schema & {
  /** The snake_case schema, every field's bounds and description kept. */
  readonly public: PublicSchema<Schema>;
  /** A camelCase value as the public snake_case value; fields the shape does not name are dropped, as zod strips them. */
  toPublic(value: z.output<Schema>): z.output<PublicSchema<Schema>>;
  /** A public snake_case value (an input the public schema accepted) as the camelCase value. */
  fromPublic(value: z.output<PublicSchema<Schema>>): z.output<Schema>;
};

/** A shape's field names: the public concept, camelCase, letters and digits only. */
const FIELD_NAME = /^[a-z][a-zA-Z0-9]*$/;

/** A camelCase field name in snake_case. */
export function snakeCaseOf(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Define a public shape: the schema itself (a copy, so a schema defined
 * elsewhere is never changed) with `.public`, `.toPublic` and `.fromPublic`.
 * Throws when a field name is not camelCase, or when a nested object sits
 * where the conversion cannot follow it (inside a union, an effect or a
 * lazy schema).
 */
export function defineShape<Schema extends z.ZodObject>(
  schema: Schema,
): Shape<Schema> {
  const own = rebuilt(schema, {});
  const publicSchema = publicSchemaOf(own) as PublicSchema<Schema>;
  return Object.assign(own, {
    public: publicSchema,
    toPublic: (value: z.output<Schema>) =>
      converted(own, value, 'toPublic') as z.output<PublicSchema<Schema>>,
    fromPublic: (value: z.output<PublicSchema<Schema>>) =>
      converted(own, value, 'fromPublic') as z.output<Schema>,
  });
}

/** A copy of a schema with some of its definition replaced. */
function rebuilt<Schema extends z.ZodType>(
  schema: Schema,
  replaced: Record<string, unknown>,
): Schema {
  const copy = schema.clone({
    ...schema._zod.def,
    ...replaced,
  } as Schema['_zod']['def']);
  const metadata = z.globalRegistry.get(schema);
  if (metadata) z.globalRegistry.add(copy, metadata);
  return copy;
}

function publicSchemaOf(schema: z.core.$ZodType): z.core.$ZodType {
  if (schema instanceof z.ZodObject) {
    if (schema._zod.def.checks?.length)
      throw new Error(
        'defineShape: an object inside a refinement cannot be converted; define it as a plain field',
      );
    const publicShape: Record<string, z.core.$ZodType> = {};
    for (const [name, field] of Object.entries(schema.shape)) {
      if (!FIELD_NAME.test(name)) {
        throw new Error(
          `defineShape: "${name}" is not a camelCase field name; name the public concept in camelCase`,
        );
      }
      publicShape[snakeCaseOf(name)] = publicSchemaOf(field);
    }
    return rebuilt(schema, { shape: publicShape });
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return rebuilt(schema, {
      innerType: publicSchemaOf(schema._zod.def.innerType),
    });
  if (schema instanceof z.ZodArray)
    return rebuilt(schema, { element: publicSchemaOf(schema.element) });
  if (schema instanceof z.ZodRecord)
    return rebuilt(schema, { valueType: publicSchemaOf(schema.valueType) });
  assertNoObjectInside(schema);
  return schema;
}

/** A value converted along its schema, field names renamed in the given direction. */
function converted(
  schema: z.core.$ZodType,
  value: unknown,
  direction: 'toPublic' | 'fromPublic',
): unknown {
  if (value === null || value === undefined) return value;
  if (schema instanceof z.ZodObject)
    return convertedObject(schema, value, direction);
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return converted(schema._zod.def.innerType, value, direction);
  if (schema instanceof z.ZodArray)
    return Array.isArray(value)
      ? value.map((item) => converted(schema.element, item, direction))
      : value;
  if (schema instanceof z.ZodRecord)
    return isPlainObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            converted(schema.valueType, item, direction),
          ]),
        )
      : value;
  return value;
}

/**
 * An object's fields in the value's own order, each renamed and converted by
 * its field schema. A field the shape does not name is dropped, unless the
 * object passes unknown keys through, when it keeps its value and is renamed
 * the same way.
 */
function convertedObject(
  schema: z.ZodObject,
  value: unknown,
  direction: 'toPublic' | 'fromPublic',
): unknown {
  if (!isPlainObject(value)) return value;
  const fieldOf = new Map<string, { name: string; field: z.core.$ZodType }>(
    Object.entries(schema.shape).map(([name, field]) => [
      direction === 'toPublic' ? name : snakeCaseOf(name),
      { name: direction === 'toPublic' ? snakeCaseOf(name) : name, field },
    ]),
  );
  const passthrough = schema._zod.def.catchall instanceof z.ZodUnknown;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const known = fieldOf.get(key);
    if (known) {
      result[known.name] = converted(known.field, item, direction);
    } else if (passthrough) {
      result[direction === 'toPublic' ? snakeCaseOf(key) : key] = item;
    }
  }
  return result;
}

/**
 * Wrappers the conversion does not follow (unions, effects, lazy schemas …)
 * may hold leaves only: an object inside one would keep its camelCase names
 * on the public side.
 */
function assertNoObjectInside(schema: z.core.$ZodType): void {
  if (schema instanceof z.ZodObject)
    throw new Error(
      'defineShape: an object inside a union, effect or lazy schema cannot be converted; define it as a plain field',
    );
  const inner: z.core.$ZodType[] = [];
  if (schema instanceof z.ZodUnion) inner.push(...schema.options);
  else if (schema instanceof z.ZodIntersection)
    inner.push(schema._zod.def.left, schema._zod.def.right);
  else if (schema instanceof z.ZodLazy) inner.push(schema._zod.def.getter());
  else if (schema instanceof z.ZodPipe)
    inner.push(schema._zod.def.in, schema._zod.def.out);
  else if (schema instanceof z.ZodTuple) inner.push(...schema._zod.def.items);
  else if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly
  )
    inner.push(schema._zod.def.innerType);
  else if (schema instanceof z.ZodArray) inner.push(schema.element);
  else if (schema instanceof z.ZodRecord) inner.push(schema.valueType);
  for (const item of inner) assertNoObjectInside(item);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}
