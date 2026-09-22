/**
 * CFG-1 (#643) — `<generated>/app-config.ts`: the boot-time config values the
 * generator writes so the consumer's app never parses `codegen.config.yaml`.
 * GEN-0 (#652) — including the standalone worker's `jobWorkerOptions`.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAppConfigContent, syncAppConfig } from '../../cli/shared/app-config-generator.js';
import { jobWorkerBackendOptions } from '../../cli/shared/job-worker-options.js';
import { buildSubsystemBarrel } from '../../cli/shared/subsystem-barrel-generator.js';
import { mainTsContent } from '../../cli/shared/init-scaffold.js';
import { projectLayout } from '../../cli/shared/project-layout.js';
import { parseCodegenConfig } from '../../config/project-config.js';

/** A stand-in for the module's own `jobPools`, which `jobWorkerOptions` references. */
const JOB_POOLS = Symbol('jobPools');

/** The object literal after `export const <name> =` (JSON plus bare `undefined`), evaluated. */
function exported(content: string, name: string): unknown {
	const m = content.match(new RegExp(`export const ${name} = ([\\s\\S]*?) as const;`));
	if (!m) throw new Error(`no export ${name}`);
	return new Function('jobPools', `return (${m[1]!});`)(JOB_POOLS);
}

describe('buildAppConfigContent (CFG-1)', () => {
	test('no config file ⇒ the schema defaults', () => {
		const content = buildAppConfigContent(null);
		expect(content).toStartWith('// @generated');
		expect(exported(content, 'openapiConfig')).toEqual({
			enabled: false,
			path: '/docs',
			title: 'API',
			version: '0.0.0',
			auth: 'bearer',
		});
		expect(exported(content, 'authConfig')).toEqual({ devAllowAnonymous: false });
		expect(exported(content, 'jobPools')).toEqual({});
		// An optional key is emitted as `undefined`, so its `as const` type has it.
		expect(content).toContain('"description": undefined');
	});

	test('a config with no openapi / auth / jobs blocks ⇒ the same defaults', () => {
		expect(buildAppConfigContent(parseCodegenConfig({}, 'x.yaml'))).toBe(buildAppConfigContent(null));
	});

	test('declared values are emitted as parsed', () => {
		const config = parseCodegenConfig(
			{
				openapi: { enabled: true, path: '/reference', title: 'Shop', version: '2.1.0', description: 'd', auth: 'none' },
				auth: { devAllowAnonymous: true },
				jobs: { pools: { batch: { concurrency: 8 }, reports: { queue: 'jobs-reports', concurrency: 2 } } },
			},
			'x.yaml',
		);
		const content = buildAppConfigContent(config);
		expect(exported(content, 'openapiConfig')).toEqual({
			enabled: true,
			path: '/reference',
			title: 'Shop',
			version: '2.1.0',
			description: 'd',
			auth: 'none',
		});
		expect(exported(content, 'authConfig')).toEqual({ devAllowAnonymous: true });
		expect(exported(content, 'jobPools')).toEqual({
			batch: { concurrency: 8 },
			reports: { queue: 'jobs-reports', concurrency: 2 },
		});
	});

	test('syncAppConfig writes once, then reports unchanged', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-config-'));
		try {
			expect(syncAppConfig(dir, null, true)).toBe('created');
			expect(fs.existsSync(path.join(dir, 'app-config.ts'))).toBe(false);
			expect(syncAppConfig(dir, null, false)).toBe('created');
			expect(syncAppConfig(dir, null, false)).toBe('unchanged');
			expect(syncAppConfig(dir, parseCodegenConfig({ auth: { devAllowAnonymous: true } }, 'x.yaml'), false)).toBe(
				'updated',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('jobWorkerOptions — the standalone worker (GEN-0, #652)', () => {
	const jobs = (block: Record<string, unknown>) =>
		buildAppConfigContent(parseCodegenConfig({ jobs: block }, 'x.yaml'));

	test('drizzle default: mode standalone, the pools, allPools', () => {
		expect(exported(buildAppConfigContent(null), 'jobWorkerOptions')).toEqual({
			mode: 'standalone',
			domainModulePools: JOB_POOLS,
			allPools: true,
		});
	});

	test('drizzle knobs flow into domainModuleExtensions (camelCase)', () => {
		expect(
			exported(jobs({ extensions: { drizzle: { listen_notify: true, poll_interval_ms: 500 } } }), 'jobWorkerOptions'),
		).toEqual({
			mode: 'standalone',
			domainModuleExtensions: { drizzle: { listenNotify: true, pollIntervalMs: 500 } },
			domainModulePools: JOB_POOLS,
			allPools: true,
		});
	});

	test('bullmq threads backend + its extension block', () => {
		const opts = exported(
			jobs({ backend: 'bullmq', extensions: { bullmq: { redis_url: 'redis://localhost:6379' } } }),
			'jobWorkerOptions',
		) as Record<string, unknown>;
		expect(opts.mode).toBe('standalone');
		expect(opts.backend).toBe('bullmq');
		expect((opts.domainModuleExtensions as { bullmq: { redis_url: string } }).bullmq.redis_url).toBe(
			'redis://localhost:6379',
		);
		expect(opts.allPools).toBe(true);
	});

	test('the embedded worker in subsystems.ts carries the same backend/extension options (one builder)', () => {
		const block = { worker_mode: 'embedded', extensions: { drizzle: { listen_notify: true, poll_interval_ms: 500 } } };
		const barrel = buildSubsystemBarrel(
			[{ name: 'jobs', path: '/fake/jobs', backend: 'drizzle', status: 'installed' }],
			{ jobs: block },
			'./shared/subsystems',
		);
		expect(barrel.content).toContain(
			"JobWorkerModule.forRoot({ mode: 'embedded', domainModuleExtensions: { drizzle: { listenNotify: true, pollIntervalMs: 500 } }, domainModulePools: jobPools }),",
		);
		expect(jobWorkerBackendOptions(block)).toEqual({
			domainModuleExtensions: { drizzle: { listenNotify: true, pollIntervalMs: 500 } },
		});
	});
});

describe('generated main.ts reads the generated module, never the YAML (CFG-1)', () => {
	for (const mode of ['package', 'vendored'] as const) {
		test(mode, () => {
			const layout = projectLayout('/p', parseCodegenConfig({ paths: { backend_src: 'apps/api/src', generated: 'apps/api/gen' } }, 'x.yaml'));
			const main = mainTsContent(mode, layout);
			expect(main).toContain(`from '../gen/app-config';`);
			expect(main).toContain('openapiConfig.enabled');
			for (const gone of ['codegen.config.yaml\'', 'parseYaml', "from 'yaml'", 'node:fs', 'interface OpenApiConfig', 'interface AuthConfig', "?? 'API'"]) {
				expect(main).not.toContain(gone);
			}
			// authConfig is imported only where main.ts wires the boot-fail check.
			expect(main.includes('import { authConfig, openapiConfig }')).toBe(mode === 'package');
			expect(main.includes('authConfig.devAllowAnonymous')).toBe(mode === 'package');
		});
	}
});
