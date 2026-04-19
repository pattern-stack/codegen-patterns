/**
 * Field type → Zod mapping tests
 *
 * Regression coverage for issue #43: Drizzle returns PG `numeric`
 * (YAML `decimal`) as a JS string, so the emitted Zod schema must not
 * be `z.number()` (runtime mismatch at the DTO boundary). Mirrors the
 * clean-lite-ps fix in #35/PR #42.
 */

import { describe, expect, it } from "bun:test";
import { fieldTypeToZod } from "../../schema/entity-definition.schema";

describe("fieldTypeToZod (Clean Architecture)", () => {
	it("maps decimal to a coerced string (issue #43)", () => {
		// Drizzle returns `numeric` as a JS string. Keeping the Zod type a
		// string preserves precision and avoids the string-leak bug.
		expect(fieldTypeToZod.decimal).toBe("z.coerce.string()");
		expect(fieldTypeToZod.decimal).not.toBe("z.number()");
	});

	it("keeps json as z.unknown() (already fixed alongside #35)", () => {
		expect(fieldTypeToZod.json).toBe("z.unknown()");
	});

	it("maps integer to z.number().int()", () => {
		expect(fieldTypeToZod.integer).toBe("z.number().int()");
	});
});
