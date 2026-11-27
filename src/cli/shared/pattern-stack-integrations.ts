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

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SCAFFOLD_SENTINEL, writeGeneratedFile, writeGeneratedFileIfChanged } from '../../utils/generated-file';
import { relativeImport } from '../../utils/import-path.js';
import { parseImportRef, type ActiveProviderDefinition } from '../../schema/provider-definition.schema';
import type { LoadedProvider } from '../../parser/validate-providers';
import type { DetectionConfig } from '../../../runtime/subsystems/integration';
import type { CompositionIntegrationsInput } from '../../emitters/composition/emit-composition.js';
import {
	adapterClassName,
	adapterDetection,
	adapterTakesClient,
	buildSinkInput,
	entitySourcesFold,
	generateAdapterScaffold,
	generatedBanner,
	generateTypedView,
	integrationSurfaces,
	isClientlessProvider,
	notIntegratedReason,
	providerApiType,
	type EmitAdaptersEntity,
} from './adapter-emission-generator';
import {
	adapterScaffoldFile,
	adaptersSystemFile,
	integrationsModuleFile,
	providerFactoryFile,
	providerSystemFile,
	sinkFiles,
	typedViewFile,
} from '../../config/integration-layout.js';
import { resolveEntityModuleImports, toImportSpecifier, type EntityModuleLocation } from './assembly-emission-generator';
import { changeEmitterClass, generateChangeEmitter } from './change-emitter-emission-generator';
import { providerPascalCase } from './provider-module-generator';
import { generateSinkBase, generateSinkSubclass } from './sink-emission-generator';
import { subsystemCoreImport, type RuntimeMode } from './runtime-import';
import { PROVIDER_BASE_URL_KEY, providerSettings, providerSettingsGroup, type ProjectSetting } from '../../derived/settings/index.js';
import { SETTINGS_FILE } from '../../emitters/settings/emit-settings.js';

/** A system the composition lists in `SYSTEMS` and `SystemApis`: the composition's own type. */
export type PatternStackIntegrationSystem = CompositionIntegrationsInput['systems'][number];

/** One `IntegrationRunner` the `integrations` module builds: the composition's own type. */
export type PatternStackIntegrationRun = CompositionIntegrationsInput['runs'][number];

/** A provider the plan emits: its author-owned factory and its system. */
export interface PatternStackProviderPlan {
	slug: string;
	def: ActiveProviderDefinition;
	factoryFile: string;
	systemFile: string;
}

/** An Integrated entity's sink on a surface: where its files go, and where its module is. */
export interface PatternStackSinkPlan {
	entity: string;
	def: EmitAdaptersEntity;
	files: ReturnType<typeof sinkFiles>;
	location: EntityModuleLocation;
	emitChanges: boolean;
}

/** A surface the plan emits: each provider's adapter scaffold, the adapters system, the typed view, the sinks. */
export interface PatternStackSurfacePlan {
	surface: string;
	slugs: string[];
	entities: string[];
	systemFile: string;
	typedViewFile: string;
	adapters: Array<{ slug: string; file: string; detection: Map<string, DetectionConfig> }>;
	sinks: PatternStackSinkPlan[];
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
	/** What the emit writes: the plan owns every file's place, and the emit walks it. */
	providers: PatternStackProviderPlan[];
	surfaces: PatternStackSurfacePlan[];
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
	/** tsconfig path aliases, for the sinks' repository import (as under Nest). */
	aliases?: Record<string, string>;
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
		apiType: providerApiType(slug),
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
	const root = input.outputRoot;
	const systems: PatternStackIntegrationSystem[] = [];
	const providers: PatternStackProviderPlan[] = [];
	for (const slug of servingProviders(bySurface)) {
		const n = providerSystemNames(slug);
		const systemFile = providerSystemFile(root, slug);
		systems.push({ name: n.name, exportName: n.exportName, apiType: n.apiType, file: systemFile });
		providers.push({ slug, def: defBySlug.get(slug)!, factoryFile: providerFactoryFile(root, slug), systemFile });
	}
	const runs: PatternStackIntegrationRun[] = [];
	const surfaces: PatternStackSurfacePlan[] = [];
	const skippedAssemblies: PatternStackIntegrationsPlan['skippedAssemblies'] = [];
	for (const surface of [...bySurface.keys()].sort()) {
		const a = adaptersSystemNames(surface);
		const systemFile = adaptersSystemFile(root, surface);
		systems.push({ name: a.name, exportName: a.exportName, apiType: a.apiType, file: systemFile });
		const slugs = [...bySurface.get(surface)!].sort();
		const entities = entitiesBySurface.get(surface) ?? [];
		const sinks: PatternStackSinkPlan[] = [];
		for (const entityName of entities) {
			const def = entityByName.get(entityName);
			const notIntegrated = notIntegratedReason(def, surface, entityName);
			if (notIntegrated || !def) {
				skippedAssemblies.push({ surface, entity: entityName, reason: notIntegrated ?? 'no entity YAML' });
				continue;
			}
			const location = resolveEntityModuleImports({
				entityName,
				entityPlural: def.entity.plural ?? `${entityName}s`,
				context: def.entity.context ?? null,
				surface,
				provider: slugs[0]!,
				backendSrcAbs: input.backendSrcAbs,
				modulesAbs: input.modulesAbs,
				aliases: input.aliases ?? {},
			});
			const sink: PatternStackSinkPlan = {
				entity: entityName,
				def,
				files: sinkFiles(root, surface, entityName),
				location,
				emitChanges: def.integration?.sink?.emit_changes === true,
			};
			sinks.push(sink);
			for (const slug of slugs) {
				runs.push({
					surface,
					entity: entityName,
					provider: slug,
					adaptersSystem: a.name,
					adapterKey: camel(slug),
					sinkFile: sink.files.sink,
					sinkClass: `${location.entityClass}Sink`,
					repositoryFile: location.repoFileAbs,
					projectionType: `${location.entityClass}IntegrationProjection`,
					...(sink.emitChanges
						? { emitter: { file: sink.files.emitter, className: changeEmitterClass(location.entityClass) } }
						: {}),
				});
			}
		}
		surfaces.push({
			surface,
			slugs,
			entities,
			systemFile,
			typedViewFile: typedViewFile(root, surface),
			adapters: bySurface.get(surface)!.map((slug) => ({
				slug,
				file: adapterScaffoldFile(root, surface, slug),
				detection: adapterDetection(entityByName, entities, slug),
			})),
			sinks,
		});
	}
	return {
		root,
		moduleFile: integrationsModuleFile(root),
		coreImport: subsystemCoreImport(input.mode, 'integration'),
		systems,
		runs,
		providers,
		surfaces,
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

/**
 * `<slug>.provider.factory.ts`: emit-once, author-owned — where the provider's auth strategy and client are built,
 * from the provider's typed settings (SET-1). The calls are not prefilled with arguments (the constructors are the
 * author's); the comment shows them with this provider's keys.
 */
export function generateProviderFactory(
	def: ActiveProviderDefinition,
	settings: readonly ProjectSetting[],
	factoryFile: string,
	settingsFile: string,
	/** S-2: the connection store's module (the vendored starter's `connection-store.ts`), when `connections` is composed. */
	connectionStoreFile: string | null = null,
): string {
	const n = providerSystemNames(def.slug);
	const strategy = parseImportRef(def.auth.strategy);
	const clientless = isClientlessProvider(def.surfaces);
	const client = clientless ? null : parseImportRef(def.client.class);
	const group = providerSettingsGroup(def.slug);
	const keys = settings.map((x) => x.key);
	const authKeys = keys.filter((k) => k !== PROVIDER_BASE_URL_KEY);
	const arg = (list: string[]) => `{ ${list.map((k) => `${k}: settings.${k}`).join(', ')} }`;
	// S-2: a refresh strategy reads and persists the connection's tokens through the store.
	const storeArgs = connectionStoreFile ? ['connectionReader: connections.reader', 'tokenWriter: connections.tokenWriter'] : [];
	const strategyArgs = [...authKeys.map((k) => `${k}: settings.${k}`), ...storeArgs];
	const examples = [
		...(strategyArgs.length > 0 ? [`//   new ${strategy.exportName}({ ${strategyArgs.join(', ')} })`] : []),
		...(client && keys.includes(PROVIDER_BASE_URL_KEY) ? [`//   new ${client.exportName}(${arg([PROVIDER_BASE_URL_KEY])})`] : []),
	];
	return `${SCAFFOLD_SENTINEL}
// Scaffolded once by @pattern-stack/codegen, then author-owned. Re-running
// codegen detects the sentinel above and SKIPS this file — your edits are safe.
// Source: definitions/providers/${def.slug}.yaml.
import { ${strategy.exportName} } from '${strategy.path}';
${client ? `import { ${client.exportName} } from '${client.path}';\n` : ''}import type { Settings } from '${relativeImport(factoryFile, settingsFile)}';
${connectionStoreFile ? `import type { ConnectionStore } from '${relativeImport(factoryFile, connectionStoreFile)}';\n` : ''}
/**
 * What the \`${n.name}\` system holds: ${client ? "the provider's auth strategy and API client." : "the provider's auth strategy. A per-connection provider\n * (RFC-0003 R5) has no client: each adapter builds one per connection."}
 * The adapters type theirs from this, so whatever these classes are, the adapters take them as they are.
 */
export interface ${n.apiType} {
  auth: ${strategy.exportName};
${client ? `  client: ${client.exportName};\n` : ''}}

/**
 * Build them here, from the provider's settings: ${keys.length > 0 ? keys.map((k) => `\`${k}\``).join(', ') : 'none'} (declared in its YAML;
 * \`codegen project settings\` lists them)${connectionStoreFile ? ', and the connection store (`connections`: the reader and token writer a\n * refresh strategy takes)' : ''}. Pass each constructor what it takes${examples.length > 0 ? ', e.g.' : '.'}
${examples.map((e) => ` * ${e.slice(3)}`).join('\n')}${examples.length > 0 ? '\n' : ''} */
export function ${n.factory}(settings: Settings['${group}']${connectionStoreFile ? ', connections: ConnectionStore' : ''}): ${n.apiType} {
  void settings;
${connectionStoreFile ? '  void connections;\n' : ''}  return {
    auth: new ${strategy.exportName}(),
${client ? `    client: new ${client.exportName}(),\n` : ''}  };
}
`;
}

/** `<slug>.provider.ts`: the provider as a system, built by the author's factory from its settings. */
export function generateProviderSystem(
	def: ActiveProviderDefinition,
	file: string,
	wiringFile: string,
	/** S-2: the `connections` system is composed, so the factory takes the store too. */
	connections = false,
): string {
	const n = providerSystemNames(def.slug);
	const group = providerSettingsGroup(def.slug);
	return `${generatedBanner(`definitions/providers/${def.slug}.yaml`)}
/**
 * The \`${def.slug}\` provider (surfaces: ${def.surfaces.join(', ')}) as a \`@pattern-stack/wiring\` system: its parts
 * come from \`${n.factory}\` (\`${def.slug}.provider.factory.ts\`, yours), given its settings (\`settings.${group}\`)${connections ? '\n * and the connection store (the `connections` system, S-2)' : ''}.
 */
import { ${n.factory}, type ${n.apiType} } from '${relativeImport(providerSystemFile('/', def.slug), providerFactoryFile('/', def.slug))}';
import { defineSystem } from '${relativeImport(file, wiringFile)}';

export type { ${n.apiType} };

export const ${n.exportName} = defineSystem({
  name: '${n.name}',
  uses: [${connections ? "'settings', 'connections'" : "'settings'"}],
  create: (${connections ? '{ settings, connections }' : '{ settings }'}): ${n.apiType} => ${n.factory}(settings.${group}${connections ? ', connections' : ''}),
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
	root: string,
): string {
	const a = adaptersSystemNames(surface);
	const sorted = [...slugs].sort();
	const adapter = (slug: string) => adapterClassName(slug, surface);
	// The client whenever the provider has one: the scaffold's constructor (emit-once) takes the same, whatever the entities.
	const args = (slug: string) => {
		const p = providerSystemNames(slug).name;
		return adapterTakesClient(defBySlug.get(slug)!) ? `${p}.auth, ${p}.client` : `${p}.auth`;
	};
	return `${generatedBanner(`surface: ${surface}`)}
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
import { defineSystem } from '${relativeImport(file, wiringFile)}';
${sorted.map((slug) => `import { ${adapter(slug)} } from '${relativeImport(file, adapterScaffoldFile(root, surface, slug))}';`).join('\n')}

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
	tenancyColumn: string;
	/**
	 * S-2: the `connections` system is composed (the auth-integrations starter, under pattern-stack): absolute path of
	 * the vendored `connection-store.ts`. Each provider's factory then takes the store as its second argument.
	 */
	connectionStoreFile?: string | null;
	dryRun?: boolean;
}

/**
 * A provider factory whose parameters don't match what its system passes, `(settings)` or, with `connections` composed,
 * `(settings, connections)`: the parameters it lacks (SET-1's settings, S-2's store), or how many it has too many (the
 * starter was removed after the factory took the store).
 */
export interface FactoryBehind {
	file: string;
	missing: Array<'settings' | 'connections'>;
	extra: number;
}

/** The text between a factory's parentheses (balanced, so a typed parameter's own parentheses stay in), or null. */
export function factoryParameters(source: string, factory: string): string | null {
	const start = source.search(new RegExp(`export function ${factory}\\(`));
	if (start === -1) return null;
	let depth = 0;
	for (let i = source.indexOf('(', start); i < source.length; i++) {
		if (source[i] === '(') depth++;
		else if (source[i] === ')' && --depth === 0) return source.slice(source.indexOf('(', start) + 1, i);
	}
	return null;
}

/** A parameter list's top-level parameters (a comma inside `<…>`, `(…)`, `{…}` or `[…]` doesn't split). */
export function countParameters(params: string): number {
	let depth = 0;
	let count = 0;
	let any = false;
	for (const ch of params) {
		if ('<({['.includes(ch)) depth++;
		else if ('>)}]'.includes(ch)) depth--;
		else if (ch === ',' && depth === 0) {
			if (any) count++;
			any = false;
			continue;
		}
		if (!/\s/.test(ch)) any = true;
	}
	return count + (any ? 1 : 0);
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
	const result: EmitPatternStackIntegrationsResult = { plan, written: [], scaffoldsWritten: [], scaffoldsSkipped: [] };
	const generated = (file: string, content: string) => {
		if (!opts.dryRun) writeGeneratedFileIfChanged(file, content);
		result.written.push(file);
	};
	const scaffold = (file: string, content: () => string) => {
		if (existsSync(file)) {
			result.scaffoldsSkipped.push(file);
			return;
		}
		if (!opts.dryRun) writeGeneratedFile(file, content());
		result.scaffoldsWritten.push(file);
	};
	const defBySlug = new Map(plan.providers.map((p) => [p.slug, p.def]));

	for (const p of plan.providers) {
		const own = providerSettings({ definition: p.def, filePath: '' });
		const store = opts.connectionStoreFile ?? null;
		scaffold(p.factoryFile, () => generateProviderFactory(p.def, own, p.factoryFile, join(dirname(opts.wiringFile), SETTINGS_FILE), store));
		generated(p.systemFile, generateProviderSystem(p.def, p.systemFile, opts.wiringFile, store !== null));
	}

	for (const s of plan.surfaces) {
		for (const a of s.adapters) {
			scaffold(a.file, () => generateAdapterScaffold(defBySlug.get(a.slug)!, s.surface, s.entities, a.detection, opts.mode, 'pattern-stack'));
		}
		generated(
			s.systemFile,
			generateAdaptersSystem(s.surface, s.slugs, defBySlug, s.systemFile, opts.wiringFile, plan.coreImport, plan.root),
		);
		generated(s.typedViewFile, generateTypedView(s.surface, s.slugs, s.entities));

		for (const k of s.sinks) {
			const sinkInput = buildSinkInput(
				k.def,
				s.surface,
				s.slugs[0]!,
				toImportSpecifier(k.location.repoFileAbs, k.files.dir, opts.aliases ?? {}),
				opts.tenancyColumn,
			);
			const sink = { ...sinkInput, mode: opts.mode, wiring: 'pattern-stack' as const };
			generated(k.files.base, generateSinkBase(sink));
			scaffold(k.files.sink, () => generateSinkSubclass(sink));
			if (k.emitChanges) {
				generated(
					k.files.emitter,
					generateChangeEmitter({
						entityName: k.entity,
						entityClass: k.location.entityClass,
						surface: s.surface,
						sourceDesc: `definitions entity '${k.entity}' (integration.sink.emit_changes)`,
						mode: opts.mode,
						wiring: 'pattern-stack',
					}),
				);
			}
		}
	}
	return result;
}
