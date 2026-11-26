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
import { z } from './zod';

export function fromZod3<Output>(schema: Zod3Type<Output, Zod3TypeDef, unknown>): z.ZodType<Output, unknown> {
	return z.unknown().transform((input, ctx) => {
		const result = schema.safeParse(input);
		if (result.success) return result.data;
		for (const issue of result.error.issues) {
			ctx.issues.push({ ...issue, input } as unknown as (typeof ctx.issues)[number]);
		}
		return z.NEVER;
	});
}
