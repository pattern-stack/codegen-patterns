/**
 * #845 (#796 follow-up) — the time-zone knob for BEHAVIOR columns.
 *
 * `timestamps` (`created_at`, `updated_at`) and `soft_delete` (`deleted_at`)
 * emit `timestamp with time zone` unless switched off:
 *   1. the behavior's own `options: { timezone }` in the entity's `behaviors:`;
 *   2. else the project's `behaviors.timezone` in `codegen.config.yaml` (default true).
 * The rule is `behaviorWithTimezone` (src/schema/field-timestamp.ts); the one
 * emission site is `entity.ejs.t`'s `timestampColumn(…, <behavior>WithTimezone)`.
 *
 * The real-database half (a naive column round-trips exactly with the knob off,
 * and is skewed by the process zone with it on) is
 * `test/scaffold/tests/behavior-timezone.test.ts`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { timestampBehaviorNames } from '../../behaviors/index';
import { parseCodegenConfig } from '../../config/project-config';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { TIMEZONE_NOT_BOOLEAN_MESSAGE, behaviorWithTimezone } from '../../schema/field-timestamp';
import { withEntities } from './_entity-lookup';

const REPO = path.resolve(import.meta.dir, '../../..');
const TZ = "{ withTimezone: true, mode: 'date' }";

const ENTITY_TEMPLATE = fs
	.readFileSync(path.join(REPO, 'templates/entity/new/backend/entity.ejs.t'), 'utf8')
	.replace(/^---\n[\s\S]*?\n---\n/, '');

function render(behaviors: unknown[], baseLocals: Record<string, unknown> = {}): string {
	const definition = {
		entity: { name: 'ledger_entry', plural: 'ledger_entries', table: 'ledger_entries', pattern: 'Base' },
		fields: { memo: { type: 'string', required: true } },
		behaviors,
	};
	const locals = buildBackendLocals(definition, withEntities(baseLocals)) as Record<string, unknown>;
	return ejs.render(ENTITY_TEMPLATE, locals, { rmWhitespace: false });
}

const BOTH = ['timestamps', 'soft_delete'];
const tzCol = (c: string) => `timestamp('${c}', ${TZ})`;
const bareCol = (c: string) => `timestamp('${c}')`;

describe('behaviorWithTimezone', () => {
	it('the behavior option wins; else the project default', () => {
		expect(behaviorWithTimezone(['timestamps'], 'timestamps', true)).toBe(true);
		expect(behaviorWithTimezone(['timestamps'], 'timestamps', false)).toBe(false);
		const off = [{ name: 'timestamps', options: { timezone: false } }];
		expect(behaviorWithTimezone(off, 'timestamps', true)).toBe(false);
		expect(behaviorWithTimezone(off, 'soft_delete', true)).toBe(true);
		const on = [{ name: 'soft_delete', options: { timezone: true } }];
		expect(behaviorWithTimezone(on, 'soft_delete', false)).toBe(true);
		// An implied behavior (no entry) takes the project default.
		expect(behaviorWithTimezone(undefined, 'timestamps', false)).toBe(false);
	});

	it('the timestamp behaviors come from the registry', () => {
		expect(timestampBehaviorNames().sort()).toEqual(['soft_delete', 'timestamps']);
	});
});

describe('emission (entity.ejs.t)', () => {
	it('default: every behavior column is timestamptz, byte-identical to an explicit project true', () => {
		const out = render(BOTH);
		expect(out).toContain(`createdAt: ${tzCol('created_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`updatedAt: ${tzCol('updated_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`deletedAt: ${tzCol('deleted_at')},`);
		expect(render(BOTH, { behaviorsTimezone: true })).toBe(out);
	});

	it('project knob off: every behavior column is bare', () => {
		const out = render(BOTH, { behaviorsTimezone: false });
		expect(out).toContain(`createdAt: ${bareCol('created_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`updatedAt: ${bareCol('updated_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`deletedAt: ${bareCol('deleted_at')},`);
		expect(out).not.toContain('withTimezone');
	});

	it('entity knob off on one behavior: only its columns are bare', () => {
		const out = render([{ name: 'timestamps', options: { timezone: false } }, 'soft_delete']);
		expect(out).toContain(`createdAt: ${bareCol('created_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`updatedAt: ${bareCol('updated_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`deletedAt: ${tzCol('deleted_at')},`);
	});

	it('entity knob on overrides a project off', () => {
		const out = render(['timestamps', { name: 'soft_delete', options: { timezone: true } }], {
			behaviorsTimezone: false,
		});
		expect(out).toContain(`createdAt: ${bareCol('created_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`deletedAt: ${tzCol('deleted_at')},`);
	});
});

describe('validation', () => {
	const entityWith = (behaviors: unknown[]) => ({
		entity: { name: 'ledger_entry', plural: 'ledger_entries', table: 'ledger_entries', pattern: 'Base' },
		fields: { memo: { type: 'string' } },
		behaviors,
	});

	it('accepts timezone: true | false on timestamps and soft_delete', () => {
		for (const name of ['timestamps', 'soft_delete']) {
			for (const timezone of [true, false]) {
				expect(EntityDefinitionSchema.safeParse(entityWith([{ name, options: { timezone } }])).success).toBe(true);
			}
		}
	});

	it('rejects timezone on a behavior with no timestamp column, at the option path', () => {
		const r = EntityDefinitionSchema.safeParse(entityWith([{ name: 'user_tracking', options: { timezone: false } }]));
		expect(r.success).toBe(false);
		const issue = r.error!.issues[0]!;
		expect(issue.path).toEqual(['behaviors', 0, 'options', 'timezone']);
		expect(issue.message).toContain("'user_tracking' emits none");
	});

	it('rejects a non-boolean timezone', () => {
		const r = EntityDefinitionSchema.safeParse(entityWith([{ name: 'timestamps', options: { timezone: 'no' } }]));
		expect(r.success).toBe(false);
		expect(r.error!.issues[0]!.message).toBe(TIMEZONE_NOT_BOOLEAN_MESSAGE);
	});

	it('codegen.config.yaml: behaviors.timezone defaults to true, takes a boolean, is strict', () => {
		expect(parseCodegenConfig({}, 'c.yaml').behaviors.timezone).toBe(true);
		expect(parseCodegenConfig({ behaviors: { timezone: false } }, 'c.yaml').behaviors.timezone).toBe(false);
		expect(() => parseCodegenConfig({ behaviors: { timezone: 'no' } }, 'c.yaml')).toThrow(/behaviors\.timezone/);
		expect(() => parseCodegenConfig({ behaviors: { tz: false } }, 'c.yaml')).toThrow(/behaviors\.tz: unknown key/);
	});
});

describe('the project knob reaches the emitted file through the CLI', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	function generate(config: string, behaviorsYaml: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-tz-'));
		dirs.push(dir);
		fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), config);
		fs.mkdirSync(path.join(dir, 'entities'));
		fs.writeFileSync(
			path.join(dir, 'entities/ledger_entry.yaml'),
			'entity:\n  name: ledger_entry\n  plural: ledger_entries\n  table: ledger_entries\n  pattern: Base\n' +
				`fields:\n  memo:\n    type: string\nbehaviors:\n${behaviorsYaml}`,
		);
		const r = spawnSync(
			'bun',
			[path.join(REPO, 'src/cli/index.ts'), 'entity', 'new', '--all', '--force', '--cwd', dir],
			{ encoding: 'utf-8' },
		);
		expect(r.status, r.stdout + r.stderr).toBe(0);
		return fs.readFileSync(path.join(dir, 'src/modules/ledger-entries/ledger-entry.entity.ts'), 'utf8');
	}

	it('behaviors.timezone: false emits every behavior column bare; an entity option turns one back on', () => {
		const out = generate(
			'behaviors:\n  timezone: false\n',
			'  - timestamps\n  - name: soft_delete\n    options:\n      timezone: true\n',
		);
		expect(out).toContain(`createdAt: ${bareCol('created_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`updatedAt: ${bareCol('updated_at')}.notNull().defaultNow(),`);
		expect(out).toContain(`deletedAt: ${tzCol('deleted_at')},`);
	}, 60_000);
});
