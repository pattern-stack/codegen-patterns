/**
 * The `$ref` closure check the OpenAPI smoke gate (`verify-openapi.ts`) runs over
 * the built document: every local reference (`#/components/schemas/CreateTaskDto`)
 * must point at something in the document. A validator alone is not enough —
 * `@readme/openapi-parser`'s `validate()` accepted a `/docs-json` whose six entity
 * refs all dangled (0.35.0 release rehearsal). Its own file so it is unit-tested
 * (`src/__tests__/smoke/openapi-refs.test.ts`) without booting a project.
 */

/** Every `$ref` in `doc` that does not resolve inside `doc`, sorted and de-duplicated. */
export function danglingRefs(doc: unknown): string[] {
	const missing = new Set<string>();
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (node === null || typeof node !== 'object') return;
		for (const [key, value] of Object.entries(node)) {
			if (key === '$ref' && typeof value === 'string') {
				if (!resolves(doc, value)) missing.add(value);
			} else {
				walk(value);
			}
		}
	};
	walk(doc);
	return [...missing].sort();
}

/** A local JSON pointer (`#/a/b`, RFC 6901 escapes) that names a value in `doc`. Anything else does not resolve. */
function resolves(doc: unknown, ref: string): boolean {
	if (!ref.startsWith('#/')) return false;
	let node: unknown = doc;
	for (const raw of ref.slice(2).split('/')) {
		const token = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
		if (node === null || typeof node !== 'object' || !Object.hasOwn(node, token)) return false;
		node = (node as Record<string, unknown>)[token];
	}
	return true;
}
