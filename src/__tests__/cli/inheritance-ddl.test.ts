/**
 * RFC-0006 / #875 slices S1–S2, end to end through the real CLI: `entity new` and
 * `entity validate` over a project holding the fixture family.
 *
 *  - the family validates clean (`entity validate`);
 *  - `entity new --all` emits the DDL: the child's shared key, both composite
 *    FKs and the kind CHECK; the base's uniques; a `match:` as one composite FK
 *    over a derived column; `choices_of:` as an imported enum;
 *  - rendering a child (or a `match:` referrer) alone re-renders its base (target);
 *  - a cross-entity rule violation is reported by BOTH commands, naming the
 *    entities (the analyze path and the generation pre-flight agree);
 *  - `natural_key:` alone changes no emitted byte.
 *
 * Projects live under `test/tmp/` (gitignored).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dir, '../../..');
const CLI = path.join(REPO, 'src/cli/index.ts');
const FAMILY = path.join(REPO, 'test/fixtures/inheritance/entities');
const roots: string[] = [];

function project(prefix: string, entities: Record<string, string>): string {
	fs.mkdirSync(path.join(REPO, 'test/tmp'), { recursive: true });
	const root = fs.mkdtempSync(path.join(REPO, `test/tmp/${prefix}-`));
	roots.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'runtime: vendored\npaths:\n  entities: entities\n');
	for (const [name, body] of Object.entries(entities)) {
		fs.mkdirSync(path.join(root, 'entities'), { recursive: true });
		fs.writeFileSync(path.join(root, 'entities', name), body);
	}
	return root;
}

function familyProject(prefix: string, edit?: (files: Record<string, string>) => void): string {
	const files: Record<string, string> = {};
	for (const f of fs.readdirSync(FAMILY)) files[f] = fs.readFileSync(path.join(FAMILY, f), 'utf8');
	edit?.(files);
	return project(prefix, files);
}

const run = (root: string, args: string[]) => {
	const r = spawnSync('bun', [CLI, ...args], { cwd: root, encoding: 'utf8' });
	return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
};

afterAll(() => {
	if (!process.env.KEEP_SMOKE_DIR) for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('the family validates', () => {
	it('entity validate is clean over the fixture family', () => {
		const root = familyProject('inh-validate');
		const r = run(root, ['entity', 'validate']);
		expect(r.out).toContain('All entities validated');
		expect(r.status).toBe(0);
	});

	it('entity validate reports a cross-entity violation, naming both entities', () => {
		const root = familyProject('inh-validate-bad', (f) => {
			f['meeting.yaml'] = f['meeting.yaml']!.replace('inherits: communication', 'inherits:\n  base: communication\n  as: call');
		});
		const r = run(root, ['entity', 'validate']);
		expect(r.status).toBe(1);
		expect(r.out).toContain("R2 — 'meeting' is the 'call' kind of 'communication'");
	});
});

describe('the family generates (S2: the DDL)', () => {
	const read = (root: string, rel: string) => fs.readFileSync(path.join(root, 'src/modules', rel), 'utf8');

	it('entity new --all emits every table, with the shared key, both composite FKs and the kind CHECK', () => {
		const root = familyProject('inh-all');
		const r = run(root, ['entity', 'new', '--all', '--force']);
		expect(r.status).toBe(0);

		const meeting = read(root, 'meetings/meeting.entity.ts');
		expect(meeting).toContain("id: uuid('id').primaryKey(),");
		expect(meeting).not.toContain('defaultRandom');
		expect(meeting).toContain(".$type<'meeting'>().notNull().default('meeting')");
		expect(meeting).toContain("tenantId: uuid('tenant_id').notNull()");
		expect(meeting).toContain("name: 'meetings_communication_kind_fk'");
		expect(meeting).toContain("name: 'meetings_communication_tenant_fk'");
		expect(meeting).toContain("check('meetings_kind_check'");
		expect(meeting).toContain("import { communicationKindEnum, communications } from '../communications/communication.entity';");
		// the base's enum is imported, never redeclared
		expect(meeting).not.toContain('pgEnum');

		const base = read(root, 'communications/communication.entity.ts');
		expect(base).toContain("unique('communications_id_kind_uniq').on(tCols.id, tCols.kind)");
		// one callback parameter name for every table, camelCase so no plural can equal it (#813)
		expect(meeting).toContain('(tCols) => [');
		expect(base).toContain('(tCols) => [');
		expect(base).toContain("unique('communications_id_tenant_id_uniq').on(tCols.id, tCols.tenantId)");
		expect(base).toContain("export const communicationKindEnum = pgEnum('communication_kind'");

		// a child gets no write use cases or routes until S4 (its inherited create would insert without an id)
		expect(fs.existsSync(path.join(root, 'src/modules/meetings/use-cases/create-meeting.use-case.ts'))).toBe(false);
		expect(fs.existsSync(path.join(root, 'src/modules/meetings/use-cases/find-meeting-by-id.use-case.ts'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'src/modules/communications/use-cases/create-communication.use-case.ts'))).toBe(true);
	});

	it('a match: is one composite FK with a derived column shared by two relationships (M3)', () => {
		const root = familyProject('inh-match');
		expect(run(root, ['entity', 'new', '--all', '--force']).status).toBe(0);
		const participant = read(root, 'communication-participants/communication-participant.entity.ts');
		expect(participant.match(/communicationKind: communicationKindEnum\('communication_kind'\)\.notNull\(\),/g)).toHaveLength(1);
		expect(participant).toContain("name: 'communication_participants_communication_match_fk'");
		expect(participant).toContain('columns: [tCols.communicationId, tCols.communicationKind],');
		expect(participant).toContain('foreignColumns: [communications.id, communications.kind],');
		expect(participant).toContain("name: 'communication_participants_role_match_fk'");
		expect(participant).toContain('foreignColumns: [communication_participant_roles.id, communication_participant_roles.kind],');
		expect(participant).toContain("}).onDelete('restrict')");
		// the single-column FK is gone, and so is its now-unused import
		expect(participant).not.toContain('.references((): AnyPgColumn => communications');
		expect(participant).not.toContain('.references((): AnyPgColumn => communication_participant_roles');
		// one import statement per module
		expect(participant).toContain("import { communications, communicationKindEnum } from '../communications/communication.entity';");
		const role = read(root, 'communication-participant-roles/communication-participant-role.entity.ts');
		expect(role).toContain("unique('communication_participant_roles_id_kind_uniq').on(tCols.id, tCols.kind)");
		expect(role).not.toContain('pgEnum'); // choices_of: the owner's type, imported
		expect(role).toContain("import { communicationKindEnum } from '../communications/communication.entity';");
	});

	it('a string literal in a raw-SQL predicate is not rewritten (the callback parameter is passed, never patched in)', () => {
		const root = familyProject('inh-literal', (f) => {
			f['communication_participant.yaml'] = f['communication_participant.yaml']!
				.replace('fields:\n', 'fields:\n  note:\n    type: string\n    nullable: true\n')
				.concat("\nunique_indexes:\n  - name: participant_note_uniq\n    fields: [person_id]\n    where: \"note <> 'https://t.co'\"\n");
		});
		expect(run(root, ['entity', 'new', '--all', '--force']).status).toBe(0);
		const participant = read(root, 'communication-participants/communication-participant.entity.ts');
		expect(participant).toContain("'https://t.co'");
		expect(participant).not.toContain('https://tCols.co');
		expect(participant).toContain('${tCols.note}');
	});

	it("M2's exception: the discriminator is the matched column, so nothing is derived", () => {
		const root = familyProject('inh-m2');
		expect(run(root, ['entity', 'new', '--all', '--force']).status).toBe(0);
		const part = read(root, 'communication-parts/communication-part.entity.ts');
		expect(part).toContain("kind: communicationKindEnum('kind').notNull()");
		expect(part).toContain('columns: [tCols.communicationId, tCols.kind],');
		expect(part).not.toContain('communicationKind:');
		expect(part).toContain("unique('communication_parts_id_kind_uniq').on(tCols.id, tCols.kind)");
	});

	it('entity new <child>.yaml re-renders the base: a stale base table is brought current', () => {
		const root = familyProject('inh-one');
		expect(run(root, ['entity', 'new', '--all', '--force']).status).toBe(0);
		const baseFile = path.join(root, 'src/modules/communications/communication.entity.ts');
		const fresh = fs.readFileSync(baseFile, 'utf8');
		fs.writeFileSync(baseFile, '// stale\n');
		expect(run(root, ['entity', 'new', 'entities/meeting.yaml', '--force']).status).toBe(0);
		expect(fs.readFileSync(baseFile, 'utf8')).toBe(fresh);
	});

	it('entity new <referrer>.yaml re-renders its match: target', () => {
		const root = familyProject('inh-two');
		expect(run(root, ['entity', 'new', '--all', '--force']).status).toBe(0);
		const roleFile = path.join(root, 'src/modules/communication-participant-roles/communication-participant-role.entity.ts');
		const fresh = fs.readFileSync(roleFile, 'utf8');
		fs.writeFileSync(roleFile, '// stale\n');
		expect(run(root, ['entity', 'new', 'entities/communication_participant.yaml', '--force']).status).toBe(0);
		expect(fs.readFileSync(roleFile, 'utf8')).toBe(fresh);
	});

	it('a base rendered with no child still carries its own unique(id, kind)', () => {
		const root = familyProject('inh-base-only', (f) => {
			for (const name of Object.keys(f)) if (name !== 'communication.yaml') delete f[name];
		});
		expect(run(root, ['entity', 'new', '--all', '--force']).status).toBe(0);
		expect(read(root, 'communications/communication.entity.ts')).toContain('communications_id_kind_uniq');
	});

	it('entity new refuses a cross-entity violation in the pre-flight, naming the entities', () => {
		const root = familyProject('inh-one-bad', (f) => {
			f['meeting.yaml'] = f['meeting.yaml']!.replace('inherits: communication', 'inherits: conversation');
		});
		const r = run(root, ['entity', 'new', 'entities/meeting.yaml', '--force']);
		expect(r.status).not.toBe(0);
		expect(r.out).toContain("R3 — 'meeting' inherits 'conversation'");
	});

	it('a violation stops the whole run, whatever --continue-on-error says: the barrels read the whole set', () => {
		const root = familyProject('inh-continue', (f) => {
			f['meeting.yaml'] = f['meeting.yaml']!.replace('inherits: communication', 'inherits: conversation');
		});
		const r = run(root, ['entity', 'new', '--all', '--force', '--continue-on-error']);
		expect(r.status).not.toBe(0);
		expect(fs.existsSync(path.join(root, 'src/modules'))).toBe(false);
	});
});

describe('natural_key: alone changes no emitted byte', () => {
	const entity = (naturalKey: boolean) =>
		[
			'entity:',
			'  name: item',
			'  plural: items',
			'  pattern: Base',
			'fields:',
			'  source: { type: string, required: true }',
			'  external_id: { type: string, required: true }',
			'unique_indexes:',
			`  - fields: [source, external_id]${naturalKey ? '\n    natural_key: true' : ''}`,
			'',
		].join('\n');

	it('the whole generated module is byte-identical with and without it', () => {
		const withKey = project('inh-nk-on', { 'item.yaml': entity(true) });
		const without = project('inh-nk-off', { 'item.yaml': entity(false) });
		expect(run(withKey, ['entity', 'new', '--all', '--force']).status).toBe(0);
		expect(run(without, ['entity', 'new', '--all', '--force']).status).toBe(0);
		const files = (root: string) => {
			const out: Record<string, string> = {};
			const walk = (dir: string) => {
				for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, e.name);
					if (e.isDirectory()) walk(full);
					else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
				}
			};
			walk(path.join(root, 'src'));
			return out;
		};
		const a = files(withKey);
		const b = files(without);
		expect(Object.keys(a).length).toBeGreaterThan(5);
		expect(a).toEqual(b);
	});
});
