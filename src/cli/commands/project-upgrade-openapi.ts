/**
 * `codegen project upgrade-openapi` — surgical codemod that brings an existing
 * consumer's `src/app.module.ts` + `src/main.ts` up to the shape `project
 * init` emits on a fresh project, covering the OPENAPI-4 gap.
 *
 * This is Option A (targeted codemod for the current gap). The generalised
 * additive-install story is tracked in issue #188 for 0.5.0.
 *
 * Behaviour:
 *   1. Resolve project root (`--path` or cwd, walking up for
 *      `codegen.config.yaml` / `package.json`).
 *   2. Vendor the `src/shared/openapi/*` slice of VENDORED_RUNTIME_FILES
 *      (idempotent; `--force` overwrites).
 *   3. Patch `src/app.module.ts`:
 *        - Merge `@nestjs/common` import to include `Global`, `Module`.
 *        - Add `import { OPENAPI_REGISTRY, OpenApiRegistry } from
 *          './shared/openapi'`.
 *        - Insert `@Global() class OpenApiModule {}` above `AppModule` (if
 *          missing).
 *        - Add `OpenApiModule` to `AppModule.imports: [...]`.
 *   4. Patch `src/main.ts` (best-effort):
 *        - If `SwaggerModule.setup` already present → skip.
 *        - Else inject the OPENAPI-4 two-pass Swagger block after
 *          `NestFactory.create(...)`.
 *   5. Report what changed, exit 0 on success, 1 on bail.
 *
 * `--dry-run` prints the diff but writes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';
import { Project, IndentationText, QuoteKind, NewLineKind } from 'ts-morph';

import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';

import {
	ensureImport,
	ensureClassDeclaration,
	ensureModuleImportEntry,
	ensureMainSwaggerBlock,
	type PatchResult,
} from '../shared/ast-patch.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONSUMER_SETUP_POINTER =
	'For manual wiring, see docs/CONSUMER-SETUP.md §OpenAPI or ' +
	'https://github.com/pattern-stack/codegen-patterns/blob/main/docs/CONSUMER-SETUP.md';

/**
 * Subset of VENDORED_RUNTIME_FILES relevant to the OpenAPI slice. Kept as a
 * literal here (rather than imported) so this command is self-contained and
 * the init-scaffold's private list stays private.
 */
const OPENAPI_VENDORED_FILES: Array<{ runtime: string; target: string }> = [
	{ runtime: 'shared/openapi/registry.ts', target: 'src/shared/openapi/registry.ts' },
	{
		runtime: 'shared/openapi/registry.tokens.ts',
		target: 'src/shared/openapi/registry.tokens.ts',
	},
	{ runtime: 'shared/openapi/errors.ts', target: 'src/shared/openapi/errors.ts' },
	{
		runtime: 'shared/openapi/error-response.dto.ts',
		target: 'src/shared/openapi/error-response.dto.ts',
	},
	{ runtime: 'shared/openapi/index.ts', target: 'src/shared/openapi/index.ts' },
];

const OPEN_API_MODULE_SNIPPET = `/**
 * OpenApiModule — @Global() wrapper around the OPENAPI_REGISTRY singleton.
 *
 * OPENAPI-4: every generated entity module @Inject(OPENAPI_REGISTRY) to
 * register its Zod DTOs at onModuleInit (OPENAPI-2). NestJS's DI scoping
 * means providers declared in AppModule are NOT automatically visible
 * inside imported feature modules. Making the provider module @Global()
 * broadcasts the token to every module in the application graph.
 */
@Global()
@Module({
  providers: [{ provide: OPENAPI_REGISTRY, useValue: new OpenApiRegistry() }],
  exports: [OPENAPI_REGISTRY],
})
class OpenApiModule {}
`;

const MAIN_SWAGGER_BLOCK = `  try {
    // OPENAPI-4: build the document in two passes — registry owns component
    // schemas (Zod-derived), Nest's scanner owns the paths map. See
    // docs/CONSUMER-SETUP.md §OpenAPI for details.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const { parse: parseYaml } = await import('yaml');
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');

    const configPath = pathMod.resolve(process.cwd(), 'codegen.config.yaml');
    const cfg: { openapi?: { enabled?: boolean; path?: string; title?: string; version?: string; description?: string; auth?: 'bearer' | 'none'; } } =
      fsMod.existsSync(configPath)
        ? (parseYaml(fsMod.readFileSync(configPath, 'utf-8')) ?? {})
        : {};

    if (cfg.openapi?.enabled) {
      const registry = app.get<OpenApiRegistry>(OPENAPI_REGISTRY);
      const registryDocument = await registry.build({
        title: cfg.openapi.title ?? 'API',
        version: cfg.openapi.version ?? '0.0.0',
        description: cfg.openapi.description,
      });

      const docBuilder = new DocumentBuilder()
        .setTitle(cfg.openapi.title ?? 'API')
        .setVersion(cfg.openapi.version ?? '0.0.0');
      if (cfg.openapi.description) docBuilder.setDescription(cfg.openapi.description);
      if ((cfg.openapi.auth ?? 'bearer') === 'bearer') docBuilder.addBearerAuth();

      const nestDocument = SwaggerModule.createDocument(app, docBuilder.build());
      nestDocument.components = {
        ...nestDocument.components,
        schemas: {
          ...(nestDocument.components?.schemas ?? {}),
          ...registryDocument.components.schemas,
        } as NonNullable<typeof nestDocument.components>['schemas'],
      };
      SwaggerModule.setup(cfg.openapi.path ?? '/docs', app, nestDocument);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[openapi] Swagger bootstrap skipped:', e instanceof Error ? e.message : e);
  }
`;

const MAIN_SWAGGER_IMPORTS = [
	"import { OPENAPI_REGISTRY, OpenApiRegistry } from './shared/openapi';",
];

// ---------------------------------------------------------------------------
// Runtime-file resolution (mirrors init-scaffold.ts)
// ---------------------------------------------------------------------------

function runtimeRoot(): string {
	const pkgRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const topLevel = path.join(pkgRoot, 'runtime');
	if (fs.existsSync(topLevel)) return topLevel;
	return path.join(pkgRoot, 'dist', 'runtime');
}

function loadRuntimeFile(rel: string): string {
	return fs.readFileSync(path.join(runtimeRoot(), rel), 'utf-8');
}

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

function resolveProjectRoot(startDir: string): string {
	let dir = path.resolve(startDir);
	for (let i = 0; i < 16; i++) {
		if (
			fs.existsSync(path.join(dir, 'codegen.config.yaml')) ||
			fs.existsSync(path.join(dir, 'package.json'))
		) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.resolve(startDir);
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

interface UpgradeChange {
	path: string;
	action: 'created' | 'updated' | 'unchanged' | 'skipped';
	note?: string;
	diff?: string;
}

interface UpgradeReport {
	projectRoot: string;
	changes: UpgradeChange[];
	bail?: { file: string; reason: string; snippet?: string };
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
	projectRoot: string;
	dryRun: boolean;
	force: boolean;
}

export async function runUpgradeOpenapi(opts: UpgradeOptions): Promise<UpgradeReport> {
	const { projectRoot, dryRun, force } = opts;
	const changes: UpgradeChange[] = [];

	// 1. Vendor openapi files
	for (const v of OPENAPI_VENDORED_FILES) {
		const target = path.join(projectRoot, v.target);
		const exists = fs.existsSync(target);
		const newContent = loadRuntimeFile(v.runtime);
		if (exists && !force) {
			const existing = fs.readFileSync(target, 'utf-8');
			if (existing === newContent) {
				changes.push({ path: v.target, action: 'unchanged' });
			} else {
				changes.push({
					path: v.target,
					action: 'skipped',
					note: 'exists with different content — pass --force to overwrite',
				});
			}
		} else {
			if (!dryRun) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, newContent);
			}
			changes.push({
				path: v.target,
				action: exists ? 'updated' : 'created',
			});
		}
	}

	// 2. Patch app.module.ts
	const appModulePath = path.join(projectRoot, 'src', 'app.module.ts');
	if (!fs.existsSync(appModulePath)) {
		return {
			projectRoot,
			changes,
			bail: {
				file: 'src/app.module.ts',
				reason: 'file does not exist — run `codegen project init` first, or author it manually',
			},
		};
	}

	const project = new Project({
		useInMemoryFileSystem: false,
		manipulationSettings: {
			indentationText: IndentationText.TwoSpaces,
			quoteKind: QuoteKind.Single,
			newLineKind: NewLineKind.LineFeed,
		},
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
		skipLoadingLibFiles: true,
	});

	const appSource = project.addSourceFileAtPath(appModulePath);
	const appBefore = appSource.getFullText();

	if (!appSource.getClass('AppModule')) {
		return {
			projectRoot,
			changes,
			bail: {
				file: 'src/app.module.ts',
				reason: 'no `AppModule` class found (factory function or unusual shape)',
				snippet: suggestAppModuleSnippet(),
			},
		};
	}

	const patches: PatchResult[] = [];
	patches.push(ensureImport(appSource, '@nestjs/common', ['Global', 'Module']));
	patches.push(
		ensureImport(appSource, './shared/openapi', ['OPENAPI_REGISTRY', 'OpenApiRegistry'])
	);
	patches.push(
		ensureClassDeclaration(appSource, 'OpenApiModule', OPEN_API_MODULE_SNIPPET, {
			insertBeforeClass: 'AppModule',
		})
	);
	// Re-resolve AppModule after potential insertText above — ts-morph
	// forgets nodes when raw text is inserted into the source file.
	const appModuleClassFresh = appSource.getClass('AppModule');
	if (!appModuleClassFresh) {
		return {
			projectRoot,
			changes,
			bail: {
				file: 'src/app.module.ts',
				reason: 'AppModule disappeared after patching (parser desync)',
				snippet: suggestAppModuleSnippet(),
			},
		};
	}
	const importEntry = ensureModuleImportEntry(appModuleClassFresh, 'OpenApiModule');
	patches.push(importEntry);

	if (importEntry.bail) {
		return {
			projectRoot,
			changes,
			bail: {
				file: 'src/app.module.ts',
				reason: importEntry.bail,
				snippet: suggestAppModuleSnippet(),
			},
		};
	}

	const appAfter = appSource.getFullText();
	const appChanged = appAfter !== appBefore;
	if (appChanged) {
		if (!dryRun) appSource.saveSync();
		const notes = patches
			.filter((p) => p.changed)
			.map((p) => p.note)
			.filter(Boolean)
			.join('; ');
		changes.push({
			path: 'src/app.module.ts',
			action: 'updated',
			note: notes,
			diff: simpleDiff(appBefore, appAfter),
		});
	} else {
		changes.push({ path: 'src/app.module.ts', action: 'unchanged' });
	}

	// 3. Patch main.ts (best-effort)
	const mainPath = path.join(projectRoot, 'src', 'main.ts');
	if (fs.existsSync(mainPath)) {
		const mainSource = project.addSourceFileAtPath(mainPath);
		const mainBefore = mainSource.getFullText();
		const result = ensureMainSwaggerBlock(mainSource, {
			swaggerImports: MAIN_SWAGGER_IMPORTS,
			swaggerBlock: MAIN_SWAGGER_BLOCK,
		});
		if (result.bail) {
			changes.push({
				path: 'src/main.ts',
				action: 'skipped',
				note: `${result.bail} — see CONSUMER-SETUP §OpenAPI`,
			});
		} else if (result.changed) {
			const mainAfter = mainSource.getFullText();
			if (!dryRun) mainSource.saveSync();
			changes.push({
				path: 'src/main.ts',
				action: 'updated',
				note: result.note,
				diff: simpleDiff(mainBefore, mainAfter),
			});
		} else {
			changes.push({ path: 'src/main.ts', action: 'unchanged', note: result.note });
		}
	} else {
		changes.push({
			path: 'src/main.ts',
			action: 'skipped',
			note: "does not exist — run `codegen project init` to scaffold",
		});
	}

	return { projectRoot, changes };
}

function suggestAppModuleSnippet(): string {
	return `Expected shape:

  import { Global, Module } from '@nestjs/common';
  import { OPENAPI_REGISTRY, OpenApiRegistry } from './shared/openapi';

  @Global()
  @Module({
    providers: [{ provide: OPENAPI_REGISTRY, useValue: new OpenApiRegistry() }],
    exports: [OPENAPI_REGISTRY],
  })
  class OpenApiModule {}

  @Module({
    imports: [/* ...existing, */ OpenApiModule /*, ...GENERATED_MODULES */],
  })
  export class AppModule {}
`;
}

/**
 * Very-coarse line-level diff — only used for `--dry-run` user-facing output.
 * Pure deletions / additions are counted; we don't try to match LCS.
 */
function simpleDiff(before: string, after: string): string {
	const b = before.split('\n');
	const a = after.split('\n');
	const bSet = new Set(b);
	const aSet = new Set(a);
	const added = a.filter((l) => !bSet.has(l)).map((l) => '+ ' + l);
	const removed = b.filter((l) => !aSet.has(l)).map((l) => '- ' + l);
	if (added.length === 0 && removed.length === 0) return '';
	return [...removed, ...added].join('\n');
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export class ProjectUpgradeOpenapiCommand extends Command {
	static paths = [['project', 'upgrade-openapi']];
	static usage = Command.Usage({
		description:
			'Patch an existing consumer app.module.ts + main.ts to wire OpenApiModule (OPENAPI-4)',
		examples: [
			['Patch the current project', 'codegen project upgrade-openapi'],
			['Preview changes without writing', 'codegen project upgrade-openapi --dry-run'],
			['Target a specific project dir', 'codegen project upgrade-openapi --path ./apps/api'],
			['Overwrite vendored files', 'codegen project upgrade-openapi --force'],
		],
	});

	dryRun = Option.Boolean('--dry-run', false);
	force = Option.Boolean('--force', false);
	pathOpt = Option.String('--path', { required: false });
	json = Option.Boolean('--json', false);

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);

		const startDir = this.pathOpt ? path.resolve(this.pathOpt) : process.cwd();
		if (!fs.existsSync(startDir)) {
			printError(`Directory not found: ${startDir}`);
			return 1;
		}
		const projectRoot = resolveProjectRoot(startDir);

		let report: UpgradeReport;
		try {
			report = await runUpgradeOpenapi({
				projectRoot,
				dryRun: this.dryRun,
				force: this.force,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			printError(`upgrade-openapi failed: ${msg}`);
			process.stderr.write(`\n${CONSUMER_SETUP_POINTER}\n`);
			return 1;
		}

		if (isJsonMode()) {
			printJson({
				command: 'project upgrade-openapi',
				projectRoot: report.projectRoot,
				dryRun: this.dryRun,
				changes: report.changes,
				bail: report.bail ?? null,
			});
			return report.bail ? 1 : 0;
		}

		// Render report
		printInfo(`OpenAPI upgrade summary (${report.projectRoot}):`);
		console.log('');
		for (const c of report.changes) {
			const icon =
				c.action === 'created' || c.action === 'updated'
					? theme.success(icons.check)
					: c.action === 'skipped'
						? theme.warning(icons.warning)
						: theme.muted(icons.dash);
			const tag = c.action.padEnd(10);
			const reason = c.note ? theme.muted(`  (${c.note})`) : '';
			console.log(`  ${icon} ${theme.muted(tag)} ${c.path}${reason}`);
			if (this.dryRun && c.diff) {
				for (const line of c.diff.split('\n').slice(0, 20)) {
					const colored = line.startsWith('+')
						? theme.success(line)
						: line.startsWith('-')
							? theme.error(line)
							: line;
					console.log(`      ${colored}`);
				}
			}
		}

		if (report.bail) {
			console.log('');
			printError(`bail: ${report.bail.file} — ${report.bail.reason}`);
			if (report.bail.snippet) {
				process.stderr.write('\n' + report.bail.snippet + '\n');
			}
			process.stderr.write('\n' + CONSUMER_SETUP_POINTER + '\n');
			return 1;
		}

		console.log('');
		if (this.dryRun) {
			printWarning('dry-run — no files written');
		} else {
			printSuccess('upgrade-openapi complete');
		}
		console.log('');
		printInfo('Next steps:');
		console.log(
			`  1. ${theme.system('bun add @nestjs/swagger @anatine/zod-openapi')} (peer deps)`
		);
		console.log(
			`  2. ${theme.system('codegen subsystem install openapi-config')} (adds openapi: block to config)`
		);
		console.log(
			`  3. ${theme.system('bun run build && bun run start')} — verify /docs and /docs-json`
		);
		return 0;
	}
}
