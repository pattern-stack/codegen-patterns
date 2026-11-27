/**
 * `src/derived/examples/` — the OpenAPI examples Swagger's "Try it out" prefills. The order a field's example comes
 * from (YAML `example:` → a fitting `default:` → first choice → a value by type), what each DTO's example holds,
 * and the literal the templates print.
 */
import { describe, expect, it } from 'bun:test';
import {
	createExample,
	EXAMPLE_DATE,
	EXAMPLE_DATETIME,
	EXAMPLE_GUID,
	exampleLiteral,
	fieldExample,
	isGuid,
	outputExample,
	updateExample,
	type ExampleField,
} from '../../derived/examples/index';
import { valueFitsField } from '../../schema/field-example';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';

const field = (over: Partial<ExampleField> & { name: string }): ExampleField => ({
	camelName: over.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
	type: 'string',
	nullable: false,
	required: false,
	hasDefault: false,
	default: undefined,
	example: undefined,
	choices: undefined,
	minLength: null,
	maxLength: null,
	...over,
});

describe('fieldExample — the order', () => {
	it('a declared example wins', () => {
		expect(fieldExample(field({ name: 'email', example: 'ada@example.com', hasDefault: true, default: 'x' }))).toBe('ada@example.com');
	});
	it('then a default the DTO accepts', () => {
		expect(fieldExample(field({ name: 'priority', choices: ['low', 'medium'], hasDefault: true, default: 'medium' }))).toBe('medium');
		expect(fieldExample(field({ name: 'is_open', type: 'boolean', hasDefault: true, default: false }))).toBe(false);
	});
	it('skips a default that is a database expression (datetime `now`)', () => {
		expect(fieldExample(field({ name: 'starts_at', type: 'datetime', hasDefault: true, default: 'now' }))).toBe(EXAMPLE_DATETIME);
	});
	it('then the first choice', () => {
		expect(fieldExample(field({ name: 'status', type: 'enum', choices: ['planned', 'active'] }))).toBe('planned');
		expect(fieldExample(field({ name: 'tags', type: 'string_array', choices: ['pg', 'sg'] }))).toEqual(['pg']);
	});
	it('then a clean value by type', () => {
		expect(fieldExample(field({ name: 'first_name' }))).toBe('Example first name');
		expect(fieldExample(field({ name: 'n', type: 'integer' }))).toBe(1);
		expect(fieldExample(field({ name: 'amount', type: 'decimal' }))).toBe('10.00');
		expect(fieldExample(field({ name: 'flag', type: 'boolean' }))).toBe(true);
		expect(fieldExample(field({ name: 'due', type: 'date' }))).toBe(EXAMPLE_DATE);
		expect(fieldExample(field({ name: 'ref', type: 'uuid' }))).toBe(EXAMPLE_GUID);
		expect(fieldExample(field({ name: 'settings', type: 'json' }))).toEqual({});
		expect(fieldExample(field({ name: 'labels', type: 'string_array' }))).toEqual(['example']);
	});
	it('fits a string to its length bounds', () => {
		expect(fieldExample(field({ name: 'code', maxLength: 4 }))).toBe('Exam');
		expect((fieldExample(field({ name: 'c', minLength: 12 })) as string).length).toBe(12);
	});
	it('has no example for a type with no single-value DTO field', () => {
		expect(fieldExample(field({ name: 'subject', type: 'entity_ref' }))).toBeUndefined();
	});
	it('refuses a declared example that does not fit (a choices_of field, checked here)', () => {
		expect(() => fieldExample(field({ name: 'kind', choices: ['a'], example: 'b' }))).toThrow(/not a value it accepts/);
	});
	it('every by-type value fits its own field', () => {
		for (const type of ['string', 'integer', 'decimal', 'boolean', 'uuid', 'date', 'datetime', 'json', 'string_array']) {
			const f = field({ name: 'x', type });
			expect(valueFitsField(f, fieldExample(f))).toBe(true);
		}
	});
});

const project = [
	field({ name: 'name', required: true, maxLength: 255 }),
	field({ name: 'status', type: 'enum', choices: ['planned', 'active'], required: true }),
	field({ name: 'is_active', type: 'boolean', hasDefault: true, default: true }),
	field({ name: 'notes', nullable: true }),
	field({ name: 'settings', type: 'json', required: true }),
];

describe('the DTO examples', () => {
	it('create: required fields, defaults and FKs; an optional field without either stays out', () => {
		expect(createExample(project, [{ camelName: 'ownerId', nullable: false }, { camelName: 'parentId', nullable: true }])).toEqual({
			ownerId: EXAMPLE_GUID,
			name: 'Example name',
			status: 'planned',
			isActive: true,
			settings: {},
		});
	});
	it('create: an override (a base\'s discriminator) and an omission', () => {
		expect(createExample(project, [], { status: 'active' }, new Set(['settings']))).toEqual({
			name: 'Example name',
			status: 'active',
			isActive: true,
		});
	});
	it('update: a minimal PATCH — the first field and the first enum or boolean after it', () => {
		expect(updateExample(project)).toEqual({ name: 'Example name', status: 'planned' });
		expect(updateExample(project, new Set(['name']))).toEqual({ status: 'planned', isActive: true });
		expect(updateExample([])).toEqual({});
	});
	it('output: the whole row, a nullable field without an example is null', () => {
		expect(outputExample(project, [{ camelName: 'ownerId', nullable: false }], { timestamps: true, softDelete: true })).toEqual({
			id: EXAMPLE_GUID,
			ownerId: EXAMPLE_GUID,
			name: 'Example name',
			status: 'planned',
			isActive: true,
			notes: 'Example notes',
			settings: {},
			createdAt: EXAMPLE_DATETIME,
			updatedAt: EXAMPLE_DATETIME,
			deletedAt: null,
		});
	});
	it('the placeholder id is a guid Nest\'s ParseUUIDPipe accepts (v4, RFC variant)', () => {
		expect(isGuid(EXAMPLE_GUID)).toBe(true);
		expect(EXAMPLE_GUID[14]).toBe('4');
		expect('89ab').toContain(EXAMPLE_GUID[19]!);
	});
});

describe('exampleLiteral — the emitted code style', () => {
	it('prints single-quoted strings and bare identifier keys', () => {
		expect(exampleLiteral({ name: "it's", 'a-b': [1, null, { x: true }] })).toBe("{ name: 'it\\'s', 'a-b': [1, null, { x: true }] }");
		expect(exampleLiteral({})).toBe('{}');
	});
});

describe('the YAML `example:` key', () => {
	const entity = (fieldDef: Record<string, unknown>) =>
		EntityDefinitionSchema.safeParse({ entity: { name: 'thing', plural: 'things' }, fields: { f: fieldDef } });
	it('accepts an example the field accepts', () => {
		expect(entity({ type: 'string', required: true, example: 'hello' }).success).toBe(true);
		expect(entity({ type: 'enum', choices: ['a', 'b'], required: true, example: 'b' }).success).toBe(true);
	});
	it('refuses one it does not, at the field', () => {
		const r = entity({ type: 'enum', choices: ['a', 'b'], required: true, example: 'c' });
		expect(r.success).toBe(false);
		expect(r.error!.issues.some((i) => i.path.join('.') === 'fields.f.example')).toBe(true);
		expect(entity({ type: 'string', required: true, max_length: 3, example: 'toolong' }).success).toBe(false);
		expect(entity({ type: 'integer', required: true, example: '1' }).success).toBe(false);
	});
});
