/**
 * dealbrain dogfood #9 — a `belongs_to` that does not declare its FK's
 * nullability emits a NULLABLE column. The default stays (changing it is
 * breaking DDL); `entity validate` says so, naming the relationship.
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

function issuesFor(observation: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-nullability-'));
	dirs.push(dir);
	fs.writeFileSync(
		path.join(dir, 'artifact.yaml'),
		'entity:\n  name: artifact\n  plural: artifacts\n  table: artifacts\nfields:\n  title: { type: string }\n',
	);
	fs.writeFileSync(
		path.join(dir, 'observation.yaml'),
		`entity:\n  name: observation\n  plural: observations\n  table: observations\n${observation}`,
	);
	const { entities } = loadEntities(dir);
	return checkConsistency(buildDomainGraph(entities)).filter(
		(i) => i.type === 'undeclared_fk_nullability',
	);
}

const rel = (extra = '') =>
	`relationships:\n  artifact:\n    type: belongs_to\n    target: artifact\n    foreign_key: artifact_id\n${extra}`;

describe('undeclared_fk_nullability', () => {
	it('warns on a belongs_to with no nullable: and no FK field', () => {
		const issues = issuesFor(`fields:\n  note: { type: string }\n${rel()}`);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.severity).toBe('warning');
		expect(issues[0]!.entity).toBe('observation');
		expect(issues[0]!.field).toBe('artifact');
		expect(issues[0]!.message).toContain('emitted NULLABLE');
	});

	it('is silent when the relationship declares nullable: (either way)', () => {
		expect(issuesFor(`fields:\n  note: { type: string }\n${rel('    nullable: false\n')}`)).toHaveLength(0);
		expect(issuesFor(`fields:\n  note: { type: string }\n${rel('    nullable: true\n')}`)).toHaveLength(0);
	});

	it('is silent when the FK field declares required: true or nullable:', () => {
		expect(
			issuesFor(`fields:\n  artifact_id: { type: uuid, required: true }\n${rel()}`),
		).toHaveLength(0);
		expect(
			issuesFor(`fields:\n  artifact_id: { type: uuid, nullable: true }\n${rel()}`),
		).toHaveLength(0);
	});
});
