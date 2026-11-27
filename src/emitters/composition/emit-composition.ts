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
 * - `<generated>/composition.ts`: `MODULES`, every module's manifest, for the app's `compose.ts` (PW-4).
 *
 * The only system pattern-stack wiring needs here is `database` (`{ db }`). Modules depend on each other one way: a cycle
 * between contexts is refused, naming it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { deriveProjectClassGraph } from '../../derived/wiring/project.js';
import type { ProjectApiContext } from '../../derived/api/project.js';
import { pascalCase, repositoryClassName, repositoryPropertyName } from '../../derived/api/names.js';
import { camelCase, emittedDir, emittedStem } from '../../config/file-naming.js';
import { entityModuleNaming } from '../../config/module-tree.js';
import { generating } from '../../utils/generated-file.js';

/** The module name of the entities that declare no `context:`. */
export const ROOT_MODULE = 'entities';

/** Names a context's module can't take: the root module's, and the systems' (`database`). */
const RESERVED_MODULE_NAMES = new Set([ROOT_MODULE, 'database']);

export interface CompositionInput {
	relations: ProjectApiContext['relations'];
	/** Absolute `paths.modules_dir`. */
	modulesDir: string;
	/** Absolute `paths.generated`. */
	generatedDir: string;
	/** The import specifier of `DrizzleClient` (`runtimeImport(mode, 'types/drizzle')`). */
	drizzleTypeImport: string;
	/** The `@generated` banner every emitted file starts with. */
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
}

/** `./x/y` from `from`'s folder to `to`, without the `.ts` extension. */
function importPath(fromFile: string, toFile: string): string {
	const rel = path.relative(path.dirname(fromFile), toFile).replace(/\.ts$/, '');
	return rel.startsWith('.') ? rel : `./${rel}`;
}

export function planComposition(input: CompositionInput): CompositionFile[] {
	const { relations, modulesDir, generatedDir } = input;
	const { graph, order, contextCycles } = deriveProjectClassGraph(relations);
	if (contextCycles.length > 0) {
		throw new Error(
			`[codegen] wiring: pattern-stack composes one module per context, and contexts must depend on each other one way; ` +
				`these depend on each other in a cycle: ${contextCycles.map((c) => c.join(' → ')).join('; ')}`,
		);
	}

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
		const plan = plans.get(name) ?? { name, file, entities: [] };
		plan.entities.push(d.entity.name);
		plans.set(name, plan);
		moduleOf.set(d.entity.name, name);
	}
	const blockOf = new Map(definitions.map((d) => [d.entity.name, d.entity]));
	const wiringFile = (entity: string) => {
		const naming = entityModuleNaming(blockOf.get(entity)!, modulesDir);
		return `${naming.moduleDir}/${emittedStem(entity)}.wiring.ts`;
	};

	const registryFile = path.join(generatedDir, 'wiring.ts');
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
			repositoryLines.push(`  const ${repoVar(node.owner)} = create${node.id}(${args.join(', ')});`);
		}

		// Phase 2: each entity's service and use cases, taking its repository and the composed ones (#632).
		const serviceLines: string[] = [];
		for (const entity of plan.entities) {
			const service = graph.nodes.find((n) => n.owner === entity && n.role === 'service');
			if (!service) throw new Error(`[codegen] wiring: '${entity}' has no service in the class graph`);
			const composed = graph.edges.filter(
				(e) => e.from === service.id && e.to !== repositoryClassName(entity) && e.to === repositoryClassName(e.toOwner),
			);
			const fields = [
				`repository: ${repoVar(entity)}`,
				...composed.map((e) => `${repositoryPropertyName(e.toOwner)}: ${repoRef(e.toOwner)}`),
			];
			serviceLines.push(`  const ${camelCase(entity)} = create${pascalCase(entity)}Services({ ${fields.join(', ')} });`);
		}

		const otherModules = [...dependsOn].sort();
		const moduleType = `${pascalCase(plan.name)}Module`;
		const imports = [
			`import type { DrizzleClient } from '${input.drizzleTypeImport}';`,
			`import type { Relations } from '${importPath(plan.file, relationsFile)}';`,
			`import { defineModule } from '${importPath(plan.file, registryFile)}';`,
			...otherModules.map(
				(m) => `import type { ${pascalCase(m)}Module } from '${importPath(plan.file, plans.get(m)!.file)}';`,
			),
			...plan.entities.map(
				(e) =>
					`import { create${repositoryClassName(e)}, create${pascalCase(e)}Services } from '${importPath(plan.file, wiringFile(e))}';`,
			),
		];
		const depsType = [
			'database: { db: DrizzleClient<Relations> }',
			...otherModules.map((m) => `${m}: ${pascalCase(m)}Module`),
		].join('; ');
		const content = `${input.banner}
/**
 * The ${plan.name} module (PW-3): ${plan.entities.join(', ')}, composed with no DI container.
 * Every repository first, then every service and its use cases (entities compose each other's repositories).
 */
${imports.join('\n')}

export function compose${pascalCase(plan.name)}(deps: { ${depsType} }) {
  const { db } = deps.database;
${repositoryLines.join('\n')}
${serviceLines.join('\n')}
  return {
    repositories: { ${plan.entities.map((e) => `${camelCase(e)}: ${repoVar(e)}`).join(', ')} },
${plan.entities.map((e) => `    ${camelCase(e)},`).join('\n')}
  };
}

export type ${moduleType} = ReturnType<typeof compose${pascalCase(plan.name)}>;

export const ${plan.name}Module = defineModule({
  name: '${plan.name}',
  kind: 'stateful',
  dependsOn: [${otherModules.map((m) => `'${m}'`).join(', ')}],
  uses: ['database'],
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
${names.map((n) => `import type { ${pascalCase(n)}Module } from '${importPath(registryFile, plans.get(n)!.file)}';`).join('\n')}

export interface ModuleApis {
${names.map((n) => `  ${n}: ${pascalCase(n)}Module;`).join('\n')}
}

export interface SystemApis {
  database: { db: DrizzleClient<Relations> };
}

export const { defineModule, defineSystem, compose } = createWiring<ModuleApis, SystemApis>();
`,
	});
	const compositionFile = path.join(generatedDir, 'composition.ts');
	files.push({
		path: compositionFile,
		content: `${input.banner}
/** Every generated module's manifest (PW-3), for the app's \`compose.ts\`: \`compose({ systems, modules: MODULES })\`. */
${names.map((n) => `import { ${n}Module } from '${importPath(compositionFile, plans.get(n)!.file)}';`).join('\n')}

export const MODULES = [${names.map((n) => `${n}Module`).join(', ')}] as const;
`,
	});
	return files;
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
