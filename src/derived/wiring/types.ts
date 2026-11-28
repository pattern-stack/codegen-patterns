/**
 * The class graph (PW-1): every class the generator emits, and what each one's constructor takes.
 *
 * Derived once (ADR-046) from the entity's API surface and its derivation input. Nest's `module.ejs.t` prints its
 * module imports, providers and controllers from it; plain wiring (PW-3) prints its composition from it, in
 * dependency order, which exists because the graph has no cycle (checked at generation, `orderClasses`).
 *
 * Types only, and no import paths or file names (ADR-046 §4): a module's import path is the template's.
 */

/** What a generated class is. A junction has a repository and a service only. */
export type ClassRole = 'repository' | 'service' | 'use_case' | 'controller';

/** Something a class takes that the app provides rather than the generator: a system. */
export type SystemDependency = 'db' | 'typed_event_bus' | 'event_bus';

/** Why one class takes another. Each reason is one constructor (or Nest property) argument. */
export type ClassEdgeReason =
	/** A service takes its own repository; a use case its own service. */
	| 'own'
	/** A service takes another entity's repository, for a `belongs_to` / `has_many` (#632). */
	| 'composes'
	/** A child's repository takes its base's (RFC-0006 §4.1). */
	| 'inherits'
	/** A parent's service takes each junction service it fans out to (JUNC-0). */
	| 'junction_fan_out'
	/** A junction's service takes the repositories of its two ends. */
	| 'junction_end'
	/** An `eav: true` entity's repository, service and create / update use cases take `FieldValueService`. */
	| 'eav_field_values'
	/** An `eav_value_table: true` entity's service takes its definition entity's repository. */
	| 'eav_definition'
	/** A search use case pages through the list use case (#744). */
	| 'list_use_case'
	/** A controller takes the use cases its routes call. */
	| 'route';

/** One generated class. `id` is its class name, which is unique across a project. */
export interface ClassNode {
	id: string;
	/** The entity or junction whose module the class lives in. */
	owner: string;
	ownerKind: 'entity' | 'junction';
	role: ClassRole;
	/** For a use case, its kind (`find_by_id`, `query`, …); absent otherwise. */
	useCaseKind?: string;
	/** The systems it takes, in constructor order. Optional ones (Nest's `@Optional()` event bus) are listed too. */
	systems: SystemDependency[];
}

/** `from`'s constructor takes `to`. */
export interface ClassEdge {
	from: string;
	to: string;
	/** The entity or junction whose module `to` lives in, so one entity's graph knows the modules it imports. */
	toOwner: string;
	toOwnerKind: 'entity' | 'junction';
	reason: ClassEdgeReason;
}

export interface ClassGraph {
	nodes: ClassNode[];
	edges: ClassEdge[];
}

/** Why one module imports another: the reasons that cross a module boundary. */
export type ModuleImportReason = 'inherits' | 'composes' | 'junction_fan_out' | 'junction_end' | 'eav_field_values' | 'eav_definition';

/** One module another module imports, and the reason it is filed under (`moduleImports`). */
export interface ModuleImport {
	owner: string;
	ownerKind: 'entity' | 'junction';
	reason: ModuleImportReason;
}
