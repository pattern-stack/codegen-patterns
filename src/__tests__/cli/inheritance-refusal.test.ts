/**
 * RFC-0006 / #875 slice S1, end to end through the real CLI: `entity new` and
 * `entity validate` over a project holding the fixture family.
 *
 *  - the family validates clean (`entity validate`);
 *  - `entity new --all` and `entity new <child>.yaml` refuse it, naming the
 *    entity and "not implemented until S2 of #875", and emit nothing for it;
 *  - a cross-entity rule violation is reported by BOTH commands, naming the
 *    entities (the analyze path and the generation pre-flight agree);
 *  - `natural_key:` alone is accepted and changes no emitted byte.
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

describe('generation is refused until S2', () => {
	it('entity new --all refuses every entity that uses the keys, and emits nothing for them', () => {
		const root = familyProject('inh-all');
		const r = run(root, ['entity', 'new', '--all', '--force']);
		expect(r.status).not.toBe(0);
		expect(r.out).toContain("'meeting' uses 'inherits:'");
		expect(r.out).toContain('not implemented until S2 of #875');
		expect(fs.existsSync(path.join(root, 'src/modules/meetings'))).toBe(false);
		expect(fs.existsSync(path.join(root, 'src/modules/communications'))).toBe(false);
	});

	it('entity new <child>.yaml refuses a single child', () => {
		const root = familyProject('inh-one');
		const r = run(root, ['entity', 'new', 'entities/meeting.yaml', '--force']);
		expect(r.status).not.toBe(0);
		expect(r.out).toContain('not implemented until S2 of #875');
		expect(fs.existsSync(path.join(root, 'src/modules/meetings'))).toBe(false);
	});

	it('entity new refuses a cross-entity violation in the pre-flight, naming the entities', () => {
		const root = familyProject('inh-one-bad', (f) => {
			f['meeting.yaml'] = f['meeting.yaml']!.replace('inherits: communication', 'inherits: conversation');
		});
		const r = run(root, ['entity', 'new', 'entities/meeting.yaml', '--force']);
		expect(r.status).not.toBe(0);
		expect(r.out).toContain("R3 — 'meeting' inherits 'conversation'");
	});

	it('a plain entity in the same directory stops too: the barrels and the manifest read the whole set', () => {
		// Old behaviour: only the family's own files were refused, so this exited 0 and wrote a schema.ts
		// re-exporting eight modules that were never emitted, and a relations.ts naming schema.meetings.
		const root = familyProject('inh-plain');
		const r = run(root, ['entity', 'new', 'entities/email_thread.yaml', '--force']);
		expect(r.status).not.toBe(0);
		expect(r.out).toContain('not implemented until S2 of #875');
		expect(fs.existsSync(path.join(root, 'src/modules/email-threads'))).toBe(false);
		expect(fs.existsSync(path.join(root, 'src/generated/schema.ts'))).toBe(false);
		expect(fs.existsSync(path.join(root, 'src/generated/relations.ts'))).toBe(false);
	});

	it('--continue-on-error does not lift it', () => {
		const root = familyProject('inh-continue');
		const r = run(root, ['entity', 'new', '--all', '--force', '--continue-on-error']);
		expect(r.status).not.toBe(0);
		expect(fs.existsSync(path.join(root, 'src/modules'))).toBe(false);
	});

	it('a directory without the family generates, barrels included', () => {
		const root = familyProject('inh-plain-only', (f) => {
			for (const name of Object.keys(f)) if (name !== 'email_thread.yaml') delete f[name];
		});
		const r = run(root, ['entity', 'new', '--all', '--force']);
		expect(r.status).toBe(0);
		expect(fs.existsSync(path.join(root, 'src/modules/email-threads/email-thread.entity.ts'))).toBe(true);
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
