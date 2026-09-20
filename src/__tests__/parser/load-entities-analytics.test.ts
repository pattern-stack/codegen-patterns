/**
 * Parser round-trip for the SEM-1 analytics vocabulary.
 *
 * `parseAnalyticsMetadata` mirrors `parseUiMetadata` — the tags reach
 * `ParsedField.analytics`, and the entity-level composite catalog reaches
 * `ParsedEntity.analytics`. Written against a real YAML file through
 * `loadEntities()` so the schema, the loader and the transform are exercised
 * together rather than the transform alone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEntities } from '../../parser/load-entities';
import type { ParsedEntity } from '../../analyzer/types';

let dir: string;
let opportunity: ParsedEntity;

const YAML = `
entity:
  name: opportunity
  plural: opportunities
  table: opportunities

fields:
  amount:
    type: decimal
    role: measure
    aggs: [sum, avg]
    additivity: additive
  win_probability:
    type: decimal
    role: measure
    agg: avg
    additivity: non
  stage:
    type: enum
    choices: [prospecting, closed_won]
    role: dimension
  closed_at:
    type: datetime
    role: dimension
    time: true
  source:
    type: enum
    choices_from: ./sources.yaml
    role: dimension
  note:
    type: string

analytics:
  metrics:
    win_rate:
      type: ratio
      numerator: amount.sum
      denominator: amount.avg
      label: Win rate
    weighted_pipeline:
      type: derived
      expr:
        op: '*'
        left: { ref: amount.sum }
        right: { lit: 0.5 }
    running_pipeline:
      type: cumulative
      measure: amount.sum
      order_by: closed_at
`;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'sem1-'));
	writeFileSync(join(dir, 'opportunity.yaml'), YAML);
	const { entities, issues } = loadEntities(dir);
	expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
	opportunity = entities[0]!;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ParsedField.analytics', () => {
	it('carries an aggs-declared measure', () => {
		expect(opportunity.fields.get('amount')!.analytics).toEqual({
			role: 'measure',
			agg: undefined,
			aggs: ['sum', 'avg'],
			additivity: 'additive',
			time: undefined,
		});
	});

	it('carries a single-agg measure', () => {
		const a = opportunity.fields.get('win_probability')!.analytics;
		expect(a.agg).toBe('avg');
		expect(a.aggs).toBeUndefined();
		expect(a.additivity).toBe('non');
	});

	it('carries choices_from unresolved, so the declared domain is visible (SEM-2)', () => {
		expect(opportunity.fields.get('source')!.choicesFrom).toBe('./sources.yaml');
		expect(opportunity.fields.get('stage')!.choicesFrom).toBeUndefined();
	});

	it('carries a dimension and a time axis', () => {
		expect(opportunity.fields.get('stage')!.analytics.role).toBe('dimension');
		expect(opportunity.fields.get('closed_at')!.analytics.time).toBe(true);
	});

	it('is always present, with every tag undefined, on an untagged field', () => {
		expect(opportunity.fields.get('note')!.analytics).toEqual({
			role: undefined,
			agg: undefined,
			aggs: undefined,
			additivity: undefined,
			time: undefined,
		});
	});
});

describe('ParsedEntity.analytics', () => {
	it('carries all three composite metric kinds verbatim', () => {
		expect(opportunity.analytics!.metrics).toEqual({
			win_rate: {
				type: 'ratio',
				numerator: 'amount.sum',
				denominator: 'amount.avg',
				label: 'Win rate',
			},
			weighted_pipeline: {
				type: 'derived',
				expr: { op: '*', left: { ref: 'amount.sum' }, right: { lit: 0.5 } },
			},
			running_pipeline: {
				type: 'cumulative',
				measure: 'amount.sum',
				order_by: 'closed_at',
			},
		});
	});

	it('is undefined when the entity declares no analytics block', () => {
		const bare = mkdtempSync(join(tmpdir(), 'sem1-bare-'));
		writeFileSync(
			join(bare, 'contact.yaml'),
			'entity:\n  name: contact\n  plural: contacts\n  table: contacts\nfields:\n  email:\n    type: string\n',
		);
		const { entities } = loadEntities(bare);
		expect(entities[0]!.analytics).toBeUndefined();
		rmSync(bare, { recursive: true, force: true });
	});
});
