/**
 * The API-surface parity comparator (PLAN §7.1) — pure: it takes what generated files declare (already parsed)
 * and the derived surface, and returns one message per disagreement. Set equality in both directions, over
 * repository and service methods, use cases and routes; every `emitted: false` method must exist somewhere on
 * its class's base chain.
 *
 * The messages are part of the spec (PLAN §7.1, §14.2 M1–M5). `_parity-compare.test.ts` pins each one.
 */

import type { EntityApiSurface } from '../../derived/api/types';

/** A class a generated file declares — only what parity reads from it. */
export interface ParsedClass {
	name: string;
	exported: boolean;
	/** Public instance methods declared in the class body (no constructor, no private / protected). */
	methods: string[];
	/** `@Controller('<prefix>')`, when the class has one. */
	controllerPrefix?: string;
	/** Each `@Get` / `@Post` / `@Patch` / `@Delete` handler: its verb and its sub-path ('' for none). */
	routes?: { verb: string; subPath: string }[];
}

/** A generated file: `classes` is `null` when the file does not exist. */
export interface ClassSource {
	file: string;
	classes: ParsedClass[] | null;
}

/** One link of a base chain: a runtime class or capability mixin and the public methods it declares. */
export interface ChainLink {
	name: string;
	methods: ReadonlySet<string>;
}

/** Everything parity reads for one entity. */
export interface GeneratedEntity {
	repository: ClassSource;
	service: ClassSource;
	/** The entity's controller files, by the controller class each is expected to declare. */
	controllers: (ClassSource & { className: string })[];
	/** The `use-cases/` folder: every file in it (an absent folder is an empty list). */
	useCases: { dir: string; files: ClassSource[] };
	/** The base chains `emitted: false` methods are looked up on, outermost first. */
	baseChains: { repository: ChainLink[]; service: ChainLink[] };
}

const P = 'api-surface parity:';

export const parityMessage = {
	methodNotDerived: (cls: string, method: string) =>
		`${P} ${cls} declares \`${method}\`, which the derived API surface does not list`,
	methodNotGenerated: (cls: string, method: string, file: string) =>
		`${P} the derived API surface lists \`${cls}.${method}\`, which ${file} does not declare`,
	routeNotDerived: (controller: string, route: string) =>
		`${P} ${controller} declares route \`${route}\`, which the derived API surface does not list`,
	routeNotGenerated: (route: string, file: string) =>
		`${P} the derived API surface lists route \`${route}\`, which ${file} does not declare`,
	inheritedMissing: (cls: string, method: string, chain: readonly string[]) =>
		`${P} ${cls} lists \`${method}\` as inherited, but no class in its base chain (${chain.join(' → ')}) declares it`,
	absent: (entity: string, file: string) => `${P} no generated file for \`${entity}\` at ${file}`,
	emptyParse: (file: string) => `${P} ${file} parsed to 0 classes`,
	useCaseNotDerived: (cls: string, file: string) =>
		`${P} ${file} declares use case \`${cls}\`, which the derived API surface does not list`,
	useCaseNotGenerated: (cls: string, dir: string) =>
		`${P} the derived API surface lists use case \`${cls}\`, which ${dir} does not declare`,
	httpOffButEmitted: (entity: string, file: string) =>
		`${P} the derived API surface has HTTP off for \`${entity}\`, but ${file} exists`,
} as const;

/** `GET /contacts/:id` — the controller prefix plus the handler's sub-path. */
export function routeKey(verb: string, prefix: string, subPath: string): string {
	return `${verb.toUpperCase()} /${prefix}${subPath ? `/${subPath}` : ''}`;
}

/** The classes of a source, or the messages saying why there are none to read. */
function readable(entity: string, source: ClassSource, errors: string[]): ParsedClass[] | null {
	if (source.classes === null) {
		errors.push(parityMessage.absent(entity, source.file));
		return null;
	}
	if (source.classes.length === 0) {
		errors.push(parityMessage.emptyParse(source.file));
		return null;
	}
	return source.classes;
}

function compareClass(
	entity: string,
	layer: { className: string; methods: { name: string; emitted: boolean }[] },
	source: ClassSource,
	chain: ChainLink[],
	errors: string[],
): void {
	const classes = readable(entity, source, errors);
	if (classes) {
		const cls = classes.find((c) => c.name === layer.className);
		const generated = new Set(cls?.methods ?? []);
		const derived = new Set(layer.methods.filter((m) => m.emitted).map((m) => m.name));
		for (const m of generated) if (!derived.has(m)) errors.push(parityMessage.methodNotDerived(layer.className, m));
		for (const m of derived) if (!generated.has(m)) errors.push(parityMessage.methodNotGenerated(layer.className, m, source.file));
	}
	for (const m of layer.methods) {
		if (m.emitted) continue;
		if (!chain.some((link) => link.methods.has(m.name))) {
			errors.push(parityMessage.inheritedMissing(layer.className, m.name, chain.map((l) => l.name)));
		}
	}
}

/** Every disagreement between one entity's generated files and its derived surface; `[]` when they agree. */
export function compareEntity(surface: EntityApiSurface, generated: GeneratedEntity): string[] {
	const errors: string[] = [];
	const entity = surface.entity;

	compareClass(entity, surface.repository, generated.repository, generated.baseChains.repository, errors);
	compareClass(entity, surface.service, generated.service, generated.baseChains.service, errors);

	// ── Use cases ──
	const useCaseFiles = generated.useCases.files;
	if (useCaseFiles.length === 0) {
		errors.push(parityMessage.absent(entity, generated.useCases.dir));
	} else {
		const derived = new Set(surface.useCases.map((u) => u.className));
		const seen = new Set<string>();
		for (const source of useCaseFiles) {
			const classes = readable(entity, source, errors) ?? [];
			for (const cls of classes) {
				if (!cls.exported) continue;
				seen.add(cls.name);
				if (!derived.has(cls.name)) errors.push(parityMessage.useCaseNotDerived(cls.name, source.file));
			}
		}
		for (const cls of derived) if (!seen.has(cls)) errors.push(parityMessage.useCaseNotGenerated(cls, generated.useCases.dir));
	}

	// ── Routes ──
	if (!surface.http.enabled) {
		for (const source of generated.controllers) {
			if (source.classes !== null) errors.push(parityMessage.httpOffButEmitted(entity, source.file));
		}
		return errors;
	}
	const fileOf = new Map(generated.controllers.map((c) => [c.className, c.file]));
	const expectedControllers = new Set(surface.http.routes.map((r) => r.controller));
	const generatedRoutes = new Map<string, string>(); // route → controller class
	for (const source of generated.controllers) {
		if (source.classes === null && !expectedControllers.has(source.className)) continue;
		for (const cls of readable(entity, source, errors) ?? []) {
			if (cls.controllerPrefix === undefined) continue;
			for (const r of cls.routes ?? []) generatedRoutes.set(routeKey(r.verb, cls.controllerPrefix, r.subPath), cls.name);
		}
	}
	const derivedRoutes = new Map(surface.http.routes.map((r) => [`${r.verb} ${r.path}`, r.controller]));
	for (const [route, controller] of generatedRoutes) {
		if (!derivedRoutes.has(route)) errors.push(parityMessage.routeNotDerived(controller, route));
	}
	for (const [route, controller] of derivedRoutes) {
		if (!generatedRoutes.has(route)) {
			errors.push(parityMessage.routeNotGenerated(route, fileOf.get(controller) ?? `<no file for ${controller}>`));
		}
	}
	return errors;
}
