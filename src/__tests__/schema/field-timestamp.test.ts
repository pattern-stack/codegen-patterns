import { describe, expect, it } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import {
	TIMEZONE_ON_NON_DATETIME_MESSAGE,
	fieldWithTimezone,
	timestampColumn,
	timezoneOnNonDatetime,
} from '../../schema/field-timestamp';

describe('field-timestamp rule (#796)', () => {
	it('fieldWithTimezone: datetime is tz unless timezone:false', () => {
		expect(fieldWithTimezone({ type: 'datetime' })).toBe(true);
		expect(fieldWithTimezone({ type: 'datetime', timezone: true })).toBe(true);
		expect(fieldWithTimezone({ type: 'datetime', timezone: false })).toBe(false);
		expect(fieldWithTimezone({ type: 'string' })).toBe(false);
	});

	it('timezoneOnNonDatetime', () => {
		expect(timezoneOnNonDatetime({ type: 'string', timezone: false })).toBe(true);
		expect(timezoneOnNonDatetime({ type: 'date', timezone: true })).toBe(true);
		expect(timezoneOnNonDatetime({ type: 'datetime', timezone: false })).toBe(false);
		expect(timezoneOnNonDatetime({ type: 'string' })).toBe(false);
		expect(timezoneOnNonDatetime({ type: 'string', timezone: null })).toBe(false);
	});

	it('timestampColumn', () => {
		expect(timestampColumn('created_at')).toBe(
			"timestamp('created_at', { withTimezone: true, mode: 'date' })",
		);
		expect(timestampColumn('opens_at', false)).toBe("timestamp('opens_at')");
	});

	const entityWith = (field: Record<string, unknown>) => ({
		entity: { name: 'appointment', plural: 'appointments', table: 'appointments', pattern: 'Base' },
		fields: { f: field },
	});

	it('schema accepts timezone on datetime, rejects it elsewhere', () => {
		expect(EntityDefinitionSchema.safeParse(entityWith({ type: 'datetime', timezone: false })).success).toBe(true);
		const bad = EntityDefinitionSchema.safeParse(entityWith({ type: 'string', timezone: false }));
		expect(bad.success).toBe(false);
		if (!bad.success) {
			const issue = bad.error.issues.find((i) => i.message === TIMEZONE_ON_NON_DATETIME_MESSAGE);
			expect(issue).toBeDefined();
			expect(issue!.path.slice(-1)).toEqual(['timezone']);
		}
	});
});
