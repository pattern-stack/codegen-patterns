/**
 * validateSemanticModel unit tests (SEM-1, docs/specs/SEM-1.md §4).
 *
 * These are the rules that need the WHOLE entity set: the emitted measure
 * catalog is one flat namespace, so a metric declared on one entity may name
 * legs on another, and both names must be unique across all of them.
 * Field-level and structural rules live in the Zod schema and are covered by
 * `src/__tests__/schema/analytics-vocabulary.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import {
	deriveAtomicMeasureKeys,
	validateSemanticModel,
} from '../../parser/validate-semantic';
import type {
	MetricDefinition,
	ParsedEntity,
	ParsedField,
	ParsedFieldAnalytics,
} from '../../analyzer/types';

function makeField(name: string, analytics: ParsedFieldAnalytics = {}): ParsedField {
	return {
		name,
		type: 'decimal',
		required: false,
		nullable: false,
		unique: false,
		index: false,
		constraints: {},
		ui: {},
		analytics,
	};
}

function makeEntity(
	name: string,
	fields: Record<string, ParsedFieldAnalytics>,
	metrics?: Record<string, MetricDefinition>,
): ParsedEntity {
	return {
		name,
		plural: `${name}s`,
		table: `${name}s`,
		expose: ['repository'],
		folderStructure: 'nested',
		fields: new Map(
			Object.entries(fields).map(([f, a]) => [f, makeField(f, a)]),
		),
		relationships: new Map(),
		behaviors: [],
		sourcePath: `entities/${name}.yaml`,
		...(metrics ? { analytics: { metrics } } : {}),
	};
}

const measure = (aggs: ParsedFieldAnalytics['aggs']): ParsedFieldAnalytics => ({
	role: 'measure',
	aggs,
	additivity: 'additive',
});

const types = (issues: { type: string }[]) => issues.map((i) => i.type);

// ---------------------------------------------------------------------------
// Atomic key derivation — the rule the consuming layer uses
// ---------------------------------------------------------------------------

describe('deriveAtomicMeasureKeys', () => {
	it('keys a declared-aggs measure as <field>.<agg>, one entry per agg', () => {
		const e = makeEntity('opportunity', { amount: measure(['sum', 'avg']) });
		expect(deriveAtomicMeasureKeys(e).map((k) => k.key)).toEqual([
			'amount.sum',
			'amount.avg',
		]);
	});

	it('keys a single-agg measure by its bare field name', () => {
		const e = makeEntity('opportunity', {
			amount: { role: 'measure', agg: 'sum', additivity: 'additive' },
		});
		expect(deriveAtomicMeasureKeys(e).map((k) => k.key)).toEqual(['amount']);
	});

	it('ignores dimensions and untagged fields', () => {
		const e = makeEntity('opportunity', {
			stage: { role: 'dimension' },
			closed_at: { role: 'dimension', time: true },
			note: {},
		});
		expect(deriveAtomicMeasureKeys(e)).toEqual([]);
	});

	it('reports the owning entity and field alongside each key', () => {
		const e = makeEntity('opportunity', { amount: measure(['sum']) });
		expect(deriveAtomicMeasureKeys(e)[0]).toEqual({
			key: 'amount.sum',
			entity: 'opportunity',
			field: 'amount',
		});
	});
});

// ---------------------------------------------------------------------------
// C1 — measure key ambiguity across entities
// ---------------------------------------------------------------------------

describe('validateSemanticModel — C1 ambiguous measures', () => {
	it('rejects the same measure key on two entities', () => {
		const issues = validateSemanticModel([
			makeEntity('opportunity', { amount: measure(['sum']) }),
			makeEntity('invoice', { amount: measure(['sum']) }),
		]);
		expect(types(issues)).toEqual(['ambiguous_measure']);
		expect(issues[0]!.message).toContain('amount.sum');
	});

	it('accepts the same field name when the aggs differ', () => {
		const issues = validateSemanticModel([
			makeEntity('opportunity', { amount: measure(['sum']) }),
			makeEntity('invoice', { amount: measure(['avg']) }),
		]);
		expect(issues).toEqual([]);
	});

	it('does not fire on a collision between two non-target entities', () => {
		const all = [
			makeEntity('opportunity', { amount: measure(['sum']) }),
			makeEntity('invoice', { amount: measure(['sum']) }),
			makeEntity('contact', { score: measure(['avg']) }),
		];
		expect(validateSemanticModel(all, [all[2]!])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// C2 — leg resolution
// ---------------------------------------------------------------------------

describe('validateSemanticModel — C2 leg resolution', () => {
	const opportunity = makeEntity('opportunity', {
		amount: measure(['sum']),
		won_amount: measure(['sum']),
	});

	it('resolves ratio legs to declared measures', () => {
		const metrics: Record<string, MetricDefinition> = {
			win_rate: { type: 'ratio', numerator: 'won_amount.sum', denominator: 'amount.sum' },
		};
		const issues = validateSemanticModel([
			{ ...opportunity, analytics: { metrics } },
		]);
		expect(issues).toEqual([]);
	});

	it('rejects a ratio leg that no entity declares', () => {
		const metrics: Record<string, MetricDefinition> = {
			win_rate: { type: 'ratio', numerator: 'won_amount.sum', denominator: 'nope.sum' },
		};
		const issues = validateSemanticModel([{ ...opportunity, analytics: { metrics } }]);
		expect(types(issues)).toEqual(['unresolved_measure']);
		expect(issues[0]!.message).toContain("references measure 'nope.sum'");
		expect(issues[0]!.message).toContain('amount.sum');
	});

	it('resolves a leg that lives on ANOTHER entity — the catalog is one namespace', () => {
		const metrics: Record<string, MetricDefinition> = {
			cost_ratio: { type: 'ratio', numerator: 'cost.sum', denominator: 'amount.sum' },
		};
		const issues = validateSemanticModel([
			{ ...opportunity, analytics: { metrics } },
			makeEntity('line_item', { cost: measure(['sum']) }),
		]);
		expect(issues).toEqual([]);
	});

	it('walks every {ref} in a derived expression tree', () => {
		const metrics: Record<string, MetricDefinition> = {
			gross_profit: {
				type: 'derived',
				expr: {
					op: '-',
					left: { ref: 'amount.sum' },
					right: { op: '*', left: { ref: 'missing.sum' }, right: { lit: 0.5 } },
				},
			},
		};
		const issues = validateSemanticModel([{ ...opportunity, analytics: { metrics } }]);
		expect(types(issues)).toEqual(['unresolved_measure']);
		expect(issues[0]!.message).toContain('missing.sum');
	});

	it("rejects a cumulative metric's unresolvable measure", () => {
		const metrics: Record<string, MetricDefinition> = {
			running: { type: 'cumulative', measure: 'missing.sum', order_by: 'created_at' },
		};
		const issues = validateSemanticModel([{ ...opportunity, analytics: { metrics } }]);
		expect(types(issues)).toEqual(['unresolved_measure']);
	});
});

// ---------------------------------------------------------------------------
// C3 / C4 — metric name uniqueness and collision with a derived measure key
// ---------------------------------------------------------------------------

describe('validateSemanticModel — C3/C4 metric names', () => {
	const ratio: MetricDefinition = {
		type: 'ratio',
		numerator: 'amount.sum',
		denominator: 'amount.sum',
	};

	it('rejects the same metric name on two entities', () => {
		const issues = validateSemanticModel([
			makeEntity('opportunity', { amount: measure(['sum']) }, { win_rate: ratio }),
			makeEntity('invoice', {}, { win_rate: ratio }),
		]);
		expect(types(issues)).toEqual(['duplicate_metric']);
	});

	it('accepts distinct metric names across entities', () => {
		const issues = validateSemanticModel([
			makeEntity('opportunity', { amount: measure(['sum']) }, { win_rate: ratio }),
			makeEntity('invoice', {}, { collection_rate: ratio }),
		]);
		expect(issues).toEqual([]);
	});

	it('rejects a metric named after a derived atomic measure key', () => {
		const issues = validateSemanticModel([
			makeEntity(
				'opportunity',
				{ amount: { role: 'measure', agg: 'sum', additivity: 'additive' } },
				{ amount: { type: 'ratio', numerator: 'amount', denominator: 'amount' } },
			),
		]);
		expect(types(issues)).toEqual(['metric_name_collision']);
	});
});

// ---------------------------------------------------------------------------
// C5 — cumulative window columns
// ---------------------------------------------------------------------------

describe('validateSemanticModel — C5 cumulative window columns', () => {
	const owner = makeEntity('opportunity', {
		amount: measure(['sum']),
		created_at: { role: 'dimension' },
		account_id: { role: 'dimension' },
	});

	it('accepts order_by and partition_by naming fields on the measure owner', () => {
		const issues = validateSemanticModel([
			{
				...owner,
				analytics: {
					metrics: {
						running: {
							type: 'cumulative',
							measure: 'amount.sum',
							order_by: 'created_at',
							partition_by: 'account_id',
						},
					},
				},
			},
		]);
		expect(issues).toEqual([]);
	});

	it('rejects an order_by that is not a field on the measure owner', () => {
		const issues = validateSemanticModel([
			{
				...owner,
				analytics: {
					metrics: {
						running: { type: 'cumulative', measure: 'amount.sum', order_by: 'nope' },
					},
				},
			},
		]);
		expect(types(issues)).toEqual(['unresolved_window_column']);
		expect(issues[0]!.message).toContain("order_by: 'nope'");
	});

	it('rejects a partition_by that is not a field on the measure owner', () => {
		const issues = validateSemanticModel([
			{
				...owner,
				analytics: {
					metrics: {
						running: {
							type: 'cumulative',
							measure: 'amount.sum',
							order_by: 'created_at',
							partition_by: 'nope',
						},
					},
				},
			},
		]);
		expect(types(issues)).toEqual(['unresolved_window_column']);
	});

	it('checks the window columns against the MEASURE OWNER, not the declaring entity', () => {
		// `forecast` declares the metric; `opportunity` owns the measure, so
		// `created_at` must exist on `opportunity` — it does not on `forecast`.
		const declaring = makeEntity('forecast', { period: { role: 'dimension' } }, {
			running: { type: 'cumulative', measure: 'amount.sum', order_by: 'period' },
		});
		const issues = validateSemanticModel([owner, declaring]);
		expect(types(issues)).toEqual(['unresolved_window_column']);
		expect(issues[0]!.message).toContain("'opportunity' has no field 'period'");
	});
});

// ---------------------------------------------------------------------------
// Nothing declared — the common case
// ---------------------------------------------------------------------------

describe('validateSemanticModel — untagged domains', () => {
	it('returns no issues when no entity declares analytics', () => {
		const issues = validateSemanticModel([
			makeEntity('contact', { email: {} }),
			makeEntity('account', { name: {} }),
		]);
		expect(issues).toEqual([]);
	});
});
