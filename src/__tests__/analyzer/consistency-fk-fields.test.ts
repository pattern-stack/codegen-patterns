/**
 * #743 — a `belongs_to` (or a `cardinality: one` role) EMITS its FK column, and
 * a tenant-scoped entity emits its tenant column, so `entity validate` must not
 * report either column as a missing field, on either side of the edge.
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
	const { entities, issues } = loadEntities(dir, { tablePrefix: '' });
	// A fixture that fails to load would make every `not.toContain` vacuous.
	expect(issues).toEqual([]);
	expect(entities).toHaveLength(Object.keys(files).length);
	return checkConsistency(buildDomainGraph(entities), 'tenant_id').map(
		(i) => `${i.entity}:${i.type}`,
	);
}

const hasMany = (fk: string) =>
	'entity:\n  name: account\n  plural: accounts\nfields:\n  name: { type: string }\n' +
	`relationships:\n  contacts:\n    type: has_many\n    target: contact\n    foreign_key: ${fk}\n`;
const ACCOUNT = hasMany('account_id');
const CONTACT =
	'entity:\n  name: contact\n  plural: contacts\nfields:\n  email: { type: string }\n' +
	'relationships:\n  account:\n    type: belongs_to\n    target: account\n    foreign_key: account_id\n    nullable: false\n';
const LONELY = 'entity:\n  name: contact\n  plural: contacts\nfields:\n  email: { type: string }\n';

describe('FK columns the generator emits are not reported missing (#743)', () => {
	it('no missing-field issue for the belongs_to side, nor for the inverse has_many', () => {
		const types = issueTypes({ 'account.yaml': ACCOUNT, 'contact.yaml': CONTACT });
		expect(types).not.toContain('contact:missing_fk_field');
		expect(types).not.toContain('account:missing_target_fk');
	});

	it('a belongs_to with a custom foreign_key satisfies the has_many naming it', () => {
		const contact =
			'entity:\n  name: contact\n  plural: contacts\nfields:\n  email: { type: string }\n' +
			'relationships:\n  employer:\n    type: belongs_to\n    target: account\n    foreign_key: employer_account_id\n    nullable: true\n';
		const types = issueTypes({ 'account.yaml': hasMany('employer_account_id'), 'contact.yaml': contact });
		expect(types).not.toContain('account:missing_target_fk');
	});

	it('a cardinality-one role (the #743 repro) satisfies the has_many naming its derived FK', () => {
		const contact =
			'entity:\n  name: contact\n  plural: contacts\nfields:\n  email: { type: string }\n' +
			'roles:\n  home:\n    target: account\n    cardinality: one\n    nullable: false\n';
		const types = issueTypes({ 'account.yaml': hasMany('home_account_id'), 'contact.yaml': contact });
		expect(types).not.toContain('account:missing_target_fk');
		expect(types).not.toContain('contact:missing_fk_field');
	});

	it("the target's emitted tenant column satisfies the has_many naming it", () => {
		const contact = `${LONELY}tenant_scoped: { column: account_id }\n`;
		expect(issueTypes({ 'account.yaml': ACCOUNT, 'contact.yaml': contact })).not.toContain(
			'account:missing_target_fk',
		);
	});

	it('still reports a has_many whose target has neither the field, a belongs_to nor the tenant column', () => {
		expect(issueTypes({ 'account.yaml': ACCOUNT, 'contact.yaml': LONELY })).toContain(
			'account:missing_target_fk',
		);
		const otherTenant = `${LONELY}tenant_scoped: true\n`;
		expect(issueTypes({ 'account.yaml': ACCOUNT, 'contact.yaml': otherTenant })).toContain(
			'account:missing_target_fk',
		);
	});
});
