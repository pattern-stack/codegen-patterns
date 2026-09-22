/**
 * PATH-0 (#642, #566, #612) — one default per `paths.*` key, declared once in
 * `PathsConfigSchema`; every reader and every scaffold goes through it.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CODEGEN_CONFIG, parseCodegenConfig } from '../../config/project-config';
import { DEFAULT_BACKEND_NAMING } from '../../schema/naming-config.schema';
import { importSpecifier, projectLayout, tsconfigIncludes } from '../../cli/shared/project-layout';
import { loadContext } from '../../cli/shared/context';
import { buildInitPlan } from '../../cli/shared/init-scaffold';

const REPO = path.resolve(import.meta.dir, '../../..');

const tmpDirs: string[] = [];
function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path0-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('the defaults table', () => {
	it('every paths.* key resolves to its one default', () => {
		expect(DEFAULT_CODEGEN_CONFIG.paths).toEqual({
			backend_src: 'src',
			frontend_src: 'apps/frontend/src',
			entities: 'entities',
			events_dir: 'events',
			jobs_dir: 'definitions/jobs',
			providers: 'definitions/providers',
			generated: 'src/generated',
			subsystems: 'src/shared/subsystems',
			modules_dir: 'src/modules',
			orchestration_src: 'src/orchestration',
		});
	});

	it('the four derived keys follow paths.backend_src, and yield to an explicit value', () => {
		const { paths } = parseCodegenConfig({ paths: { backend_src: 'apps/backend/src/', generated: 'gen' } }, 't');
		expect(paths.generated).toBe('gen');
		expect(paths.subsystems).toBe('apps/backend/src/shared/subsystems');
		expect(paths.modules_dir).toBe('apps/backend/src/modules');
		expect(paths.orchestration_src).toBe('apps/backend/src/orchestration');
	});

	it('an empty path is an error, not a silent default', () => {
		expect(() => parseCodegenConfig({ paths: { backend_src: '' } }, 't')).toThrow(/paths\.backend_src/);
	});

	// THE pin for charter Q5. Changing the no-config architecture is this
	// assertion plus the one `.default()` in `GenerateConfigSchema`; no reader
	// carries its own fallback (the junction prompt's and `barrel-generator`'s
	// were deleted in PATH-0).
	it('generate.architecture defaults to the schema value, clean (charter Q5)', () => {
		expect(DEFAULT_CODEGEN_CONFIG.generate.architecture).toBe('clean');
	});

	it('the naming defaults are the schema defaults (#644 review)', () => {
		expect(DEFAULT_BACKEND_NAMING).toEqual(DEFAULT_CODEGEN_CONFIG.naming);
	});
});

describe('no reader carries its own default literal', () => {
	// A fallback literal for a `paths.*` value, or the deleted `app/backend/src`
	// default, anywhere outside the schema is a second default (I1). So is a
	// fallback that BUILDS a path (`?? path.resolve(cwd, 'entities')`): a value
	// that already resolved through the schema never needs one.
	const FALLBACKS = [
		/['"]app\/backend\/src['"]/,
		/\?\?\s*['"](?:src|entities|events|src\/generated|definitions\/(?:jobs|providers))['"]/,
		/\|\|\s*['"]src['"]/,
		/\?\?\s*path\.(?:resolve|join)\(/,
		/\|\|\s*path\.(?:resolve|join)\(/,
	];

	// Exact, asserted-present exceptions: a `?? path.…(` that derives from an
	// already-resolved value and is not a `paths.*` default.
	const NOT_A_PATHS_DEFAULT = [
		// The junctions directory is not a `paths.*` key — PathsConfigSchema
		// declares none, so there is no schema default to defer to.
		"src/cli/shared/relations-generator.ts: junctionsDir: opts.junctionsDir ?? path.resolve(ctx.cwd, 'junctions'),",
		"src/cli/shared/semantic-generator.ts: junctionsDir: opts.junctionsDir ?? path.resolve(ctx.cwd, 'junctions'),",
		"src/emitters/frontend/load-context.ts: const junctionsDir = opts.junctionsDir ?? path.resolve(cwd, JUNCTIONS_DIR);",
		"src/emitters/relations/load-context.ts: const junctionsDir = opts.junctionsDir ?? path.resolve(cwd, JUNCTIONS_DIRNAME);",
		"src/emitters/semantic/load-context.ts: const junctionsDir = opts.junctionsDir ?? path.resolve(cwd, JUNCTIONS_DIRNAME);",
		// The relations and semantic emitters are callable with no config at all
		// (`config: … | null`). Their CLI callers resolve `entities` from the
		// schema; these are the standalone fallbacks.
		"src/emitters/relations/load-context.ts: opts.entitiesDir ?? path.resolve(cwd, config?.paths?.entities ?? ENTITIES_DIRNAME);",
		"src/emitters/semantic/load-context.ts: opts.entitiesDir ?? path.resolve(cwd, config?.paths?.entities ?? ENTITIES_DIRNAME);",
		// `copyRuntime`'s option: the parent of the install target it was handed.
		"src/cli/shared/runtime-copier.ts: const depsTargetRoot = opts.depsTargetRoot ?? path.resolve(targetDir, '..');",
	];

	it('src/ and templates/ are clean', () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
				} else if (/\.(ts|js|mjs|t)$/.test(entry.name)) {
					fs.readFileSync(full, 'utf-8')
						.split('\n')
						.forEach((line, i) => {
							if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
							if (FALLBACKS.some((re) => re.test(line))) {
								offenders.push(`${path.relative(REPO, full)}: ${line.trim()}`);
							}
						});
				}
			}
		};
		walk(path.join(REPO, 'src'));
		walk(path.join(REPO, 'templates'));
		// Exact both ways: a new fallback fails, and so does a stale exception.
		expect(offenders.sort()).toEqual([...NOT_A_PATHS_DEFAULT].sort());
	});
});

describe('projectLayout / importSpecifier', () => {
	const layout = projectLayout('/p', {
		paths: { backend_src: 'apps/backend/src', generated: 'apps/backend/codegen' },
	});

	it('derives the keyless files from backend_src', () => {
		expect(layout.appModule).toBe('/p/apps/backend/src/app.module.ts');
		expect(layout.databaseModule).toBe('/p/apps/backend/src/shared/database/database.module.ts');
		expect(layout.shared).toBe('/p/apps/backend/src/shared');
		expect(layout.workerTs).toBe('/p/apps/backend/src/worker.ts');
	});

	it('specifiers are relative to the emitting file', () => {
		expect(importSpecifier(layout.appModule, path.join(layout.generated, 'modules'))).toBe('../codegen/modules');
		expect(importSpecifier(layout.appModule, layout.databaseModule)).toBe('./shared/database/database.module');
		expect(importSpecifier('/p/src/app.module.ts', '/p/src/generated/modules.ts')).toBe('./generated/modules');
	});

	it('tsconfig include covers a generated dir outside backend_src', () => {
		expect(tsconfigIncludes(layout)).toEqual(['apps/backend/src/**/*', 'apps/backend/codegen/**/*']);
		expect(tsconfigIncludes(projectLayout('/p', null))).toEqual(['src/**/*']);
	});
});

describe('project init honours an existing config (#566, #612)', () => {
	it('every target and every emitted specifier follows paths.*', async () => {
		const cwd = tmp();
		fs.writeFileSync(
			path.join(cwd, 'codegen.config.yaml'),
			'runtime: vendored\npaths:\n  backend_src: apps/backend/src\n  generated: apps/backend/codegen\n  entities: definitions/entities\n',
		);
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true, runtimeMode: 'vendored', withTsconfig: true });
		const rel = plan.entries.map((e) => e.relPath);
		for (const r of rel) {
			if (r === 'codegen.config.yaml' || r === 'tsconfig.json') continue;
			expect(r).toMatch(/^(apps\/backend\/(src|codegen)\/|definitions\/entities)/);
		}
		const content = (r: string) => plan.entries.find((e) => e.relPath === r)!.content!;
		expect(rel).toContain('apps/backend/src/shared/base-classes/base-repository.ts');
		expect(content('apps/backend/src/app.module.ts')).toContain("from '../codegen/modules'");
		expect(content('apps/backend/src/app.module.ts')).toContain("from './shared/database/database.module'");
		expect(content('apps/backend/src/schema.ts')).toContain("export * from '../codegen/schema';");
		expect(rel).toContain('definitions/entities/example.yaml');
		const tsconfig = JSON.parse(content('tsconfig.json'));
		expect(tsconfig.compilerOptions.paths['@shared/*']).toEqual(['./apps/backend/src/shared/*']);
		expect(tsconfig.include).toContain('apps/backend/codegen/**/*');
	});

	it('the default layout is byte-identical to before (#612 specifiers)', async () => {
		const cwd = tmp();
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true, runtimeMode: 'package', withTsconfig: true });
		const content = (r: string) => plan.entries.find((e) => e.relPath === r)!.content!;
		expect(content('src/app.module.ts')).toContain("import { DatabaseModule } from './shared/database/database.module';");
		expect(content('src/app.module.ts')).toContain("import { GENERATED_MODULES } from './generated/modules';");
		expect(content('src/schema.ts')).toContain("export * from './generated/schema';");
		expect(content('tsconfig.json')).toContain('"@shared/*": ["./src/shared/*"]');
		expect(content('tsconfig.json')).toContain('    "src/**/*",\n    "drizzle.config.ts"');
	});
});
