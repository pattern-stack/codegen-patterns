/**
 * Unit tests for `test/smoke/_openapi-examples.ts`, the prefill check in the OpenAPI smoke gate: Swagger's
 * "Try it out" must prefill only requests the app accepts.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { examplePrefillProblems } from '../../../test/smoke/_openapi-examples';

const Create = z.object({ name: z.string(), status: z.enum(['a', 'b']) });
const Output = z.object({ id: z.guid(), name: z.string() });
const schemas: Record<string, z.ZodType> = { CreateThingDto: Create, ThingOutputDto: Output };
const named = (n: string) => schemas[n];

const json = (name: string) => ({ content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } });
const GUID = '00000000-0000-4000-8000-000000000001';

function doc(createExample: unknown, opts: { idExample?: unknown; outputExample?: unknown } = {}) {
	return {
		paths: {
			'/things': { post: { requestBody: json('CreateThingDto'), responses: { 201: json('ThingOutputDto') } } },
			'/things/{id}': {
				get: { parameters: [{ in: 'path', name: 'id', example: 'idExample' in opts ? opts.idExample : GUID }] },
			},
		},
		components: {
			schemas: {
				CreateThingDto: createExample === undefined ? { type: 'object' } : { type: 'object', example: createExample },
				ThingOutputDto: { type: 'object', example: 'outputExample' in opts ? opts.outputExample : { id: GUID, name: 'x' } },
			},
		},
	};
}

describe('examplePrefillProblems', () => {
	it('passes valid prefills', () => {
		expect(examplePrefillProblems(doc({ name: 'Example name', status: 'a' }), named)).toEqual([]);
	});

	it('fails a request body with no example (Swagger would prefill "string")', () => {
		expect(examplePrefillProblems(doc(undefined), named)).toEqual([
			'POST /things request body: component CreateThingDto has no example, so Try it out prefills a placeholder body',
		]);
	});

	it('fails an example the DTO rejects, naming the field', () => {
		const [problem] = examplePrefillProblems(doc({ name: 'x', status: 'c' }), named);
		expect(problem).toContain("CreateThingDto's example does not parse");
		expect(problem).toContain('status');
	});

	it('checks a response example too', () => {
		const [problem] = examplePrefillProblems(doc({ name: 'x', status: 'a' }, { outputExample: { id: 'nope', name: 'x' } }), named);
		expect(problem).toContain("ThingOutputDto's example does not parse");
	});

	it('reads a parameter example from its schema, where @nestjs/swagger writes it', () => {
		const d = doc({ name: 'x', status: 'a' });
		d.paths['/things/{id}'].get.parameters = [{ in: 'path', name: 'id', schema: { type: 'string', example: GUID } } as never];
		expect(examplePrefillProblems(d, named)).toEqual([]);
	});

	it('fails an :id parameter without a guid example', () => {
		expect(examplePrefillProblems(doc({ name: 'x', status: 'a' }, { idExample: undefined }), named)).toEqual([
			'GET /things/{id}: path parameter id has no guid example (got undefined)',
		]);
	});
});
