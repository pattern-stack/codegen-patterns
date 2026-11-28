/**
 * The pattern-stack wiring composition (PW-3): one module per context, composed with `@pattern-stack/wiring`.
 *
 * A whole-set TypeScript emitter (the ADR-038 kind), run as the `entity new` post-step under `target.wiring: pattern-stack`.
 * It reads the class graph (PW-1, `src/derived/wiring/`) and writes:
 *
 * - `<modules_dir>/<context>/module.ts` per `context:` (d27, d29: the YAML says context, the code says module), and
 *   `<modules_dir>/module.ts` for the entities with none (module `entities`). Each exports `compose<Module>(deps)`,
 *   which builds every repository of the module first and then every service and its use cases (each entity's own
 *   `<entity>.wiring.ts` holds the constructor calls), and a `defineModule` manifest whose `dependsOn` is the modules
 *   whose repositories it takes;
 * - `<generated>/wiring.ts`: the registry (`ModuleApis`, `SystemApis`) and `createWiring`'s `defineModule`,
 *   `defineSystem` and `compose`, typed against it;
 * - `<generated>/composition.ts`: `MODULES`, every module's manifest, for the app's `compose.ts` (PW-4);
 * - `<generated>/openapi.ts`: `registerOpenApiSchemas(openApi)`, every entity's DTO schemas (PW-3b).
 *
 * Each module also exports its `<Context>Repositories` bundle (PW-3b, d27): one `<Entity>RepositoryPort` per entity,
 * the type a hand-written context service takes. The composed repositories are checked against it (`satisfies`).
 *
 * The only system pattern-stack wiring needs here is `database` (`{ db }`). Modules depend on each other one way: a cycle
 * between modules (the root module's included) is refused, naming it.
 */

import { TOKEN_ENCRYPTION_KEY_ENV } from '../../../runtime/subsystems/auth/backends/encryption-key/env.js';
import fs from 'node:fs';
import path from 'node:path';

import { composedRepositoryOwners } from '../../derived/wiring/classes.js';
import { contextCycles } from '../../derived/wiring/order.js';
import { deriveProjectClassGraph } from '../../derived/wiring/project.js';
import { EAV_FIELD_VALUE_ENTITY, FIELD_VALUES_DEPS_FIELD, SYSTEM_DEPS_FIELD, useCaseSystems } from '../../derived/wiring/classes.js';
import type { SystemDependency } from '../../derived/wiring/types.js';
import type { ProjectApiContext } from '../../derived/api/project.js';
import {
	pascalCase,
	registerSchemasName,
	repositoriesBundleName,
	repositoryClassName,
	repositoryFactoryName,
	repositoryPortName,
	repositoryPropertyName,
	junctionServiceFactoryName,
	junctionServicePropertyName,
	serviceClassName,
	servicesFactoryName,
} from '../../derived/api/names.js';
import { junctionIdentity } from '../../emitters/relations/build-graph.js';
import { rowFor } from '../../utils/keyed-row.js';
import { junctionWiringFile } from '../../config/junction-naming.js';
import { camelCase, emittedDir } from '../../config/file-naming.js';
import { entityModuleNaming } from '../../config/module-tree.js';
import { generating } from '../../utils/generated-file.js';
import { relativeImport } from '../../utils/import-path.js';
import type { ProjectSetting } from '../../derived/settings/index.js';
import { SETTINGS_FILE, settingsContent } from '../settings/emit-settings.js';

/** The module name of the entities that declare no `context:`. */
export const ROOT_MODULE = 'entities';

/** Names a context's module can't take: the root module's, and the systems' (`database`). */
/** The `database` system's name: the one system every generated module uses (`{ db }`), and the app's `database.ts` defines. */
export const DATABASE_SYSTEM = 'database';

/** The names of the systems codegen generates (and the app's `database`): a module may not take one. */
export const GENERATED_SYSTEM_NAMES = [DATABASE_SYSTEM, 'settings', 'jobs', 'events', 'integration', 'auth', 'connections', 'jobDeps'] as const;

const RESERVED_MODULE_NAMES = new Set<string>([ROOT_MODULE, ...GENERATED_SYSTEM_NAMES]);

/** The files the composition writes under `paths.generated`; stale-files removes the same list on a switch to nest. */
export const COMPOSITION_GENERATED_FILES = { registry: 'wiring.ts', composition: 'composition.ts', openApi: 'openapi.ts' } as const;

/** The function `<generated>/openapi.ts` exports, which no entity's own register function may share a name with. */
const REGISTER_OPENAPI_SCHEMAS = 'registerOpenApiSchemas';

/**
 * What the composition imports from an entity's `<entity>.wiring.ts`: a context's module.ts the two factories and the
 * repository port, openapi.ts the schema registration. `wiringFilesBehind` checks a file exports every one.
 */
function wiringImports(entity: string): { module: string[]; openApi: string[] } {
	return {
		module: [repositoryFactoryName(entity), servicesFactoryName(entity), `type ${repositoryPortName(entity)}`],
		openApi: [registerSchemasName(entity)],
	};
}

/** The keys a module's API holds beside its entities: the repository bundle (PW-3b) and the junction services (PW-3c). */
const RESERVED_MODULE_KEYS = new Set(['repositories', 'junctions']);

/** What a module.ts imports from a junction's `<junction>.wiring.ts`; `wiringFilesBehind` checks the same list. */
function junctionWiringImports(junction: string): string[] {
	return [repositoryFactoryName(junction), junctionServiceFactoryName(junction)];
}

/** What a module passes for each system a use case takes, in the module's own scope. */
const SYSTEM_DEPS_VALUE: Record<SystemDependency, () => string> = {
	db: () => 'db',
	// S-1: the `events` system's typed bus (the module `uses` it whenever one of its use cases publishes).
	typed_event_bus: () => 'deps.events.typed',
};

/** `key: value`, or the shorthand when they are the same name. */
const property = (key: string, value: string): string => (key === value ? key : `${key}: ${value}`);

export interface CompositionInput {
	relations: ProjectApiContext['relations'];
	/** Absolute `paths.modules_dir`. */
	modulesDir: string;
	/** Absolute `paths.generated`. */
	generatedDir: string;
	/** The import specifier of `DrizzleClient` (`runtimeImport(mode, 'types/drizzle')`). */
	drizzleTypeImport: string;
	/** The import specifier of `OpenApiRegistry` (`openApiImport(mode)`). */
	openApiImport: string;
	/** The banner every emitted file starts with (`CODEGEN_BANNER`). */
	banner: string;
	/**
	 * The `events` system (S-1), when the events subsystem is installed: written to `<generated>/events-system.ts`,
	 * listed in `SYSTEMS` and `SystemApis`. Null ⇒ no events system, and a module whose use cases publish an event is
	 * refused, naming the install.
	 */
	events?: CompositionEventsInput | null;
	/**
	 * The `integration` system (S-3), when the integration subsystem is installed: written to
	 * `<generated>/integration-system.ts`, listed in `SYSTEMS` and `SystemApis`.
	 */
	integration?: CompositionIntegrationInput | null;
	/**
	 * The integrations (S-3), when providers serve a surface: the providers' and surfaces' adapters systems (written by
	 * `emitPatternStackIntegrations`, listed here in `SYSTEMS` and `SystemApis`) and the runs, which this emitter
	 * writes as the `integrations` module (it knows which module holds each entity's repository).
	 */
	integrations?: CompositionIntegrationsInput | null;
	/**
	 * The `auth` system (S-2), when the auth subsystem is installed: written to `<generated>/auth-system.ts`, listed in
	 * `SYSTEMS` and `SystemApis`. It reads the `auth` settings, so it needs `settings`.
	 */
	auth?: CompositionAuthInput | null;
	/**
	 * The `connections` system (S-2), when the auth-integrations starter is vendored: written to
	 * `<generated>/connections-system.ts`, listed after `auth`. Needs `auth` and a generated `connection` entity.
	 */
	connections?: CompositionConnectionsInput | null;
	/**
	 * The project's settings (SET-1): written to `<generated>/settings.ts` with the `settings` system, first in
	 * `SYSTEMS` (so a missing value fails compose before any other part is made), and `settings: Settings` in
	 * `SystemApis`. Null ⇒ no settings system.
	 */
	settings?: { settings: readonly ProjectSetting[]; runtimeImport: string } | null;
	/**
	 * The `jobs` system (J-1), when the jobs subsystem is installed: written to `<generated>/jobs-system.ts`, listed in
	 * `SYSTEMS` and `SystemApis`; and, when a job factory names a composition part, the `jobDeps` module that provides
	 * them (`<generated>/job-deps.ts`).
	 */
	jobs?: CompositionJobsInput | null;
	dryRun?: boolean;
}

/** The jobs subsystem's composition (J-1): the engine's entry, the job factories' dependencies, and the bridge. */
export interface CompositionJobsInput {
	/** The Nest-free jobs entry (`subsystemCoreImport(mode, 'jobs')`). */
	coreImport: string;
	/**
	 * Every `jobFactory` export under the jobs directory (the registry scan) and its dependencies: each one's name and
	 * the composition part it names (`injected<T>('<part>')`), or no part when it is written otherwise.
	 */
	factories: ReadonlyArray<{
		exportName: string;
		file: string;
		deps: ReadonlyArray<{ name: string; part?: string; unreadable?: string }>;
	}>;
	/** The bridge, when installed: the `events` system passes its drain to the bus. */
	bridge: { coreImport: string; registryFile: string } | null;
	/**
	 * The job registry (`<generated>/jobs.ts`, `jobDefinitions`), built from the same scan as `factories`: the
	 * composition writes it beside `job-deps.ts`, so every command that writes one writes the other, and a factory the
	 * `jobDeps` module provides is always one the registry lists (review #985).
	 */
	registry: CompositionFile;
}

/** The modules that hold the `jobs` system and the `jobDeps` module, beside `wiring.ts` (J-1). */
export const JOBS_SYSTEM_FILE = 'jobs-system.ts';
export const JOB_DEPS_FILE = 'job-deps.ts';
/** The module that provides the job factories' dependencies (J-1). */
export const JOB_DEPS_MODULE = 'jobDeps';

/** The integrations' systems and runs (S-3, `planPatternStackIntegrations`). */
export interface CompositionIntegrationsInput {
	/** Absolute: where the `integrations` module goes. */
	moduleFile: string;
	/** The Nest-free integration entry. */
	coreImport: string;
	systems: Array<{ name: string; exportName: string; file: string; apiType: string }>;
	runs: Array<{
		surface: string;
		entity: string;
		provider: string;
		adaptersSystem: string;
		adapterKey: string;
		sinkFile: string;
		sinkClass: string;
		repositoryFile: string;
		projectionType: string;
		emitter?: { file: string; className: string };
	}>;
}

/** The module the integration runs are composed in (S-3). */
export const INTEGRATIONS_MODULE = 'integrations';

/** The `events` system's settings and imports (S-1): from `codegen.config.yaml`'s `events:` block and the runtime mode. */
export interface CompositionEventsInput {
	backend: 'drizzle' | 'memory';
	multiTenant: boolean;
	listenNotify: boolean;
	/** The selected backend's module (`runtimeImport(mode, 'subsystems/events/event-bus.<backend>-backend')`). */
	backendImport: string;
	/** The Nest-free events entry (`subsystemCoreImport(mode, 'events')`). */
	coreImport: string;
	/** Absolute: the generated event files' directory (`TypedEventBus`, `eventRegistry`). */
	generatedEventsDir: string;
}

/** The module that holds the `events` system, beside `wiring.ts`. */
export const EVENTS_SYSTEM_FILE = 'events-system.ts';

/** The `integration` system's settings and imports (S-3): from `codegen.config.yaml`'s `integration:` block. */
export interface CompositionIntegrationInput {
	backend: 'drizzle' | 'memory';
	multiTenant: boolean;
	/** The default differ's `ignore` / `unignore` (DIFFER-UNIGNORE); absent ⇒ the default ignore list. */
	differ?: { ignore?: string[]; unignore?: string[] };
	/** The Nest-free integration entry (`subsystemCoreImport(mode, 'integration')`). */
	coreImport: string;
	/** A runtime file's import specifier in this project (`runtimeImport(mode, relpath)`), for the backend's files. */
	runtimeImport: (relpath: string) => string;
}

/** The module that holds the `integration` system, beside `wiring.ts`. */
export const INTEGRATION_SYSTEM_FILE = 'integration-system.ts';

/** The `auth` system's import (S-2): the Nest-free auth entry (`subsystemCoreImport(mode, 'auth')`). */
export interface CompositionAuthInput {
	coreImport: string;
}

/** The module that holds the `auth` system, beside `wiring.ts`. */
export const AUTH_SYSTEM_FILE = 'auth-system.ts';

/** The `connections` system's input (S-2): where the vendored starter's store is. */
export interface CompositionConnectionsInput {
	/** Absolute: the vendored `connections/connection-store.ts` (`createConnectionStore`, `ConnectionStore`). */
	storeFile: string;
}

/** The module that holds the `connections` system, beside `wiring.ts`. */
export const CONNECTIONS_SYSTEM_FILE = 'connections-system.ts';


/** The entity the connection store reads and writes: the starter's `connection.yaml`. */
export const CONNECTION_ENTITY = 'connection';

/** Every generated system's file beside `wiring.ts`; stale-files removes each when its subsystem goes, or on a switch. */
export const GENERATED_SYSTEM_FILES = [SETTINGS_FILE, JOBS_SYSTEM_FILE, JOB_DEPS_FILE, EVENTS_SYSTEM_FILE, INTEGRATION_SYSTEM_FILE, AUTH_SYSTEM_FILE, CONNECTIONS_SYSTEM_FILE] as const;

export interface CompositionFile {
	path: string;
	content: string;
}

interface ModulePlan {
	/** The wiring name: `crm`, or `entities`. */
	name: string;
	file: string;
	entities: string[];
	/** The junctions whose ends are this module's entities (PW-3c). */
	junctions: JunctionPlan[];
}

interface JunctionPlan {
	name: string;
	plural: string;
	left: string;
	right: string;
}

export function planComposition(input: CompositionInput): CompositionFile[] {
	const { relations, modulesDir, generatedDir } = input;
	const { graph, order } = deriveProjectClassGraph(relations);

	const definitions = [...relations.definitions.values()].sort((a, b) => a.entity.name.localeCompare(b.entity.name));
	const moduleOf = new Map<string, string>();
	const plans = new Map<string, ModulePlan>();
	const contextOfModule = new Map<string, string>();
	for (const d of definitions) {
		const context = d.entity.context;
		const name = context ? camelCase(context) : ROOT_MODULE;
		if (context) {
			// A context's module name must be its own: not the root module's, not a system's, not another context's.
			if (RESERVED_MODULE_NAMES.has(name)) {
				throw new Error(
					`[codegen] wiring: pattern-stack: context '${context}' (entity '${d.entity.name}') would be the module '${name}', ` +
						`a name the composition reserves (${[...RESERVED_MODULE_NAMES].join(', ')}); rename the context`,
				);
			}
			const other = contextOfModule.get(name);
			if (other !== undefined && other !== context) {
				throw new Error(
					`[codegen] wiring: pattern-stack: contexts '${other}' and '${context}' would both be the module '${name}'; rename one`,
				);
			}
			contextOfModule.set(name, context);
		}
		const file = context
			? path.join(modulesDir, emittedDir(context), 'module.ts')
			: path.join(modulesDir, 'module.ts');
		// The module's API keys each entity by its camelCase name beside `repositories` (the bundle, PW-3b) and
		// `junctions` (PW-3c).
		if (RESERVED_MODULE_KEYS.has(camelCase(d.entity.name))) {
			throw new Error(
				`[codegen] wiring: pattern-stack: entity '${d.entity.name}' would be the key '${camelCase(d.entity.name)}' in module ` +
					`'${name}', which the module's API reserves (${[...RESERVED_MODULE_KEYS].join(', ')}); rename the entity`,
			);
		}
		// openapi.ts imports each entity's register function beside its own `registerOpenApiSchemas`.
		if (registerSchemasName(d.entity.name) === REGISTER_OPENAPI_SCHEMAS) {
			throw new Error(
				`[codegen] wiring: pattern-stack: entity '${d.entity.name}' would export '${REGISTER_OPENAPI_SCHEMAS}', the ` +
					`function <generated>/openapi.ts declares; rename the entity`,
			);
		}
		const plan = plans.get(name) ?? { name, file, entities: [], junctions: [] };
		plan.entities.push(d.entity.name);
		plans.set(name, plan);
		moduleOf.set(d.entity.name, name);
	}
	// PW-3c: a junction is composed in the module of the parents that fan out to it (`expose_on_parent`), its left
	// end's when both or neither do. Its service takes both ends' repositories, so a junction both parents use across
	// two modules makes them depend on each other: refused below, as a module cycle.
	const ownerModule = new Map(moduleOf);
	const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
	const usersOf = (junction: string): string[] => [
		...new Set(
			graph.edges
				.filter((e) => e.reason === 'junction_fan_out' && e.toOwner === junction)
				.map((e) => moduleOf.get(nodeById.get(e.from)?.owner ?? ''))
				.filter((m): m is string => m !== undefined),
		),
	];
	const junctionPlans = relations.junctions
		.filter((j) => j.between.length === 2)
		.map((j) => ({ ...junctionIdentity(j), left: j.between[0]!, right: j.between[1]! }))
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const j of junctionPlans) {
		if (!moduleOf.has(j.left)) throw new Error(`[codegen] wiring: junction '${j.name}' names '${j.left}', which has no entity YAML in the set`);
		const users = usersOf(j.name);
		const module = users.length === 1 ? users[0]! : moduleOf.get(j.left)!;
		plans.get(module)!.junctions.push({ name: j.name, plural: j.plural, left: j.left, right: j.right });
		ownerModule.set(j.name, module);
	}
	// Modules depend on each other one way (wiring orders them, and each module's type names the others'). The check
	// runs over the modules this composition builds (`ownerModule`): an entity with no `context:` is in `entities`, and
	// each junction is in the module the placement above chose, so neither is a pass-through.
	const moduleCycles = contextCycles(graph, (owner) => ownerModule.get(owner));
	if (moduleCycles.length > 0) {
		// A junction is named only when the cycle needs it: without its edges, the modules no longer form a cycle.
		const withoutJunction = (junction: string) => {
			const ids = new Set(graph.nodes.filter((n) => n.owner === junction).map((n) => n.id));
			return { nodes: graph.nodes, edges: graph.edges.filter((e) => !ids.has(e.from) && e.toOwner !== junction) };
		};
		const causing = junctionPlans
			.filter((j) => moduleOf.get(j.left) !== moduleOf.get(j.right))
			.filter((j) => contextCycles(withoutJunction(j.name), (owner) => ownerModule.get(owner)).length === 0)
			.map((j) => j.name);
		throw new Error(
			`[codegen] wiring: pattern-stack composes one module per context, and modules must depend on each other one way; ` +
				`these depend on each other in a cycle: ${moduleCycles.map((c) => c.join(' → ')).join('; ')}` +
				(causing.length > 0
					? ` (a junction across two modules makes them depend on each other: ${causing.join(', ')})`
					: ''),
		);
	}

	const blockOf = new Map(definitions.map((d) => [d.entity.name, d.entity]));
	const wiringFile = (entity: string) => entityModuleNaming(blockOf.get(entity)!, modulesDir).wiringFile;
	const junctionWiringFileOf = (j: JunctionPlan) => junctionWiringFile(j.name, modulesDir);

	const registryFile = path.join(generatedDir, COMPOSITION_GENERATED_FILES.registry);
	const eventsSystemFile = path.join(generatedDir, EVENTS_SYSTEM_FILE);
	const connectionsPlan = input.connections
		? planConnections(input, definitions.find((d) => d.entity.name === CONNECTION_ENTITY), wiringFile)
		: null;
	const relationsFile = path.join(generatedDir, 'relations.ts');
	const files: CompositionFile[] = [];

	for (const plan of plans.values()) {
		const own = new Set(plan.entities);
		const repoVar = (entity: string) => `${camelCase(entity)}Repository`;
		const dependsOn = new Set<string>();
		// What a class of this module takes from another module's repositories.
		const repoRef = (entity: string): string => {
			if (own.has(entity)) return repoVar(entity);
			const other = moduleOf.get(entity);
			if (!other) throw new Error(`[codegen] wiring: '${entity}' is composed but has no entity YAML in the set`);
			dependsOn.add(other);
			return `deps.${other}.repositories.${camelCase(entity)}`;
		};
		// S-1: a module whose use cases publish an event uses the `events` system.
		const publishes = (entity: string) =>
			graph.nodes.some((n) => n.owner === entity && n.role === 'use_case' && n.systems.includes('typed_event_bus'));
		const usesEvents = plan.entities.some(publishes);
		if (usesEvents && !input.events) {
			throw new Error(
				`[codegen] wiring: pattern-stack: ${plan.entities.filter(publishes).join(', ')} publish events (\`emits:\`), and ` +
					`the events subsystem isn't installed: run \`codegen subsystem install events\`.`,
			);
		}
		// EAV: a class that takes another entity's service (FieldValueService), built before it.
		const serviceRef = (entity: string): string => {
			if (own.has(entity)) return `${camelCase(entity)}.service`;
			const other = moduleOf.get(entity);
			if (!other) throw new Error(`[codegen] wiring: '${entity}' is composed but has no entity YAML in the set`);
			dependsOn.add(other);
			return `deps.${other}.${camelCase(entity)}.service`;
		};
		const takesFieldValues = (from: string) =>
			graph.edges.some((e) => e.from === from && e.reason === 'eav_field_values' && e.toOwner === EAV_FIELD_VALUE_ENTITY);

		// Phase 1: repositories, in the class graph's order (a base before its child). An EAV entity's repository takes
		// FieldValueService, so it waits for it (the build order below).
		const repositoryLines: { node: string; line: string }[] = [];
		for (const node of order) {
			if (node.role !== 'repository' || node.ownerKind !== 'entity' || !own.has(node.owner)) continue;
			const base = graph.edges.find((e) => e.from === node.id && e.reason === 'inherits');
			const args = [
				'db',
				...(base ? [repoRef(base.toOwner)] : []),
				...(takesFieldValues(node.id) ? [serviceRef(EAV_FIELD_VALUE_ENTITY)] : []),
			];
			repositoryLines.push({ node: node.id, line: `  const ${repoVar(node.owner)} = ${repositoryFactoryName(node.owner)}(${args.join(', ')});` });
		}
		// PW-3c: each junction's repository, then its service over both ends' repositories (the ends' services take it).
		for (const j of plan.junctions) {
			repositoryLines.push({ node: repositoryClassName(j.name), line: `  const ${repoVar(j.name)} = ${repositoryFactoryName(j.name)}(db);` });
		}
		const junctionLines = plan.junctions.map((j) => ({
			node: serviceClassName(j.name),
			line:
				`  const ${junctionServicePropertyName(j.name)} = ${junctionServiceFactoryName(j.name)}({ repository: ${repoVar(j.name)}, ` +
				`left: ${repoRef(j.left)}, right: ${repoRef(j.right)} });`,
		}));
		const ownJunctions = new Set(plan.junctions.map((j) => j.name));

		// Phase 2: each entity's service and use cases, taking its repository and the composed ones (#632).
		const serviceLines: { node: string; line: string }[] = [];
		for (const entity of plan.entities) {
			const service = graph.nodes.find((n) => n.owner === entity && n.role === 'service');
			if (!service) throw new Error(`[codegen] wiring: '${entity}' has no service in the class graph`);
			const fannedOut = graph.edges.filter((e) => e.from === service.id && e.reason === 'junction_fan_out');
			for (const e of fannedOut) {
				// Every junction an entity fans out to is its own module's (a cross-module one is refused above as a cycle).
				if (!ownJunctions.has(e.toOwner)) {
					throw new Error(`[codegen] wiring: '${entity}' fans out to junction '${e.toOwner}', which module '${plan.name}' does not compose`);
				}
			}
			// EAV: the service takes FieldValueService; and each system a use case takes (`db`, for a write's one
			// transaction) is a field, named by the same table the template declares them from.
			const eav = takesFieldValues(service.id);
			// S-1: its publishing use cases take `db` and the typed bus.
			const fields = [
				`repository: ${repoVar(entity)}`,
				...(eav ? [`${FIELD_VALUES_DEPS_FIELD}: ${serviceRef(EAV_FIELD_VALUE_ENTITY)}`] : []),
				...useCaseSystems(graph, entity).map((s) => property(SYSTEM_DEPS_FIELD[s], SYSTEM_DEPS_VALUE[s]())),
				...composedRepositoryOwners(graph, entity).map((owner) => `${repositoryPropertyName(owner)}: ${repoRef(owner)}`),
				...fannedOut.map((e) => `${junctionServicePropertyName(e.toOwner)}: ${junctionServicePropertyName(e.toOwner)}`),
			];
			serviceLines.push({
				node: service.id,
				line: `  const ${camelCase(entity)} = ${servicesFactoryName(entity)}({ ${fields.join(', ')} });`,
			});
		}
		const buildLines = buildOrder([...repositoryLines, ...junctionLines, ...serviceLines], graph);

		const otherModules = [...dependsOn].sort();
		const moduleType = `${pascalCase(plan.name)}Module`;
		const bundleType = repositoriesBundleName(plan.name);
		const imports = [
			`import type { DrizzleClient } from '${input.drizzleTypeImport}';`,
			`import type { Relations } from '${relativeImport(plan.file, relationsFile)}';`,
			`import { defineModule } from '${relativeImport(plan.file, registryFile)}';`,
			...(usesEvents ? [`import type { EventsApi } from '${relativeImport(plan.file, eventsSystemFile)}';`] : []),
			...otherModules.map(
				(m) => `import type { ${pascalCase(m)}Module } from '${relativeImport(plan.file, plans.get(m)!.file)}';`,
			),
			...plan.entities.map(
				(e) =>
					`import { ${wiringImports(e).module.join(', ')} } from '${relativeImport(plan.file, wiringFile(e))}';`,
			),
			...plan.junctions.map(
				(j) =>
					`import { ${junctionWiringImports(j.name).join(', ')} } from '${relativeImport(plan.file, junctionWiringFileOf(j))}';`,
			),
		];
		const depsType = [
			`${DATABASE_SYSTEM}: { db: DrizzleClient<Relations> }`,
			...(usesEvents ? ['events: EventsApi'] : []),
			...otherModules.map((m) => `${m}: ${pascalCase(m)}Module`),
		].join('; ');
		const content = `${input.banner}
/**
 * The ${plan.name} module (PW-3): ${plan.entities.join(', ')}, composed with no DI container.
 * Every repository first, then each junction's service, then every service and its use cases (entities compose each
 * other's repositories, and fan out to the junctions between them). An EAV entity's repository comes after the
 * FieldValueService it takes.
 */
${imports.join('\n')}

/** The ${plan.name} module's repositories, one port per entity: what a hand-written context service takes (d27). */
export interface ${bundleType} {
${plan.entities.map((e) => `  ${camelCase(e)}: ${repositoryPortName(e)};`).join('\n')}
}

export function compose${pascalCase(plan.name)}(deps: { ${depsType} }) {
  const { db } = deps.${DATABASE_SYSTEM};
${buildLines.join('\n')}
  return {
    repositories: { ${plan.entities.map((e) => `${camelCase(e)}: ${repoVar(e)}`).join(', ')} } satisfies ${bundleType},
${plan.junctions.length > 0 ? `    junctions: { ${plan.junctions.map((j) => `${camelCase(j.name)}: ${junctionServicePropertyName(j.name)}`).join(', ')} },\n` : ''}${plan.entities.map((e) => `    ${camelCase(e)},`).join('\n')}
  };
}

export type ${moduleType} = ReturnType<typeof compose${pascalCase(plan.name)}>;

export const ${plan.name}Module = defineModule({
  name: '${plan.name}',
  kind: 'stateful',
  dependsOn: [${otherModules.map((m) => `'${m}'`).join(', ')}],
  uses: [${[DATABASE_SYSTEM, ...(usesEvents ? ['events'] : [])].map((n) => `'${n}'`).join(', ')}],
  create: (deps) => compose${pascalCase(plan.name)}(deps),
});
`;
		files.push({ path: plan.file, content });
	}

	const names = [...plans.keys()].sort();
	const integrationsModule = input.integrations ? integrationsModuleFile(input, plans, moduleOf, registryFile) : null;
	if (integrationsModule) files.push({ path: integrationsModule.file, content: integrationsModule.content });
	// The systems codegen generates, in order: each is imported by the registry (its API type, its `SystemApis` key)
	// and by composition.ts (its manifest, in `SYSTEMS`), and its file is written. One list, so a new system is a row.
	const systems = generatedSystems(input, eventsSystemFile, connectionsPlan);
	// J-1: the job factories' dependencies, each a composition part (a module, or a system from the same list as
	// `SystemApis` and `SYSTEMS`); the module that provides them, when any is named.
	const jobDeps = input.jobs
		? jobDepsModuleFile(input, {
				modules: [...names, ...(integrationsModule ? [INTEGRATIONS_MODULE] : [])],
				systems: [DATABASE_SYSTEM, ...systems.map((sys) => sys.key)],
				registryFile,
			})
		: null;
	files.push({
		path: registryFile,
		content: `${input.banner}
/**
 * The pattern-stack wiring registry (PW-3): every module and system by name, and the wiring typed against it
 * (\`@pattern-stack/wiring\`). A manifest that uses something it didn't declare is a type error.
 */
import { createWiring } from '@pattern-stack/wiring';
import type { DrizzleClient } from '${input.drizzleTypeImport}';
import type { Relations } from './relations';
${systems.map((s) => `import type { ${s.apiType} } from '${relativeImport(registryFile, s.apiTypeFile)}';\n`).join('')}${jobDeps ? `import type { JobDepsModule } from './${JOB_DEPS_FILE.replace(/\.ts$/, '')}';\n` : ''}${names.map((n) => `import type { ${pascalCase(n)}Module } from '${relativeImport(registryFile, plans.get(n)!.file)}';`).join('\n')}
${integrationsModule ? `import type { IntegrationsModule } from '${relativeImport(registryFile, integrationsModule.file)}';\n` : ''}
export interface ModuleApis {
${names.map((n) => `  ${n}: ${pascalCase(n)}Module;`).join('\n')}
${integrationsModule ? `  ${INTEGRATIONS_MODULE}: IntegrationsModule;\n` : ''}${jobDeps ? `  ${JOB_DEPS_MODULE}: JobDepsModule;\n` : ''}}

export interface SystemApis {
  ${DATABASE_SYSTEM}: { db: DrizzleClient<Relations> };
${systems.map((s) => `  ${s.key}: ${s.apiType};\n`).join('')}}

export const { defineModule, defineSystem, compose } = createWiring<ModuleApis, SystemApis>();
`,
	});
	const compositionFile = path.join(generatedDir, COMPOSITION_GENERATED_FILES.composition);
	files.push({
		path: compositionFile,
		content: `${input.banner}
/**
 * Every generated module's manifest (PW-3), and the systems codegen generates (\`settings\`, and \`events\`,
 * \`integration\`, \`auth\`, \`connections\` and the integrations' when installed), for the app's \`compose.ts\`:
 * \`compose({ systems: [databaseSystem(), ...SYSTEMS], modules: MODULES })\`.
 */
${systems.map((s) => `import { ${s.exportName} } from '${relativeImport(compositionFile, s.file)}';\n`).join('')}${jobDeps ? `import { jobDepsModule } from './${JOB_DEPS_FILE.replace(/\.ts$/, '')}';\n` : ''}${integrationsModule ? `import { integrationsModule } from '${relativeImport(compositionFile, integrationsModule.file)}';\n` : ''}${names.map((n) => `import { ${n}Module } from '${relativeImport(compositionFile, plans.get(n)!.file)}';`).join('\n')}

export const SYSTEMS = [${systems.map((s) => s.exportName).join(', ')}] as const;

export const MODULES = [${[...names.map((n) => `${n}Module`), ...(integrationsModule ? ['integrationsModule'] : []), ...(jobDeps ? ['jobDepsModule'] : [])].join(', ')}] as const;
`,
	});
	const openApiFile = path.join(generatedDir, COMPOSITION_GENERATED_FILES.openApi);
	const entities = definitions.map((d) => d.entity.name);
	files.push({
		path: openApiFile,
		content: `${input.banner}
/**
 * Every entity's DTO schemas (PW-3b), registered as the Nest modules' constructors register them. An HTTP layer, or a
 * script that writes the OpenAPI document, calls this once before \`openApi.build()\`.
 */
import type { OpenApiRegistry } from '${input.openApiImport}';
${entities.map((e) => `import { ${wiringImports(e).openApi.join(', ')} } from '${relativeImport(openApiFile, wiringFile(e))}';`).join('\n')}

export function ${REGISTER_OPENAPI_SCHEMAS}(openApi: OpenApiRegistry): void {
${entities.map((e) => `  ${registerSchemasName(e)}(openApi);`).join('\n')}
}
`,
	});
	for (const s of systems) if (s.content !== null) files.push({ path: s.file, content: s.content });
	if (jobDeps) files.push({ path: jobDeps.file, content: jobDeps.content });
	if (input.jobs) files.push(input.jobs.registry);
	return files;
}

/** A system codegen generates, beside `wiring.ts`: its key in `SystemApis`, its API type, its manifest and file. */
interface GeneratedSystem {
	key: string;
	apiType: string;
	/** Where the API type is declared: the system's own file, unless it is a runtime type. */
	apiTypeFile: string;
	exportName: string;
	file: string;
	/** The file's content; null when another step writes it. */
	content: string | null;
}

/** The systems codegen generates for this input, in `SYSTEMS` order: settings (SET-1), events (S-1), integration (S-3), auth and connections (S-2), the integrations' (S-3b). */
function generatedSystems(
	input: CompositionInput,
	eventsSystemFile: string,
	connectionsPlan: ConnectionsPlan | null,
): GeneratedSystem[] {
	const integrationFile = path.join(input.generatedDir, INTEGRATION_SYSTEM_FILE);
	const authFile = path.join(input.generatedDir, AUTH_SYSTEM_FILE);
	const connectionsFile = path.join(input.generatedDir, CONNECTIONS_SYSTEM_FILE);
	const settingsFile = path.join(input.generatedDir, SETTINGS_FILE);
	const jobsFile = path.join(input.generatedDir, JOBS_SYSTEM_FILE);
	return [
		// SET-1: the settings, checked before the build; every other system may read them.
		...(input.settings
			? [{ key: 'settings', apiType: 'Settings', apiTypeFile: settingsFile, exportName: 'settingsSystem', file: settingsFile, content: settingsContent(input.settings.settings, input.settings.runtimeImport, input.banner) }]
			: []),
		// J-1: the jobs engine; the events system's drain starts runs through it, so it comes first.
		...(input.jobs
			? [{ key: 'jobs', apiType: 'JobsApi', apiTypeFile: jobsFile, exportName: 'jobsSystem', file: jobsFile, content: jobsSystemContent(input.jobs, Boolean(input.settings), input.banner) }]
			: []),
		...(input.events
			? [{ key: 'events', apiType: 'EventsApi', apiTypeFile: eventsSystemFile, exportName: 'eventsSystem', file: eventsSystemFile, content: eventsSystemContent(input.events, eventsSystemFile, input.banner, input.jobs?.bridge ?? null) }]
			: []),
		...(input.integration
			? [{ key: 'integration', apiType: 'IntegrationApi', apiTypeFile: integrationFile, exportName: 'integrationSystem', file: integrationFile, content: integrationSystemContent(input.integration, input.banner) }]
			: []),
		// S-2: auth (the key, the OAuth state, the callback URL), then the starter's connection store, which encrypts with it.
		...(input.auth
			? [{ key: 'auth', apiType: 'AuthApi', apiTypeFile: authFile, exportName: 'authSystem', file: authFile, content: authSystemContent(input.auth, input.banner) }]
			: []),
		...(connectionsPlan
			? [{ key: 'connections', apiType: 'ConnectionStore', apiTypeFile: connectionsPlan.storeFile, exportName: 'connectionsSystem', file: connectionsFile, content: connectionsSystemContent(connectionsPlan, connectionsFile, input.banner) }]
			: []),
		// S-3b: each provider's and adapter set's system, which `emitPatternStackIntegrations` writes.
		...(input.integrations?.systems ?? []).map((s) => ({
			key: s.name,
			apiType: s.apiType,
			apiTypeFile: s.file,
			exportName: s.exportName,
			file: s.file,
			content: null,
		})),
	];

}

interface ConnectionsPlan {
	storeFile: string;
	/** Absolute: `connection.wiring.ts` (`createConnectionRepository`). */
	repositoryWiringFile: string;
}

/**
 * The `connections` system's plan (S-2), or a refusal: it needs the `auth` system (the key), and a generated
 * `connection` entity in the starter's folder whose repository is built from `db` alone.
 */
function planConnections(
	input: CompositionInput,
	connection: { inherits?: unknown; eav?: boolean } | undefined,
	wiringFile: (entity: string) => string,
): ConnectionsPlan {
	const storeFile = input.connections!.storeFile;
	if (!input.auth) {
		throw new Error(
			'[codegen] wiring: pattern-stack: the auth-integrations starter is vendored, and the auth subsystem isn\'t installed: ' +
				'the connection store encrypts with its key. Run `codegen subsystem install auth`.',
		);
	}
	if (!connection) {
		throw new Error(
			`[codegen] wiring: pattern-stack: the auth-integrations starter is vendored (${path.dirname(storeFile)}), and there is ` +
				`no '${CONNECTION_ENTITY}' entity: its store reads and writes it. Keep the starter's connection.yaml and run ` +
				'`codegen entity new --all`.',
		);
	}
	if (connection.inherits !== undefined || connection.eav === true) {
		throw new Error(
			`[codegen] wiring: pattern-stack: the '${CONNECTION_ENTITY}' entity ${connection.inherits !== undefined ? 'inherits a base' : 'is EAV'}, so ` +
				'its repository takes more than `db`, and the `connections` system builds it from `db` alone. Remove ' +
				`\`${connection.inherits !== undefined ? 'inherits:' : 'eav:'}\` from connection.yaml.`,
		);
	}
	const repositoryWiringFile = wiringFile(CONNECTION_ENTITY);
	if (path.dirname(repositoryWiringFile) !== path.dirname(storeFile)) {
		throw new Error(
			`[codegen] wiring: pattern-stack: the '${CONNECTION_ENTITY}' entity generates into ${path.dirname(repositoryWiringFile)}, ` +
				`and the auth-integrations starter (which imports it as ./connection.entity) is in ${path.dirname(storeFile)}: ` +
				'drop `context:` from connection.yaml, or move the starter beside it.',
		);
	}
	return { storeFile, repositoryWiringFile };
}

/**
 * \`<generated>/auth-system.ts\` (S-2): auth's non-HTTP half as a \`@pattern-stack/wiring\` system — the encryption key,
 * the OAuth state store and the callback URL, from the \`auth\` settings.
 */
function authSystemContent(auth: CompositionAuthInput, banner: string): string {
	return `${banner}
/**
 * The \`auth\` system (S-2): what provider connections share, as a \`@pattern-stack/wiring\` system —
 * - \`encryptionKey\`: AES-256-GCM over \`settings.auth.tokenEncryptionKey\` (\`${TOKEN_ENCRYPTION_KEY_ENV}\`); the
 *   connection store encrypts every stored token with it;
 * - \`oauthState\`: the single-use state of a connect → callback dance, in \`auth_oauth_state\`;
 * - \`callbackUrl(provider)\`: where the provider redirects back, \`<settings.auth.redirectUriBase>/auth/<provider>/callback\`.
 * The OAuth routes themselves are the HTTP layer's.
 */
import { DrizzleOAuthStateStore, EnvEncryptionKey, oauthCallbackUrl, type IEncryptionKey, type IOAuthStateStore } from '${auth.coreImport}';
import { defineSystem } from './wiring';

export interface AuthApi {
  encryptionKey: IEncryptionKey;
  oauthState: IOAuthStateStore;
  /** The URL a provider redirects back to after an authorize: the authorize request and the code exchange send it. */
  callbackUrl(provider: string): string;
}

export const authSystem = defineSystem({
  name: 'auth',
  uses: ['settings', 'database'],
  create: ({ settings, database }): AuthApi => ({
    encryptionKey: new EnvEncryptionKey({ key: settings.auth.tokenEncryptionKey }),
    oauthState: new DrizzleOAuthStateStore(database.db),
    callbackUrl: (provider) => oauthCallbackUrl(settings.auth.redirectUriBase, provider),
  }),
});
`;
}

/** \`<generated>/connections-system.ts\` (S-2): the connection store, over its own connection repository. */
function connectionsSystemContent(plan: ConnectionsPlan, file: string, banner: string): string {
	const create = `create${repositoryClassName(CONNECTION_ENTITY)}`;
	return `${banner}
/**
 * The \`connections\` system (S-2): the connection store (the auth-integrations starter's \`createConnectionStore\`) as a
 * \`@pattern-stack/wiring\` system — \`reader\` and \`tokenWriter\` (what a refresh strategy takes), \`grantSink\` (what an
 * OAuth callback hands a grant to) and \`connections\` (the facade), every token encrypted with the \`auth\` system's key.
 *
 * A system, not a module, because a provider system's refresh strategy needs it and a system can't depend on a module.
 * So it builds its own connection repository: a repository is stateless over \`db\` and reads the same request state,
 * so it acts as the one in \`connection\`'s module does.
 */
import { createConnectionStore, type ConnectionStore } from '${relativeImport(file, plan.storeFile)}';
import { ${create} } from '${relativeImport(file, plan.repositoryWiringFile)}';
import { defineSystem } from './wiring';

export const connectionsSystem = defineSystem({
  name: 'connections',
  uses: ['database', 'auth'],
  create: ({ database, auth }): ConnectionStore => createConnectionStore(${create}(database.db), auth.encryptionKey),
});
`;
}

/**
 * The \`integrations\` module (S-3): one \`IntegrationRunner\` per (surface, Integrated entity, provider), keyed
 * \`<surface>.<entity>.<provider>\`. Its source is the provider's adapter's \`changeSources[<entity>]\`, its sink the
 * entity's sink over the entity module's repository, its substrate the \`integration\` system's parts; an
 * \`emit_changes\` entity's runs also take its change emitter over the \`events\` system's typed bus. Null when no
 * Integrated entity has a provider (the systems are still composed).
 */
function integrationsModuleFile(
	input: CompositionInput,
	plans: Map<string, ModulePlan>,
	moduleOf: Map<string, string>,
	registryFile: string,
): { file: string; content: string } | null {
	const ig = input.integrations!;
	if (ig.runs.length > 0 && plans.has(INTEGRATIONS_MODULE)) {
		throw new Error(
			`[codegen] wiring: pattern-stack: a context's module is named '${INTEGRATIONS_MODULE}', the module the integration runs ` +
				`are composed in; rename the context`,
		);
	}
	const taken = new Set<string>([...plans.keys(), ...GENERATED_SYSTEM_NAMES]);
	for (const s of ig.systems) {
		if (taken.has(s.name)) {
			throw new Error(
				`[codegen] wiring: pattern-stack: the integration system '${s.name}' would share its name with a module or ` +
					`system of the composition; rename the provider or the context`,
			);
		}
		taken.add(s.name);
	}
	if (ig.runs.length === 0) return null;
	if (!input.integration) {
		throw new Error(
			`[codegen] wiring: pattern-stack: ${[...new Set(ig.runs.map((r) => r.entity))].join(', ')} ` +
				`${ig.runs.length === 1 ? 'is' : 'are'} integrated from a provider, and the integration subsystem isn't installed: ` +
				`run \`codegen subsystem install integration\`.`,
		);
	}
	const emitting = ig.runs.filter((r) => r.emitter);
	if (emitting.length > 0 && !input.events) {
		throw new Error(
			`[codegen] wiring: pattern-stack: ${[...new Set(emitting.map((r) => r.entity))].join(', ')} declare ` +
				`\`integration.sink.emit_changes\`, and the events subsystem isn't installed: run \`codegen subsystem install events\`.`,
		);
	}
	const file = ig.moduleFile;
	const moduleFor = (entity: string): string => {
		const m = moduleOf.get(entity);
		if (!m) throw new Error(`[codegen] wiring: '${entity}' is integrated but has no entity YAML in the set`);
		return m;
	};
	const dependsOn = [...new Set(ig.runs.map((r) => moduleFor(r.entity)))].sort();
	const adapters = [...new Set(ig.runs.map((r) => r.adaptersSystem))].sort();
	const uses = ['integration', ...adapters, ...(emitting.length > 0 ? ['events'] : [])];
	const systemOf = new Map(ig.systems.map((s) => [s.name, s]));
	const byEntity = new Map<string, (typeof ig.runs)[number]>();
	for (const r of ig.runs) byEntity.set(r.entity, r);
	const imports = [
		`import { IntegrationRunner, type IChangeSource } from '${ig.coreImport}';`,
		`import { defineModule } from '${relativeImport(file, registryFile)}';`,
		`import type { IntegrationApi } from '${relativeImport(file, path.join(input.generatedDir, INTEGRATION_SYSTEM_FILE))}';`,
		...(emitting.length > 0 ? [`import type { EventsApi } from '${relativeImport(file, path.join(input.generatedDir, EVENTS_SYSTEM_FILE))}';`] : []),
		...adapters.map((a) => `import type { ${systemOf.get(a)!.apiType} } from '${relativeImport(file, systemOf.get(a)!.file)}';`),
		...dependsOn.map((m) => `import type { ${pascalCase(m)}Module } from '${relativeImport(file, plans.get(m)!.file)}';`),
		...[...byEntity.values()].flatMap((r) => [
			`import type { ${r.projectionType} } from '${relativeImport(file, r.repositoryFile)}';`,
			`import { ${r.sinkClass} } from '${relativeImport(file, r.sinkFile)}';`,
			...(r.emitter ? [`import { ${r.emitter.className} } from '${relativeImport(file, r.emitter.file)}';`] : []),
		]),
	];
	const depsType = [
		'integration: IntegrationApi',
		...adapters.map((a) => `${a}: ${systemOf.get(a)!.apiType}`),
		...dependsOn.map((m) => `${m}: ${pascalCase(m)}Module`),
		...(emitting.length > 0 ? ['events: EventsApi'] : []),
	];
	const surfaces = [...new Set(ig.runs.map((r) => r.surface))].sort();
	const body = surfaces
		.map((surface) => {
			const entities = [...new Set(ig.runs.filter((r) => r.surface === surface).map((r) => r.entity))].sort();
			return `    ${camelCase(surface)}: {\n${entities
				.map((entity) => {
					const runs = ig.runs.filter((r) => r.surface === surface && r.entity === entity);
					return `      ${camelCase(entity)}: {\n${runs
						.map((r) => {
							const T = r.projectionType;
							return (
								`        ${r.adapterKey}: new IntegrationRunner<${T}>({\n` +
								`          ...deps.integration,\n` +
								`          source: deps.${r.adaptersSystem}.adapters.${r.adapterKey}.changeSources.${entity} as IChangeSource<${T}>,\n` +
								`          sink: new ${r.sinkClass}(deps.${moduleFor(entity)}.repositories.${camelCase(entity)}, '${r.provider}'),\n` +
								(r.emitter ? `          emitter: new ${r.emitter.className}(deps.events.typed),\n` : '') +
								`        }),`
							);
						})
						.join('\n')}\n      },`;
				})
				.join('\n')}\n    },`;
		})
		.join('\n');
	const content = `${input.banner}
/**
 * The integrations module (S-3): one \`IntegrationRunner\` per (surface, entity, provider), keyed
 * \`<surface>.<entity>.<provider>\` — \`app.module('integrations').${camelCase(ig.runs[0]!.surface)}.${camelCase(ig.runs[0]!.entity)}.${ig.runs[0]!.adapterKey}.execute(…)\`
 * runs one. Each reads its adapter's change source, writes through the entity's sink over its module's repository, and
 * keeps its cursor and run log on the \`integration\` system. An adapter whose \`changeSources\` has no entry for the
 * entity yet makes that run fail when executed, not at compose.
 */
${imports.join('\n')}

export function composeIntegrations(deps: { ${depsType.join('; ')} }) {
  return {
${body}
  };
}

export type IntegrationsModule = ReturnType<typeof composeIntegrations>;

export const integrationsModule = defineModule({
  name: '${INTEGRATIONS_MODULE}',
  kind: 'derived',
  dependsOn: [${dependsOn.map((m) => `'${m}'`).join(', ')}],
  uses: [${uses.map((u) => `'${u}'`).join(', ')}],
  create: (deps) => composeIntegrations(deps),
});
`;
	return { file, content };
}

/**
 * \`<generated>/integration-system.ts\` (S-3): the integration substrate as a \`@pattern-stack/wiring\` system. Every
 * \`IntegrationRunner\` takes its cursor store, run recorder, differ and multi-tenant flag from here.
 */
/**
 * The integration system's classes by backend (S-3): the cursor store and the run recorder it builds, whether they take
 * the database, and where each comes from (the Nest-free entry, or a backend file by path).
 */
const INTEGRATION_BACKENDS: Readonly<
	Record<
		CompositionIntegrationInput['backend'],
		{ cursorClass: string; recorderClass: string; usesDatabase: boolean; byPath: readonly { name: string; file: string }[] }
	>
> = {
	drizzle: {
		cursorClass: 'PostgresCursorStore',
		recorderClass: 'DrizzleIntegrationRunRecorder',
		usesDatabase: true,
		byPath: [
			{ name: 'PostgresCursorStore', file: 'subsystems/integration/integration-cursor-store.drizzle-backend' },
			{ name: 'DrizzleIntegrationRunRecorder', file: 'subsystems/integration/integration-run-recorder.drizzle-backend' },
		],
	},
	memory: { cursorClass: 'MemoryCursorStore', recorderClass: 'MemoryRunRecorder', usesDatabase: false, byPath: [] },
};

/** `<generated>/integration-system.ts` (S-3), printed from the selected backend's row. */
function integrationSystemContent(integration: CompositionIntegrationInput, banner: string): string {
	const row = INTEGRATION_BACKENDS[integration.backend];
	const differ = integration.differ && (integration.differ.ignore || integration.differ.unignore) ? JSON.stringify(integration.differ) : '';
	const byPath = new Set(row.byPath.map((b) => b.name));
	const fromCore = ['DeepEqualDiffer', ...[row.cursorClass, row.recorderClass].filter((c) => !byPath.has(c)), 'type IntegrationSubstrate'];
	const dbArgs = row.usesDatabase ? `database.db, ${integration.multiTenant}` : '';
	return `${banner}
/**
 * The \`integration\` system (S-3): the substrate every integration run shares, as a \`@pattern-stack/wiring\` system —
 * the cursor store, the run recorder (the \`integration_runs\` audit log), the default differ and the multi-tenant flag,
 * from codegen.config.yaml's \`integration:\` block. An \`IntegrationRunner\` takes them with its change source and sink:
 * \`new IntegrationRunner({ ...integration, source, sink })\`.
 */
import { ${fromCore.join(', ')} } from '${integration.coreImport}';
${row.byPath.map((b) => `import { ${b.name} } from '${integration.runtimeImport(b.file)}';\n`).join('')}import { defineSystem } from './wiring';

/** The runtime's \`IntegrationSubstrate\`: what \`app.system('integration')\` holds. */
export type IntegrationApi = IntegrationSubstrate;

export const integrationSystem = defineSystem({
  name: 'integration',
  uses: [${row.usesDatabase ? `'${DATABASE_SYSTEM}'` : ''}],
  create: (${row.usesDatabase ? '{ database }' : ''}): IntegrationApi => ({
    cursors: new ${row.cursorClass}(${dbArgs}),
    recorder: new ${row.recorderClass}(${dbArgs}),
    differ: new DeepEqualDiffer<object>(${differ}),
    multiTenant: ${integration.multiTenant},
  }),
});
`;
}

/** \`<generated>/events-system.ts\` (S-1): the event bus as a \`@pattern-stack/wiring\` system. */
/**
 * The event bus each \`events.backend\` builds (S-1), one row per backend: its class, what the system uses, and its
 * construction. A backend that drains an outbox (\`bridged\`) takes the bridge's drainer when the bridge is installed
 * (J-1): the drain then starts each trigger's run in the event's own transaction, over the \`jobs\` system's starter.
 */
interface EventBusRow {
	busClass: string;
	bridged: boolean;
	uses(drained: boolean): string[];
	params(drained: boolean): string;
	construct(drained: boolean): string[];
}

/**
 * Whether an events backend's bus drains an outbox, so the bridge can start runs from it (its row's `bridged`): the one
 * answer the bridge's install prerequisite and the events system both read. An unknown backend is refused by its rows.
 */
export function eventBusDrainsOutbox(backend: string): boolean {
	return rowFor('events backend', EVENT_BUSES, backend).bridged;
}

/** The events backends whose bus drains an outbox, for a refusal to name. */
export function outboxEventBackends(): string[] {
	return Object.entries(EVENT_BUSES)
		.filter(([, row]) => row.bridged)
		.map(([name]) => name);
}

const EVENT_BUSES: Readonly<Record<CompositionEventsInput['backend'], EventBusRow>> = {
	drizzle: {
		busClass: 'DrizzleEventBus',
		bridged: true,
		uses: (drained) => ['database', ...(drained ? ['jobs'] : [])],
		params: (drained) => (drained ? '{ database, jobs }' : '{ database }'),
		construct: (drained) =>
			drained
				? [
						"    // The bridge (J-1): the drain starts each trigger's run in the event's own transaction, over the jobs starter.",
						'    // Its ledger is the Drizzle delivery repo, the one writer, which checks the tenant. A trigger naming a job this',
						'    // app does not register stops the compose, naming it.',
						'    const deliveries = new DrizzleBridgeDeliveries(database.db, options.multiTenant ?? false);',
						'    const drainer = new BridgeOutboxDrainer(jobs.starter, deliveries, bridgeRegistry);',
						'    drainer.assertTriggersRegistered();',
						'    const bus = new DrizzleEventBus(database.db, options, drainer);',
					]
				: ['    const bus = new DrizzleEventBus(database.db, options);'],
	},
	memory: {
		busClass: 'MemoryEventBus',
		bridged: false,
		uses: () => [],
		params: () => '',
		construct: () => ['    const bus = new MemoryEventBus(options);'],
	},
};

function eventsSystemContent(
	events: CompositionEventsInput,
	file: string,
	banner: string,
	bridge: CompositionJobsInput['bridge'],
): string {
	const bus = rowFor('events backend', EVENT_BUSES, events.backend);
	const busClass = bus.busClass;
	// J-1: with the bridge installed, a backend that drains an outbox drains each event through the bridge's drainer.
	const drain = bus.bridged && bridge ? bridge : null;
	return `${banner}
/**
 * The \`events\` system (S-1): the event bus the generated use cases publish through, as a \`@pattern-stack/wiring\`
 * system. \`create\` builds the bus, its typed facade and the scheduler (for the events that declare \`schedule:\`);
 * \`start\` runs the drain loop and the scheduler only after every system and module was created, so every subscriber
 * is attached before the first event is delivered. \`stop\` stops both.
 */
import { ${busClass} } from '${events.backendImport}';
import { EventScheduler, scheduledEventsFromRegistry, type EventsModuleOptions } from '${events.coreImport}';
import { TypedEventBus, eventRegistry } from '${relativeImport(file, events.generatedEventsDir)}';
${drain ? `import { BridgeOutboxDrainer, DrizzleBridgeDeliveries } from '${drain.coreImport}';\nimport { bridgeRegistry } from '${relativeImport(file, drain.registryFile)}';\n` : ''}import { defineSystem } from './wiring';

/** From codegen.config.yaml's \`events:\` block. */
const options: EventsModuleOptions = {
  backend: '${events.backend}',
  multiTenant: ${events.multiTenant},
  listenNotify: ${events.listenNotify},
};

export interface EventsApi {
  /** The bus: \`subscribe(type, handler)\` here. */
  bus: ${busClass};
  /** The typed facade the generated use cases publish through. */
  typed: TypedEventBus;
  /** Materializes the scheduled events; null when none declares \`schedule:\`. */
  scheduler: EventScheduler | null;
}

export const eventsSystem = defineSystem({
  name: 'events',
  uses: [${bus.uses(drain !== null).map((u) => `'${u}'`).join(', ')}],
  create: (${bus.params(drain !== null)}): EventsApi => {
${bus.construct(drain !== null).join('\n')}
    const schedules = scheduledEventsFromRegistry(eventRegistry);
    return {
      bus,
      typed: new TypedEventBus(bus, options.multiTenant ?? false),
      scheduler: schedules.length > 0 ? new EventScheduler(bus, schedules) : null,
    };
  },
  start: async ({ bus, scheduler }) => {
    await bus.start();
    try {
      await scheduler?.start();
    } catch (err) {
      // A part that fails to start is not stopped by compose: stop the drain loop this start began.
      await bus.stop();
      throw err;
    }
  },
  stop: async ({ bus, scheduler }) => {
    scheduler?.stop();
    await bus.stop();
  },
});
`;
}

/** \`<generated>/jobs-system.ts\` (J-1): the jobs engine as a \`@pattern-stack/wiring\` system. */
function jobsSystemContent(jobs: CompositionJobsInput, withSettings: boolean, banner: string): string {
	return `${banner}
/**
 * The \`jobs\` system (J-1): \`@pattern-stack/jobs\` on the app's Postgres, run in process. \`create\` builds the engine
 * over every job the app defines (\`./jobs\`) and the pools and knobs from codegen.config.yaml's \`jobs:\` block
 * (\`./app-config\`); \`starter.start(key, input)\` starts a run, and the bridge starts one per trigger. \`start\` checks
 * every job factory got its dependencies, then runs the executor's loop when this process is a worker
 * (\`JOBS_WORKER\`, default true; \`codegen project settings\` lists it). \`stop\` stops the loop, in-flight work settling.
 */
import { createJobsEngine, type JobsEngine } from '${jobs.coreImport}';
import { jobLimiters, jobsInProcessOptions } from './app-config';
import { jobDefinitions } from './jobs';
import { defineSystem } from './wiring';

export type JobsApi = JobsEngine;

export const jobsSystem = defineSystem({
  name: 'jobs',
  uses: [${withSettings ? "'database', 'settings'" : "'database'"}],
  create: (${withSettings ? '{ database, settings }' : '{ database }'}): JobsApi =>
    createJobsEngine({
      db: database.db,
      definitions: jobDefinitions,
      worker: ${withSettings ? "settings.jobs.worker === 'true'" : 'true'},
      limiters: jobLimiters,
      inProcess: jobsInProcessOptions,
    }),
  start: (jobs) => jobs.start(),
  stop: (jobs) => jobs.stop(),
});
`;
}

/**
 * \`<generated>/job-deps.ts\` (J-1): the \`jobDeps\` module, which hands each job factory the composition parts its
 * dependencies name (\`injected<T>('<part>')\`), typed by the factory. Null when no factory names one. A dependency that
 * names no part, or a part this composition doesn't have, is refused, naming the job and the dependency.
 */
function jobDepsModuleFile(
	input: CompositionInput,
	parts: { modules: readonly string[]; systems: readonly string[]; registryFile: string },
): { file: string; content: string } | null {
	const jobs = input.jobs!;
	const modules = new Set(parts.modules);
	const systems = new Set(parts.systems);
	for (const [name, what] of [
		['jobs', 'the jobs system'],
		[JOB_DEPS_MODULE, "the module that provides the job factories' dependencies"],
	] as const) {
		if (modules.has(name)) {
			throw new Error(`[codegen] wiring: pattern-stack: a context's module is named '${name}', which is ${what}; rename the context`);
		}
	}
	const factories = jobs.factories.filter((f) => f.deps.length > 0);
	for (const f of factories) {
		for (const d of f.deps) {
			const where = `job factory '${f.exportName}' (${path.relative(input.generatedDir, f.file)}): its dependency '${d.name}'`;
			if (d.unreadable !== undefined) {
				throw new Error(
					`[codegen] wiring: pattern-stack: ${where} is ${d.unreadable}, which codegen cannot read: write each one ` +
						`\`<name>: injected<T>('<module or system>')\` in the factory's \`deps\` object`,
				);
			}
			if (d.part === undefined) {
				throw new Error(
					`[codegen] wiring: pattern-stack: ${where} must name a composition part, \`injected<T>('<module or system>')\` ` +
						`(there is no container to resolve a class by): ${[...modules, ...systems].join(', ')}`,
				);
			}
			if (!modules.has(d.part) && !systems.has(d.part)) {
				throw new Error(
					`[codegen] wiring: pattern-stack: ${where} names '${d.part}', which this composition has no module or system ` +
						`of: ${[...modules, ...systems].join(', ')}`,
				);
			}
		}
	}
	if (factories.length === 0) return null;
	const named = [...new Set(factories.flatMap((f) => f.deps.map((d) => d.part!)))].sort();
	const dependsOn = named.filter((p) => modules.has(p));
	const uses = ['jobs', ...named.filter((p) => systems.has(p) && p !== 'jobs')];
	const file = path.join(input.generatedDir, JOB_DEPS_FILE);
	const byFile = new Map<string, string[]>();
	for (const f of factories) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f.exportName]);
	const content = `${input.banner}
/**
 * The \`jobDeps\` module (J-1): hands each job factory the composition parts its dependencies name, typed by the
 * factory, so a wrong part does not compile. Composed last, it is stopped first, and its \`stop\` stops the jobs
 * engine, so no step keeps running against a module that has already stopped.
 */
import { defineModule } from '${relativeImport(file, parts.registryFile)}';
import type { JobsApi } from './${JOBS_SYSTEM_FILE.replace(/\.ts$/, '')}';
${[...byFile.entries()].map(([from, names]) => `import { ${names.join(', ')} } from '${relativeImport(file, from)}';`).join('\n')}

export interface JobDepsModule {
  /** The jobs engine, which this module's \`stop\` stops. */
  readonly jobs: JobsApi;
}

export const jobDepsModule = defineModule({
  name: '${JOB_DEPS_MODULE}',
  kind: 'derived',
  dependsOn: [${dependsOn.map((m) => `'${m}'`).join(', ')}],
  uses: [${uses.map((u) => `'${u}'`).join(', ')}],
  create: (deps): JobDepsModule => {
${factories.map((f) => `    deps.jobs.provide(${f.exportName}, { ${f.deps.map((d) => `${d.name}: deps.${d.part}`).join(', ')} });`).join('\n')}
    return { jobs: deps.jobs };
  },
  stop: ({ jobs }) => jobs.stop(),
});
`;
	return { file, content };
}

/**
 * A module's construction lines in build order: each after the module's own classes it takes. The order they come in
 * (every repository, then the junction services, then the entity services) is kept wherever nothing forces
 * otherwise, so only an EAV entity's repository, which takes FieldValueService, moves (after that service).
 * A use case's needs count as its service's: `create<Entity>Services` builds both.
 */
function buildOrder(lines: { node: string; line: string }[], graph: ReturnType<typeof deriveProjectClassGraph>['graph']): string[] {
	const nodeOf = new Map(graph.nodes.map((n) => [n.id, n]));
	const serviceOfOwner = new Map(graph.nodes.filter((n) => n.role === 'service').map((n) => [n.owner, n.id]));
	const builder = (id: string): string => {
		const n = nodeOf.get(id);
		return n?.role === 'use_case' ? (serviceOfOwner.get(n.owner) ?? id) : id;
	};
	const inModule = new Set(lines.map((l) => l.node));
	const needs = new Map(lines.map((l) => [l.node, new Set<string>()]));
	for (const e of graph.edges) {
		const from = builder(e.from);
		if (inModule.has(from) && inModule.has(e.to) && from !== e.to) needs.get(from)!.add(e.to);
	}
	const out: string[] = [];
	const done = new Set<string>();
	while (out.length < lines.length) {
		const next = lines.find((l) => !done.has(l.node) && [...needs.get(l.node)!].every((n) => done.has(n)));
		if (!next) throw new Error(`[codegen] wiring: a cycle among ${lines.filter((l) => !done.has(l.node)).map((l) => l.node).join(', ')}`);
		done.add(next.node);
		out.push(next.line);
	}
	return out;
}

/**
 * The entities and junctions whose `.wiring.ts` is missing, or doesn't export what the composition imports from it (a
 * file an older codegen wrote, or a junction `junction new` hasn't generated yet). `entity new <one>` re-renders only that entity's, so the composition would not compile; the CLI
 * names them and says to run `entity new --all`.
 */
export function wiringFilesBehind(input: Pick<CompositionInput, 'relations' | 'modulesDir'>): string[] {
	const behind: string[] = [];
	for (const d of input.relations.definitions.values()) {
		const e = d.entity.name;
		const file = entityModuleNaming(d.entity, input.modulesDir).wiringFile;
		const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
		const { module, openApi } = wiringImports(e);
		const exports = [...module, ...openApi].map((name) => name.replace(/^type /, ''));
		if (!exports.every((name) => new RegExp(`export (function|type) ${name}\\b`).test(text))) behind.push(e);
	}
	// PW-3c: each junction's, which `junction new` writes.
	for (const j of input.relations.junctions.filter((x) => x.between.length === 2)) {
		const { name } = junctionIdentity(j);
		const file = junctionWiringFile(name, input.modulesDir);
		const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
		if (!junctionWiringImports(name).every((n) => new RegExp(`export function ${n}\\b`).test(text))) behind.push(name);
	}
	return behind.sort();
}

/** Plan and write the composition. Returns the files written (or that would be, on a dry run). */
export function emitComposition(input: CompositionInput): CompositionFile[] {
	const files = planComposition(input);
	if (!input.dryRun) {
		for (const f of files) {
			fs.mkdirSync(path.dirname(f.path), { recursive: true });
			generating(f.path, () => fs.writeFileSync(f.path, f.content));
		}
	}
	return files;
}
