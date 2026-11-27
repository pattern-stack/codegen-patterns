/**
 * Unit tests for `test/smoke/_openapi-refs.ts`, the `$ref` closure check in the
 * OpenAPI smoke gate. The case it exists for: a fresh app's `/docs-json` whose
 * routes referenced `CreateTaskDto` & co while `components.schemas` held only
 * `ErrorResponseDto` (0.35.0 release rehearsal) — and a validator passed it.
 */
import { describe, expect, it } from 'bun:test';
import { danglingRefs } from '../../../test/smoke/_openapi-refs';

const body = (name: string) => ({
	requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } },
});

describe('danglingRefs', () => {
	it('names every route ref with no component (the rehearsal document)', () => {
		const doc = {
			paths: { '/tasks': { post: body('CreateTaskDto'), patch: body('UpdateTaskDto') } },
			components: { schemas: { ErrorResponseDto: { type: 'object' } } },
		};
		expect(danglingRefs(doc)).toEqual(['#/components/schemas/CreateTaskDto', '#/components/schemas/UpdateTaskDto']);
	});

	it('passes a document whose refs all resolve, including refs between components', () => {
		const doc = {
			paths: { '/tasks': { post: body('CreateTaskDto') } },
			components: {
				schemas: {
					CreateTaskDto: { type: 'object', properties: { err: { $ref: '#/components/schemas/ErrorResponseDto' } } },
					ErrorResponseDto: { type: 'object' },
				},
			},
		};
		expect(danglingRefs(doc)).toEqual([]);
	});

	it('reports each dangling ref once, sorted', () => {
		const doc = { paths: { '/a': { post: body('B'), put: body('A'), patch: body('B') } }, components: { schemas: {} } };
		expect(danglingRefs(doc)).toEqual(['#/components/schemas/A', '#/components/schemas/B']);
	});

	it('fails a document with no components at all', () => {
		expect(danglingRefs({ paths: { '/a': { post: body('A') } } })).toEqual(['#/components/schemas/A']);
	});

	it('treats a non-local ref as unresolved (the gate builds a self-contained document)', () => {
		expect(danglingRefs({ x: { $ref: 'other.json#/A' } })).toEqual(['other.json#/A']);
	});

	it('decodes JSON-pointer escapes', () => {
		const doc = { components: { schemas: { 'a/b': {}, 'c~d': {} } }, x: [{ $ref: '#/components/schemas/a~1b' }, { $ref: '#/components/schemas/c~0d' }] };
		expect(danglingRefs(doc)).toEqual([]);
	});
});
