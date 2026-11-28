/**
 * CFG-0 (#640) — `codegen.config.yaml` is parsed once, strictly, by
 * `src/config/project-config.ts`, for the CLI and the hygen prompts alike.
 *
 * Issue gate 1: a removed key (`paths.entities_dir`) or a typo is an error that
 * names the key and the file. Every config the generator itself writes — the
 * fixtures, the subsystem config-block injectors, `project init`, `project
 * scan --write` — passes the strict parse.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import {
	CodegenConfigError,
	loadCodegenConfig,
	loadProjectConfig,
	parseCodegenConfig,
	CONFIG_PATH_ENV,
} from '../../config/project-config';
import {
	CodegenConfigObjectSchema,
	SUBSYSTEM_NAMES,
} from '../../schema/codegen-config.schema';
import { SUBSYSTEMS } from '../../cli/shared/subsystem-detect';
import { loadContext } from '../../cli/shared/context';
import { buildInitPlan } from '../../cli/shared/init-scaffold';
import { proposedConfigYaml } from '../../cli/commands/project';
import { generateConfig, scanProject } from '../../scanner/index';
import { jsonSchemaErrors } from '../schema/_config-json-schema';

const REPO = path.resolve(import.meta.dir, '../../..');

const tmpDirs: string[] = [];
function tmpProject(configYaml: string | null): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg0-'));
	tmpDirs.push(dir);
	if (configYaml !== null) fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), configYaml);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function errorOf(fn: () => unknown): CodegenConfigError {
	try {
		fn();
	} catch (err) {
		if (err instanceof CodegenConfigError) return err;
		throw err;
	}
	throw new Error('expected a CodegenConfigError');
}

describe('unknown and removed keys are errors naming the key and the file (issue gate 1)', () => {
	it('paths.entities_dir — deleted in CLI-0 (#634)', () => {
		const dir = tmpProject('paths:\n  entities_dir: defs\n');
		const err = errorOf(() => loadProjectConfig(dir));
		expect(err.configPath).toBe(path.join(dir, 'codegen.config.yaml'));
		expect(err.issues).toEqual([
			expect.stringMatching(/^paths\.entities_dir: unknown key \(expected one of: backend_src, .*entities.*\)$/),
		]);
		expect(err.message).toContain(path.join(dir, 'codegen.config.yaml'));
		expect(err.message).toContain('paths.entities_dir: unknown key');
	});

	it('a typo — paths.entitis', () => {
		const err = errorOf(() => parseCodegenConfig({ paths: { entitis: 'defs' } }, 'x.yaml'));
		expect(err.issues[0]).toStartWith('paths.entitis: unknown key');
	});

	it('an unknown top-level block', () => {
		const err = errorOf(() => parseCodegenConfig({ framework: 'nestjs' }, 'x.yaml'));
		expect(err.issues[0]).toStartWith('framework: unknown key (expected one of: runtime, target, paths,');
	});

	it('an unknown key inside an open map value — jobs.pools.<name>', () => {
		const err = errorOf(() => parseCodegenConfig({ jobs: { pools: { reports: { concurency: 2 } } } }, 'x.yaml'));
		expect(err.issues).toContainEqual(
			expect.stringMatching(/^jobs\.pools\.reports\.concurency: unknown key \(expected one of: concurrency, description/),
		);
	});

	it('the jobs pool rules, at generation — JOBS-3', () => {
		// A pool is a limiter: a positive concurrency; ADR-022's queue/reserved are named as removed.
		const err = errorOf(() =>
			parseCodegenConfig(
				{ jobs: { pools: { batch: { concurrency: 0 }, reports: { queue: 'jobs-reports', concurrency: 2, reserved: true } } } },
				'x.yaml',
			),
		);
		expect(err.issues).toEqual([
			expect.stringMatching(/^jobs\.pools\.batch\.concurrency: /),
			expect.stringMatching(/^jobs\.pools\.reports\.queue: 'jobs\.pools\.<name>\.queue' was removed by JOBS-3/),
			expect.stringMatching(/^jobs\.pools\.reports\.reserved: 'jobs\.pools\.<name>\.reserved' was removed by JOBS-3/),
		]);
		// A default pool re-capped, and a pool of the app's own, pass.
		expect(() =>
			parseCodegenConfig({ jobs: { pools: { batch: { concurrency: 8 }, reports: { concurrency: 2 } } } }, 'x.yaml'),
		).not.toThrow();
	});

	it('openapi: a bad value or an unknown key — CFG-1', () => {
		expect(errorOf(() => parseCodegenConfig({ openapi: { auth: 'basic' } }, 'x.yaml')).issues[0]).toStartWith(
			'openapi.auth:',
		);
		expect(errorOf(() => parseCodegenConfig({ openapi: { titel: 'x' } }, 'x.yaml')).issues[0]).toStartWith(
			'openapi.titel: unknown key',
		);
	});

	it('every issue is reported, not just the first', () => {
		const err = errorOf(() =>
			parseCodegenConfig({ paths: { entitis: 'a' }, generate: { architecture: 'mvc' } }, 'x.yaml'),
		);
		expect(err.issues).toHaveLength(2);
		expect(err.issues.join('\n')).toContain('generate.architecture');
	});

	it('a removed key in a deleted-key list (CFG-0 census) is rejected', () => {
		for (const raw of [
			{ paths: { schema_dir: 'x' } },
			{ paths: { manifest_dir: 'x' } },
			{ paths: { packages: 'x' } },
			{ generate: { schemaServer: true } },
			{ auth: { encryption_key: 'env' } },
			{ events: { pools: [] } },
			{ locations: { backendSrc: { path: 'src' } } },
		]) {
			expect(() => parseCodegenConfig(raw, 'x.yaml')).toThrow(CodegenConfigError);
		}
	});

	it('malformed YAML is an error naming the file', () => {
		const dir = tmpProject('paths:\n  entities: "unterminated\n');
		const err = errorOf(() => loadProjectConfig(dir));
		expect(err.issues[0]).toStartWith('not valid YAML');
	});
});

describe('loadProjectConfig', () => {
	it('null when the project has no config file', () => {
		const dir = tmpProject(null);
		expect(loadProjectConfig(dir)).toBeNull();
	});

	it('an empty file is the all-defaults config', () => {
		const dir = tmpProject('');
		const config = loadProjectConfig(dir);
		expect(config?.runtime).toBe('package');
		expect(config?.paths.generated).toBe('src/generated');
		expect(config?.generate).toEqual({ frontend: false, semantic: false });
	});

	it('walks upward from cwd, like the CLI', () => {
		const dir = tmpProject('generate:\n  frontend: true\n');
		const nested = path.join(dir, 'a', 'b');
		fs.mkdirSync(nested, { recursive: true });
		expect(loadProjectConfig(nested)?.generate.frontend).toBe(true);
	});

	it('$CODEGEN_CONFIG_PATH (set by the CLI for hygen) wins over the upward walk', () => {
		const a = tmpProject('generate:\n  frontend: false\n');
		const b = tmpProject('generate:\n  frontend: true\n');
		process.env[CONFIG_PATH_ENV] = path.join(b, 'codegen.config.yaml');
		try {
			expect(loadProjectConfig(a)?.generate.frontend).toBe(true);
		} finally {
			delete process.env[CONFIG_PATH_ENV];
		}
	});

	it('re-parses when the file text changes (subsystem install edits it in-process)', () => {
		const dir = tmpProject('runtime: package\n');
		const file = path.join(dir, 'codegen.config.yaml');
		expect(loadCodegenConfig(file).runtime).toBe('package');
		fs.writeFileSync(file, 'runtime: vendored\n');
		expect(loadCodegenConfig(file).runtime).toBe('vendored');
	});

	it('the CLI context throws the same error', async () => {
		const dir = tmpProject('paths:\n  entities_dir: defs\n');
		await expect(loadContext({ cwd: dir, skipDetection: true })).rejects.toThrow(
			/paths\.entities_dir: unknown key/,
		);
	});
});

describe('the configs the generator writes pass the strict parse, and the editor\'s JSON Schema (TGT-0b)', () => {
	it('test/fixtures/codegen.config*.yaml', () => {
		const dir = path.join(REPO, 'test/fixtures');
		const files = fs.readdirSync(dir).filter((f) => /^codegen\.config.*\.yaml$/.test(f));
		expect(files.length).toBeGreaterThanOrEqual(1);
		for (const f of files) {
			expect(() => loadCodegenConfig(path.join(dir, f))).not.toThrow();
			expect(jsonSchemaErrors(yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))).toEqual([]);
		}
	});

	it('every subsystem config-block injector', () => {
		const root = path.join(REPO, 'templates/subsystem');
		const blocks = fs
			.readdirSync(root)
			.filter((d) => d.endsWith('-config'))
			.flatMap((d) =>
				fs
					.readdirSync(path.join(root, d))
					.filter((f) => f.endsWith('.ejs.t'))
					.map((f) => path.join(root, d, f)),
			);
		expect(blocks.length).toBe(7);
		for (const file of blocks) {
			// The one local a block prints: the installed backend (events, S-1).
			const body = fs
				.readFileSync(file, 'utf-8')
				.split(/^---$/m)
				.slice(2)
				.join('---')
				.replace('<%= backend %>', 'drizzle');
			expect(body).not.toContain('<%');
			expect(() => parseCodegenConfig(yaml.parse(body), file)).not.toThrow();
			expect(jsonSchemaErrors(yaml.parse(body))).toEqual([]);
		}
	});

	it('project init, both runtime modes', async () => {
		for (const runtimeMode of ['package', 'vendored'] as const) {
			const cwd = tmpProject(null);
			const ctx = await loadContext({ cwd, skipDetection: true });
			const plan = await buildInitPlan(ctx, { cwd, skipScan: true, runtimeMode });
			const entry = plan.entries.find((e) => e.relPath === 'codegen.config.yaml');
			expect(entry?.content).toBeDefined();
			expect(() => parseCodegenConfig(yaml.parse(entry!.content!), 'init')).not.toThrow();
			expect(jsonSchemaErrors(yaml.parse(entry!.content!))).toEqual([]);
		}
	});

	it('project scan --write', async () => {
		const profile = await scanProject({ directory: REPO });
		const written = proposedConfigYaml(generateConfig(profile));
		expect(Object.keys(written).sort()).toEqual(['generate', 'paths']);
		expect(() => parseCodegenConfig(written, 'scan')).not.toThrow();
		expect(jsonSchemaErrors(written)).toEqual([]);
	});
});

describe('tables kept in step with the schema', () => {
	it('SUBSYSTEM_NAMES is the SUBSYSTEMS descriptor list', () => {
		expect([...SUBSYSTEM_NAMES].sort()).toEqual(SUBSYSTEMS.map((s) => s.name).sort());
	});

	it('the top-level schema is strict', () => {
		expect(CodegenConfigObjectSchema.def.catchall?.def.type).toBe('never');
	});
});

describe('the CLI and a direct hygen run both refuse an invalid config', () => {
	const entity = 'entity:\n  name: widget\n  plural: widgets\nfields:\n  name:\n    type: string\n';

	it('codegen entity new exits 1 naming the key', () => {
		const dir = tmpProject('paths:\n  entities_dir: defs\n');
		fs.mkdirSync(path.join(dir, 'entities'));
		fs.writeFileSync(path.join(dir, 'entities/widget.yaml'), entity);
		const r = spawnSync('bun', [path.join(REPO, 'src/cli/index.ts'), 'entity', 'new', '--all', '--cwd', dir], {
			encoding: 'utf-8',
		});
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toContain('paths.entities_dir: unknown key');
		expect(fs.existsSync(path.join(dir, 'src'))).toBe(false);
	});

	it('hygen entity new (prompt run directly) exits non-zero naming the key', () => {
		const dir = tmpProject('paths:\n  entitis: defs\n');
		fs.writeFileSync(path.join(dir, 'widget.yaml'), entity);
		const r = spawnSync('bunx', ['--bun', 'hygen', 'entity', 'new', '--yaml', path.join(dir, 'widget.yaml')], {
			cwd: dir,
			encoding: 'utf-8',
			env: { ...process.env, HYGEN_TMPLS: path.join(REPO, 'templates') },
		});
		expect(r.status).not.toBe(0);
		expect(r.stdout + r.stderr).toContain('paths.entitis: unknown key');
		expect(fs.existsSync(path.join(dir, 'src'))).toBe(false);
	}, 30_000);
});

describe('jobs: the ADR-022 keys are removed, by name (JOBS-3)', () => {
	const issues = (jobs: Record<string, unknown>) => errorOf(() => parseCodegenConfig({ jobs }, 'x.yaml')).issues;

	for (const [key, value] of [
		['backend', 'drizzle'],
		['extensions', { drizzle: { listen_notify: true } }],
		['worker_pools', ['batch']],
		['all_pools', true],
		['multi_tenant', true],
	] as const) {
		it(`jobs.${key} names itself as removed and points at the migration note`, () => {
			expect(issues({ [key]: value })).toEqual([
				expect.stringMatching(new RegExp(`^jobs\\.${key}: 'jobs\\.${key}' was removed by JOBS-3 .*MIGRATION-jobs-engine\\.md`)),
			]);
		});
	}

	it('worker_mode defaults to embedded; standalone parses', () => {
		expect(parseCodegenConfig({ jobs: {} }, 'x.yaml').jobs?.worker_mode).toBe('embedded');
		expect(() => parseCodegenConfig({ jobs: { worker_mode: 'standalone' } }, 'x.yaml')).not.toThrow();
	});
});

describe('target: — the (database, orm) pair, derived from TARGET_PAIRS (TGT-0, ADR-047)', () => {
	const SUPPORTED = 'supported: { database: postgres, orm: drizzle }, { database: sqlite, orm: drizzle }';

	it('absent → { database: postgres, orm: drizzle }, the first row of the table', () => {
		expect(parseCodegenConfig({}, 'x.yaml').target).toEqual({ database: 'postgres', orm: 'drizzle' });
	});

	it('{ database: postgres, orm: drizzle } parses', () => {
		expect(parseCodegenConfig({ target: { database: 'postgres', orm: 'drizzle' } }, 'x.yaml').target).toEqual({
			database: 'postgres',
			orm: 'drizzle',
		});
	});

	it('a pair the table lacks is refused, naming the supported pairs', () => {
		// Two rows: the union's one issue names the pair and the supported ones (TGT-0b's two-row messages, now live).
		const err = errorOf(() => parseCodegenConfig({ target: { database: 'mysql', orm: 'drizzle' } }, 'x.yaml'));
		expect(err.issues).toEqual([`target: { database: mysql, orm: drizzle } is not a supported (database, orm) pair; ${SUPPORTED}`]);
		const orm = errorOf(() => parseCodegenConfig({ target: { database: 'sqlite', orm: 'kysely' } }, 'x.yaml'));
		expect(orm.issues).toEqual([`target: { database: sqlite, orm: kysely } is not a supported (database, orm) pair; ${SUPPORTED}`]);
		expect(parseCodegenConfig({ target: { database: 'sqlite', orm: 'drizzle' } }, 'x.yaml').target).toEqual({
			database: 'sqlite',
			orm: 'drizzle',
		});
	});

	it('written, both keys are required', () => {
		const err = errorOf(() => parseCodegenConfig({ target: { database: 'postgres' } }, 'x.yaml'));
		expect(err.issues).toEqual([`target: required: write both database and orm; ${SUPPORTED}`]);
	});

	it('a key with no second value yet (runtime) is an unknown key, not a silently ignored one', () => {
		const err = errorOf(() =>
			parseCodegenConfig({ target: { database: 'postgres', orm: 'drizzle', runtime: 'bun' } }, 'x.yaml'),
		);
		expect(err.issues).toEqual(['target.runtime: unknown key (expected one of: database, orm, wiring, http)']);
	});

	it('wiring and http (PW-3): pattern-stack/none parses, pattern-stack alone means pattern-stack/none, and the defaults stay nest', () => {
		const plain = parseCodegenConfig(
			{ target: { database: 'postgres', orm: 'drizzle', wiring: 'pattern-stack', http: 'none' } },
			'x.yaml',
		);
		expect(plain.target).toEqual({ database: 'postgres', orm: 'drizzle', wiring: 'pattern-stack', http: 'none' });
		const bare = parseCodegenConfig({ target: { database: 'postgres', orm: 'drizzle', wiring: 'pattern-stack' } }, 'x.yaml');
		expect(bare.target.wiring).toBe('pattern-stack');
		expect(parseCodegenConfig({}, 'x.yaml').target).toEqual({ database: 'postgres', orm: 'drizzle' });
	});

	it('an unsupported app is refused naming the supported ones', () => {
		const err = errorOf(() =>
			parseCodegenConfig({ target: { database: 'postgres', orm: 'drizzle', wiring: 'pattern-stack', http: 'nest' } }, 'x.yaml'),
		);
		expect(err.issues.join('\n')).toContain('{ wiring: pattern-stack, http: nest } is not a supported app');
		expect(err.issues.join('\n')).toContain('{ wiring: pattern-stack, http: none }');
		const hono = errorOf(() =>
			parseCodegenConfig({ target: { database: 'postgres', orm: 'drizzle', http: 'hono' } }, 'x.yaml'),
		);
		expect(hono.issues[0]).toContain('http: hono is not one of nest, none');
	});

	it('pattern-stack wiring on a storage-only pair is refused until G7', () => {
		const err = errorOf(() =>
			parseCodegenConfig({ target: { database: 'sqlite', orm: 'drizzle', wiring: 'pattern-stack', http: 'none' } }, 'x.yaml'),
		);
		expect(err.issues.join('\n')).toContain('wiring: pattern-stack needs a pair that emits the app layers');
	});

	it('a bare string is not a target', () => {
		const err = errorOf(() => parseCodegenConfig({ target: 'drizzle-postgres' }, 'x.yaml'));
		expect(err.issues[0]).toStartWith('target:');
	});
});
