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

import fs from 'node:fs';
import path from 'node:path';

import { composedRepositoryOwners } from '../../derived/wiring/classes.js';
import { contextCycles } from '../../derived/wiring/order.js';
import { deriveProjectClassGraph } from '../../derived/wiring/project.js';
import type { ProjectApiContext } from '../../derived/api/project.js';
import {
	pascalCase,
	registerSchemasName,
	repositoriesBundleName,
	repositoryFactoryName,
	repositoryPortName,
	repositoryPropertyName,
	junctionServiceFactoryName,
	junctionServicePropertyName,
	servicesFactoryName,
} from '../../derived/api/names.js';
import { junctionIdentity } from '../../emitters/relations/build-graph.js';
import { junctionWiringFile } from '../../config/junction-naming.js';
import { camelCase, emittedDir } from '../../config/file-naming.js';
import { entityModuleNaming } from '../../config/module-tree.js';
import { generating } from '../../utils/generated-file.js';
import { relativeImport } from '../../utils/import-path.js';

/** The module name of the entities that declare no `context:`. */
export const ROOT_MODULE = 'entities';

/** Names a context's module can't take: the root module's, and the systems' (`database`). */
/** The `database` system's name: the one system every generated module uses (`{ db }`), and the app's `database.ts` defines. */
export const DATABASE_SYSTEM = 'database';

const RESERVED_MODULE_NAMES = new Set([ROOT_MODULE, DATABASE_SYSTEM]);

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
	dryRun?: boolean;
}

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

		// Phase 1: repositories, in the class graph's order (a base before its child).
		const repositoryLines: string[] = [];
		for (const node of order) {
			if (node.role !== 'repository' || node.ownerKind !== 'entity' || !own.has(node.owner)) continue;
			const base = graph.edges.find((e) => e.from === node.id && e.reason === 'inherits');
			const args = ['db', ...(base ? [repoRef(base.toOwner)] : [])];
			repositoryLines.push(`  const ${repoVar(node.owner)} = ${repositoryFactoryName(node.owner)}(${args.join(', ')});`);
		}
		// PW-3c: each junction's repository, then its service over both ends' repositories (the ends' services take it).
		for (const j of plan.junctions) {
			repositoryLines.push(`  const ${repoVar(j.name)} = ${repositoryFactoryName(j.name)}(db);`);
		}
		const junctionLines = plan.junctions.map(
			(j) =>
				`  const ${junctionServicePropertyName(j.name)} = ${junctionServiceFactoryName(j.name)}({ repository: ${repoVar(j.name)}, ` +
				`left: ${repoRef(j.left)}, right: ${repoRef(j.right)} });`,
		);
		const ownJunctions = new Set(plan.junctions.map((j) => j.name));

		// Phase 2: each entity's service and use cases, taking its repository and the composed ones (#632).
		const serviceLines: string[] = [];
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
			const fields = [
				`repository: ${repoVar(entity)}`,
				...composedRepositoryOwners(graph, entity).map((owner) => `${repositoryPropertyName(owner)}: ${repoRef(owner)}`),
				...fannedOut.map((e) => `${junctionServicePropertyName(e.toOwner)}: ${junctionServicePropertyName(e.toOwner)}`),
			];
			serviceLines.push(`  const ${camelCase(entity)} = ${servicesFactoryName(entity)}({ ${fields.join(', ')} });`);
		}

		const otherModules = [...dependsOn].sort();
		const moduleType = `${pascalCase(plan.name)}Module`;
		const bundleType = repositoriesBundleName(plan.name);
		const imports = [
			`import type { DrizzleClient } from '${input.drizzleTypeImport}';`,
			`import type { Relations } from '${relativeImport(plan.file, relationsFile)}';`,
			`import { defineModule } from '${relativeImport(plan.file, registryFile)}';`,
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
			...otherModules.map((m) => `${m}: ${pascalCase(m)}Module`),
		].join('; ');
		const content = `${input.banner}
/**
 * The ${plan.name} module (PW-3): ${plan.entities.join(', ')}, composed with no DI container.
 * Every repository first, then each junction's service, then every service and its use cases (entities compose each
 * other's repositories, and fan out to the junctions between them).
 */
${imports.join('\n')}

/** The ${plan.name} module's repositories, one port per entity: what a hand-written context service takes (d27). */
export interface ${bundleType} {
${plan.entities.map((e) => `  ${camelCase(e)}: ${repositoryPortName(e)};`).join('\n')}
}

export function compose${pascalCase(plan.name)}(deps: { ${depsType} }) {
  const { db } = deps.${DATABASE_SYSTEM};
${[...repositoryLines, ...junctionLines, ...serviceLines].join('\n')}
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
  uses: ['${DATABASE_SYSTEM}'],
  create: (deps) => compose${pascalCase(plan.name)}(deps),
});
`;
		files.push({ path: plan.file, content });
	}

	const names = [...plans.keys()].sort();
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
${names.map((n) => `import type { ${pascalCase(n)}Module } from '${relativeImport(registryFile, plans.get(n)!.file)}';`).join('\n')}

export interface ModuleApis {
${names.map((n) => `  ${n}: ${pascalCase(n)}Module;`).join('\n')}
}

export interface SystemApis {
  ${DATABASE_SYSTEM}: { db: DrizzleClient<Relations> };
}

export const { defineModule, defineSystem, compose } = createWiring<ModuleApis, SystemApis>();
`,
	});
	const compositionFile = path.join(generatedDir, COMPOSITION_GENERATED_FILES.composition);
	files.push({
		path: compositionFile,
		content: `${input.banner}
/** Every generated module's manifest (PW-3), for the app's \`compose.ts\`: \`compose({ systems, modules: MODULES })\`. */
${names.map((n) => `import { ${n}Module } from '${relativeImport(compositionFile, plans.get(n)!.file)}';`).join('\n')}

export const MODULES = [${names.map((n) => `${n}Module`).join(', ')}] as const;
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
	return files;
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
