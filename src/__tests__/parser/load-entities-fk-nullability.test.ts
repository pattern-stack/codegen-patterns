/**
 * #850 — the parser's `ParsedField.nullable` for a `belongs_to` FK reads the
 * one FK rule (`foreignKeyColumnNullable`): NOT NULL unless `nullable: true`.
 * The semantic model and `entity validate`'s manifest read this field, so it
 * must agree with the column the entity template emits.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEntities } from '../../parser/load-entities';
import type { ParsedEntity } from '../../analyzer/types';

let dir: string;
let deal: ParsedEntity;

const ACCOUNT = `
entity:
  name: account
  plural: accounts
fields:
  name: { type: string, required: true }
`;

const DEAL = `
entity:
  name: deal
  plural: deals
fields:
  account_id: { type: uuid, index: true }
  owner_account_id: { type: uuid, nullable: true }
  broker_account_id: { type: uuid }
relationships:
  account: { type: belongs_to, target: account, foreign_key: account_id }
  owner_account: { type: belongs_to, target: account, foreign_key: owner_account_id }
  broker_account: { type: belongs_to, target: account, foreign_key: broker_account_id, nullable: true }
`;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'fk850-'));
	writeFileSync(join(dir, 'account.yaml'), ACCOUNT);
	writeFileSync(join(dir, 'deal.yaml'), DEAL);
	const { entities, issues } = loadEntities(dir, { tablePrefix: '' });
	expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
	deal = entities.find((e) => e.name === 'deal')!;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ParsedField.nullable for a belongs_to FK (#850)', () => {
	it('an FK field without nullable: is NOT NULL', () => {
		expect(deal.fields.get('account_id')!.nullable).toBe(false);
	});

	it('nullable: true on the FK field opts out', () => {
		expect(deal.fields.get('owner_account_id')!.nullable).toBe(true);
	});

	it('nullable: true on the relationship opts out', () => {
		expect(deal.fields.get('broker_account_id')!.nullable).toBe(true);
	});
});
