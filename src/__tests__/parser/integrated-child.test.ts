/**
 * RFC-0006 §4.2 / S7a (#917) — `pattern: Integrated` on a child of a joined-table family.
 *
 * The fixture (test/fixtures/integrated-child/entities): a base `inbox_item` (`external_id_tracking`, natural key
 * [provider, external_id]), two Integrated children (`mail_message`, `calendar_event`) and a base-only kind (`note`).
 * Every negative case is that family with one line changed. The single-file halves (D2, R5, R11) are asserted
 * through the entity schema, the cross-entity halves (D1, R6) through `validateInheritance`.
 */

import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { validateInheritance } from '../../parser/validate-inheritance';
import {
	familyWith,
	INTEGRATED_FAMILY_DIR as DIR,
	loadFamily,
	type Mutations,
	rawFixture,
	schemaIssues,
} from './inheritance-family';

setDefaultTimeout(60_000);

const OPTS = { tenancyColumn: 'tenant_id', syncMode: 'electric' } as const;
const errorMessages = (mutations: Mutations) =>
	validateInheritance(familyWith(mutations, DIR), OPTS)
		.filter((i) => i.severity === 'error')
		.map((i) => i.message);
const raw = (name: string, mutate?: (r: Record<string, any>) => void) => rawFixture(name, mutate, DIR);
const joined = (xs: string[]) => xs.join('\n');

describe('the integrated family', () => {
	it('validates clean: no schema issue on any entity, no cross-entity error', () => {
		for (const name of ['inbox_item', 'mail_message', 'calendar_event']) expect(schemaIssues(raw(name))).toEqual([]);
		expect(validateInheritance(loadFamily(DIR), OPTS)).toEqual([]);
	});

	it('a child may also declare integration: and detection: (accepted since S7a)', () => {
		const r = raw('mail_message', (x) => {
			x.integration = { providers: {} };
			x.detection = {};
		});
		expect(schemaIssues(r)).toEqual([]);
	});

	it('validates through `entity validate --json` on a temp copy (exit 0, valid: true)', () => {
		const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 's7a-'));
		try {
			fs.mkdirSync(path.join(root, 'entities'));
			for (const f of fs.readdirSync(DIR)) fs.copyFileSync(path.join(DIR, f), path.join(root, 'entities', f));
			fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'runtime: vendored\npaths:\n  entities: entities\n');
			const cli = path.resolve(import.meta.dir, '../../cli/index.ts');
			const r = spawnSync('bun', [cli, 'entity', 'validate', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
			expect(r.status).toBe(0);
			expect(JSON.parse(r.stdout).valid).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('D1 — what the base of an Integrated child declares', () => {
	it('a base without external_id_tracking (and no key on its columns) is two errors, each naming both entities', () => {
		const msgs = errorMessages({
			inbox_item: (r) => {
				r.behaviors = ['timestamps', 'soft_delete'];
				r.unique_indexes = [{ fields: ['title'], natural_key: true }];
			},
		});
		const behavior = msgs.filter((m) => m.includes("declares no 'external_id_tracking'"));
		expect(behavior.length).toBe(2); // one per Integrated child
		expect(joined(behavior)).toContain("D1 — 'mail_message' declares 'pattern: Integrated', and its base 'inbox_item'");
		expect(joined(behavior)).toContain("Add 'external_id_tracking' to 'inbox_item'");
		expect(joined(msgs)).toContain("D1 — 'calendar_event' declares 'pattern: Integrated', and its base 'inbox_item' declares no 'external_id_tracking'");
	});

	it('a base without the natural key', () => {
		const msgs = errorMessages({ inbox_item: (r) => delete r.unique_indexes });
		const m = msgs.find((x) => x.includes("D1 — 'mail_message'"))!;
		expect(m).toContain("its base 'inbox_item' declares no 'natural_key: true' unique_indexes entry");
		expect(m).toContain('[provider, external_id]');
		expect(msgs.some((x) => x.includes("declares no 'external_id_tracking'"))).toBe(false);
	});

	it('a base whose natural key is on other columns', () => {
		const msgs = errorMessages({ inbox_item: (r) => (r.unique_indexes = [{ fields: ['title'], natural_key: true }]) });
		const m = msgs.find((x) => x.includes("D1 — 'calendar_event'"))!;
		expect(m).toContain("its base 'inbox_item' has its natural key on [title], not [provider, external_id]");
	});

	it('a child that declares no Integrated needs none of it (base-only kind and plain children are untouched)', () => {
		const msgs = errorMessages({
			inbox_item: (r) => delete r.unique_indexes,
			mail_message: (r) => delete r.entity.pattern,
			calendar_event: (r) => delete r.entity.pattern,
		});
		expect(msgs).toEqual([]);
	});
});

describe('D2 — Integrated on a base is refused (#927)', () => {
	for (const [label, mutate] of [
		['pattern: Integrated', (r: any) => (r.entity.pattern = 'Integrated')],
		['surface:', (r: any) => (r.entity.surface = 'mail')],
		['integration:', (r: any) => (r.integration = { providers: {} })],
		['detection:', (r: any) => (r.detection = {})],
	] as const) {
		it(label, () => {
			const msg = joined(schemaIssues(raw('inbox_item', mutate)));
			expect(msg).toContain(`'inbox_item' is the base of a family (discriminator 'kind') and declares '${label}'`);
			expect(msg).toContain('#927');
		});
	}
});

describe('R5 — external_id_tracking on an Integrated child', () => {
	it('implied by Integrated: no issue; declared on the child: still R5', () => {
		expect(schemaIssues(raw('mail_message'))).toEqual([]);
		expect(joined(schemaIssues(raw('mail_message', (r) => (r.behaviors = ['external_id_tracking']))))).toContain(
			"R5 — 'mail_message' is a child of 'inbox_item' and declares or implies the 'external_id_tracking' behavior",
		);
	});
});

describe('R6 — an Integrated child reads the base columns through the base', () => {
	it('a base that fails D1 yields only the D1 errors, never R6 on the three columns', () => {
		for (const mutate of [
			(r: any) => delete r.unique_indexes,
			(r: any) => (r.unique_indexes = [{ fields: ['title'], natural_key: true }]),
		]) {
			const msgs = errorMessages({ inbox_item: mutate });
			expect(msgs.length).toBe(2);
			for (const m of msgs) expect(m).toStartWith('D1 — ');
			expect(joined(msgs)).not.toContain('R6');
		}
	});

	it('D1 wants exactly the pair: a superset is not the key, and the schema refuses it first (R11)', async () => {
		const { isIntegratedNaturalKey } = await import('../../schema/inheritance');
		expect(isIntegratedNaturalKey(['external_id', 'provider'])).toBe(true);
		expect(isIntegratedNaturalKey(['provider', 'external_id', 'title'])).toBe(false);
		expect(isIntegratedNaturalKey(['provider'])).toBe(false);
		const msg = joined(
			schemaIssues(
				raw('inbox_item', (r) => (r.unique_indexes = [{ fields: ['provider', 'external_id', 'title'], natural_key: true }])),
			),
		);
		expect(msg).toContain("natural_key column 'provider' is not a declared field");
	});

	it('the exemption is the declaring pattern\'s own: Activity reading a base column is still R6', () => {
		const msgs = errorMessages({
			mail_message: (r) => {
				delete r.entity.pattern;
				r.entity.patterns = ['Integrated', 'Activity'];
				r.entity.config = { Activity: { occurredAt: 'provider' } };
			},
		});
		expect(joined(msgs)).toContain("'mail_message' declares pattern 'Activity', which reads the column 'provider'");
	});

	it('another pattern that reads a base column still fails', () => {
		const msgs = errorMessages({
			mail_message: (r) => {
				delete r.entity.pattern;
				r.entity.patterns = ['Integrated', 'Activity'];
				r.entity.config = { Activity: { occurredAt: 'created_at' } };
			},
		});
		expect(joined(msgs)).toContain("'mail_message' declares pattern 'Activity', which reads the column 'created_at'");
		// ...and only that one: Integrated's own columns stay accepted.
		expect(joined(msgs)).not.toContain("pattern 'Integrated', which reads");
	});

	it('Integrated reads exactly external_id_tracking\'s columns', async () => {
		const { IntegratedPattern } = await import('../../patterns/library/integrated.pattern');
		const { externalIdTrackingBehavior } = await import('../../behaviors/external-id-tracking');
		expect(IntegratedPattern.columnsRead?.(undefined)).toEqual(externalIdTrackingBehavior.fields.map((f) => f.name));
		expect(IntegratedPattern.readsThroughBase).toEqual(['external_id_tracking']);
	});
});

describe('R11 — the natural key over the behavior columns', () => {
	it('[provider, external_id] passes on a base that declares the behavior', () => {
		expect(schemaIssues(raw('inbox_item'))).toEqual([]);
	});
	it('the same columns fail on a base that does not', () => {
		const msg = joined(schemaIssues(raw('inbox_item', (r) => (r.behaviors = ['timestamps', 'soft_delete']))));
		expect(msg).toContain("R11 — 'inbox_item': natural_key column 'provider' is not a declared field or foreign key column");
	});
	it('another nullable column still fails', () => {
		const msg = joined(
			schemaIssues(
				raw('inbox_item', (r) => {
					r.fields.thread = { type: 'string', nullable: true };
					r.unique_indexes = [{ fields: ['provider', 'thread'], natural_key: true }];
				}),
			),
		);
		expect(msg).toContain("R11 — 'inbox_item': natural_key column 'thread' is nullable");
		// Not the exact pair, so no exemption: provider is refused too.
		expect(msg).toContain("natural_key column 'provider' is not a declared field");
	});
	it('a key on external_id alone is refused, even on a base that declares the behavior', () => {
		const msg = joined(schemaIssues(raw('inbox_item', (r) => (r.unique_indexes = [{ fields: ['external_id'], natural_key: true }]))));
		expect(msg).toContain("natural_key column 'external_id' is not a declared field");
	});
	it('a non-family entity may not key on the behavior columns (as on main)', () => {
		const msg = joined(
			schemaIssues({
				entity: { name: 'widget', plural: 'widgets' },
				behaviors: ['timestamps', 'external_id_tracking'],
				fields: { title: { type: 'string', required: true } },
				unique_indexes: [{ fields: ['provider', 'external_id'], natural_key: true }],
			} as any),
		);
		expect(msg).toContain("natural_key column 'external_id' is not a declared field");
		const alone = joined(
			schemaIssues({
				entity: { name: 'widget', plural: 'widgets' },
				behaviors: ['timestamps', 'external_id_tracking'],
				fields: { title: { type: 'string', required: true } },
				unique_indexes: [{ fields: ['external_id'], natural_key: true }],
			} as any),
		);
		expect(alone).toContain("natural_key column 'external_id' is not a declared field");
	});
	it('the identity columns are fields the behavior declares', async () => {
		const { externalIdTrackingBehavior: b } = await import('../../behaviors/external-id-tracking');
		const { INTEGRATED_NATURAL_KEY } = await import('../../schema/inheritance');
		expect(b.identityColumns).toEqual(['provider', 'external_id']);
		for (const c of b.identityColumns ?? []) expect(b.fields.map((f) => f.name)).toContain(c);
		expect([...INTEGRATED_NATURAL_KEY]).toEqual(b.identityColumns);
	});
	it('provider_metadata is payload, not identity: it is not accepted in a key', () => {
		const msg = joined(
			schemaIssues(raw('inbox_item', (r) => (r.unique_indexes = [{ fields: ['provider', 'provider_metadata'], natural_key: true }]))),
		);
		expect(msg).toContain("natural_key column 'provider_metadata' is not a declared field");
	});
	it('a second natural key fails, naming both entries and why', () => {
		const msg = joined(
			schemaIssues(
				raw('inbox_item', (r) => {
					r.unique_indexes.push({ fields: ['title'], natural_key: true, name: 'second' });
				}),
			),
		);
		expect(msg).toContain("R11 — 'inbox_item' marks 2 unique_indexes entries 'natural_key: true'");
		expect(msg).toContain('["provider","external_id"] and ["title"]');
		expect(msg).toContain("An Integrated child's sync upserts its base on [provider, external_id]");
	});
	it('the "at most one" message names Integrated children only for a base', () => {
		const msg = joined(
			schemaIssues({
				entity: { name: 'widget', plural: 'widgets' },
				fields: { a: { type: 'string', required: true }, b: { type: 'string', required: true } },
				unique_indexes: [
					{ fields: ['a'], natural_key: true },
					{ fields: ['b'], natural_key: true, name: 'second' },
				],
			} as any),
		);
		expect(msg).toContain("R11 — 'widget' marks 2 unique_indexes entries");
		expect(msg).not.toContain('Integrated');
	});
});
