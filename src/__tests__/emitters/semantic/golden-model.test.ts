/**
 * Semantic emitter — golden-tree snapshot (SEM-2, ADR-045).
 *
 * Exercises the REAL CLI path — `loadSemanticEmitContext` → `emitSemanticModel`,
 * exactly what the `entity new` post-step calls — into a tmp dir, and compares
 * the tree byte-for-byte against the checked-in `test/semantic-golden/snapshot/`.
 * Mirrors the frontend emitter's golden test.
 *
 * The fixture set is chosen so the snapshot LOCKS the decisions that are easy
 * to regress silently: both catalog key shapes (`aggs:` → `field.agg`, single
 * `agg:` → bare `field`), a non-additive measure, a `time: true` axis, an enum
 * dimension with a declared domain, a scope column derived to a dimension, a
 * `has_one`, a junction with its inverse edges and its real column set (a
 * `choices:` role, a payload field, no phantom `id`), a `through:` relationship that
 * must NOT appear, and `string_array` / `entity_ref` fields that must not reach
 * `analytics.fields`. Focused assertions below name each one independently, so
 * a regression reports what broke rather than just "the snapshot moved".
 *
 * Regenerate after intentional emitter changes:
 *   UPDATE_SEMANTIC_GOLDEN=1 bun test src/__tests__/emitters/semantic/golden-model.test.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	emitSemanticModel,
	loadSemanticEmitContext,
} from '../../../emitters/semantic/index';

const GOLDEN_DIR = resolve(import.meta.dir, '../../../../test/semantic-golden');
const ENTITIES_DIR = join(GOLDEN_DIR, 'entities');
const JUNCTIONS_DIR = join(GOLDEN_DIR, 'junctions');
const SNAPSHOT_DIR = join(GOLDEN_DIR, 'snapshot');
const UPDATE = process.env.UPDATE_SEMANTIC_GOLDEN === '1';

const tmpRoot = mkdtempSync(join(tmpdir(), 'sem-golden-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const loaded = loadSemanticEmitContext(GOLDEN_DIR, null, {
	entitiesDir: ENTITIES_DIR,
	junctionsDir: JUNCTIONS_DIR,
});
if (loaded.skip !== undefined) {
	throw new Error(`golden fixtures did not load: ${loaded.skip}`);
}

const outDir = join(tmpRoot, 'semantic');
const emitted = emitSemanticModel(loaded.ctx, outDir);
const model = readFileSync(join(outDir, 'model.ts'), 'utf-8');

if (UPDATE) {
	rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
	mkdirSync(SNAPSHOT_DIR, { recursive: true });
	for (const file of emitted.written) {
		writeFileSync(join(SNAPSHOT_DIR, file), readFileSync(join(outDir, file)));
	}
}

describe('semantic golden tree', () => {
	it('emits exactly the snapshot file set', () => {
		const snapshot = existsSync(SNAPSHOT_DIR) ? readdirSync(SNAPSHOT_DIR).sort() : [];
		expect(emitted.written).toEqual(snapshot);
	});

	it('emits byte-identical content', () => {
		for (const file of emitted.written) {
			expect({ file, text: readFileSync(join(outDir, file), 'utf-8') }).toEqual({
				file,
				text: readFileSync(join(SNAPSHOT_DIR, file), 'utf-8'),
			});
		}
	});

	it('is idempotent — a second emit produces the same bytes', () => {
		const second = join(tmpRoot, 'semantic-2');
		const again = emitSemanticModel(loaded.ctx!, second);
		for (const file of again.written) {
			expect(readFileSync(join(second, file), 'utf-8')).toBe(
				readFileSync(join(outDir, file), 'utf-8'),
			);
		}
	});

	it('reports no warnings for a well-formed fixture set', () => {
		expect(emitted.warnings).toEqual([]);
	});
});

describe('semantic golden — the decisions the snapshot locks', () => {
	it('emits an aggs: measure with its allowed set', () => {
		expect(model).toContain(
			"annual_revenue: { type: 'number', role: 'measure', aggs: ['sum', 'avg', 'min', 'max'], additivity: 'additive', column: 'annual_revenue' }",
		);
	});

	it('emits a single-agg measure with agg, not aggs', () => {
		expect(model).toContain(
			"health_score: { type: 'number', role: 'measure', agg: 'avg', additivity: 'non', column: 'health_score' }",
		);
	});

	it('marks an enum dimension as having a declared value domain', () => {
		expect(model).toContain(
			"tier: { type: 'enum', role: 'dimension', column: 'tier', hasDeclaredDomain: true }",
		);
	});

	it('derives a scope column to a dimension without the author saying so', () => {
		expect(model).toContain("tenant_id: { type: 'uuid', role: 'dimension', column: 'tenant_id' }");
	});

	it('emits the time axis', () => {
		expect(model).toContain(
			"closed_at: { type: 'datetime', role: 'dimension', time: true, column: 'closed_at' }",
		);
	});

	it('emits has_one faithfully (query-surface#40)', () => {
		expect(model).toContain(
			"primary_contact: { kind: 'has_one', target: 'contact', fk: 'primary_for_account_id' }",
		);
	});

	it('emits the junction with meta.kind junction and two belongs_to', () => {
		expect(model).toContain("meta: { kind: 'junction' }");
		expect(model).toContain("opportunity: { kind: 'belongs_to', target: 'opportunity', fk: 'opportunity_id' }");
		expect(model).toContain("contact: { kind: 'belongs_to', target: 'contact', fk: 'contact_id' }");
	});

	it('emits the inverse has_many on each junction endpoint', () => {
		expect(model).toContain(
			"opportunity_contacts: { kind: 'has_many', target: 'opportunity_contact', fk: 'opportunity_id' }",
		);
		expect(model).toContain(
			"opportunity_contacts: { kind: 'has_many', target: 'opportunity_contact', fk: 'contact_id' }",
		);
	});

	it('does NOT emit a through: relationship', () => {
		expect(model).not.toContain('account_contacts');
	});

	it('does NOT put string_array or entity_ref in analytics.fields', () => {
		expect(model).not.toContain('tags:');
		expect(model).not.toContain('linked_to');
	});

	it('resolves the table identifier through the registry, never re-pluralized', () => {
		// `opportunity.plural` is `opportunities`; a naive pluralizer would agree
		// here, but the assertion pins that the value comes from the barrel export.
		expect(model).toContain('opportunity: schema.opportunities,');
		// A junction's table const is CAMEL-cased by its template, unlike an
		// entity's, which is the raw plural. Found #1 in docs/specs/SEM-2.md.
		expect(model).toContain('opportunity_contact: schema.opportunityContacts,');
	});

	it('emits composite metrics only — never atomic catalog entries', () => {
		expect(model).toContain(
			"win_rate: { kind: 'ratio', numerator: 'won_amount.sum', denominator: 'amount.sum', label: 'Win rate' }",
		);
		expect(model).toContain(
			"revenue_gap: { kind: 'derived', expr: { op: '-', left: { ref: 'annual_revenue.sum' }, right: { ref: 'amount.sum' } } }",
		);
		expect(model).toContain(
			"running_pipeline: { kind: 'cumulative', measure: 'amount.sum', order_by: 'closed_at', partition_by: 'account_id' }",
		);
		expect(model).not.toContain("kind: 'atomic'");
	});

	it('derives searchableColumns from the declaration, excluding ids and FKs', () => {
		// Sorted, and `external_id` / `*_id` / FK columns are excluded.
		expect(model).toContain("searchableColumns: ['email', 'first_name', 'last_name'],");
		expect(model).toContain("searchableColumns: ['name', 'website'],");
	});
});
