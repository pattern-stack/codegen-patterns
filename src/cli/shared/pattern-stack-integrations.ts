/**
 * Integrations under `target.wiring: pattern-stack` (S-3): the provider × surface × entity set the Nest generators
 * emit as modules and tokens, emitted as `@pattern-stack/wiring` manifests instead.
 *
 * - **A provider is a system** (`<slug>Provider`): `<slug>.provider.ts` (@generated) calls the emit-once
 *   `<slug>.provider.factory.ts`, where the author builds the auth strategy and the client (`auth.strategy`,
 *   `client.class`), so their constructors can take whatever config they need. A per-connection provider (every
 *   surface a read primitive, RFC-0003 R5) has no client.
 * - **A surface's adapters are a system** (`<surface>Adapters`): `<surface>-adapters.system.ts` builds each
 *   provider's adapter from that provider's system, and folds their change sources into one registry on demand.
 * - **The runs are a module** (`integrations`, written by the composition): one `IntegrationRunner` per
 *   (surface, Integrated entity, provider), its source the adapter's `changeSources[<entity>]`, its sink the
 *   entity's sink over the entity module's repository, its substrate the `integration` system. A module, because the
 *   sinks need the entity modules' repositories and a system can't depend on a module.
 *
 * The adapter scaffold, the sinks, the change emitter and the typed view are the Nest generators' own, given
 * `wiring: 'pattern-stack'`; their Nest text is unchanged.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { generating } from '../../utils/generated-file';
import { emittedStem } from '../../config/file-naming.js';
import { parseImportRef, type ActiveProviderDefinition } from '../../schema/provider-definition.schema';
import type { LoadedProvider } from '../../parser/validate-providers';
import type { DetectionConfig } from '../../../runtime/subsystems/integration';
import {
	adapterTakesClient,
	buildSinkInput,
	entitySourcesFold,
	generateAdapterScaffold,
	generateTypedView,
	integrationSurfaces,
	isClientlessProvider,
	notIntegratedReason,
	type EmitAdaptersEntity,
} from './adapter-emission-generator';
import { resolveEntityModuleImports, toImportSpecifier } from './assembly-emission-generator';
import { changeEmitterClass, generateChangeEmitter } from './change-emitter-emission-generator';
import { providerPascalCase } from './provider-module-generator';
import { generateSinkBase, generateSinkSubclass } from './sink-emission-generator';
import { subsystemCoreImport, type RuntimeMode } from './runtime-import';

/** A system the composition lists in `SYSTEMS` and `SystemApis`. */
export interface PatternStackIntegrationSystem {
	/** Its name in `SystemApis` (`salesforceProvider`, `crmAdapters`). */
	name: string;
	/** The manifest's export (`salesforceProviderSystem`). */
	exportName: string;
	/** Absolute: the file that exports it. */
	file: string;
	/** Its API type, exported from the same file. */
	apiType: string;
}

/** One `IntegrationRunner` the `integrations` module builds. */
export interface PatternStackIntegrationRun {
	surface: string;
	entity: string;
	provider: string;
	/** The adapters system it reads its change source from (`crmAdapters`). */
	adaptersSystem: string;
	/** The adapter's key in that system's `adapters` (the provider slug, as a property name). */
	adapterKey: string;
	/** Absolute: the emit-once sink subclass, and its class. */
	sinkFile: string;
	sinkClass: string;
	/** Absolute: the entity's repository, and its projection type (the runner's record type). */
	repositoryFile: string;
	projectionType: string;
	/** For an `integration.sink.emit_changes` entity: its change emitter (needs the events system). */
	emitter?: { file: string; className: string };
}

export interface PatternStackIntegrationsPlan {
	/** `<backend_src>/integrations`. */
	root: string;
	/** Absolute: the `integrations` module the composition writes (`<root>/module.ts`). */
	moduleFile: string;
	/** The Nest-free integration entry (`subsystemCoreImport(mode, 'integration')`). */
	coreImport: string;
	/** The providers' systems, then the surfaces' adapters systems. */
	systems: PatternStackIntegrationSystem[];
	runs: PatternStackIntegrationRun[];
	skippedSurfaces: Array<{ provider: string; surface: string; reason: string }>;
	skippedAssemblies: Array<{ surface: string; entity: string; reason: string }>;
}

export interface PatternStackIntegrationsInput {
	providers: LoadedProvider[];
	entities: EmitAdaptersEntity[];
	/** `<backend_src>/integrations`. */
	outputRoot: string;
	/** Absolute `<backend_src>` and `paths.modules_dir`: where the entity repositories are. */
	backendSrcAbs: string;
	modulesAbs: string;
	mode: RuntimeMode;
}

const camel = (s: string): string => {
	const p = providerPascalCase(s);
	return p.charAt(0).toLowerCase() + p.slice(1);
};

/** The provider's names: its system, its API type (the factory's return), its factory. */
export function providerSystemNames(slug: string): { name: string; exportName: string; apiType: string; factory: string } {
	const pascal = providerPascalCase(slug);
	return {
		name: `${camel(slug)}Provider`,
		exportName: `${camel(slug)}ProviderSystem`,
		apiType: `${pascal}Provider`,
		factory: `create${pascal}Provider`,
	};
}

/** The surface's adapters system: its name and API type. */
export function adaptersSystemNames(surface: string): { name: string; exportName: string; apiType: string } {
	return {
		name: `${camel(surface)}Adapters`,
		exportName: `${camel(surface)}AdaptersSystem`,
		apiType: `${providerPascalCase(surface)}AdaptersApi`,
	};
}

/** The integration set under pattern-stack wiring: what is emitted, and what the composition composes. Pure. */
export function planPatternStackIntegrations(input: PatternStackIntegrationsInput): PatternStackIntegrationsPlan {
	const { entitiesBySurface, entityByName, bySurface, defBySlug, skippedSurfaces } = integrationSurfaces(
		input.providers,
		input.entities,
	);
	const systems: PatternStackIntegrationSystem[] = [];
	for (const slug of servingProviders(bySurface)) {
		const n = providerSystemNames(slug);
		systems.push({ name: n.name, exportName: n.exportName, apiType: n.apiType, file: providerSystemFile(input.outputRoot, slug) });
	}
	const runs: PatternStackIntegrationRun[] = [];
	const skippedAssemblies: PatternStackIntegrationsPlan['skippedAssemblies'] = [];
	for (const surface of [...bySurface.keys()].sort()) {
		const a = adaptersSystemNames(surface);
		systems.push({ name: a.name, exportName: a.exportName, apiType: a.apiType, file: adaptersSystemFile(input.outputRoot, surface) });
		const slugs = [...bySurface.get(surface)!].sort();
		for (const entityName of entitiesBySurface.get(surface) ?? []) {
			const def = entityByName.get(entityName);
			const notIntegrated = notIntegratedReason(def, surface, entityName);
			if (notIntegrated) {
				skippedAssemblies.push({ surface, entity: entityName, reason: notIntegrated });
				continue;
			}
			const loc = resolveEntityModuleImports({
				entityName,
				entityPlural: def?.entity.plural ?? `${entityName}s`,
				context: def?.entity.context ?? null,
				surface,
				provider: slugs[0]!,
				backendSrcAbs: input.backendSrcAbs,
				modulesAbs: input.modulesAbs,
				aliases: {},
			});
			const sinksDir = join(input.outputRoot, surface, 'sinks');
			const emitChanges = def?.integration?.sink?.emit_changes === true;
			for (const slug of slugs) {
				runs.push({
					surface,
					entity: entityName,
					provider: slug,
					adaptersSystem: a.name,
					adapterKey: camel(slug),
					sinkFile: join(sinksDir, `${emittedStem(entityName)}.sink.ts`),
					sinkClass: `${loc.entityClass}Sink`,
					repositoryFile: loc.repoFileAbs,
					projectionType: `${loc.entityClass}IntegrationProjection`,
					...(emitChanges
						? {
								emitter: {
									file: join(sinksDir, `${emittedStem(entityName)}.change-emitter.ts`),
									className: changeEmitterClass(loc.entityClass),
								},
							}
						: {}),
				});
			}
		}
	}
	return {
		root: input.outputRoot,
		moduleFile: join(input.outputRoot, 'module.ts'),
		coreImport: subsystemCoreImport(input.mode, 'integration'),
		systems,
		runs,
		skippedSurfaces,
		skippedAssemblies,
	};
}

/**
 * The providers that serve a surface with a package: only those get a system and a factory. A provider whose every
 * surface is skipped (no `codegen-<surface>` yet) has nothing to build its parts for.
 */
function servingProviders(bySurface: Map<string, string[]>): string[] {
	return [...new Set([...bySurface.values()].flat())].sort();
}

function providerSystemFile(root: string, slug: string): string {
	return join(root, 'providers', slug, `${slug}.provider.ts`);
}

function adaptersSystemFile(root: string, surface: string): string {
	return join(root, surface, `${surface}-adapters.system.ts`);
}

/** A relative import specifier from one file to another, without the extension. */
function importFrom(fromFile: string, toFile: string): string {
	const rel = relative(dirname(fromFile), toFile.replace(/\.ts$/, '')).split(sep).join('/');
	return rel.startsWith('.') ? rel : `./${rel}`;
}

function banner(sourceDesc: string): string {
	return (
		`// @generated by @pattern-stack/codegen from ${sourceDesc} — DO NOT EDIT.\n` +
		`// Hand edits are overwritten on re-emit. Regenerate with \`bun run codegen\`.`
	);
}

/** `<slug>.provider.factory.ts`: emit-once, author-owned — where the provider's auth strategy and client are built. */
export function generateProviderFactory(def: ActiveProviderDefinition): string {
	const n = providerSystemNames(def.slug);
	const strategy = parseImportRef(def.auth.strategy);
	const clientless = isClientlessProvider(def.surfaces);
	const client = clientless ? null : parseImportRef(def.client.class);
	return `// <CODEGEN-SCAFFOLD-V1>
// Scaffolded once by @pattern-stack/codegen, then author-owned. Re-running
// codegen detects the sentinel above and SKIPS this file — your edits are safe.
// Source: definitions/providers/${def.slug}.yaml.
import { ${strategy.exportName} } from '${strategy.path}';
${client ? `import { ${client.exportName} } from '${client.path}';\n` : ''}
/**
 * What the \`${n.name}\` system holds: ${client ? "the provider's auth strategy and API client." : "the provider's auth strategy. A per-connection provider\n * (RFC-0003 R5) has no client: each adapter builds one per connection."}
 * The adapters type theirs from this, so whatever these classes are, the adapters take them as they are.
 */
export interface ${n.apiType} {
  auth: ${strategy.exportName};
${client ? `  client: ${client.exportName};\n` : ''}}

/** Build them here: pass a constructor whatever config it needs (a base URL, a credential reader). */
export function ${n.factory}(): ${n.apiType} {
  return {
    auth: new ${strategy.exportName}(),
${client ? `    client: new ${client.exportName}(),\n` : ''}  };
}
`;
}

/** `<slug>.provider.ts`: the provider as a system, built by the author's factory. */
export function generateProviderSystem(def: ActiveProviderDefinition, file: string, wiringFile: string): string {
	const n = providerSystemNames(def.slug);
	return `${banner(`definitions/providers/${def.slug}.yaml`)}
/**
 * The \`${def.slug}\` provider (surfaces: ${def.surfaces.join(', ')}) as a \`@pattern-stack/wiring\` system: its parts
 * come from \`${n.factory}\` (\`${def.slug}.provider.factory.ts\`, yours).
 */
import { ${n.factory}, type ${n.apiType} } from './${def.slug}.provider.factory';
import { defineSystem } from '${importFrom(file, wiringFile)}';

export type { ${n.apiType} };

export const ${n.exportName} = defineSystem({
  name: '${n.name}',
  uses: [],
  create: (): ${n.apiType} => ${n.factory}(),
});
`;
}

/** `<surface>-adapters.system.ts`: each provider's adapter for the surface, and their change sources folded. */
export function generateAdaptersSystem(
	surface: string,
	slugs: string[],
	defBySlug: Map<string, ActiveProviderDefinition>,
	file: string,
	wiringFile: string,
	coreImport: string,
	entities: readonly string[],
): string {
	const a = adaptersSystemNames(surface);
	const sorted = [...slugs].sort();
	const adapter = (slug: string) => `${providerPascalCase(slug)}${providerPascalCase(surface)}Adapter`;
	const args = (slug: string) => {
		const p = providerSystemNames(slug).name;
		return adapterTakesClient(defBySlug.get(slug)!, surface, entities) ? `${p}.auth, ${p}.client` : `${p}.auth`;
	};
	return `${banner(`surface: ${surface}`)}
/**
 * The \`${surface}\` surface's adapters as a \`@pattern-stack/wiring\` system: each provider's adapter, built from that
 * provider's system. \`sources()\` folds their change sources into one entity-keyed registry when called (two
 * providers serving one entity is an ambiguous-source error then, not at boot).
 */
import {
  MemoryEntityChangeSourceRegistry,
  type IChangeSource,
  type IEntityChangeSourceRegistry,
} from '${coreImport}';
import { defineSystem } from '${importFrom(file, wiringFile)}';
${sorted.map((slug) => `import { ${adapter(slug)} } from './adapters/${slug}/${slug}-${surface}.adapter';`).join('\n')}

/** One provider-adapter's contribution to the registry. */
interface AdapterContribution {
  provider: string;
  sources: globalThis.Record<string, IChangeSource<unknown>>;
}

${entitySourcesFold(`fold${providerPascalCase(surface)}EntitySources`, 'AdapterContribution', { globalThis: true })}
export interface ${a.apiType} {
  /** Each provider's adapter, by provider. */
  adapters: {
${sorted.map((slug) => `    ${camel(slug)}: ${adapter(slug)};`).join('\n')}
  };
  /** Every adapter's change sources, entity-keyed. */
  sources(): IEntityChangeSourceRegistry;
}

export const ${a.exportName} = defineSystem({
  name: '${a.name}',
  uses: [${sorted.map((slug) => `'${providerSystemNames(slug).name}'`).join(', ')}],
  create: ({ ${sorted.map((slug) => providerSystemNames(slug).name).join(', ')} }): ${a.apiType} => {
    const adapters = {
${sorted.map((slug) => `      ${camel(slug)}: new ${adapter(slug)}(${args(slug)}),`).join('\n')}
    };
    return {
      adapters,
      sources: () =>
        fold${providerPascalCase(surface)}EntitySources([
${sorted.map((slug) => `          { provider: '${slug}', sources: adapters.${camel(slug)}.changeSources },`).join('\n')}
        ]),
    };
  },
});
`;
}

export interface EmitPatternStackIntegrationsOptions extends PatternStackIntegrationsInput {
	/** Absolute `<generated>/wiring.ts`, which every manifest imports `defineSystem` from. */
	wiringFile: string;
	/** tsconfig path aliases, for the sinks' repository import (as under Nest). */
	aliases?: Record<string, string>;
	tenancyColumn: string;
	dryRun?: boolean;
}

export interface EmitPatternStackIntegrationsResult {
	plan: PatternStackIntegrationsPlan;
	/** @generated files written. */
	written: string[];
	/** Emit-once scaffolds written this run, and those left (author-owned). */
	scaffoldsWritten: string[];
	scaffoldsSkipped: string[];
}

/** Write the pattern-stack integration files. The `integrations` module is the composition's. */
export function emitPatternStackIntegrations(opts: EmitPatternStackIntegrationsOptions): EmitPatternStackIntegrationsResult {
	const plan = planPatternStackIntegrations(opts);
	const { entitiesBySurface, entityByName, bySurface, defBySlug } = integrationSurfaces(opts.providers, opts.entities);
	const result: EmitPatternStackIntegrationsResult = { plan, written: [], scaffoldsWritten: [], scaffoldsSkipped: [] };
	const generated = (file: string, content: string) => {
		if (!opts.dryRun) writeIfChanged(file, content);
		result.written.push(file);
	};
	const scaffold = (file: string, content: () => string) => {
		if (existsSync(file)) {
			result.scaffoldsSkipped.push(file);
			return;
		}
		if (!opts.dryRun) write(file, content());
		result.scaffoldsWritten.push(file);
	};
	const root = opts.outputRoot;

	for (const slug of servingProviders(bySurface)) {
		const def = defBySlug.get(slug)!;
		scaffold(join(root, 'providers', slug, `${slug}.provider.factory.ts`), () => generateProviderFactory(def));
		const file = providerSystemFile(root, slug);
		generated(file, generateProviderSystem(def, file, opts.wiringFile));
	}

	for (const surface of [...bySurface.keys()].sort()) {
		const slugs = bySurface.get(surface)!;
		const surfaceEntities = entitiesBySurface.get(surface) ?? [];
		for (const slug of slugs) {
			const entityDetection = new Map<string, DetectionConfig>();
			for (const name of surfaceEntities) {
				const det = entityByName.get(name)?.entity.detection?.[slug];
				if (det) entityDetection.set(name, det);
			}
			scaffold(join(root, surface, 'adapters', slug, `${slug}-${surface}.adapter.ts`), () =>
				generateAdapterScaffold(defBySlug.get(slug)!, surface, surfaceEntities, entityDetection, opts.mode, 'pattern-stack'),
			);
		}
		const systemFile = adaptersSystemFile(root, surface);
		generated(
			systemFile,
			generateAdaptersSystem(surface, slugs, defBySlug, systemFile, opts.wiringFile, plan.coreImport, surfaceEntities),
		);
		generated(join(root, surface, 'types.generated.ts'), generateTypedView(surface, slugs, surfaceEntities));

		const sinksDir = join(root, surface, 'sinks');
		for (const entityName of surfaceEntities) {
			const def = entityByName.get(entityName);
			if (!def || notIntegratedReason(def, surface, entityName)) continue;
			const loc = resolveEntityModuleImports({
				entityName,
				entityPlural: def.entity.plural ?? `${entityName}s`,
				context: def.entity.context ?? null,
				surface,
				provider: slugs[0]!,
				backendSrcAbs: opts.backendSrcAbs,
				modulesAbs: opts.modulesAbs,
				aliases: opts.aliases ?? {},
			});
			const sinkInput = buildSinkInput(
				def,
				surface,
				slugs[0]!,
				toImportSpecifier(loc.repoFileAbs, sinksDir, opts.aliases ?? {}),
				opts.tenancyColumn,
			);
			const sink = { ...sinkInput, mode: opts.mode, wiring: 'pattern-stack' as const };
			generated(join(sinksDir, `${emittedStem(entityName)}.sink.generated.ts`), generateSinkBase(sink));
			scaffold(join(sinksDir, `${emittedStem(entityName)}.sink.ts`), () => generateSinkSubclass(sink));
			if (def.integration?.sink?.emit_changes === true) {
				generated(
					join(sinksDir, `${emittedStem(entityName)}.change-emitter.ts`),
					generateChangeEmitter({
						entityName,
						entityClass: loc.entityClass,
						surface,
						sourceDesc: `definitions entity '${entityName}' (integration.sink.emit_changes)`,
						mode: opts.mode,
						wiring: 'pattern-stack',
					}),
				);
			}
		}
	}
	return result;
}

function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	generating(file, () => writeFileSync(file, content));
}

function writeIfChanged(file: string, content: string): void {
	if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
	write(file, content);
}
