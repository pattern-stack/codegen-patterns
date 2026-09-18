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
		expect(err.issues[0]).toStartWith('framework: unknown key (expected one of: runtime, paths,');
	});

	it('an unknown key inside an open map value — jobs.pools.<name>', () => {
		const err = errorOf(() =>
			parseCodegenConfig({ jobs: { pools: { reports: { queue: 'q', concurency: 2 } } } }, 'x.yaml'),
		);
		expect(err.issues[0]).toStartWith(
			'jobs.pools.reports.concurency: unknown key (expected one of: queue, concurrency, reserved, description)',
		);
	});

	it('the jobs pool rules, at generation — CFG-1', () => {
		const err = errorOf(() =>
			parseCodegenConfig(
				{
					jobs: {
						pools: {
							events_inbound: { reserved: false },
							batch: { queue: 'elsewhere', concurrency: 8 },
							reports: { concurrency: 2 },
							rogue: { queue: 'jobs-rogue', concurrency: 1, reserved: true },
						},
					},
				},
				'x.yaml',
			),
		);
		expect(err.issues).toEqual([
			expect.stringMatching(/^jobs\.pools\.events_inbound\.reserved: 'events_inbound' is a framework pool/),
			expect.stringMatching(/^jobs\.pools\.batch\.queue: 'batch' is a framework pool/),
			expect.stringMatching(/^jobs\.pools\.reports\.queue: user-defined pool 'reports' must declare a non-empty 'queue'/),
			expect.stringMatching(/^jobs\.pools\.rogue\.reserved: .*framework-only/),
		]);
		// A framework pool tuning concurrency, and a complete user pool, pass.
		expect(() =>
			parseCodegenConfig(
				{ jobs: { pools: { batch: { concurrency: 8 }, reports: { queue: 'jobs-reports', concurrency: 2 } } } },
				'x.yaml',
			),
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
		expect(config?.generate.architecture).toBe('clean');
	});

	it('walks upward from cwd, like the CLI', () => {
		const dir = tmpProject('generate:\n  architecture: clean-lite-ps\n');
		const nested = path.join(dir, 'a', 'b');
		fs.mkdirSync(nested, { recursive: true });
		expect(loadProjectConfig(nested)?.generate.architecture).toBe('clean-lite-ps');
	});

	it('$CODEGEN_CONFIG_PATH (set by the CLI for hygen) wins over the upward walk', () => {
		const a = tmpProject('generate:\n  architecture: clean-lite-ps\n');
		const b = tmpProject('generate:\n  architecture: clean\n');
		process.env[CONFIG_PATH_ENV] = path.join(b, 'codegen.config.yaml');
		try {
			expect(loadProjectConfig(a)?.generate.architecture).toBe('clean');
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

describe('the configs the generator writes pass the strict parse', () => {
	it('test/fixtures/codegen.config*.yaml', () => {
		const dir = path.join(REPO, 'test/fixtures');
		const files = fs.readdirSync(dir).filter((f) => /^codegen\.config.*\.yaml$/.test(f));
		expect(files.length).toBeGreaterThanOrEqual(3);
		for (const f of files) expect(() => loadCodegenConfig(path.join(dir, f))).not.toThrow();
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
			const body = fs.readFileSync(file, 'utf-8').split(/^---$/m).slice(2).join('---');
			expect(body).not.toContain('<%');
			expect(() => parseCodegenConfig(yaml.parse(body), file)).not.toThrow();
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
		}
	});

	it('project scan --write', async () => {
		const profile = await scanProject({ directory: REPO });
		const written = proposedConfigYaml(generateConfig(profile));
		expect(Object.keys(written).sort()).toEqual(['generate', 'naming', 'paths']);
		expect(() => parseCodegenConfig(written, 'scan')).not.toThrow();
	});
});

describe('tables kept in step with the schema', () => {
	it('SUBSYSTEM_NAMES is the SUBSYSTEMS descriptor list', () => {
		expect([...SUBSYSTEM_NAMES].sort()).toEqual(SUBSYSTEMS.map((s) => s.name).sort());
	});

	it('the top-level schema is strict', () => {
		expect(CodegenConfigObjectSchema._def.unknownKeys).toBe('strict');
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
