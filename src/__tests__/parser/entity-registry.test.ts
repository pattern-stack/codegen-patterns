/**
 * loadEntityRegistry unit tests (ADR-038, FE-1).
 *
 * The registry is the authoritative cross-entity naming source for FK target
 * resolution: plural comes straight from `entity.plural` (never derived), and
 * casings are computed from the snake_case name/plural. Tests use
 * `mkdtempSync(tmpdir())` so fixtures (incl. intentionally-broken YAML) stay
 * out of the checked-in tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEntityRegistry } from '../../parser/entity-registry';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'entity-registry-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeEntity(file: string, body: string): void {
	writeFileSync(join(dir, file), body, 'utf-8');
}

// ----------------------------------------------------------------------------
// Cross-entity load + casings
// ----------------------------------------------------------------------------

describe('loadEntityRegistry — two cross-referencing entities', () => {
	beforeEach(() => {
		// `deal` belongs_to `deal_state`; the registry is what an emitter would
		// consult to resolve the `deal_state` target's authoritative names.
		writeEntity(
			'deal.yaml',
			`entity:
  name: deal
  plural: deals
  table: deals
fields:
  name: { type: string, required: true }
relationships:
  state:
    type: belongs_to
    target: deal_state
    foreign_key: deal_state_id
`,
		);
		writeEntity(
			'deal_state.yaml',
			`entity:
  name: deal_state
  plural: deal_states
  table: deal_states
fields:
  label: { type: string, required: true }
`,
		);
	});

	it('keys the registry by entity name with zero issues', () => {
		const { registry, issues } = loadEntityRegistry(dir);
		expect(issues).toEqual([]);
		expect([...registry.keys()].sort()).toEqual(['deal', 'deal_state']);
	});

	it('derives pascal/camel casings for a multi-word name', () => {
		const { registry } = loadEntityRegistry(dir);
		const dealState = registry.get('deal_state');
		expect(dealState).toMatchObject({
			name: 'deal_state',
			plural: 'deal_states',
			table: 'deal_states',
			className: 'DealState',
			classNamePlural: 'DealStates',
			camelName: 'dealState',
			pluralCamelName: 'dealStates',
		});
	});
});

// ----------------------------------------------------------------------------
// Authoritative plural — never derived
// ----------------------------------------------------------------------------

describe('loadEntityRegistry — irregular plural is read from YAML, never derived', () => {
	it('returns plural: people for person (not pluralized "persons")', () => {
		writeEntity(
			'person.yaml',
			`entity:
  name: person
  plural: people
  table: people
fields:
  name: { type: string, required: true }
`,
		);

		const { registry } = loadEntityRegistry(dir);
		const person = registry.get('person');
		expect(person?.plural).toBe('people');
		expect(person?.pluralCamelName).toBe('people');
		expect(person?.classNamePlural).toBe('People');
	});
});

// ----------------------------------------------------------------------------
// sync round-trip
// ----------------------------------------------------------------------------

describe('loadEntityRegistry — sync mode round-trip', () => {
	it('carries entity.sync through; absent → null (inherit global)', () => {
		writeEntity(
			'order.yaml',
			`entity:
  name: order
  plural: orders
  table: orders
  sync: api
fields:
  total: { type: decimal, required: true }
`,
		);
		writeEntity(
			'invoice.yaml',
			`entity:
  name: invoice
  plural: invoices
  table: invoices
fields:
  total: { type: decimal, required: true }
`,
		);

		const { registry } = loadEntityRegistry(dir);
		expect(registry.get('order')?.sync).toBe('api');
		expect(registry.get('invoice')?.sync).toBeNull();
	});
});

// ----------------------------------------------------------------------------
// Invalid-YAML tolerance
// ----------------------------------------------------------------------------

describe('loadEntityRegistry — tolerant of invalid files', () => {
	it('loads valid entities and reports the broken one as an issue', () => {
		writeEntity(
			'good.yaml',
			`entity:
  name: good
  plural: goods
  table: goods
fields:
  name: { type: string, required: true }
`,
		);
		// Missing required `table` → schema validation failure.
		writeEntity(
			'broken.yaml',
			`entity:
  name: broken
  plural: brokens
fields:
  name: { type: string, required: true }
`,
		);

		const { registry, issues } = loadEntityRegistry(dir);
		expect(registry.has('good')).toBe(true);
		expect(registry.has('broken')).toBe(false);
		expect(issues.some((i) => i.severity === 'error')).toBe(true);
		expect(issues.some((i) => i.path?.endsWith('broken.yaml'))).toBe(true);
	});

	it('reports a missing directory as an error, returns an empty registry', () => {
		const { registry, issues } = loadEntityRegistry(join(dir, 'does-not-exist'));
		expect(registry.size).toBe(0);
		expect(issues.some((i) => i.severity === 'error')).toBe(true);
	});
});
