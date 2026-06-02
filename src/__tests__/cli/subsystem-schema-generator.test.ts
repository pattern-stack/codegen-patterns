/**
 * Subsystem schema barrel generator tests (ADR-037 / package-mode brief #9).
 *
 * Cover:
 *   - empty installed set → `export {};`
 *   - package mode → re-exports tables + pgEnums from package subpaths
 *   - events contributes a table but NO pgEnum (text-enums → no CREATE TYPE)
 *   - jobs / bridge / integration contribute their pgEnums
 *   - vendored mode → re-exports from the consumer's per-subsystem barrel
 *   - `incomplete` subsystems are excluded
 */

import { describe, test, expect } from 'bun:test';

import { buildSubsystemSchemaBarrel } from '../../cli/shared/subsystem-schema-generator.js';
import type { InstalledSubsystem } from '../../cli/shared/subsystem-detect.js';

function inst(
	name: InstalledSubsystem['name'],
	status: InstalledSubsystem['status'] = 'installed',
): InstalledSubsystem {
	return { name, path: `/fake/${name}`, backend: 'drizzle', status };
}

describe('buildSubsystemSchemaBarrel', () => {
	const subsystemsRel = './shared/subsystems';

	test('empty installed set produces an empty module', () => {
		const out = buildSubsystemSchemaBarrel([], subsystemsRel, 'package');
		expect(out.emitted).toEqual([]);
		expect(out.content).toContain('export {};');
	});

	test('package mode re-exports tables + enums from package subpaths', () => {
		const out = buildSubsystemSchemaBarrel(
			[inst('events'), inst('jobs'), inst('bridge'), inst('integration')],
			subsystemsRel,
			'package',
		);
		expect(out.emitted).toEqual(['events', 'jobs', 'bridge', 'integration']);

		// events: domainEvents table, NO enum (text-enum columns).
		expect(out.content).toContain(
			"export { domainEvents } from '@pattern-stack/codegen/runtime/subsystems/events/index';",
		);

		// jobs: 3 tables + 8 pgEnums.
		expect(out.content).toContain('jobs, jobRuns, jobSteps');
		expect(out.content).toContain('jobRunStatusEnum');
		expect(out.content).toContain('triggerSourceEnum');
		expect(out.content).toContain(
			"from '@pattern-stack/codegen/runtime/subsystems/jobs/index';",
		);

		// bridge: table + 1 pgEnum.
		expect(out.content).toContain('bridgeDelivery, bridgeDeliveryStatusEnum');
		expect(out.content).toContain(
			"from '@pattern-stack/codegen/runtime/subsystems/bridge/index';",
		);

		// integration: 3 tables + 5 pgEnums.
		expect(out.content).toContain('integrationRuns');
		expect(out.content).toContain('integrationRunDirectionEnum');
		expect(out.content).toContain('integrationRunItemStatusEnum');

		// package mode must never reference the vendored relative path.
		expect(out.content).not.toContain('./shared/subsystems/');
	});

	test('events contributes a table but emits no pgEnum (text-enums → no CREATE TYPE)', () => {
		const out = buildSubsystemSchemaBarrel([inst('events')], subsystemsRel, 'package');
		// Inspect the export line only — the HEADER comment legitimately mentions
		// "CREATE TYPE"; the assertion is about the emitted symbol set.
		const exportLine = out.content
			.split('\n')
			.find((l) => l.startsWith('export {'));
		expect(exportLine).toContain('domainEvents');
		expect(exportLine).not.toContain('Enum');
	});

	test('vendored mode re-exports from the consumer per-subsystem barrel', () => {
		const out = buildSubsystemSchemaBarrel(
			[inst('jobs')],
			subsystemsRel,
			'vendored',
		);
		const exportLine = out.content
			.split('\n')
			.find((l) => l.startsWith('export {')) as string;
		expect(exportLine).toContain("from './shared/subsystems/jobs';");
		// The package specifier must not appear in the EXPORT line (the header
		// banner legitimately contains the package name).
		expect(exportLine).not.toContain('@pattern-stack/codegen');
	});

	test('an `incomplete` subsystem is excluded from the schema barrel', () => {
		const out = buildSubsystemSchemaBarrel(
			[inst('events'), inst('bridge', 'incomplete')],
			subsystemsRel,
			'package',
		);
		expect(out.emitted).toEqual(['events']);
		expect(out.content).not.toContain('bridgeDelivery');
	});
});
