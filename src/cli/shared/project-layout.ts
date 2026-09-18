/**
 * The project's directory layout, from the resolved `paths` block — the ONE
 * place the CLI and every scaffold turn `paths.*` into filesystem locations
 * and emitted import specifiers (PATH-0, #642 / #566 / #612).
 *
 * Every `paths.*` default is declared once, in `PathsConfigSchema`
 * (`src/schema/codegen-config.schema.ts`); with no config file the schema's
 * defaults apply (`DEFAULT_CODEGEN_CONFIG`). Directories that have no key of
 * their own (the vendored `shared/` root, `app.module.ts`, `main.ts`, …) derive
 * from `backend_src` here and nowhere else.
 *
 * `entitiesDirPath(cwd, paths)` (`src/config/entities-dir.ts`) and
 * `projectLayout(cwd, config).entities` are two spellings of one value —
 * `path.resolve(cwd, paths.entities)`. The first exists because the hygen
 * templates import it from the shipped `src/config/` files, and this module
 * (under `src/cli/`, compiled into `dist/`) is not shipped as source.
 */

import path from 'node:path';

import { ResolvedPathsSchema, type PathsConfigInput } from '../../schema/codegen-config.schema.js';

export interface ProjectLayout {
	/** Project root (absolute) — every `paths.*` value resolves against it. */
	root: string;
	/** `paths.backend_src`. */
	backendSrc: string;
	/** `paths.frontend_src`. */
	frontendSrc: string;
	/** `paths.entities` — entity YAML. */
	entities: string;
	/** `paths.events_dir` — top-level event YAML. */
	eventsDir: string;
	/** `paths.jobs_dir` — job definition YAML (RFC-0005). */
	jobsDir: string;
	/** `paths.providers` — integration provider YAML (RFC-0001). */
	providers: string;
	/** `paths.generated` — codegen-owned cross-entity barrels. */
	generated: string;
	/** `paths.modules_dir` — the clean-lite-ps entity module tree (target of
	 *  `@modules/*`) and the `auth-integrations` vendor root. */
	modules: string;
	/** `paths.orchestration_src` — orchestration emission root. */
	orchestration: string;
	/** `<backend_src>/shared` — the vendored runtime root, target of `@shared/*`. */
	shared: string;
	/** `<backend_src>/shared/subsystems` — the subsystem runtime root. No key of
	 *  its own: `@shared/subsystems/<name>` is the only import that reaches it
	 *  (PATH-1, #645). */
	subsystems: string;
	/** `<backend_src>/shared/database/database.module.ts`. */
	databaseModule: string;
	/** `<backend_src>/app.module.ts`. */
	appModule: string;
	/** `<backend_src>/main.ts`. */
	mainTs: string;
	/** `<backend_src>/worker.ts` — the standalone jobs worker (#513). */
	workerTs: string;
	/** `<backend_src>/schema.ts` — the Drizzle schema root. */
	rootSchema: string;
	/** `<backend_src>/jobs` — scanned for `@JobHandler` bridge handlers. */
	jobHandlers: string;
}

/**
 * Absolute locations for the project rooted at `cwd`. The `paths` block goes
 * through `ResolvedPathsSchema` here — idempotent on the loader's parsed config,
 * and the same defaults for a `null` config (no file) or a partial one — so it
 * takes the schema's input type: the loader's parsed config is one instance.
 */
export function projectLayout(
	cwd: string,
	config: { paths?: PathsConfigInput } | null | undefined,
): ProjectLayout {
	const paths = ResolvedPathsSchema.parse(config?.paths ?? {});
	const at = (rel: string) => path.resolve(cwd, rel);
	const backendSrc = at(paths.backend_src);
	const shared = path.join(backendSrc, 'shared');
	return {
		root: path.resolve(cwd),
		backendSrc,
		frontendSrc: at(paths.frontend_src),
		entities: at(paths.entities),
		eventsDir: at(paths.events_dir),
		jobsDir: at(paths.jobs_dir),
		providers: at(paths.providers),
		generated: at(paths.generated),
		modules: at(paths.modules_dir),
		orchestration: at(paths.orchestration_src),
		shared,
		subsystems: path.join(shared, 'subsystems'),
		databaseModule: path.join(shared, 'database', 'database.module.ts'),
		appModule: path.join(backendSrc, 'app.module.ts'),
		mainTs: path.join(backendSrc, 'main.ts'),
		workerTs: path.join(backendSrc, 'worker.ts'),
		rootSchema: path.join(backendSrc, 'schema.ts'),
		jobHandlers: path.join(backendSrc, 'jobs'),
	};
}

/** POSIX-separated relative path, `./`-prefixed unless it already climbs. */
function relativeSpecifier(fromDir: string, to: string): string {
	const rel = path.relative(fromDir, to).split(path.sep).join('/');
	if (rel === '') return '.';
	return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * The import specifier an emitted file at `fromFile` uses to reach the module
 * at `toModule` (absolute; a `.ts` extension is dropped). Relative to the
 * emitted file's own directory, so it holds for any `paths.*` layout.
 */
export function importSpecifier(fromFile: string, toModule: string): string {
	return relativeSpecifier(path.dirname(fromFile), toModule.replace(/\.ts$/, ''));
}

/**
 * The `compilerOptions.paths` aliases the generated code imports through
 * (`@shared/*` in vendored mode, `@modules/*`, `@generated/*`), relative to the
 * tsconfig at `tsconfigDir`.
 */
export function tsconfigAliases(layout: ProjectLayout, tsconfigDir: string = layout.root): Record<string, string[]> {
	const glob = (dir: string) => [`${relativeSpecifier(tsconfigDir, dir)}/*`];
	return {
		'@shared/*': glob(layout.shared),
		'@modules/*': glob(layout.modules),
		'@generated/*': glob(layout.generated),
	};
}

/**
 * The tsconfig `include` globs for the generated backend: `<backend_src>`, plus
 * `<generated>` and `<modules_dir>` when they lie outside it.
 */
export function tsconfigIncludes(layout: ProjectLayout, tsconfigDir: string = layout.root): string[] {
	const glob = (dir: string) => `${path.relative(tsconfigDir, dir).split(path.sep).join('/') || '.'}/**/*`;
	const includes = [glob(layout.backendSrc)];
	for (const dir of [layout.generated, layout.modules]) {
		const rel = path.relative(layout.backendSrc, dir);
		if (rel.startsWith('..') || path.isAbsolute(rel)) includes.push(glob(dir));
	}
	return includes;
}
