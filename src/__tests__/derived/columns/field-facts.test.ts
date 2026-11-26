/**
 * TGT-0: a field's facts (`deriveFieldFacts`) hold no source text, and the `drizzle/postgres` renderer turns them into
 * exactly the columns the entity pipeline emitted before the split.
 *
 * The expected triples were produced by `processFields` on `main` before TGT-0 (the record that held facts and
 * Drizzle text together); every backend golden pins the same bytes through the templates. This table pins them for
 * every field shape on its own, so a renderer change shows up here, named by field, before it shows up as a golden
 * diff.
 */

import { describe, expect, it } from 'bun:test';
import { deriveFieldFacts } from '../../../derived/columns/fields';
import { columnRendererFor } from '../../../targets/columns';
import { TARGET_RENDERERS } from '../../../targets/renderers';
import { TARGET_PAIRS } from '../../../targets/pairs';
import { TargetConfigSchema } from '../../../schema/codegen-config.schema';
import { processFields } from '../../../../templates/entity/new/backend/entity-locals.js';
import { buildBackendLocals } from '../../../../templates/entity/new/backend/entity-locals.js';
import { DEFAULT_CODEGEN_CONFIG } from '../../../config/project-config';
import { PROJECT_CONFIG_LOCALS, withEntities } from '../../backend/_entity-lookup';

/** One field per shape: every type, a bounded string, defaults of each kind, both time zones, arrays and enums. */
const FIELDS = {
	title: { type: 'string' },
	code: { type: 'string', max_length: 8, required: true },
	slug: { type: 'string', min_length: 2 },
	note: { type: 'string', default: "it's" },
	count: { type: 'integer', nullable: false, default: 0 },
	price: { type: 'decimal', default: 9.5 },
	active: { type: 'boolean', default: true },
	owner_id: { type: 'uuid', required: true },
	born_on: { type: 'date', default: 'now' },
	seen_at: { type: 'datetime' },
	naive_at: { type: 'datetime', timezone: false, required: true },
	meta: { type: 'json', default: { a: 1 } },
	tags: { type: 'string_array', default: ['x', 'y'] },
	status: { type: 'enum', choices: ['open', 'closed'], default: 'open', required: true },
	levels: { type: 'string_array', choices: ['low', 'high'] },
	untyped: {},
};

/** `[drizzleType, drizzleChain, tsType]` per field, as `main` rendered them before TGT-0. */
const EXPECTED: Record<keyof typeof FIELDS, [string, string, string]> = {
	title: ['text', "text('title')", 'string'],
	code: ['varchar', "varchar('code', { length: 8 }).notNull()", 'string'],
	slug: ['text', "text('slug')", 'string'],
	note: ['text', "text('note').default('it\\'s')", 'string'],
	count: ['integer', "integer('count').notNull().default(0)", 'number'],
	price: ['numeric', "numeric('price').default('9.5')", 'string'],
	active: ['boolean', "boolean('active').default(true)", 'boolean'],
	owner_id: ['uuid', "uuid('owner_id').notNull()", 'string'],
	born_on: ['date', "date('born_on', { mode: 'date' }).defaultNow()", 'Date'],
	seen_at: ['timestamp', "timestamp('seen_at', { withTimezone: true, mode: 'date' })", 'Date'],
	naive_at: ['timestamp', "timestamp('naive_at').notNull()", 'Date'],
	meta: ['jsonb', 'jsonb(\'meta\').default({"a":1})', 'unknown'],
	tags: ['text', "text('tags').array().default(['x', 'y'])", 'string[]'],
	status: ['enum', "widgetStatusEnum('status').notNull().default('open')", "'open' | 'closed'"],
	levels: ['enum', "widgetLevelsEnum('levels').array()", "('low' | 'high')[]"],
	untyped: ['text', "text('untyped')", 'string'],
};

const facts = deriveFieldFacts(FIELDS, 'widget', null);
const drizzlePostgres = columnRendererFor(DEFAULT_CODEGEN_CONFIG.target, 'test');

describe('deriveFieldFacts', () => {
	it('derives one fact record per field but id, in declaration order', () => {
		const withId = deriveFieldFacts({ id: { type: 'uuid' }, ...FIELDS }, 'widget', null);
		expect(withId.map((f) => f.name)).toEqual(Object.keys(FIELDS));
	});

	// A fact a renderer reads, never text a renderer would have written. Drizzle builder calls, Zod chains and
	// TypeScript type strings all carry one of these; no declared value in FIELDS does.
	it.each(facts.map((f) => [f.name, f] as const))('%s carries no source text', (_name, f) => {
		const text = JSON.stringify(f);
		for (const token of ['(', 'z.', '.notNull', 'varchar', 'pgTable', 'Enum(', ' | ', '[]']) {
			expect(text).not.toContain(token);
		}
	});

	it('records what the renderers branch on', () => {
		const byName = Object.fromEntries(facts.map((f) => [f.name, f]));
		expect(byName.tags).toMatchObject({ isArray: true, elementType: 'string', hasDefault: true, default: ['x', 'y'] });
		expect(byName.naive_at).toMatchObject({ withTimezone: false, nullable: false });
		expect(byName.seen_at).toMatchObject({ withTimezone: true, nullable: true });
		expect(byName.title).toMatchObject({ withTimezone: null, minLength: null, maxLength: null });
		expect(byName.code).toMatchObject({ maxLength: 8, required: true });
		expect(byName.status).toMatchObject({
			hasChoices: true,
			enumName: 'widgetStatusEnum',
			enumDbName: 'widget_status',
			enumImport: null,
		});
		expect(byName.untyped).toMatchObject({ type: 'string', elementType: 'string', isArray: false });
	});

	it('takes a choices_of field from its resolver: the owner names it, this entity imports it', () => {
		const [kind] = deriveFieldFacts({ kind: { type: 'enum', choices_of: 'base.kind' } }, 'child', () => ({
			choices: ['a', 'b'],
			enumName: 'baseKindEnum',
			dbName: 'base_kind',
			importPath: '../bases/base.enums',
		}));
		expect(kind).toMatchObject({
			choices: ['a', 'b'],
			enumName: 'baseKindEnum',
			enumDbName: 'base_kind',
			enumImport: { enumName: 'baseKindEnum', importPath: '../bases/base.enums' },
		});
	});
});

describe('the drizzle/postgres column renderer', () => {
	it.each(facts.map((f) => [f.name, f] as const))('%s renders as it did before TGT-0', (name, f) => {
		const { drizzleType, drizzleChain, tsType } = drizzlePostgres.render(f);
		expect([drizzleType, drizzleChain, tsType]).toEqual(EXPECTED[name as keyof typeof FIELDS]);
	});

	it('covers every field in the matrix (a field added without an expectation fails)', () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(FIELDS).sort());
	});
});

describe('the target selects the renderer, and is required', () => {
	it('drizzle/postgres is the one supported pair, and the default', () => {
		expect(Object.keys(TARGET_RENDERERS)).toEqual(['drizzle/postgres']);
		expect(DEFAULT_CODEGEN_CONFIG.target).toEqual({ database: 'postgres', orm: 'drizzle' });
		expect(drizzlePostgres.pair).toBe('drizzle/postgres');
	});

	// One table (`TARGET_PAIRS`) feeds the schema and the renderers: a row that renders nothing, or a pair the
	// schema accepts with no renderer, fails here.
	it.each(TARGET_PAIRS.map((p) => [`${p.orm}/${p.database}`, p] as const))(
		'%s parses, has a renderer, and renders every field shape',
		(key, p) => {
			const target = TargetConfigSchema.parse({ database: p.database, orm: p.orm });
			const renderer = columnRendererFor(target, 'test');
			expect(renderer.pair).toBe(key as typeof renderer.pair);
			for (const f of facts) expect(renderer.render(f).drizzleChain.length).toBeGreaterThan(0);
		},
	);

	it('a pair not in the table is refused by the schema and by the renderer lookup', () => {
		expect(TargetConfigSchema.safeParse({ database: 'sqlite', orm: 'drizzle' }).success).toBe(false);
		expect(TargetConfigSchema.safeParse({ database: 'postgres', orm: 'kysely' }).success).toBe(false);
		expect(() => columnRendererFor({ database: 'sqlite', orm: 'drizzle' } as never, 'caller')).toThrow(
			'caller: target { database: sqlite, orm: drizzle } is not a supported pair (supported: { database: postgres, orm: drizzle }).',
		);
	});

	it('an absent target is an error, never a fallback renderer', () => {
		expect(() => columnRendererFor(undefined, 'caller')).toThrow(/caller: target must be .* got undefined/);
	});

	it('processFields refuses to run without a renderer', () => {
		expect(() => processFields(FIELDS, { entityName: 'widget', enumResolver: null, columns: undefined })).toThrow(
			/processFields\(widget\): columns .* is required/,
		);
	});

	it('buildBackendLocals refuses baseLocals without the project target (#726 shape c)', () => {
		const { target: _omitted, ...withoutTarget } = PROJECT_CONFIG_LOCALS;
		const definition = { entity: { name: 'widget', plural: 'widgets' }, fields: { title: { type: 'string' } } };
		expect(() => buildBackendLocals(definition, { ...withEntities(), ...withoutTarget, target: undefined })).toThrow(
			/buildBackendLocals\(widget\): target must be/,
		);
	});
});
