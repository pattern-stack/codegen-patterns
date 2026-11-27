/**
 * The prefill check the OpenAPI smoke gate (`verify-openapi.ts`) runs over the built document: what Swagger's
 * "Try it out" fills in must be a request the app accepts, without the user typing anything.
 *
 * - Every operation's JSON request body names a component that carries an `example`, and that example parses
 *   through the component's own generated Zod DTO (the registry's schema of that name).
 * - Every response component that carries an `example` parses through its DTO too.
 * - Every `:id` path parameter has a guid example.
 * - A `page` / `pageSize` example is a positive integer.
 *
 * Its own file so it is unit-tested (`src/__tests__/smoke/openapi-examples.test.ts`) without booting a project.
 */

/** The part of a Zod schema this check calls. */
export interface ParsesInput {
	safeParse(input: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } };
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const SCHEMA_REF = '#/components/schemas/';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function refName(schema: unknown): string | null {
	if (!isObj(schema) || typeof schema.$ref !== 'string' || !schema.$ref.startsWith(SCHEMA_REF)) return null;
	return schema.$ref.slice(SCHEMA_REF.length);
}

function issuesOf(result: ReturnType<ParsesInput['safeParse']>): string {
	return (result.error?.issues ?? []).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Every prefill problem in `doc`, one line each; empty when Try it out sends only valid requests. */
export function examplePrefillProblems(doc: unknown, schemaNamed: (name: string) => ParsesInput | undefined): string[] {
	const problems: string[] = [];
	if (!isObj(doc)) return ['the document is not an object'];
	const components = isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : {};
	const paths = isObj(doc.paths) ? doc.paths : {};

	const checkComponent = (name: string, where: string, requireExample: boolean): void => {
		const component = components[name];
		if (!isObj(component)) return; // a dangling ref is the $ref check's to report
		if (!('example' in component)) {
			if (requireExample) problems.push(`${where}: component ${name} has no example, so Try it out prefills a placeholder body`);
			return;
		}
		const schema = schemaNamed(name);
		if (!schema) {
			problems.push(`${where}: no registered Zod schema named ${name} to check its example against`);
			return;
		}
		const result = schema.safeParse(component.example);
		if (!result.success) problems.push(`${where}: ${name}'s example does not parse — ${issuesOf(result)}`);
	};

	for (const [path, item] of Object.entries(paths)) {
		if (!isObj(item)) continue;
		for (const method of METHODS) {
			const op = item[method];
			if (!isObj(op)) continue;
			const where = `${method.toUpperCase()} ${path}`;

			const body = isObj(op.requestBody) && isObj(op.requestBody.content) ? op.requestBody.content['application/json'] : undefined;
			const bodyRef = isObj(body) ? refName(body.schema) : null;
			if (bodyRef !== null) checkComponent(bodyRef, `${where} request body`, true);

			if (isObj(op.responses)) {
				for (const [status, response] of Object.entries(op.responses)) {
					const content = isObj(response) && isObj(response.content) ? response.content['application/json'] : undefined;
					const ref = isObj(content) ? refName(content.schema) : null;
					if (ref !== null) checkComponent(ref, `${where} ${status} response`, false);
				}
			}

			for (const param of Array.isArray(op.parameters) ? op.parameters : []) {
				if (!isObj(param)) continue;
				// OpenAPI 3 lets a parameter carry its example itself or on its schema; @nestjs/swagger writes the
				// schema's, and Swagger UI reads either.
				const example = 'example' in param ? param.example : isObj(param.schema) ? param.schema.example : undefined;
				if (param.in === 'path' && param.name === 'id') {
					if (typeof example !== 'string' || !GUID.test(example)) {
						problems.push(`${where}: path parameter id has no guid example (got ${JSON.stringify(example)})`);
					}
				}
				if (param.in === 'query' && (param.name === 'page' || param.name === 'pageSize') && example !== undefined) {
					if (typeof example !== 'number' || !Number.isInteger(example) || example < 1) {
						problems.push(`${where}: query ${String(param.name)} example ${JSON.stringify(example)} is not a positive integer`);
					}
				}
			}
		}
	}
	return problems;
}
