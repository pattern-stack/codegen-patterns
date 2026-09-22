/**
 * Frontend emitter — the relation descriptor + typed graph accessors
 * (ADR-038, ADR-044 §5, FE-REL).
 *
 * Two kinds of file, both whole-set, complete-file, `@generated`:
 *
 *  - `graph.ts` — the client descriptor (FE-REL §3). The same edges REL-1 puts
 *    in `relations.ts`, keyed the same way, as a runtime value the browser can
 *    read. Emitted from REL-1's builder via `graph-model.ts`, so "both sides
 *    project from the same declared graph" is literal rather than aspirational.
 *  - `graph/<entity>.ts` — one fully generated accessor per `electric` entity
 *    with edges: an `<Entity>Include` type, an `<Entity>Graph<I>` result type,
 *    and a `use<Entity>Graph(id, include)` hook.
 *
 * ## Why fully generated (charter Q1, closed 2026-09-20)
 *
 * `@pattern-stack/frontend-patterns` has **zero** relation surface at any
 * published version, its collections are typed `any` (its own comment blames
 * the bundled TanStack DB), and the one place it derives a relation-shaped name
 * it re-pluralizes at runtime — the thing ADR-038 forbids. A traversal API over
 * `any` collections is untyped traversal, which is exactly the part worth
 * generating. `emit-store.ts` already reached this conclusion for FK resolvers;
 * this is the same call for the same measured reason (FE-REL §2).
 *
 * ## The query-count contract (charter I4, FE-REL §4.1)
 *
 * Server-side a traversal is literally one statement. On the client it cannot
 * be, and the reason is measured: TanStack DB has no array aggregate, so a
 * to-many cannot be folded into a nested array inside one result row — a join
 * fans out flat. So the invariant that carries I4's intent is:
 *
 *   > One live query per to-many relation OF THE ROOT. Never one per row.
 *
 * The generated module makes that countable by eye: exactly one `useLiveQuery`
 * for the root (carrying every to-one hop as a join) plus one per to-many
 * relation, all at the top level of the hook. There is no loop that could
 * produce an N+1, and the count does not depend on the data.
 *
 * A branch the caller did not ask for returns `undefined` from its query
 * function, which `useLiveQuery`'s second overload accepts as **disabled** —
 * so the number of queries actually RUN is a function of the include shape,
 * while the number of hooks stays static, as React requires.
 *
 * Depth: a to-one hop of a branch's target is joined into that branch's own
 * query (`opportunities: { with: { account: true } }` stays one query). A
 * to-many inside a branch is not in v1 — it needs client-side grouping of a
 * cartesian fan-out, and the honest version of that is its own unit. A
 * misspelled relation name is a compile error at either level (FE-REL §5).
 */

import { join } from 'node:path';
import type { FrontendEmitContext } from './types';
import { withBanner, writeFile } from './emit-utils';
import { emittedStem } from '../../config/file-naming.js';
import {
	accessorNodes,
	type ClientGraph,
	type ClientGraphNode,
	type ClientRelation,
} from './graph-model';

const SOURCE_DESC_SET = 'the entity set';

/**
 * Where the graph tree lands, relative to the frontend out dir.
 *
 * FE-REL §3 drafted the descriptor as `generated/graph.ts` beside a
 * `generated/graph/` directory of accessors. That pair is an **ambiguous module
 * specifier** — `./graph` resolves to either file depending on the bundler — so
 * the descriptor moved inside the directory as `graph/descriptor.ts`, and
 * `graph/index.ts` re-exports both. Nothing else about §3 changed: the keys,
 * the edges and the `graph` export name are exactly as specified.
 */
export const GRAPH_DIR = 'graph';
export const GRAPH_FILE = 'descriptor.ts';

// ---------------------------------------------------------------------------
// graph.ts — the descriptor
// ---------------------------------------------------------------------------

/** Render one relation as an object literal line. */
function relationLiteral(rel: ClientRelation): string {
	const parts = [
		`kind: '${rel.kind}'`,
		`target: '${rel.target}'`,
		`from: '${rel.from}'`,
		`to: '${rel.to}'`,
	];
	if (rel.through) {
		parts.push(
			`through: { collection: '${rel.through.collection}', from: '${rel.through.from}', to: '${rel.through.to}' }`,
		);
	}
	if (rel.optional !== undefined) parts.push(`optional: ${rel.optional}`);
	return `\t\t${rel.key}: { ${parts.join(', ')} },`;
}

/**
 * `graph.ts` — the client relation descriptor.
 *
 * Keys are the collection names the store already uses (`entity.plural`) and
 * relation keys are the YAML relationship names camelCased — the SAME keys
 * REL-1 emits, so one name works on both sides of the wire.
 */
export function buildGraphFile(graph: ClientGraph): string {
	const nodeBlocks = graph.nodes.map((node) => {
		if (node.relations.length === 0) {
			const why = node.junction
				? ` // junction rows — reachable as a to-many hop from either parent`
				: '';
			return `\t${node.collection}: {},${why}`;
		}
		return `\t${node.collection}: {\n${node.relations.map(relationLiteral).join('\n')}\n\t},`;
	});

	const deferredBlock =
		graph.deferred.length > 0
			? `\n *\n * Accessors deliberately NOT emitted (the edges below are still declared):\n${graph.deferred
					.map((d) => ` *   - ${d.entity}: ${d.reason}`)
					.join('\n')}`
			: '';

	const body = `/**
 * The client relation graph — the same declaration the Drizzle manifest
 * (\`src/generated/relations.ts\`) is built from, projected onto the browser's
 * collections (ADR-044 §5).
 *
 * Collection keys are \`entity.plural\`; relation keys are the YAML relationship
 * names camelCased. Both match the server manifest exactly, so one name works
 * on both sides of the wire. Nothing here is re-pluralized — every name is
 * resolved through the cross-entity registry.${deferredBlock}
 */
export const graph = {
${nodeBlocks.join('\n')}
} as const;

/** The graph's type, for deriving include and result types from. */
export type Graph = typeof graph;
`;
	return withBanner(SOURCE_DESC_SET, body);
}

// ---------------------------------------------------------------------------
// graph/<entity>.ts — the typed accessors
// ---------------------------------------------------------------------------

/** The row type name + import module for a relation's target. */
interface TargetNaming {
	className: string;
	camelName: string;
	/** Module under `dbEntities` the row type comes from. */
	entityFile: string;
	/** The emitted collection export. */
	collectionVar: string;
	collectionFile: string;
}

function targetNaming(
	rel: ClientRelation,
	graph: ClientGraph,
): TargetNaming | null {
	const node = graph.nodes.find((n) => n.collection === rel.target);
	if (!node) return null;
	if (node.entity) {
		return {
			className: node.entity.className,
			camelName: node.entity.camelName,
			entityFile: node.entity.name,
			collectionVar: `${node.entity.camelName}Collection`,
			// A codegen-EMITTED path (`../collections/<stem>`), so it takes the
			// #695/#684 naming rule. `entityFile` above is a CONSUMER-owned
			// `dbEntities` module and deliberately keeps the raw name.
			collectionFile: emittedStem(node.entity.name),
		};
	}
	if (node.junction) {
		return {
			className: node.junction.className,
			camelName: node.junction.camelName,
			entityFile: node.junction.name,
			collectionVar: `${node.junction.camelName}Collection`,
			collectionFile: emittedStem(node.junction.name),
		};
	}
	return null;
}

/**
 * Aliases the generated query bodies bind. A relation whose key is one of these
 * would shadow the row it is joined onto, so it is a generation error rather
 * than a file that compiles into the wrong join.
 */
const RESERVED_QUERY_ALIASES = new Set(['row', 'link', 'q']);

/** A relation key that would collide with a generated query alias. */
export class ReservedRelationAliasError extends Error {
	constructor(
		readonly entity: string,
		readonly relation: string,
	) {
		super(
			`relation '${relation}' on '${entity}' cannot be emitted: the generated live ` +
				`query binds '${relation}' as a table alias already (reserved: ` +
				`${[...RESERVED_QUERY_ALIASES].join(', ')}). Rename the relationship in the YAML.`,
		);
		this.name = 'ReservedRelationAliasError';
	}
}

/** The to-one relations of a node — the ones joinable into an existing query. */
function toOneRelations(node: ClientGraphNode | undefined): ClientRelation[] {
	return (node?.relations ?? []).filter((r) => r.kind === 'one');
}

/**
 * Build `graph/<entity>.ts` — the fully generated accessor for one entity.
 *
 * Emits, in order: the include type (with a nested `with` type per to-many
 * branch), the result type, and the hook.
 */
export function buildEntityGraphFile(
	node: ClientGraphNode,
	graph: ClientGraph,
	ctx: FrontendEmitContext,
): string {
	const entity = node.entity;
	if (!entity) throw new Error(`buildEntityGraphFile called for a non-entity node '${node.collection}'`);

	const dbEntities = ctx.config.dbEntitiesImport;
	const ones = node.relations.filter((r) => r.kind === 'one');
	const manys = node.relations.filter((r) => r.kind === 'many');

	for (const rel of node.relations) {
		if (RESERVED_QUERY_ALIASES.has(rel.key)) {
			throw new ReservedRelationAliasError(entity.name, rel.key);
		}
		const targetNode = graph.nodes.find((n) => n.collection === rel.target);
		for (const nested of toOneRelations(targetNode)) {
			if (RESERVED_QUERY_ALIASES.has(nested.key)) {
				throw new ReservedRelationAliasError(entity.name, `${rel.key}.${nested.key}`);
			}
		}
	}

	// ── imports ───────────────────────────────────────────────────────────────
	// Every collection the hook touches: this entity, each relation target, and
	// each junction a to-many passes through. Deduped, sorted, and named through
	// the registry — never re-derived from a relation's target string.
	const collections = new Map<string, string>(); // file → var
	const rowTypes = new Map<string, string>(); // file → className
	collections.set(emittedStem(entity.name), `${entity.camelName}Collection`);
	rowTypes.set(entity.name, entity.className);

	const naming = new Map<string, TargetNaming>();
	for (const rel of node.relations) {
		const t = targetNaming(rel, graph);
		if (!t) continue;
		naming.set(rel.key, t);
		collections.set(t.collectionFile, t.collectionVar);
		rowTypes.set(t.entityFile, t.className);
		if (rel.through) {
			const j = graph.junctions.find((x) => x.collectionKey === rel.through?.collection);
			// The key is a FILE STEM — it becomes `../collections/<stem>`. It must be
			// the #695/#684 naming rule, like every other entry in this map, not the
			// raw junction name (NAME-2: filesystem kebab).
			if (j) collections.set(emittedStem(j.name), `${j.camelName}Collection`);
		}
		// A to-many branch may nest the TARGET's to-one hops into its own query.
		const targetNode = graph.nodes.find((n) => n.collection === rel.target);
		for (const nested of toOneRelations(targetNode)) {
			const nt = targetNaming(nested, graph);
			if (!nt) continue;
			collections.set(nt.collectionFile, nt.collectionVar);
			rowTypes.set(nt.entityFile, nt.className);
		}
	}

	const collectionImports = [...collections.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([file, varName]) => `import { ${varName} } from '../collections/${file}';`)
		.join('\n');
	const typeImports = [...rowTypes.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([file, className]) => `import type { ${className} } from '${dbEntities}/${file}';`)
		.join('\n');

	// ── the nested `with` types, one per to-many branch ───────────────────────
	const withTypeName = (rel: ClientRelation): string =>
		`${entity.className}${rel.key.charAt(0).toUpperCase()}${rel.key.slice(1)}With`;

	const withTypes: string[] = [];
	const branchTypes: string[] = [];
	for (const rel of manys) {
		const targetNode = graph.nodes.find((n) => n.collection === rel.target);
		const nested = toOneRelations(targetNode);
		const t = naming.get(rel.key);
		if (!t) continue;
		const wName = withTypeName(rel);
		const bName = `${entity.className}${rel.key.charAt(0).toUpperCase()}${rel.key.slice(1)}Row`;

		if (nested.length === 0) {
			withTypes.push(
				`/** \`${entity.name}.${rel.key}\` has no to-one hop to nest — \`with\` is empty. */\nexport type ${wName} = Record<never, never>;`,
			);
			branchTypes.push(
				`/** \`${entity.name}.${rel.key}\` rows — nothing nests into them. */\ntype ${bName} = ${t.className};`,
			);
			continue;
		}

		const fields = nested
			.map((n) => {
				const nt = naming.get(n.key) ?? targetNaming(n, graph);
				return `\t/** ${t.className}.${n.key} → ${nt?.className ?? n.target} */\n\t${n.key}?: true;`;
			})
			.join('\n');
		withTypes.push(
			`/** To-one hops of ${t.className} that join into the \`${rel.key}\` branch's own query. */\nexport interface ${wName} {\n${fields}\n}`,
		);

		const clauses = nested
			.map((n) => {
				const nt = targetNaming(n, graph);
				const value = `${nt?.className ?? 'unknown'} | undefined`;
				return `\t(Sel<Sel<W, 'with'>, '${n.key}'> extends true ? { ${n.key}: ${value} } : unknown)`;
			})
			.join(' &\n');
		branchTypes.push(`type ${bName}<W> = ${t.className} &\n${clauses};`);
	}

	// ── the include type ──────────────────────────────────────────────────────
	const includeFields: string[] = [];
	for (const rel of ones) {
		const t = naming.get(rel.key);
		includeFields.push(
			`\t/** to-one → ${t?.className ?? rel.target}${rel.optional === false ? '' : ' | undefined'} */\n\t${rel.key}?: true;`,
		);
	}
	for (const rel of manys) {
		const t = naming.get(rel.key);
		const via = rel.through ? ` (through \`${rel.through.collection}\`)` : '';
		includeFields.push(
			`\t/** to-many → ${t?.className ?? rel.target}[]${via} — its own live query */\n\t${rel.key}?: true | { with?: ${withTypeName(rel)} };`,
		);
	}

	// ── the result type ───────────────────────────────────────────────────────
	const resultClauses: string[] = [];
	for (const rel of ones) {
		const t = naming.get(rel.key);
		// Left-joined, so the row may be absent — preserved as `| undefined`
		// exactly as measured (FE-REL §4.2), never narrowed to the bare type.
		resultClauses.push(
			`\t(Sel<I, '${rel.key}'> extends true ? { ${rel.key}: ${t?.className ?? 'unknown'} | undefined } : unknown)`,
		);
	}
	for (const rel of manys) {
		const bName = `${entity.className}${rel.key.charAt(0).toUpperCase()}${rel.key.slice(1)}Row`;
		const targetNode = graph.nodes.find((n) => n.collection === rel.target);
		const row =
			toOneRelations(targetNode).length === 0
				? bName
				: `${bName}<Sel<I, '${rel.key}'>>`;
		resultClauses.push(
			`\t(Sel<I, '${rel.key}'> extends undefined ? unknown : { ${rel.key}: Array<${row}> })`,
		);
	}

	// ── the hook body ─────────────────────────────────────────────────────────
	const rootJoins = ones
		.map((rel) => {
			const t = naming.get(rel.key);
			return `\t\t\t\t\t\t.join({ ${rel.key}: ${t?.collectionVar} }, ({ row, ${rel.key} }) =>\n\t\t\t\t\t\t\teq(row.${rel.from}, ${rel.key}.${rel.to}),\n\t\t\t\t\t\t)`;
		})
		.join('\n');
	const rootSelectRefs = ['row', ...ones.map((r) => r.key)];
	const rootSelect = `\t\t\t\t\t\t.select(({ ${rootSelectRefs.join(', ')} }) => ({ ${rootSelectRefs.join(', ')} }))`;

	const branchHooks = manys
		.map((rel) => {
			const t = naming.get(rel.key);
			const targetNode = graph.nodes.find((n) => n.collection === rel.target);
			const nested = toOneRelations(targetNode);
			const nestedJoins = nested
				.map((n) => {
					const nt = targetNaming(n, graph);
					return `\t\t\t\t\t\t.join({ ${n.key}: ${nt?.collectionVar} }, ({ row, ${n.key} }) =>\n\t\t\t\t\t\t\teq(row.${n.from}, ${n.key}.${n.to}),\n\t\t\t\t\t\t)`;
				})
				.join('\n');
			const selectRefs = ['row', ...nested.map((n) => n.key)];
			const select = `\t\t\t\t\t\t.select(({ ${selectRefs.join(', ')} }) => ({ ${selectRefs.join(', ')} }))`;

			let source: string;
			if (rel.through) {
				const j = graph.junctions.find((x) => x.collectionKey === rel.through?.collection);
				// The junction hop: filter the LINK rows by the root id, then inner-join
				// the target. Inner, not left: a link row whose target is missing is not
				// a member of the set. One query, still — the fan-out is flat and each
				// link row yields at most one target row, so no grouping is needed.
				source = `q\n\t\t\t\t\t\t.from({ link: ${j?.camelName ?? 'unknown'}Collection })\n\t\t\t\t\t\t.where(({ link }) => eq(link.${rel.through.from}, id))\n\t\t\t\t\t\t.innerJoin({ row: ${t?.collectionVar} }, ({ link, row }) =>\n\t\t\t\t\t\t\teq(link.${rel.through.to}, row.${rel.to}),\n\t\t\t\t\t\t)`;
			} else {
				source = `q\n\t\t\t\t\t\t.from({ row: ${t?.collectionVar} })\n\t\t\t\t\t\t.where(({ row }) => eq(row.${rel.to}, id))`;
			}

			return `\t// \`${rel.key}\` — one live query, disabled unless it was included.
\tconst ${rel.key}Branch = useLiveQuery(
\t\t(q) =>
\t\t\tid !== null && id !== undefined && inc.${rel.key}
\t\t\t\t? ${source}
${nestedJoins ? `${nestedJoins}\n` : ''}${select}
\t\t\t\t: undefined,
\t\t[id, Boolean(inc.${rel.key})],
\t);`;
		})
		.join('\n\n');

	const assembleOnes = ones
		.map((rel) => `\tif (inc.${rel.key}) out.${rel.key} = rootRow.${rel.key};`)
		.join('\n');

	const assembleManys = manys
		.map((rel) => {
			const targetNode = graph.nodes.find((n) => n.collection === rel.target);
			const nested = toOneRelations(targetNode);
			if (nested.length === 0) {
				return `\tif (inc.${rel.key}) {\n\t\tout.${rel.key} = (${rel.key}Branch.data ?? []).map((r) => ({ ...r.row }));\n\t}`;
			}
			const nestedWith = nested
				.map(
					(n) =>
						`\t\t\t...(withOf(inc.${rel.key}).${n.key} ? { ${n.key}: r.${n.key} } : {}),`,
				)
				.join('\n');
			return `\tif (inc.${rel.key}) {\n\t\tout.${rel.key} = (${rel.key}Branch.data ?? []).map((r) => ({\n\t\t\t...r.row,\n${nestedWith}\n\t\t}));\n\t}`;
		})
		.join('\n');

	const loadingRefs = ['root', ...manys.map((r) => `${r.key}Branch`)];

	const withOfHelper =
		manys.some((rel) => toOneRelations(graph.nodes.find((n) => n.collection === rel.target)).length > 0)
			? `
/** The \`with\` object of a branch's include value, or \`{}\` for a bare \`true\`. */
function withOf(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && 'with' in value
		? ((value as { with?: Record<string, unknown> }).with ?? {})
		: {};
}
`
			: '';

	const body = `import { eq, useLiveQuery } from '@tanstack/react-db';

${collectionImports}

${typeImports}

/**
 * Read a key off an include literal that may omit it.
 *
 * \`I['${ones[0]?.key ?? manys[0]?.key ?? 'rel'}']\` alone would be an error for a literal that does not
 * carry the key; this resolves to \`undefined\` instead, which is what the
 * result type branches on.
 */
type Sel<I, K extends PropertyKey> = K extends keyof I ? I[K] : undefined;

${withTypes.join('\n\n')}

/**
 * The relations of ${entity.className} that are navigable on the client.
 *
 * A misspelled key is a compile error here, nested or not (FE-REL §5). The
 * include literal is inferred at the CALL SITE — annotating a \`const\` with this
 * type widens it and loses the exact result shape, the same caveat REL-2
 * records for the server side.
 */
export interface ${entity.className}Include {
${includeFields.join('\n')}
}

${branchTypes.join('\n')}

/**
 * The result of {@link use${entity.className}Graph} for a given include.
 *
 * A to-one hop is \`T | undefined\` (it is left-joined); a to-many is \`T[]\`. A
 * relation that was not included is not on the type at all, so reading it is a
 * compile error rather than \`undefined\` at runtime.
 */
export type ${entity.className}Graph<I extends ${entity.className}Include> = ${entity.className} &
${resultClauses.join(' &\n')};

/** What every graph hook returns. */
export interface ${entity.className}GraphResult<I extends ${entity.className}Include> {
	data: ${entity.className}Graph<I> | undefined;
	isLoading: boolean;
	isError: boolean;
}
${withOfHelper}
/**
 * Traverse the graph from one ${entity.className}.
 *
 * \`\`\`ts
 * const { data } = use${entity.className}Graph(id, { ${manys[0]?.key ?? ones[0]?.key ?? 'rel'}: true });
 * \`\`\`
 *
 * Queries issued: **1 for the root** (carrying every to-one hop as a join) plus
 * **one per to-many relation that was included** — ${manys.length} possible, all
 * visible below. Never one per row: there is no loop here that could produce an
 * N+1 (charter I4, FE-REL §4.1). A branch that was not included returns
 * \`undefined\` from its query function, which \`useLiveQuery\` treats as disabled,
 * so it costs nothing while keeping the hook count static as React requires.
 */
export function use${entity.className}Graph<const I extends ${entity.className}Include>(
	id: string | null | undefined,
	include: I,
): ${entity.className}GraphResult<I> {
	// Widened once: the generic \`I\` is for the CALLER's result type; the body
	// reads the include as plain data.
	const inc = include as ${entity.className}Include;

	// The root row, with every to-one hop joined in. One query regardless of
	// how many to-one relations the entity has.
	const root = useLiveQuery(
		(q) =>
			id !== null && id !== undefined
				? q
						.from({ row: ${entity.camelName}Collection })
						.where(({ row }) => eq(row.id, id))
${rootJoins ? `${rootJoins}\n` : ''}${rootSelect}
				: undefined,
		[id],
	);

${branchHooks}

	const isLoading = ${loadingRefs.map((r) => `${r}.isLoading`).join(' || ')};
	const isError = ${loadingRefs.map((r) => `${r}.isError`).join(' || ')};

	const rootRow = root.data?.[0];
	if (!rootRow) return { data: undefined, isLoading, isError };

	const out: Record<string, unknown> = { ...rootRow.row };
${assembleOnes}
${assembleManys}

	// The one cast in the file, and it is the boundary cast: \`out\` is assembled
	// from the include at runtime, and \`${entity.className}Graph<I>\` is the same
	// shape derived from it at compile time. Every property put on \`out\` above is
	// guarded by the same \`inc.<rel>\` check the type branches on.
	return { data: out as ${entity.className}Graph<I>, isLoading, isError };
}
`;
	return withBanner(`entities/${entity.name}.yaml`, body);
}

/**
 * `graph/index.ts` — the descriptor plus every emitted accessor, entity-name
 * sorted. The root barrel exports this one module, so `./graph` is
 * unambiguous.
 */
export function buildGraphIndexFile(nodes: ClientGraphNode[]): string {
	const lines = [
		"export * from './descriptor';",
		...nodes.filter((n) => n.entity).map((n) => `export * from './${n.entity?.name}';`),
	];
	return withBanner(SOURCE_DESC_SET, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

export interface EmitGraphResult {
	written: string[];
	/** Entities that got an accessor module, entity-name sorted. */
	accessors: string[];
}

/**
 * Emit `graph.ts` and the `graph/` accessor tree into `outDir`.
 *
 * Takes the ALREADY-BUILT client graph: `emitFrontendSet` builds it once and
 * threads it through, so the cross-mode check (which throws) runs exactly once
 * per emit and every step sees the same projection.
 */
export function emitGraph(
	ctx: FrontendEmitContext,
	outDir: string,
	graph: ClientGraph | null,
): EmitGraphResult {
	if (!graph || !graph.nodes.some((n) => n.relations.length > 0)) {
		return { written: [], accessors: [] };
	}

	const written: string[] = [];
	const graphPath = join(outDir, GRAPH_DIR, GRAPH_FILE);
	writeFile(graphPath, buildGraphFile(graph));
	written.push(graphPath);

	const nodes = accessorNodes(graph, ctx);
	for (const node of nodes) {
		const filePath = join(outDir, GRAPH_DIR, `${node.entity?.name}.ts`);
		writeFile(filePath, buildEntityGraphFile(node, graph, ctx));
		written.push(filePath);
	}

	const indexPath = join(outDir, GRAPH_DIR, 'index.ts');
	writeFile(indexPath, buildGraphIndexFile(nodes));
	written.push(indexPath);

	return { written, accessors: nodes.map((n) => n.entity?.name ?? '').filter(Boolean) };
}

/**
 * The junctions that need a collection emitting.
 *
 * Empty unless the global sync mode is `electric`: `junction new` emits no
 * controller, so there is no REST surface for junction rows and an `api`-mode
 * project has no way to get them into the browser. A hop through a junction in
 * such a project is caught by the cross-mode check rather than emitted against
 * a collection that cannot exist.
 */
export function graphJunctions(
	ctx: FrontendEmitContext,
	graph: ClientGraph | null,
): ClientGraph['junctions'] {
	if (!graph || ctx.config.globalSyncMode !== 'electric') return [];
	return graph.junctions;
}
