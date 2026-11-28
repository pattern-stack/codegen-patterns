/**
 * Events under `wiring: pattern-stack` (S-1): the generated typed bus loads no Nest, package-mode imports and the registry
 * augmentation go through the Nest-free `…/events/core`, the subsystem schema barrel re-exports `domain_events` from it,
 * and `subsystem install` refuses what has no Nest-free system yet. The Nest output is unchanged.
 */
import { describe, expect, it } from 'bun:test';

import { buildBusContent, buildTypesContent } from '../../cli/shared/event-codegen-generator';
import { buildSubsystemSchemaBarrel } from '../../cli/shared/subsystem-schema-generator';
import {
	PATTERN_STACK_SUBSYSTEMS,
	patternStackFileFilter,
	patternStackSubsystemRefusal,
} from '../../cli/shared/pattern-stack-subsystems';
import type { EventDefinition } from '../../schema/event-definition.schema';

const NEST = /@nestjs\/|@Inject|@Injectable/;
const event = { type: 'invoice_created', payload: {} } as unknown as EventDefinition;

describe('the typed bus under pattern-stack wiring', () => {
	it('has no decorators and no tokens; the multi-tenant flag defaults to false', () => {
		for (const mode of ['vendored', 'package'] as const) {
			const bus = buildBusContent([], mode, 'pattern-stack');
			expect(bus).not.toMatch(NEST);
			expect(bus).not.toContain('EVENT_BUS');
			expect(bus).toContain('private readonly multiTenant: boolean = false,');
		}
	});

	it('imports through events/core in package mode', () => {
		const bus = buildBusContent([], 'package', 'pattern-stack');
		expect(bus).toContain("from '@pattern-stack/codegen/runtime/subsystems/events/core'");
		expect(bus).not.toContain('/events/index');
	});

	it("augments events/core's DomainEventRegistry in package mode", () => {
		const types = buildTypesContent([event], 'package', 'pattern-stack');
		expect(types).toContain("declare module '@pattern-stack/codegen/runtime/subsystems/events/core' {");
	});

	it('leaves the Nest bus as it was', () => {
		expect(buildBusContent([], 'vendored')).toBe(buildBusContent([], 'vendored', 'nest'));
		expect(buildBusContent([], 'vendored')).toContain('@Injectable()');
	});
});

describe('the subsystem schema barrel under pattern-stack wiring', () => {
	const events = [{ name: 'events', path: '/x', backend: 'drizzle', status: 'installed' }] as Parameters<
		typeof buildSubsystemSchemaBarrel
	>[0];
	it('re-exports domain_events from events/core', () => {
		expect(buildSubsystemSchemaBarrel(events, '../shared/subsystems', 'vendored', 'pattern-stack').content).toContain(
			"export { domainEvents } from '../shared/subsystems/events/core';",
		);
		expect(buildSubsystemSchemaBarrel(events, '', 'package', 'pattern-stack').content).toContain(
			"from '@pattern-stack/codegen/runtime/subsystems/events/core';",
		);
		expect(buildSubsystemSchemaBarrel(events, '../shared/subsystems', 'vendored').content).toContain(
			"from '../shared/subsystems/events';",
		);
	});
});

describe('subsystem install under pattern-stack wiring', () => {
	it('installs events on drizzle or memory; refuses redis and every other subsystem, naming its step', () => {
		expect(patternStackSubsystemRefusal('events', 'drizzle')).toBeNull();
		expect(patternStackSubsystemRefusal('events', 'memory')).toBeNull();
		expect(patternStackSubsystemRefusal('events', 'redis')).toMatch(/redis backend/);
		expect(patternStackSubsystemRefusal('jobs', 'drizzle')).toMatch(/comes with J-1\. Supported: events, openapi-config\./);
		expect(patternStackSubsystemRefusal('auth', 'drizzle')).toMatch(/comes with S-2/);
		// Config-only: the `openapi:` block, which pattern-stack's openapi.ts reads too.
		expect(patternStackSubsystemRefusal('openapi-config', 'drizzle')).toBeNull();
	});

	it("vendors no Nest file: the module, the barrel that re-exports it, the bundled generated set", () => {
		const filter = patternStackFileFilter('events', () => true);
		for (const f of ['events.module.ts', 'index.ts', 'generated/bus.ts', 'bus.ts']) expect(filter(f)).toBe(false);
		for (const f of ['core.ts', 'event-bus.drizzle-backend.ts', 'event-registry.ts', 'events-options.ts']) {
			expect(filter(f)).toBe(true);
		}
	});

	it('has one row per subsystem; each it installs names the entry file detection keys on', () => {
		const events = PATTERN_STACK_SUBSYSTEMS.events;
		expect('entryFile' in events && events.entryFile).toBe('core.ts');
		// The entry file is vendored: the row's skips never drop it.
		expect(patternStackFileFilter('events', () => true)('core.ts')).toBe(true);
	});
});
