/**
 * RFC-0006 §13.1 — the fixture family lives in several harness directories, on
 * purpose (each harness generates from its own closed set). The copies must stay
 * field-identical, or a rule proved against one is not the rule the others run.
 *
 * Parses every YAML of the four locations through the real loader and fails when
 * an entity present in more than one differs:
 *
 *   test/fixtures/inheritance/entities/   the whole family (the source, unit tests)
 *   test/fixtures/entities/               the baseline set (communication, meeting, email, …)
 *   test/scaffold/entities/*-scaffold.yaml  the integration set (the whole family)
 *   test/smoke/fixtures/                  the smoke set (the whole family)
 *
 * The one allowed difference: the smoke sets `tenancy.column: organization_id`
 * for its whole project, so its three tenant-scoped entities spell their column
 * out (`tenant_scoped: { column: tenant_id }`). That key is normalised away on
 * both sides before comparing; nothing else is.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { loadEntityFromYaml } from '../../utils/yaml-loader.js';

const REPO = path.resolve(import.meta.dir, '../../..');

const LOCATIONS: Record<string, string> = {
	inheritance: 'test/fixtures/inheritance/entities',
	baseline: 'test/fixtures/entities',
	scaffold: 'test/scaffold/entities',
	smoke: 'test/smoke/fixtures',
};

/** entity name → location → normalised parsed definition */
function loadAll(): Map<string, Map<string, unknown>> {
	const byEntity = new Map<string, Map<string, unknown>>();
	for (const [location, rel] of Object.entries(LOCATIONS)) {
		const dir = path.join(REPO, rel);
		for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
			const res = loadEntityFromYaml(path.join(dir, file));
			if (!res.success) continue; // a file another test owns may be deliberately invalid
			const def = JSON.parse(JSON.stringify(res.definition)) as Record<string, unknown>;
			delete def.tenant_scoped;
			const name = (def.entity as { name: string }).name;
			if (!byEntity.has(name)) byEntity.set(name, new Map());
			byEntity.get(name)!.set(location, def);
		}
	}
	return byEntity;
}

describe('the RFC-0006 fixture family agrees across harness directories', () => {
	const byEntity = loadAll();
	const family = [...fs.readdirSync(path.join(REPO, LOCATIONS.inheritance))]
		.filter((f) => f.endsWith('.yaml'))
		.map((f) => f.replace(/\.yaml$/, ''));

	it('every family entity is in the scaffold and smoke sets, and the baseline holds its subset', () => {
		for (const name of family) {
			const where = [...(byEntity.get(name)?.keys() ?? [])];
			expect(where).toContain('inheritance');
			expect(where).toContain('scaffold');
			expect(where).toContain('smoke');
		}
		for (const name of ['communication', 'meeting', 'email', 'email_thread', 'meeting_transcript']) {
			expect([...(byEntity.get(name)?.keys() ?? [])]).toContain('baseline');
		}
	});

	for (const name of family) {
		it(`${name} is identical wherever it appears`, () => {
			const copies = byEntity.get(name)!;
			const [firstLocation, first] = [...copies.entries()][0]!;
			for (const [location, def] of copies) {
				expect({ location, def }).toEqual({ location, def: first });
				void firstLocation;
			}
		});
	}
});
