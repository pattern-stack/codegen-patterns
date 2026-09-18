/**
 * CFG-1 (#643) — `<generated>/app-config.ts`: the boot-time config values the
 * generator writes so the consumer's app never parses `codegen.config.yaml`.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAppConfigContent, syncAppConfig } from '../../cli/shared/app-config-generator.js';
import { mainTsContent } from '../../cli/shared/init-scaffold.js';
import { projectLayout } from '../../cli/shared/project-layout.js';
import { parseCodegenConfig } from '../../config/project-config.js';

/** The object literal after `export const <name> =` (JSON plus bare `undefined`), evaluated. */
function exported(content: string, name: string): unknown {
	const m = content.match(new RegExp(`export const ${name} = ([\\s\\S]*?) as const;`));
	if (!m) throw new Error(`no export ${name}`);
	return new Function(`return (${m[1]!});`)();
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
