/**
 * Events under `wiring: pattern-stack` (S-1): the generated typed bus loads no Nest, package-mode imports and the registry
 * augmentation go through the Nest-free `…/events/core`, the subsystem schema barrel re-exports `domain_events` from it,
 * and `subsystem install` refuses what has no Nest-free system yet. The Nest output is unchanged.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { buildBusContent, buildTypesContent } from '../../cli/shared/event-codegen-generator';
import { buildSubsystemSchemaBarrel } from '../../cli/shared/subsystem-schema-generator';
import {
	PATTERN_STACK_SUBSYSTEMS,
	patternStackFileFilter,
	patternStackSubsystemRefusal,
} from '../../cli/shared/pattern-stack-subsystems';
import { backendFileFilter } from '../../cli/commands/subsystem';
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
		expect(patternStackSubsystemRefusal('jobs', 'drizzle')).toMatch(/comes with J-1\. Supported: events, openapi-config, integration\./);
		expect(patternStackSubsystemRefusal('auth', 'drizzle')).toMatch(/comes with S-2/);
		// S-3: integration on either backend.
		expect(patternStackSubsystemRefusal('integration', 'drizzle')).toBeNull();
		expect(patternStackSubsystemRefusal('integration', 'memory')).toBeNull();
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

	it("integration (S-3) vendors no Nest file either: the module, the barrel, Nest's use case", () => {
		const filter = patternStackFileFilter('integration', () => true);
		for (const f of ['integration.module.ts', 'index.ts', 'execute-integration.use-case.ts']) expect(filter(f)).toBe(false);
		for (const f of ['core.ts', 'integration-runner.ts', 'integration-cursor-store.drizzle-backend.ts', 'deep-equal.differ.ts']) {
			expect(filter(f)).toBe(true);
		}
	});
});

/**
 * What `subsystem install <name> --backend <b>` vendors under pattern-stack: the runtime folder's files through the
 * install's filter, plus the schema its Hygen template writes on every backend. Every file the pattern-stack code
 * imports (core.ts, and on drizzle the backends the system imports by path) must reach its whole relative-import
 * closure inside that set, or the project does not compile (a memory install once pruned detection-config.schema.ts).
 */
describe('a pattern-stack install vendors what its entries import', () => {
	const RUNTIME = path.resolve(import.meta.dir, '../../../runtime/subsystems');
	const HYGEN_SCHEMA: Record<string, string> = {
		events: 'domain-events.schema.ts',
		integration: 'integration-audit.schema.ts',
	};
	const ENTRIES: Record<string, Record<'drizzle' | 'memory', string[]>> = {
		events: { drizzle: ['core.ts', 'event-bus.drizzle-backend.ts'], memory: ['core.ts', 'event-bus.memory-backend.ts'] },
		integration: {
			drizzle: ['core.ts', 'integration-cursor-store.drizzle-backend.ts', 'integration-run-recorder.drizzle-backend.ts'],
			memory: ['core.ts'],
		},
	};
	for (const name of ['events', 'integration'] as const) {
		for (const backend of ['drizzle', 'memory'] as const) {
			it(`${name} on ${backend}`, () => {
				const dir = path.join(RUNTIME, name);
				const filter = patternStackFileFilter(name, backendFileFilter(backend, name));
				const vendored = new Set([...fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && filter(f)), HYGEN_SCHEMA[name]!]);
				const missing: string[] = [];
				const seen = new Set<string>();
				const visit = (file: string) => {
					if (seen.has(file)) return;
					seen.add(file);
					if (!vendored.has(file)) {
						missing.push(file);
						return;
					}
					for (const { fileName } of ts.preProcessFile(fs.readFileSync(path.join(dir, file), 'utf8'), true, true).importedFiles) {
						// Only this folder: `../../` reaches the shared runtime, which copyRuntime resolves as dependencies.
						if (fileName.startsWith('./')) visit(`${fileName.slice(2).replace(/\.js$/, '')}.ts`);
					}
				};
				for (const entry of ENTRIES[name]![backend]) visit(entry);
				expect(missing).toEqual([]);
			});
		}
	}
});

/** The config block prints the installed backend, which the system (and the Nest module) builds: a memory install's
 * block must not say `drizzle`, or the system imports the Drizzle backends the install pruned. */
describe('the events and integration config blocks print the installed backend', () => {
	const TEMPLATES = path.resolve(import.meta.dir, '../../../templates/subsystem');
	for (const name of ['events', 'integration'] as const) {
		it(name, async () => {
			const prompt = (await import(path.join(TEMPLATES, `${name}-config/prompt.js`))).default.prompt;
			expect((await prompt({ args: { backend: 'memory' } })).backend).toBe('memory');
			expect((await prompt({ args: {} })).backend).toBe('drizzle');
			const block = fs.readFileSync(path.join(TEMPLATES, `${name}-config/codegen-config-${name}-block.ejs.t`), 'utf8');
			expect(block).toContain('\n  backend: <%= backend %>\n');
		});
	}
});
