/**
 * Unit tests for fieldTypeToZod mapping — issue #43
 *
 * PG `numeric` columns are returned by Drizzle as strings (precision
 * preservation). Using z.coerce.string() — not z.coerce.number() — ensures
 * the DTO type aligns with the Drizzle runtime value and prevents silent
 * precision loss on large decimal values.
 *
 * The clean-lite-ps DTO templates read this map (fixed in PR #42, commit e1729e5).
 */

import { describe, it, expect } from 'bun:test';
import { fieldTypeToZod } from '../../schema/entity-definition.schema';

// ============================================================================
// fieldTypeToZod map (schema-level export)
// ============================================================================

describe('fieldTypeToZod — decimal field (issue #43)', () => {
	it('maps decimal to z.coerce.string() to preserve Drizzle numeric precision', () => {
		expect(fieldTypeToZod.decimal).toBe('z.coerce.string()');
	});

	it('does not map decimal to z.coerce.number() (would silently lose precision)', () => {
		expect(fieldTypeToZod.decimal).not.toBe('z.coerce.number()');
	});

	it('does not map decimal to bare z.number() (would fail on string input from Drizzle)', () => {
		expect(fieldTypeToZod.decimal).not.toBe('z.number()');
	});

	it('json stays z.unknown() — unaffected by decimal fix', () => {
		expect(fieldTypeToZod.json).toBe('z.unknown()');
	});
});
