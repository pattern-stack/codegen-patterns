/**
 * Unit tests for fieldTypeToZod mapping — issue #43
 *
 * PG `numeric` columns are returned by Drizzle as strings (precision
 * preservation). `z.number()` fails validation when the value is a string;
 * `z.coerce.number()` accepts either JS number or string input.
 *
 * This test covers the Clean Architecture path (fieldTypeToZod exported from
 * entity-definition.schema.ts and the zodTypes map in prompt.js).
 * The clean-lite-ps parallel fix (z.coerce.string()) is covered by
 * src/__tests__/clean-lite-ps/dto-template.test.ts.
 */

import { describe, it, expect } from 'bun:test';
import { fieldTypeToZod } from '../../schema/entity-definition.schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';

// ============================================================================
// fieldTypeToZod map (schema-level export)
// ============================================================================

describe('fieldTypeToZod — decimal field (issue #43)', () => {
	it('maps decimal to z.coerce.number() — not bare z.number()', () => {
		expect(fieldTypeToZod.decimal).toBe('z.coerce.number()');
	});

	it('json stays z.unknown() — unaffected by decimal fix', () => {
		expect(fieldTypeToZod.json).toBe('z.unknown()');
	});
});

// ============================================================================
// Template-level emission test (Clean Architecture DTO template)
// ============================================================================

const DTO_TEMPLATE = readFileSync(
	resolve(
		import.meta.dir,
		'../../../templates/entity/new/backend/application/schemas/dto.ejs.t',
	),
	'utf8',
);

function extractBody(source: string): string {
	const lines = source.split('\n');
	if (lines[0] !== '---') return source;
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === '---') {
			end = i;
			break;
		}
	}
	if (end === -1) return source;
	return lines.slice(end + 1).join('\n');
}

function render(template: string, locals: Record<string, unknown>): string {
	return ejs.render(extractBody(template), locals, { rmWhitespace: false });
}

// Minimal locals matching what prompt.js provides to the DTO template
const minimalLocals = {
	className: 'Deal',
	isCleanArchitecture: true,
	generate: { dtos: true },
	outputPaths: { dto: 'deal.dto.ts' },
	hasEntityRefFields: false,
	locations: { dbContextEngine: { import: '@shared/db' } },
	fields: [
		{
			name: 'amount',
			camelName: 'amount',
			type: 'decimal',
			zodType: 'z.coerce.number()',
			required: false,
			nullable: true,
			maxLength: undefined,
			minLength: undefined,
			min: undefined,
			max: undefined,
			choices: null,
		},
	],
};

describe('Clean Architecture DTO template — decimal emission (issue #43)', () => {
	it('emits z.coerce.number() for a decimal field', () => {
		const output = render(DTO_TEMPLATE, minimalLocals);
		expect(output).toContain('amount: z.coerce.number()');
	});

	it('does not emit bare z.number() for a decimal field', () => {
		const output = render(DTO_TEMPLATE, minimalLocals);
		expect(output).not.toMatch(/amount:\s*z\.number\(\)/);
	});
});
