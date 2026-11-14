/**
 * Reads generated output for the parity gate: parses TypeScript with `ts-morph` (syntax only — no type check, no
 * import resolution) into the plain shapes `_parity-compare.ts` compares, and locates an entity's files.
 *
 * File locations come from the generator's own naming owners — `entityModuleNaming` for the module folder and
 * repository file, `emittedStem` for the rest — exactly as `entity-locals.js` builds its `outputPaths`, so the
 * gate looks where the generator writes (#726 shape (b)).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Node, Project, Scope, type ClassDeclaration, type ClassExpression, type SourceFile } from 'ts-morph';

import { entityModuleNaming } from '../../../templates/_shared/entity-naming.mjs';
import { emittedStem } from '../../config/file-naming';
import type { EntityBlockInput, PatternCompositionInput } from '../../derived/api/entity';
import type { ChainLink, ClassSource, GeneratedEntity, ParsedClass } from './_parity-compare';
import { REPO_ROOT } from './_inputs';

const project = new Project({
	useInMemoryFileSystem: true,
	skipAddingFilesFromTsConfig: true,
	skipFileDependencyResolution: true,
	compilerOptions: { noResolve: true },
});

let parseCount = 0;
function sourceFile(text: string): SourceFile {
	return project.createSourceFile(`/parse-${parseCount++}.ts`, text, { overwrite: true });
}

const ROUTE_DECORATORS: Record<string, string> = { Get: 'GET', Post: 'POST', Patch: 'PATCH', Delete: 'DELETE' };

function firstStringArg(args: Node[]): string {
	const arg = args[0];
	return arg && Node.isStringLiteral(arg) ? arg.getLiteralValue() : '';
}

function publicMethods(cls: ClassDeclaration | ClassExpression): string[] {
	return cls
		.getMethods()
		.filter((m) => !m.isStatic() && !m.getName().startsWith('#'))
		.filter((m) => {
			const scope = m.getScope();
			return scope !== Scope.Private && scope !== Scope.Protected;
		})
		.map((m) => m.getName());
}

function parseClass(cls: ClassDeclaration): ParsedClass {
	const parsed: ParsedClass = { name: cls.getName() ?? '', exported: cls.isExported(), methods: publicMethods(cls) };
	const controller = cls.getDecorator('Controller');
	if (controller) {
		parsed.controllerPrefix = firstStringArg(controller.getArguments());
		parsed.routes = [];
		for (const method of cls.getMethods()) {
			for (const decorator of method.getDecorators()) {
				const verb = ROUTE_DECORATORS[decorator.getName()];
				if (verb) parsed.routes.push({ verb, subPath: firstStringArg(decorator.getArguments()) });
			}
		}
	}
	return parsed;
}

/** Every top-level class a TypeScript source declares. */
export function parseClasses(text: string): ParsedClass[] {
	return sourceFile(text).getClasses().map(parseClass);
}

// ---------------------------------------------------------------------------
// Runtime base chains
// ---------------------------------------------------------------------------

interface RuntimeClass {
	extends?: string;
	methods: Set<string>;
}

let runtimeIndex: Map<string, RuntimeClass> | null = null;

/**
 * Every class and capability mixin under `runtime/base-classes/`, by name: a class with what it extends, a mixin
 * (`export function WithX(Base) { … class extends Base { … } }`) with the methods its class declares.
 */
function runtimeClasses(): Map<string, RuntimeClass> {
	if (runtimeIndex) return runtimeIndex;
	const index = new Map<string, RuntimeClass>();
	const dir = join(REPO_ROOT, 'runtime/base-classes');
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
		const sf = sourceFile(readFileSync(join(dir, file), 'utf-8'));
		for (const cls of sf.getClasses()) {
			const name = cls.getName();
			if (!name) continue;
			const ext = cls.getExtends()?.getExpression().getText();
			index.set(name, { ...(ext ? { extends: ext } : {}), methods: new Set(publicMethods(cls)) });
		}
		for (const fn of sf.getFunctions()) {
			const name = fn.getName();
			if (!name) continue;
			const classes = fn.getDescendants().filter((n): n is ClassExpression | ClassDeclaration =>
				Node.isClassExpression(n) || Node.isClassDeclaration(n),
			);
			if (classes.length === 0) continue;
			index.set(name, { methods: new Set(classes.flatMap(publicMethods)) });
		}
	}
	runtimeIndex = index;
	return index;
}

/** `name` and every runtime class it extends, outermost first. */
function classChain(name: string): ChainLink[] {
	const index = runtimeClasses();
	const chain: ChainLink[] = [];
	let current: string | undefined = name;
	while (current && !chain.some((l) => l.name === current)) {
		const cls = index.get(current);
		chain.push({ name: current, methods: cls?.methods ?? new Set() });
		current = cls?.extends;
	}
	return chain;
}

/** The capability mixins (rightmost outermost, ADR-041) and then the spine's class chain. */
export function baseChains(
	composition: PatternCompositionInput & { capabilities: readonly { name: string; mixin?: string }[] },
): GeneratedEntity['baseChains'] {
	const index = runtimeClasses();
	const mixins: ChainLink[] = [...composition.capabilities]
		.reverse()
		.filter((cap) => cap.mixin)
		.map((cap) => ({ name: cap.mixin ?? cap.name, methods: index.get(cap.mixin ?? '')?.methods ?? new Set() }));
	return {
		repository: [...mixins, ...classChain(composition.repositoryBaseClass)],
		service: classChain(composition.serviceBaseClass),
	};
}

// ---------------------------------------------------------------------------
// Locating an entity's files
// ---------------------------------------------------------------------------

/** Where generated files are read from: the checked-in baseline on disk, or an in-memory render. */
export interface GeneratedTree {
	/** The path a message names for `path` (relative to the repo root for files on disk). */
	display(path: string): string;
	read(path: string): string | null;
	list(dir: string): string[];
}

export function diskTree(root: string): GeneratedTree {
	return {
		display: (path) => `${root}/${path}`,
		read: (path) => {
			const full = join(REPO_ROOT, root, path);
			return existsSync(full) ? readFileSync(full, 'utf-8') : null;
		},
		list: (dir) => {
			const full = join(REPO_ROOT, root, dir);
			return existsSync(full) ? readdirSync(full).filter((f) => f.endsWith('.ts')).sort().map((f) => `${dir}/${f}`) : [];
		},
	};
}

export function memoryTree(files: ReadonlyMap<string, string>): GeneratedTree {
	return {
		display: (path) => path,
		read: (path) => files.get(path) ?? null,
		list: (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).sort(),
	};
}

function classSource(tree: GeneratedTree, path: string): ClassSource {
	const text = tree.read(path);
	return { file: tree.display(path), classes: text === null ? null : parseClasses(text) };
}

/** One entity's generated files, read and parsed, plus the base chains of its composition. */
export function readGeneratedEntity(
	tree: GeneratedTree,
	entity: EntityBlockInput,
	modulesDir: string,
	composition: Parameters<typeof baseChains>[0],
	controllerClasses: { controller: string; searchController: string },
): GeneratedEntity {
	const naming = entityModuleNaming(entity, modulesDir);
	const dir = naming.moduleDir;
	const useCasesDir = `${dir}/use-cases`;
	return {
		repository: classSource(tree, naming.repositoryFile),
		service: classSource(tree, `${dir}/${emittedStem(entity.name)}.service.ts`),
		controllers: [
			{ className: controllerClasses.controller, ...classSource(tree, `${dir}/${emittedStem(entity.name)}.controller.ts`) },
			{
				className: controllerClasses.searchController,
				...classSource(tree, `${dir}/${emittedStem(entity.name, 'search')}.controller.ts`),
			},
		],
		useCases: { dir: tree.display(useCasesDir), files: tree.list(useCasesDir).map((p) => classSource(tree, p)) },
		baseChains: baseChains(composition),
	};
}
