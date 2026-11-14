/**
 * The derived backend API surface — what the generator emits per entity, what each piece is called, and the
 * YAML declaration that caused it (ADR-046).
 *
 * Types only: zero runtime imports, so Studio's contract (`src/studio/shared/api.ts`) can re-export them.
 *
 * Deliberately NOT here (ADR-046 §4): TypeScript type strings, import paths, file paths, method bodies, SQL,
 * decorator text, DTO fields. Names, kinds, provenance, parameter names and result shape only.
 */

/** A path into a YAML document: `['relationships', 'account']`, `['queries', 1]`. */
export type YamlPath = (string | number)[];

/** One declaration in one YAML document. */
export interface YamlRef {
	doc: { kind: 'entity' | 'junction'; name: string };
	path: YamlPath;
	note?: string;
}

/**
 * Why an entry exists. `yaml.at` is the declaration that won; `shadows` are declarations that resolved to the
 * same name and lost.
 */
export type Origin =
	| { from: 'base' }
	| { from: 'pattern'; pattern: string }
	| { from: 'capability'; capability: string }
	| { from: 'yaml'; at: YamlRef; shadows?: YamlRef[] };

/** A parameter by name. `field` is the YAML field it binds, when it binds one. No TypeScript type. */
export interface Param {
	name: string;
	field?: string;
}

/**
 * What a method resolves to.
 *
 * - `none` — returns nothing (`detach`, `setPrimary`, an EAV write).
 * - `forwarded` — whatever the method it forwards to returns. A capability forwarder's result is the
 *   capability's own method's, which the capability declares and codegen does not see.
 */
export type Shape = 'one' | 'many' | 'count' | 'projection' | 'none' | 'forwarded';

/** A method on a generated class, by entity, layer and name. */
export interface MethodRef {
	entity: string;
	layer: 'repository' | 'service';
	method: string;
}

/** The read options a repository read takes (READ-1 §2.3). */
export type ReadOptionsShape = 'none' | 'columns' | 'columns+with';

export interface RepositoryMethod {
	name: string;
	kind:
		| 'find_by_id'
		| 'find_by_ids'
		| 'list'
		| 'count'
		/** `queries:` — a plain by-column finder. */
		| 'finder'
		/** `queries:` — a `via:` or `select:` finder. */
		| 'finder_projection'
		/** `belongs_to` — the FK-traversal finder. */
		| 'fk_finder'
		| 'eav_upsert'
		| 'inherited';
	/** `false`: the method lives on the base class or a capability mixin, not in the generated class body. */
	emitted: boolean;
	params: Param[];
	returns: Shape;
	readOptions: ReadOptionsShape;
	/** The FK finder takes `{ limit }`. */
	limit?: boolean;
	unique?: boolean;
	order?: { column: string; direction: 'asc' | 'desc' };
	origin: Origin;
}

export interface ServiceMethod {
	name: string;
	kind:
		| 'read'
		| 'finder'
		| 'capability_forwarder'
		| 'relation_one'
		| 'relation_many'
		| 'junction_attach'
		| 'junction_detach'
		| 'junction_list'
		| 'junction_set_primary'
		| 'eav_read'
		| 'eav_write'
		| 'inherited';
	emitted: boolean;
	params: Param[];
	returns: Shape;
	/** The method this one calls. Resolved against the target's surface in the whole-set pass. */
	delegatesTo?: MethodRef;
	origin: Origin;
}

export interface UseCase {
	className: string;
	kind:
		| 'find_by_id'
		| 'list'
		| 'create'
		| 'update'
		| 'delete'
		| 'find_by_id_with_fields'
		| 'list_with_fields'
		| 'query'
		| 'search';
	calls: MethodRef;
	origin: Origin;
}

export interface Route {
	verb: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	/** `/contacts/:id` — the controller prefix plus the handler's sub-path. */
	path: string;
	controller: string;
	handler: string;
	operationId?: string;
	useCase: string;
	/** The `api.includes` key this handler resolves `?include=` against. */
	includeRoute?: 'list' | 'find_by_id';
	origin: Origin;
}

export interface EntityApiSurface {
	entity: string;
	plural: string;
	className: string;
	repository: { className: string; baseClass: string; typedInclude: boolean; methods: RepositoryMethod[] };
	service: { className: string; baseClass: string; methods: ServiceMethod[] };
	useCases: UseCase[];
	http: {
		enabled: boolean;
		/** The declaration that turned HTTP off (`api: false` / `api: { enabled: false }`). */
		disabledBy?: YamlRef;
		routes: Route[];
		/** The `api.includes` keys this entity's own YAML declares. */
		includeRoutes: string[];
		/** The compiled allowlist paths — the whole-set pass attaches these. */
		includes?: { route: string; maxDepth: number; paths: { path: string; depth: number }[] }[];
		/** The generated allowlist constant's name. */
		includesConst: string;
	};
}

/** The edge view. `id` is REL-1's own origin string. */
export interface RelationApiSurface {
	id: string;
	from: string;
	to: string;
	kind: 'belongs_to' | 'has_many' | 'has_one' | 'role' | 'junction';
	inverseOf?: string;
	generates: MethodRef[];
	includeKeys: { table: string; key: string }[];
}

export interface ProjectApiSurface {
	entities: Record<string, EntityApiSurface>;
	relations: RelationApiSurface[];
	unmodelled: { name: string; kind: 'junction' | 'relationship'; reason: string }[];
	warnings: string[];
}
