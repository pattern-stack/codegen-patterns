/**
 * The OpenAPI operations of an entity's routes (H-1b2, `docs/specs/H-1.md`): per routed command, the ordered list of
 * what its documentation says (the operation, its query and path parameters, its body, its responses), in the order
 * the Nest controller's decorators print it. The one source two printers read:
 *
 * - `nestDecorators(items)`: the `@ApiOperation` / `@ApiQuery` / `@ApiParam` / `@ApiBody` / `@ApiResponse` lines
 *   `controller.ejs.t` prints (the Nest baseline holds them byte for byte);
 * - `openApiPathSpec(items)`: the `registerPath` spec `routes.ejs.t` prints for the Hono app's `/docs-json`.
 *
 * Template-side on purpose: ADR-046 §4 keeps decorator text out of `src/derived`. Names, routes and summaries come from
 * the derivation (`apiSurface.commands`); the prose below is documentation.
 */

import { rowFor } from '../../src/utils/keyed-row.js';

const ERROR_REF = 'ErrorResponseDto';

/** A value as a single-quoted JS string literal, escaped (what the decorators print). */
const lit = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const ref = (name) => `#/components/schemas/${name}`;

const PAGE_PARAMS = (paramExamples) => [
	{ kind: 'query', name: 'page', type: 'integer', example: paramExamples.page, descriptionLiteral: "'1-based page number (default 1).'" },
	{ kind: 'query', name: 'pageSize', type: 'integer', example: paramExamples.pageSize, descriptionLiteral: "'Page size (default 50, max 200).'" },
	{ kind: 'query', name: 'cursor', type: 'string', descriptionLiteral: "'Opaque keyset cursor (accepted; v1 paginates by offset).'" },
	{ kind: 'query', name: 'sort_by', type: 'string', descriptionLiteral: `"Sort column (default 'created_at')."` },
	{ kind: 'query', name: 'sort_order', enum: ['asc', 'desc'], descriptionLiteral: `"Sort direction (default 'desc')."` },
];

/** The `?include=` parameter of a route: allowlisted or not, with its first allowlisted path as the example. */
function includeParam(route, allowlisted, example) {
	// The two routes' texts differ slightly (find's names the key in backticks); kept as the controller wrote them.
	const none =
		route === 'list'
			? "'No include is exposed on this route (no api.includes.list in the entity YAML), so any value is a 400.'"
			: "'No include is exposed on this route (no `api.includes.find_by_id` in the entity YAML), so any value is a 400.'";
	return {
		kind: 'include',
		name: 'include',
		type: 'string',
		example,
		descriptionLiteral: allowlisted
			? `'Comma-separated include paths, written as relation keys (camelCase), allowlisted by api.includes.${route} in the entity YAML. Anything else is a 400.'`
			: none,
	};
}

const idParam = (paramExamples) => ({
	kind: 'param',
	name: 'id',
	example: paramExamples.id,
	descriptionLiteral: paramExamples.idDescriptionLiteral,
	description: paramExamples.idDescription,
});
const errors = (...statuses) => statuses.map((s) => (typeof s === 'number' ? { kind: 'response', status: s, schema: ERROR_REF } : s));
const UNIQUE = { kind: 'response', status: 409, description: 'A unique value is already taken (code unique_violation).', schema: ERROR_REF };
const FOREIGN = { kind: 'response', status: 422, description: 'A foreign key names no existing row (code foreign_key_violation).', schema: ERROR_REF };
const STILL = { kind: 'response', status: 409, description: 'Another row still references this one (code still_referenced).', schema: ERROR_REF };

/**
 * Each routed command kind's operation: its documentation items after the operation, whether the operation is
 * printed on several lines (the EAV ones), and whether it names the bearer security (`@ApiBearerAuth()` sits on the
 * entity controller; the search controller has none). One row per kind.
 */
const OPERATIONS = {
	list: {
		items: ({ paramExamples, includeRoutes, outputDto }) => [
			...PAGE_PARAMS(paramExamples),
			includeParam('list', includeRoutes.includes('list'), paramExamples.include.list),
			{ kind: 'response', status: 200, page: outputDto },
			...errors(401),
		],
		block: false,
		bearer: true,
	},
	list_with_fields: { items: () => [{ kind: 'response', status: 200 }, ...errors(401)], block: true, bearer: true },
	find_by_id: {
		items: ({ paramExamples, includeRoutes, outputDto }) => [
			{ kind: 'response', status: 200, schema: outputDto },
			...errors(401, 404),
			idParam(paramExamples),
			includeParam('find_by_id', includeRoutes.includes('find_by_id'), paramExamples.include.find_by_id),
		],
		block: false,
		bearer: true,
	},
	find_by_id_with_fields: {
		items: ({ paramExamples }) => [{ kind: 'response', status: 200 }, ...errors(401, 404), idParam(paramExamples)],
		block: true,
		bearer: true,
	},
	create: {
		items: ({ createDto, outputDto }) => [
			{ kind: 'body', schema: createDto },
			{ kind: 'response', status: 201, schema: outputDto },
			...errors(400, UNIQUE, FOREIGN, 401),
		],
		block: false,
		bearer: true,
	},
	update: {
		items: ({ paramExamples, updateDto, outputDto }) => [
			{ kind: 'body', schema: updateDto },
			{ kind: 'response', status: 200, schema: outputDto },
			...errors(400, UNIQUE, FOREIGN, 401, 404),
			idParam(paramExamples),
		],
		block: false,
		bearer: true,
	},
	// Nest's docs say 204 (`@ApiResponse({ status: 204 })`) though it sends 200; the document keeps what Nest's says.
	delete: {
		items: ({ paramExamples }) => [{ kind: 'response', status: 204 }, ...errors(401, 404), STILL, idParam(paramExamples)],
		block: false,
		bearer: true,
	},
	// The search controller has no Swagger decorators: Nest's document gives it only its default 200 (its query is a
	// Zod type Nest's scan can't read, so no parameters), and no security.
	search: { items: () => [{ kind: 'response', status: 200 }], block: false, bearer: false },
};

/**
 * Every routed command's operation: `{ command, items }`, `items[0]` the operation itself.
 *
 * `ctx`: `apiSurface`, `paramExamples`, and the DTO names (`outputDto`, `createDto`, `updateDto`).
 */
export function openApiOperations(ctx) {
	const { apiSurface } = ctx;
	const facts = { ...ctx, includeRoutes: apiSurface.http.includeRoutes };
	return apiSurface.commands
		.filter((c) => c.http)
		.map((c) => {
			const route = apiSurface.http.routes.find((r) => r.useCase === c.useCase);
			if (!route || !route.operationId) {
				throw new Error(`[codegen] '${apiSurface.entity}': command '${c.name}' has no route with an operationId to document`);
			}
			const row = rowFor(`'${apiSurface.entity}' OpenAPI operation`, OPERATIONS, c.kind);
			const operation = { kind: 'operation', summary: c.summary, operationId: route.operationId, block: row.block, bearer: row.bearer };
			return { command: c, route, items: [operation, ...row.items(facts)] };
		});
}

/** The decorators a Nest handler carries, from its items: the lines `controller.ejs.t` prints above the route. */
export function nestDecorators(items) {
	return items.map((item) => NEST_PRINTERS[item.kind](item)).join('\n');
}

const NEST_PRINTERS = {
	operation: (i) =>
		i.block
			? `  @ApiOperation({\n    summary: ${lit(i.summary)},\n    operationId: ${lit(i.operationId)},\n  })`
			: `  @ApiOperation({ summary: ${lit(i.summary)}, operationId: ${lit(i.operationId)} })`,
	query: (i) =>
		`  @ApiQuery({ name: ${lit(i.name)}, required: false, ${i.enum ? `enum: [${i.enum.map(lit).join(', ')}]` : `type: ${lit(i.type)}`}${i.example !== undefined ? `, example: ${i.example}` : ''}, description: ${i.descriptionLiteral} })`,
	include: (i) =>
		[
			'  @ApiQuery({',
			`    name: ${lit(i.name)},`,
			'    required: false,',
			`    type: ${lit(i.type)},`,
			...(i.example !== null ? [`    example: ${lit(i.example)},`] : []),
			'    description:',
			`      ${i.descriptionLiteral},`,
			'  })',
		].join('\n'),
	param: (i) => `  @ApiParam({ name: ${lit(i.name)}, type: 'string', format: 'uuid', example: ${lit(i.example)}, description: ${i.descriptionLiteral} })`,
	body: (i) => `  @ApiBody({ schema: { $ref: '${ref(i.schema)}' } })`,
	response: (i) => {
		if (i.page) {
			return [
				'  @ApiResponse({',
				`    status: ${i.status},`,
				'    schema: {',
				"      type: 'object',",
				'      properties: {',
				`        items: { type: 'array', items: { $ref: '${ref(i.page)}' } },`,
				"        page: { type: 'integer' },",
				"        pageCount: { type: 'integer' },",
				"        total: { type: 'integer' },",
				"        pageSize: { type: 'integer' },",
				"        nextCursor: { type: 'string', nullable: true },",
				'      },',
				"      required: ['items', 'page', 'pageCount', 'total', 'pageSize', 'nextCursor'],",
				'    },',
				'  })',
			].join('\n');
		}
		const parts = [`status: ${i.status}`, ...(i.description ? [`description: ${lit(i.description)}`] : []), ...(i.schema ? [`schema: { $ref: '${ref(i.schema)}' }`] : [])];
		return `  @ApiResponse({ ${parts.join(', ')} })`;
	},
};

/** A JS string literal's value (`'a'` or `"a"`, as the decorators print them). */
const literalValue = (literal) => literal.slice(1, -1).replace(/\\'/g, "'");

/**
 * The OpenAPI operation for `registerPath`, from the same items: what Nest's document says for the route (parameters,
 * request body, responses, and the controllers' bearer security).
 */
export function openApiPathSpec(operation) {
	const [op, ...rest] = operation.items;
	const parameters = [];
	const responses = {};
	let requestBody;
	for (const i of rest) {
		if (i.kind === 'query' || i.kind === 'include') {
			parameters.push({
				name: i.name,
				in: 'query',
				required: false,
				schema: i.enum ? { type: 'string', enum: i.enum } : { type: i.type },
				...(i.example !== undefined && i.example !== null ? { example: i.example } : {}),
				description: literalValue(i.descriptionLiteral),
			});
		} else if (i.kind === 'param') {
			parameters.push({ name: i.name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, example: i.example, description: i.description });
		} else if (i.kind === 'body') {
			requestBody = { required: true, content: { 'application/json': { schema: { $ref: ref(i.schema) } } } };
		} else {
			const schema = i.page
				? {
						type: 'object',
						properties: {
							items: { type: 'array', items: { $ref: ref(i.page) } },
							page: { type: 'integer' },
							pageCount: { type: 'integer' },
							total: { type: 'integer' },
							pageSize: { type: 'integer' },
							nextCursor: { type: 'string', nullable: true },
						},
						required: ['items', 'page', 'pageCount', 'total', 'pageSize', 'nextCursor'],
					}
				: i.schema
					? { $ref: ref(i.schema) }
					: undefined;
			responses[String(i.status)] = { description: i.description ?? '', ...(schema ? { content: { 'application/json': { schema } } } : {}) };
		}
	}
	return {
		summary: op.summary,
		operationId: op.operationId,
		...(parameters.length > 0 ? { parameters } : {}),
		...(requestBody ? { requestBody } : {}),
		responses,
		...(op.bearer ? { security: [{ bearer: [] }] } : {}),
	};
}

/** `/accounts/:id` → `/accounts/{id}`: the OpenAPI form of a route's path. */
export function openApiPath(path) {
	return path.replace(/:([A-Za-z_]\w*)/g, '{$1}');
}
