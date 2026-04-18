/**
 * Init scaffold — compute and (optionally) apply the file set `codegen
 * project init` writes. Pure planning functions + a `writePlan()` actor so
 * unit tests can inspect the plan without hitting the filesystem.
 *
 * Every scaffolded file matches the skeleton in docs/CONSUMER-SETUP.md. The
 * shim files use a computed relative path back to the codegen-patterns
 * runtime so consumers in sibling/workspace/installed layouts all work.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import type { Context } from './context.js';
import { scanProject, generateConfig } from '../../scanner/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanAction = 'create' | 'skip' | 'merge' | 'overwrite';

export interface PlanEntry {
	/** Absolute path of the target file or directory. */
	path: string;
	/** Relative path, for display. */
	relPath: string;
	/** What we plan to do. */
	action: PlanAction;
	/** File contents to write (undefined for directory-only entries). */
	content?: string;
	/** Human-readable reason the entry resolved this way. */
	reason?: string;
	/** True if this entry represents a directory (mkdir), not a file. */
	directory?: boolean;
}

export interface InitPlan {
	entries: PlanEntry[];
	/** High-level summary for the user (config snapshot, detected framework). */
	summary: {
		cwd: string;
		framework: string;
		orm: string;
		architecture: string;
		frontend: boolean;
		runtimePath: string;
	};
}

export interface InitOptions {
	cwd: string;
	/** Pass --force — overwrite non-directory files that already exist. */
	force?: boolean;
	/** Create tsconfig.json if it doesn't exist. */
	withTsconfig?: boolean;
	/** Override the detected runtime path (for tests). */
	runtimePath?: string;
	/** Skip running the scanner (use when the caller already has a context). */
	skipScan?: boolean;
}

// ---------------------------------------------------------------------------
// Runtime path resolution
// ---------------------------------------------------------------------------

/**
 * Compute the relative path from `<cwd>/src/shared/base-classes/` back to the
 * codegen-patterns `runtime/`.
 *
 * Strategy:
 * 1. Find the runtime source. It's bundled with this CLI at
 *    `<packageRoot>/runtime/`.
 * 2. Resolve the relative path from the shim directory. For most layouts
 *    (sibling repo, workspace dep) this produces `../../../../codegen-patterns/
 *    runtime` or `../../../node_modules/@pattern-stack/codegen/runtime` — either
 *    works as an import specifier.
 */
export function resolveRuntimePath(cwd: string): string {
	// src/cli/shared/init-scaffold.ts → ../../../runtime
	const runtimeAbs = path.resolve(import.meta.dirname, '..', '..', '..', 'runtime');
	// Shim files live at <cwd>/src/shared/<subdir>/<file>.ts — that's depth 4.
	// Compute relative from <cwd>/src/shared/base-classes/ (representative).
	const shimDir = path.join(cwd, 'src', 'shared', 'base-classes');
	return path.relative(shimDir, runtimeAbs);
}

function resolveRuntimePathFor(cwd: string, shimRelDir: string): string {
	const runtimeAbs = path.resolve(import.meta.dirname, '..', '..', '..', 'runtime');
	const shimDir = path.join(cwd, shimRelDir);
	return path.relative(shimDir, runtimeAbs);
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

const BASE_CLASS_SHIMS: Array<{ file: string; exportLine: (rt: string) => string }> = [
	{
		file: 'base-repository.ts',
		exportLine: (rt) => `export * from '${rt}/base-classes/base-repository';\n`,
	},
	{
		file: 'base-service.ts',
		exportLine: (rt) => `export * from '${rt}/base-classes/base-service';\n`,
	},
	{
		file: 'synced-entity-repository.ts',
		exportLine: (rt) =>
			`export * from '${rt}/base-classes/synced-entity-repository';\n`,
	},
	{
		file: 'synced-entity-service.ts',
		exportLine: (rt) => `export * from '${rt}/base-classes/synced-entity-service';\n`,
	},
	{
		file: 'activity-entity-repository.ts',
		exportLine: (rt) =>
			`export * from '${rt}/base-classes/activity-entity-repository';\n`,
	},
	{
		file: 'activity-entity-service.ts',
		exportLine: (rt) =>
			`export * from '${rt}/base-classes/activity-entity-service';\n`,
	},
	{
		file: 'metadata-entity-repository.ts',
		exportLine: (rt) =>
			`export * from '${rt}/base-classes/metadata-entity-repository';\n`,
	},
	{
		file: 'metadata-entity-service.ts',
		exportLine: (rt) =>
			`export * from '${rt}/base-classes/metadata-entity-service';\n`,
	},
	{
		file: 'knowledge-entity-repository.ts',
		exportLine: (rt) =>
			`export * from '${rt}/base-classes/knowledge-entity-repository';\n`,
	},
	{
		file: 'knowledge-entity-service.ts',
		exportLine: (rt) =>
			`export * from '${rt}/base-classes/knowledge-entity-service';\n`,
	},
	{
		file: 'with-analytics.ts',
		exportLine: (rt) => `export { WithAnalytics } from '${rt}/base-classes/with-analytics';\n`,
	},
];

function databaseModuleContent(): string {
	return `import { Module, Global } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../schema';
import { DRIZZLE } from '../constants/tokens';

export { DRIZZLE };
export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * DatabaseModule — provides the DRIZZLE injection token globally.
 * Import once in AppModule, before any generated module.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/app_dev',
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
`;
}

function tokensShim(cwd: string): string {
	const rt = resolveRuntimePathFor(cwd, 'src/shared/constants');
	return `/**
 * Re-export every injection token from the codegen runtime.
 * Generated code imports from '@shared/constants/tokens'.
 *
 * Uses star-export so new runtime tokens (DRIZZLE, EVENT_BUS, future)
 * are picked up automatically without editing this shim.
 */
export * from '${rt}/constants/tokens';
`;
}

function drizzleTypeShim(cwd: string): string {
	const rt = resolveRuntimePathFor(cwd, 'src/shared/types');
	return `/**
 * Re-export the DrizzleClient type from the codegen runtime.
 * Generated code imports from '@shared/types/drizzle'.
 */
export type { DrizzleClient } from '${rt}/types/drizzle';
`;
}

function appModuleContent(): string {
	return `import { Module } from '@nestjs/common';
import { DatabaseModule } from './shared/database/database.module';
import { GENERATED_MODULES } from './generated/modules';

/**
 * AppModule — wires DatabaseModule (global) + the GENERATED_MODULES barrel.
 *
 * DatabaseModule must come first — it provides the DRIZZLE token that every
 * generated repository depends on.
 */
@Module({
  imports: [DatabaseModule, ...GENERATED_MODULES],
})
export class AppModule {}
`;
}

function rootSchemaContent(): string {
	return `/**
 * Drizzle schema root.
 * Re-exports the generated schema barrel. Codegen owns src/generated/schema.ts
 * — add or remove entity YAML to change the table set.
 */
export * from './generated/schema';
`;
}

function emptyModulesBarrel(): string {
	return `// AUTO-GENERATED — DO NOT EDIT.
// Regenerated on every \`codegen entity new\` / \`codegen entity new --all\`.
// See ADR-017.
export const GENERATED_MODULES: unknown[] = [];
`;
}

function emptySchemaBarrel(): string {
	return `// AUTO-GENERATED — DO NOT EDIT.
// Regenerated on every \`codegen entity new\` / \`codegen entity new --all\`.
// See ADR-017.
export {};
`;
}

function exampleEntityYaml(): string {
	return `# Example entity definition — delete or rename to get started.
#
# entity:
#   name: account
#   family: synced        # base | synced | activity | metadata | knowledge
#
# fields:
#   name:
#     type: string
#     required: true
#   email:
#     type: string
#   status:
#     type: enum
#     choices: [active, inactive]
#
# queries:
#   - by: [email]
#     unique: true
`;
}

function tsconfigTemplate(): string {
	return `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@modules/*": ["./src/modules/*"],
      "@generated/*": ["./src/generated/*"]
    },
    "types": ["node"]
  },
  "include": [
    "src/**/*",
    "drizzle.config.ts"
  ]
}
`;
}

// ---------------------------------------------------------------------------
// tsconfig merge
// ---------------------------------------------------------------------------

const REQUIRED_ALIASES: Record<string, string[]> = {
	'@shared/*': ['./src/shared/*'],
	'@modules/*': ['./src/modules/*'],
	'@generated/*': ['./src/generated/*'],
};

interface TsconfigMergeResult {
	content: string;
	added: string[];
	unchanged: boolean;
}

/**
 * Strip JSONC single-line (//) and block (/* ... *&#47;) comments so
 * JSON.parse can handle a typical tsconfig.json authored by `bun init` or
 * similar tooling. Deliberately simple — doesn't handle comment-looking
 * substrings inside string literals, which is acceptable because tsconfig
 * values are well-known shapes.
 */
function stripJsonComments(raw: string): string {
	let out = '';
	let i = 0;
	let inString = false;
	let stringChar = '';
	while (i < raw.length) {
		const c = raw[i];
		const next = raw[i + 1];
		if (inString) {
			out += c;
			if (c === '\\' && i + 1 < raw.length) {
				out += next;
				i += 2;
				continue;
			}
			if (c === stringChar) inString = false;
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			inString = true;
			stringChar = c;
			out += c;
			i++;
			continue;
		}
		if (c === '/' && next === '/') {
			// single-line comment — skip to newline
			while (i < raw.length && raw[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && next === '*') {
			i += 2;
			while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	// Strip trailing commas before ] and }
	return out.replace(/,\s*([\]}])/g, '$1');
}

const REQUIRED_COMPILER_OPTIONS: Record<string, unknown> = {
	experimentalDecorators: true,
	emitDecoratorMetadata: true,
};

/**
 * Idempotent merge of required path aliases + compiler options into an
 * existing tsconfig. Only adds missing entries — never clobbers user-
 * authored paths or flags. Tolerates JSONC via a comment-stripping pass.
 */
export function mergeTsconfig(raw: string): TsconfigMergeResult & { parseError?: string } {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch (err: unknown) {
		return {
			content: raw,
			added: [],
			unchanged: true,
			parseError: err instanceof Error ? err.message : String(err),
		};
	}

	const compilerOptions = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
	const paths = (compilerOptions.paths ?? {}) as Record<string, unknown>;

	const added: string[] = [];
	for (const [alias, target] of Object.entries(REQUIRED_ALIASES)) {
		if (!(alias in paths)) {
			paths[alias] = target;
			added.push(alias);
		}
	}

	// Also ensure decorator flags are enabled — NestJS generated code uses them.
	for (const [opt, value] of Object.entries(REQUIRED_COMPILER_OPTIONS)) {
		if (compilerOptions[opt] === undefined) {
			compilerOptions[opt] = value;
			added.push(opt);
		}
	}

	// Verbatim module syntax + allowImportingTsExtensions (bun init defaults)
	// conflict with NestJS decorator metadata — turn them off for decorated code.
	if (compilerOptions.verbatimModuleSyntax === true) {
		compilerOptions.verbatimModuleSyntax = false;
		added.push('verbatimModuleSyntax=false');
	}

	if (added.length === 0) {
		return { content: raw, added: [], unchanged: true };
	}

	compilerOptions.paths = paths;
	if (compilerOptions.baseUrl === undefined) compilerOptions.baseUrl = '.';
	parsed.compilerOptions = compilerOptions;

	return {
		content: JSON.stringify(parsed, null, 2) + '\n',
		added,
		unchanged: false,
	};
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

function relOf(cwd: string, abs: string): string {
	return path.relative(cwd, abs) || abs;
}

function fileEntry(
	cwd: string,
	absPath: string,
	content: string,
	opts: { force?: boolean; skipReason?: string }
): PlanEntry {
	const exists = fs.existsSync(absPath);
	let action: PlanAction;
	let reason: string | undefined = opts.skipReason;
	if (!exists) {
		action = 'create';
	} else if (opts.force) {
		action = 'overwrite';
		reason = 'exists — --force';
	} else {
		action = 'skip';
		reason = opts.skipReason ?? 'already exists';
	}
	return { path: absPath, relPath: relOf(cwd, absPath), action, content, reason };
}

function dirEntry(cwd: string, absPath: string): PlanEntry {
	const exists = fs.existsSync(absPath);
	return {
		path: absPath,
		relPath: relOf(cwd, absPath),
		action: exists ? 'skip' : 'create',
		directory: true,
		reason: exists ? 'already exists' : undefined,
	};
}

/**
 * Build the complete init plan without touching disk.
 *
 * Detection: if `ctx.framework` is provided (not null), it's used; otherwise
 * we run `scanProject()` unless `skipScan` is set.
 */
export async function buildInitPlan(
	ctx: Context,
	options: InitOptions
): Promise<InitPlan> {
	const cwd = options.cwd;
	const force = Boolean(options.force);

	// Detection — drive config defaults.
	//
	// Architecture default: 'clean-lite-ps'. The CONSUMER-SETUP.md flow and
	// the codegen-pattern-demo-app both use clean-lite-ps; it's the
	// supported consumer path. The scanner only overrides when it finds
	// high-confidence evidence of a different layout (e.g. existing
	// domain/ + application/ directories).
	let framework = 'nestjs';
	let orm = 'drizzle';
	let architecture: 'clean' | 'clean-lite-ps' = 'clean-lite-ps';
	let frontend = false;

	if (!options.skipScan) {
		try {
			const profile = ctx.framework ?? (await scanProject({ directory: cwd }));
			const proposed = generateConfig(profile);
			framework = proposed.framework;
			orm = proposed.orm;
			// Only override architecture when the scanner detected actual
			// clean-architecture evidence (domain/, application/ dirs). A
			// fresh project that resolves to 'flat' with high confidence
			// should stay at the clean-lite-ps default — otherwise init
			// would emit a config that asks codegen to generate files into
			// presentation/ and infrastructure/ directories that don't
			// (and shouldn't) exist.
			if (
				profile.architecture.detected === 'clean' &&
				profile.architecture.confidence >= 50
			) {
				architecture = proposed.generate.architecture;
			}
			frontend = proposed.generate.frontend;
		} catch {
			// Detection failed — keep defaults.
		}
	}

	const runtimePath = options.runtimePath ?? resolveRuntimePath(cwd);

	const entries: PlanEntry[] = [];

	// 1. codegen.config.yaml
	{
		const configPath = path.join(cwd, 'codegen.config.yaml');
		const config = {
			paths: {
				backend_src: 'src',
				entities_dir: 'entities',
				generated: 'src/generated',
			},
			generate: {
				architecture,
				frontend,
				commands: true,
				queries: true,
			},
			naming: {
				fileCase: 'kebab-case',
				suffixStyle: 'dotted',
				terminology: {
					command: 'use-case',
					query: 'use-case',
				},
			},
			database: {
				dialect: 'postgres',
			},
		};
		const content = stringifyYaml(config, { indent: 2 });
		entries.push(fileEntry(cwd, configPath, content, { force }));
	}

	// 2. tsconfig.json — idempotent merge
	{
		const tsconfigPath = path.join(cwd, 'tsconfig.json');
		if (fs.existsSync(tsconfigPath)) {
			const raw = fs.readFileSync(tsconfigPath, 'utf-8');
			const merged = mergeTsconfig(raw);
			if (merged.parseError) {
				entries.push({
					path: tsconfigPath,
					relPath: relOf(cwd, tsconfigPath),
					action: 'skip',
					reason: `unable to parse (${merged.parseError}); add aliases manually`,
				});
			} else if (merged.unchanged) {
				entries.push({
					path: tsconfigPath,
					relPath: relOf(cwd, tsconfigPath),
					action: 'skip',
					reason: 'path aliases already present',
				});
			} else {
				entries.push({
					path: tsconfigPath,
					relPath: relOf(cwd, tsconfigPath),
					action: 'merge',
					content: merged.content,
					reason: `add aliases: ${merged.added.join(', ')}`,
				});
			}
		} else if (options.withTsconfig) {
			entries.push({
				path: tsconfigPath,
				relPath: relOf(cwd, tsconfigPath),
				action: 'create',
				content: tsconfigTemplate(),
				reason: 'new tsconfig.json',
			});
		} else {
			entries.push({
				path: tsconfigPath,
				relPath: relOf(cwd, tsconfigPath),
				action: 'skip',
				reason: 'missing — pass --with-tsconfig to create one',
			});
		}
	}

	// 3. src/shared/database/database.module.ts
	entries.push(
		fileEntry(
			cwd,
			path.join(cwd, 'src', 'shared', 'database', 'database.module.ts'),
			databaseModuleContent(),
			{ force }
		)
	);

	// 4. src/shared/constants/tokens.ts
	entries.push(
		fileEntry(cwd, path.join(cwd, 'src', 'shared', 'constants', 'tokens.ts'), tokensShim(cwd), {
			force,
		})
	);

	// 5. src/shared/types/drizzle.ts
	entries.push(
		fileEntry(cwd, path.join(cwd, 'src', 'shared', 'types', 'drizzle.ts'), drizzleTypeShim(cwd), {
			force,
		})
	);

	// 6. src/shared/base-classes/*
	{
		const rt = resolveRuntimePathFor(cwd, 'src/shared/base-classes');
		for (const shim of BASE_CLASS_SHIMS) {
			entries.push(
				fileEntry(
					cwd,
					path.join(cwd, 'src', 'shared', 'base-classes', shim.file),
					shim.exportLine(rt),
					{ force }
				)
			);
		}
	}

	// 7. src/generated/{modules,schema}.ts — empty barrels
	entries.push(
		fileEntry(
			cwd,
			path.join(cwd, 'src', 'generated', 'modules.ts'),
			emptyModulesBarrel(),
			{ force }
		)
	);
	entries.push(
		fileEntry(
			cwd,
			path.join(cwd, 'src', 'generated', 'schema.ts'),
			emptySchemaBarrel(),
			{ force }
		)
	);

	// 8. src/app.module.ts — only if missing (never clobber user auth'd module)
	{
		const appModulePath = path.join(cwd, 'src', 'app.module.ts');
		if (!fs.existsSync(appModulePath)) {
			entries.push({
				path: appModulePath,
				relPath: relOf(cwd, appModulePath),
				action: 'create',
				content: appModuleContent(),
			});
		} else {
			entries.push({
				path: appModulePath,
				relPath: relOf(cwd, appModulePath),
				action: 'skip',
				reason: 'exists — wire DatabaseModule + GENERATED_MODULES manually',
			});
		}
	}

	// 9. src/schema.ts — drizzle schema root
	{
		const schemaPath = path.join(cwd, 'src', 'schema.ts');
		if (!fs.existsSync(schemaPath)) {
			entries.push({
				path: schemaPath,
				relPath: relOf(cwd, schemaPath),
				action: 'create',
				content: rootSchemaContent(),
			});
		} else {
			entries.push({
				path: schemaPath,
				relPath: relOf(cwd, schemaPath),
				action: 'skip',
				reason: "exists — ensure it re-exports './generated/schema'",
			});
		}
	}

	// 10. entities/ + entities/example.yaml
	entries.push(dirEntry(cwd, path.join(cwd, 'entities')));
	{
		const examplePath = path.join(cwd, 'entities', 'example.yaml');
		if (!fs.existsSync(examplePath)) {
			entries.push({
				path: examplePath,
				relPath: relOf(cwd, examplePath),
				action: 'create',
				content: exampleEntityYaml(),
			});
		} else {
			entries.push({
				path: examplePath,
				relPath: relOf(cwd, examplePath),
				action: 'skip',
				reason: 'already exists',
			});
		}
	}

	return {
		entries,
		summary: {
			cwd,
			framework,
			orm,
			architecture,
			frontend,
			runtimePath,
		},
	};
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface WriteResult {
	created: PlanEntry[];
	merged: PlanEntry[];
	overwritten: PlanEntry[];
	skipped: PlanEntry[];
}

export function writePlan(plan: InitPlan): WriteResult {
	const created: PlanEntry[] = [];
	const merged: PlanEntry[] = [];
	const overwritten: PlanEntry[] = [];
	const skipped: PlanEntry[] = [];

	for (const e of plan.entries) {
		if (e.action === 'skip') {
			skipped.push(e);
			continue;
		}
		if (e.directory) {
			fs.mkdirSync(e.path, { recursive: true });
			created.push(e);
			continue;
		}
		if (e.content === undefined) {
			skipped.push(e);
			continue;
		}
		fs.mkdirSync(path.dirname(e.path), { recursive: true });
		fs.writeFileSync(e.path, e.content, 'utf-8');
		if (e.action === 'create') created.push(e);
		else if (e.action === 'merge') merged.push(e);
		else if (e.action === 'overwrite') overwritten.push(e);
	}

	return { created, merged, overwritten, skipped };
}
