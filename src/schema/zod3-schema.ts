/**
 * A Zod 3 schema inside a Zod 4 one (ZOD-0).
 *
 * Codegen's own schemas are Zod 4 (`src/schema/zod.ts`). A few schemas they embed live under `runtime/`, which emitted apps import
 * and parse with their own `zod` — still Zod 3 until the generated code moves (ZOD-0 step 2, a major). Those schemas
 * keep one owner, the runtime file; codegen hosts them through this bridge rather than restating them on Zod 4:
 *
 * - the value parses with the Zod 3 schema, so its defaults and messages are the runtime parser's own;
 * - each Zod 3 issue is passed up unchanged (code, message, `keys`), so its path joins the outer schema's path the way
 *   a native issue's does.
 *
 * Today's use: `DetectionConfigSchema` (`runtime/subsystems/integration`) under an entity's `detection:` and a job
 * arm's `read:`. Delete this file when `runtime/` moves to Zod 4.
 */

import type { ZodType as Zod3Type, ZodTypeDef as Zod3TypeDef } from 'zod';
import { editorHints, z } from './zod';

/**
 * Host `schema` in a Zod 4 schema. `description` is what an editor shows on the value; the editor's shape (keys, and
 * a discriminator's values) is read from the Zod 3 schema itself, so it cannot drift from the runtime's.
 */
export function fromZod3<Output>(
	schema: Zod3Type<Output, Zod3TypeDef, unknown>,
	description: string,
): z.ZodType<Output, unknown> {
	const hosted = z.unknown().transform((input, ctx) => {
		const result = schema.safeParse(input);
		if (result.success) return result.data;
		for (const issue of result.error.issues) {
			ctx.issues.push({ ...issue, input } as unknown as (typeof ctx.issues)[number]);
		}
		return z.NEVER;
	});
	return hosted.register(editorHints, { jsonSchema: { description, ...editorShapeOf(schema) } });
}

/**
 * The JSON Schema an editor can use for a Zod 3 object or discriminated union of objects: `type: object`, the keys
 * (any value), the keys every option requires, and the discriminator's values as an `enum`. Deliberately shallow —
 * the hosted parse is the check; this is for completion. Anything else: `{}`.
 */
function editorShapeOf(schema: unknown): Record<string, unknown> {
	const def = (schema as { _def?: { typeName?: string } })._def;
	const options: Array<{ shape: Record<string, { isOptional(): boolean; _def: { value?: unknown } }> }> =
		def?.typeName === 'ZodDiscriminatedUnion'
			? (schema as { options: [] }).options
			: def?.typeName === 'ZodObject'
				? [schema as never]
				: [];
	if (options.length === 0) return {};
	const discriminator =
		def?.typeName === 'ZodDiscriminatedUnion' ? (schema as { discriminator: string }).discriminator : undefined;
	const keys = [...new Set(options.flatMap((o) => Object.keys(o.shape)))];
	const required = keys.filter((k) => options.every((o) => o.shape[k] !== undefined && !o.shape[k]!.isOptional()));
	const properties = Object.fromEntries(
		keys.map((k) => [
			k,
			k === discriminator ? { enum: options.map((o) => o.shape[k]!._def.value) } : {},
		]),
	);
	return { type: 'object', properties, required };
}
