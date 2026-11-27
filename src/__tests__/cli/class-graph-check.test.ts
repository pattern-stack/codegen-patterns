/**
 * The generation-time class-graph check (PW-1) on real on-disk sets: `classGraphRejections` stops the run with the
 * cycle, or the class two owners emit, named. Without these the check could stop rejecting (a loader that throws,
 * an `instanceof` that stops matching) with no test failing.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classGraphRejections } from '../../cli/shared/class-graph-check';

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'class-graph-check-'));
	dirs.push(root);
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	}
	return root;
}

const plain = (name: string) => `entity:\n  name: ${name}\n  plural: ${name}s\nfields:\n  name:\n    type: string\n`;

describe('classGraphRejections', () => {
	it('names a real class cycle: an EAV entity whose field_value belongs_to it', () => {
		// FieldValueService composes ThingRepository (the belongs_to), and ThingRepository takes FieldValueService (EAV).
		const root = project({
			'entities/thing.yaml': 'entity:\n  name: thing\n  plural: things\neav: true\nfields:\n  name:\n    type: string\n',
			'entities/field_value.yaml': [
				'entity:',
				'  name: field_value',
				'  plural: field_values',
				'fields:',
				'  thing_id:',
				'    type: uuid',
				'    nullable: true',
				'    foreign_key: things.id',
				'relationships:',
				'  thing:',
				'    type: belongs_to',
				'    target: thing',
				'    foreign_key: thing_id',
				'',
			].join('\n'),
		});
		const rejections = classGraphRejections(root, null, path.join(root, 'entities'));
		expect(rejections).toHaveLength(1);
		expect(rejections[0]!.message).toContain('FieldValueService → ThingRepository → FieldValueService');
	});

	it('names a class two owners emit: an entity named like a junction', () => {
		const root = project({
			'entities/account.yaml': plain('account'),
			'entities/contact.yaml': plain('contact'),
			'entities/account_contact.yaml': plain('account_contact'),
			'junctions/account_contact.yaml': 'pattern: Junction\nbetween: [account, contact]\nfields:\n  role:\n    type: string\n',
		});
		const rejections = classGraphRejections(root, null, path.join(root, 'entities'));
		expect(rejections).toHaveLength(1);
		expect(rejections[0]!.message).toContain(
			'AccountContactRepository is emitted by both entity account_contact and junction account_contact',
		);
	});

	it('passes a set with neither', () => {
		const root = project({ 'entities/account.yaml': plain('account'), 'entities/contact.yaml': plain('contact') });
		expect(classGraphRejections(root, null, path.join(root, 'entities'))).toEqual([]);
	});
});
