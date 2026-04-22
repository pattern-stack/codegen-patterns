/**
 * Unit tests for the BRIDGE-9 fanout-discovery CLI (`codegen events
 * consumers <type>`). Fixture-driven: each test writes a temporary src/
 * tree + an optional events/generated/registry.ts stub, runs the scan, and
 * asserts on the emitted report or scan-result shape.
 *
 * Coverage targets:
 *   - happy path: all three tiers populated → exact lines + ordering
 *   - empty event type registered + zero consumers → "(no consumers found)"
 *   - unknown event type → suggestions populated; warn-to-stderr asserted
 *     by checking the scan-result shape (CLI surfaces console.warn separately)
 *   - fallback warn path: zero Tier 2 hits + EventFlowService imported
 *   - empty-tier rendering (`(none)` bullets present)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	renderConsumerReport,
	runConsumersScan,
	scanDirectoryForConsumers,
	scanSourceFileForConsumers,
	suggestEventTypes,
} from '../../cli/commands/events.js';
import ts from 'typescript';

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `events-consumers-${prefix}-`));
}

function writeFile(root: string, rel: string, content: string): string {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

function writeEventsRegistry(cwd: string, eventTypes: string[]): string {
	const dir = path.join(cwd, 'src/shared/subsystems/events/generated');
	fs.mkdirSync(dir, { recursive: true });
	const lines: string[] = [
		"// AUTO-GENERATED",
		"import type { EventTypeName } from './types';",
		'export const eventRegistry = {',
		...eventTypes.map(
			(t) => `\t'${t}': {\n\t\ttype: '${t}',\n\t},`,
		),
		'} as const satisfies Record<EventTypeName, unknown>;',
	];
	fs.writeFileSync(path.join(dir, 'registry.ts'), lines.join('\n'));
	return dir;
}

function parse(text: string, name = 'fixture.ts'): ts.SourceFile {
	return ts.createSourceFile(
		name,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('scanSourceFileForConsumers', () => {
	test('matches publishAndStart calls with string-literal event types', () => {
		const sf = parse(`
			class Signup {
				constructor(private eventFlow: any) {}
				async run() {
					await this.eventFlow.publishAndStart('user.created', 'send_email', {});
				}
			}
		`);
		const out = scanSourceFileForConsumers(sf, '/x/signup.ts', 'user.created');
		expect(out.tier2.length).toBe(1);
		expect(out.tier2[0].receiverText).toBe('this.eventFlow');
		expect(out.tier1.length).toBe(0);
	});

	test('does not match calls with mismatched event-type literal', () => {
		const sf = parse(`
			eventFlow.publishAndStart('other.event', 'job', {});
		`);
		const out = scanSourceFileForConsumers(sf, '/x.ts', 'user.created');
		expect(out.tier2.length).toBe(0);
	});

	test('matches @OnEvent decorators on methods', () => {
		const sf = parse(`
			class MetricsListener {
				@OnEvent('user.created')
				onCreate() {}
			}
		`);
		const out = scanSourceFileForConsumers(sf, '/x/metrics.ts', 'user.created');
		expect(out.tier1.length).toBe(1);
		expect(out.tier1[0].kind).toBe('on-event');
		expect(out.tier1[0].siteLabel).toContain('MetricsListener.onCreate');
	});

	test('matches subscribe() calls', () => {
		const sf = parse(`
			eventBus.subscribe('user.created', (e) => { /* ... */ });
		`);
		const out = scanSourceFileForConsumers(sf, '/x/sub.ts', 'user.created');
		expect(out.tier1.length).toBe(1);
		expect(out.tier1[0].kind).toBe('subscribe');
		expect(out.tier1[0].siteLabel).toContain("eventBus.subscribe('user.created'");
	});

	test('detects EventFlowService import via named binding', () => {
		const sf = parse(`
			import { EventFlowService } from '@shared/subsystems/bridge';
			class X {}
		`);
		const out = scanSourceFileForConsumers(sf, '/x.ts', 'user.created');
		expect(out.hasEventFlowImport).toBe(true);
	});

	test('detects EventFlowService import via subsystems/bridge module path', () => {
		const sf = parse(`
			import { foo } from './subsystems/bridge/index';
		`);
		const out = scanSourceFileForConsumers(sf, '/x.ts', 'user.created');
		expect(out.hasEventFlowImport).toBe(true);
	});

	test('hasEventFlowImport is false when bridge is absent', () => {
		const sf = parse(`
			import { TYPED_EVENT_BUS } from '@shared/subsystems/events';
		`);
		const out = scanSourceFileForConsumers(sf, '/x.ts', 'user.created');
		expect(out.hasEventFlowImport).toBe(false);
	});
});

describe('runConsumersScan + renderConsumerReport', () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpDir('scan');
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	test('happy path — all three tiers populated', () => {
		writeEventsRegistry(cwd, ['user.created']);

		// Tier 3 — handler with a trigger
		writeFile(
			cwd,
			'src/jobs/send-welcome-email.job.ts',
			`
import { JobHandler } from '../jobs/job-handler.base';

@JobHandler<{}>('send_welcome_email', {
  triggers: [
    { event: 'user.created', map: (e) => ({ userId: e.aggregateId }) },
  ],
})
export class SendWelcomeEmailJob {}
			`.trim(),
		);

		// Tier 2 — publishAndStart call site
		writeFile(
			cwd,
			'src/use-cases/signup.uc.ts',
			`
import { EventFlowService } from '@shared/subsystems/bridge';

export class SignupUseCase {
  constructor(private eventFlow: EventFlowService) {}
  async run() {
    await this.eventFlow.publishAndStart('user.created', 'provision', {});
  }
}
			`.trim(),
		);

		// Tier 1 — @OnEvent subscriber
		writeFile(
			cwd,
			'src/observability/metrics.ts',
			`
export class MetricsListener {
  @OnEvent('user.created')
  onCreate() {}
}
			`.trim(),
		);

		const result = runConsumersScan({
			cwd,
			config: null,
			eventType: 'user.created',
		});

		expect(result.knownEventType).toBe(true);
		expect(result.tier3.length).toBe(1);
		expect(result.tier3[0].triggerId).toBe('send_welcome_email#0');
		expect(result.tier2.length).toBe(1);
		expect(result.tier1.length).toBe(1);

		const lines = renderConsumerReport(result, cwd);
		const out = lines.join('\n');
		expect(out).toContain('Event: user.created');
		expect(out).toContain('Tier 3 — Bridge triggers (1):');
		expect(out).toContain('send_welcome_email#0');
		expect(out).toContain('Tier 2 — Direct invoke via publishAndStart (1):');
		expect(out).toContain('src/use-cases/signup.uc.ts:');
		expect(out).toContain('Tier 1 — Subscribers (1):');
		expect(out).toContain('MetricsListener.onCreate');
		expect(out).not.toContain('(no consumers found)');
	});

	test('empty case — registered event type with zero consumers', () => {
		writeEventsRegistry(cwd, ['user.created']);
		// No handler, no publishAndStart, no @OnEvent.
		writeFile(cwd, 'src/empty.ts', `export const x = 1;`);

		const result = runConsumersScan({
			cwd,
			config: null,
			eventType: 'user.created',
		});

		expect(result.knownEventType).toBe(true);
		expect(result.tier3.length).toBe(0);
		expect(result.tier2.length).toBe(0);
		expect(result.tier1.length).toBe(0);

		const lines = renderConsumerReport(result, cwd);
		const out = lines.join('\n');
		expect(out).toContain('Event: user.created');
		expect(out).toContain('(no consumers found)');
		// All three tier sections render with the (none) bullet for greppability.
		expect(out).toContain('Tier 3 — Bridge triggers (0):');
		expect(out).toContain('Tier 2 — Direct invoke via publishAndStart (0):');
		expect(out).toContain('Tier 1 — Subscribers (0):');
		expect((out.match(/\(none\)/g) ?? []).length).toBe(3);
	});

	test('unknown event type — knownEventType=false + suggestions populated', () => {
		writeEventsRegistry(cwd, ['user.created', 'user.deleted', 'user.updated']);

		const result = runConsumersScan({
			cwd,
			config: null,
			eventType: 'user.craeted', // typo
		});

		expect(result.knownEventType).toBe(false);
		expect(result.suggestions).toContain('user.created');
		expect(result.suggestions.length).toBeLessThanOrEqual(3);
	});

	test('fallback warn path — zero Tier 2 hits but EventFlowService imported', () => {
		writeEventsRegistry(cwd, ['user.created']);
		// File imports EventFlowService but never calls publishAndStart.
		writeFile(
			cwd,
			'src/x.ts',
			`
import { EventFlowService } from '@shared/subsystems/bridge';
export const noop = (x: EventFlowService) => x;
			`.trim(),
		);

		const result = runConsumersScan({
			cwd,
			config: null,
			eventType: 'user.created',
		});

		expect(result.tier2.length).toBe(0);
		expect(result.eventFlowServicePresent).toBe(true);
		// CLI command surfaces this as a console.warn — the scan-result shape is
		// what the command checks before warning. (Command-level warn is asserted
		// indirectly: any non-zero `eventFlowServicePresent` with empty tier2
		// triggers it.)
	});
});

describe('renderConsumerReport empty-tier formatting', () => {
	test('shows `(none)` for each empty tier', () => {
		const lines = renderConsumerReport(
			{
				eventType: 'x.y',
				tier3: [],
				tier2: [],
				tier1: [],
				eventFlowServicePresent: false,
				knownEventType: true,
				suggestions: [],
			},
			'/cwd',
		);
		const out = lines.join('\n');
		expect((out.match(/- \(none\)/g) ?? []).length).toBe(3);
	});
});

describe('suggestEventTypes', () => {
	test('returns closest matches by edit distance', () => {
		const out = suggestEventTypes(
			'user.craeted',
			['user.created', 'user.updated', 'order.placed'],
			3,
		);
		expect(out[0]).toBe('user.created');
	});

	test('respects the limit', () => {
		const out = suggestEventTypes(
			'x',
			['a', 'b', 'c', 'd', 'e'],
			2,
		);
		expect(out.length).toBe(2);
	});

	test('returns [] when no known types', () => {
		expect(suggestEventTypes('x', [], 3)).toEqual([]);
	});
});

describe('scanDirectoryForConsumers', () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpDir('dir');
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	test('skips node_modules + generated/ trees', () => {
		writeFile(
			cwd,
			'src/a.ts',
			`eventBus.subscribe('x.y', () => {});`,
		);
		writeFile(
			cwd,
			'src/node_modules/dep/index.ts',
			`eventBus.subscribe('x.y', () => {});`,
		);
		writeFile(
			cwd,
			'src/generated/registry.ts',
			`eventBus.subscribe('x.y', () => {});`,
		);

		const result = scanDirectoryForConsumers(path.join(cwd, 'src'), 'x.y');
		expect(result.tier1.length).toBe(1);
		expect(result.tier1[0].sourceFile).toContain('src/a.ts');
	});
});
