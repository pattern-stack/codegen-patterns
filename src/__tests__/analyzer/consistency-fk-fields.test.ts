/**
 * #743 / dealbrain dogfood #13 — a `belongs_to` (or a `cardinality: one` role)
 * EMITS its FK column, so `entity validate` must not report the column as a
 * missing field, on either side of the edge.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkConsistency } from '../../analyzer/consistency-checker';
import { buildDomainGraph } from '../../analyzer/graph-builder';
import { loadEntities } from '../../parser/load-entities';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function issueTypes(files: Record<string, string>): string[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-fields-'));
	dirs.push(dir);
	for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
	const { entities } = loadEntities(dir);
	return checkConsistency(buildDomainGraph(entities)).map((i) => `${i.entity}:${i.type}`);
}

const ACCOUNT =
	'entity:\n  name: account\n  plural: accounts\n  table: accounts\nfields:\n  name: { type: string }\n' +
	'relationships:\n  contacts:\n    type: has_many\n    target: contact\n    foreign_key: account_id\n';
const CONTACT =
	'entity:\n  name: contact\n  plural: contacts\n  table: contacts\nfields:\n  email: { type: string }\n' +
	'relationships:\n  account:\n    type: belongs_to\n    target: account\n    foreign_key: account_id\n    nullable: false\n';

describe('FK columns a belongs_to emits are not reported missing', () => {
	it('no missing-field issue for the belongs_to side, nor for the inverse has_many', () => {
		const types = issueTypes({ 'account.yaml': ACCOUNT, 'contact.yaml': CONTACT });
		expect(types).not.toContain('contact:missing_fk_field');
		expect(types).not.toContain('account:missing_target_fk');
	});

	it('still reports a has_many whose target has neither the field nor a belongs_to', () => {
		const lonely =
			'entity:\n  name: contact\n  plural: contacts\n  table: contacts\nfields:\n  email: { type: string }\n';
		expect(issueTypes({ 'account.yaml': ACCOUNT, 'contact.yaml': lonely })).toContain(
			'account:missing_target_fk',
		);
	});
});
