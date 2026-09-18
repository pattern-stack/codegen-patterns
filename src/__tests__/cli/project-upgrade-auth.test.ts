/**
 * `project upgrade-auth` (ADR-043) — CFG-1: the patched boot-fail block reads
 * `authConfig` from the generated `<generated>/app-config.ts`, never the YAML,
 * and every target resolves from `paths.*` (it used to hard-code `src/`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUpgradeAuth } from '../../cli/commands/project-upgrade-auth.js';

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function seed(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-auth-'));
	roots.push(root);
	const src = path.join(root, 'apps', 'api', 'src');
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(
		path.join(root, 'codegen.config.yaml'),
		'runtime: vendored\npaths:\n  backend_src: apps/api/src\nauth:\n  devAllowAnonymous: true\n',
	);
	fs.writeFileSync(
		path.join(src, 'app.module.ts'),
		"import { Module } from '@nestjs/common';\n\n@Module({ imports: [] })\nexport class AppModule {}\n",
	);
	fs.writeFileSync(
		path.join(src, 'main.ts'),
		"import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\n\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\nbootstrap();\n",
	);
	return root;
}

describe('runUpgradeAuth (CFG-1)', () => {
	test('patches <backend_src>/main.ts to read the generated authConfig', async () => {
		const root = seed();
		const report = await runUpgradeAuth({ projectRoot: root, dryRun: false });
		expect(report.bail).toBeUndefined();

		const main = fs.readFileSync(path.join(root, 'apps/api/src/main.ts'), 'utf-8');
		expect(main).toContain('installRequesterContext(app)');
		expect(main).toContain('authConfig.devAllowAnonymous');
		// #651: the probe is resolveUserContext, on an app that throws (not exits).
		expect(main).toContain('const userContext = resolveUserContext(app);');
		expect(main).toContain('NestFactory.create(AppModule, { abortOnError: false })');
		expect(main).toContain("import { authConfig } from './generated/app-config';");
		expect(main).toContain("from './shared/subsystems/auth';");
		expect(main).not.toContain("'codegen.config.yaml'");
		expect(main).not.toContain('parseYaml');

		const appConfig = fs.readFileSync(path.join(root, 'apps/api/src/generated/app-config.ts'), 'utf-8');
		expect(appConfig).toContain('"devAllowAnonymous": true');

		expect(report.changes.map((c) => [c.path, c.action])).toEqual([
			['apps/api/src/app.module.ts', 'updated'],
			['apps/api/src/generated/app-config.ts', 'created'],
			['apps/api/src/main.ts', 'updated'],
		]);
	});

	test('adds abortOnError to inline create options; bails on abortOnError: true (#651)', async () => {
		const root = seed();
		const mainPath = path.join(root, 'apps/api/src/main.ts');
		const withOpts = (opts: string) =>
			fs.writeFileSync(
				mainPath,
				fs.readFileSync(mainPath, 'utf-8').replace(/NestFactory\.create\(AppModule[^)]*\)/, `NestFactory.create(AppModule, ${opts})`),
			);
		withOpts('{ bufferLogs: true }');
		await runUpgradeAuth({ projectRoot: root, dryRun: false });
		expect(fs.readFileSync(mainPath, 'utf-8')).toMatch(/NestFactory\.create\(AppModule, \{\s*bufferLogs: true,\s*abortOnError: false\s*\}\)/);

		const other = seed();
		const otherMain = path.join(other, 'apps/api/src/main.ts');
		fs.writeFileSync(
			otherMain,
			fs.readFileSync(otherMain, 'utf-8').replace('NestFactory.create(AppModule)', 'NestFactory.create(AppModule, { abortOnError: true })'),
		);
		const report = await runUpgradeAuth({ projectRoot: other, dryRun: false });
		const mainChange = report.changes.find((c) => c.path === 'apps/api/src/main.ts');
		expect(mainChange?.action).toBe('skipped');
		expect(mainChange?.note).toContain('abortOnError');
	});

	test('adds a missing authConfig import to a main.ts that already has the block', async () => {
		const root = seed();
		await runUpgradeAuth({ projectRoot: root, dryRun: false });
		const mainPath = path.join(root, 'apps/api/src/main.ts');
		const withBlock = fs.readFileSync(mainPath, 'utf-8');
		const stripped = withBlock.replace("import { authConfig } from './generated/app-config';\n", '');
		expect(stripped).not.toContain("from './generated/app-config'");
		fs.writeFileSync(mainPath, stripped);

		const report = await runUpgradeAuth({ projectRoot: root, dryRun: false });
		const main = fs.readFileSync(mainPath, 'utf-8');
		expect(main).toContain("import { authConfig } from './generated/app-config';");
		expect(main.match(/installRequesterContext\(app\)/g)).toHaveLength(1);
		expect(report.changes.find((c) => c.path === 'apps/api/src/main.ts')?.action).toBe('updated');
	});

	test('is idempotent', async () => {
		const root = seed();
		await runUpgradeAuth({ projectRoot: root, dryRun: false });
		const second = await runUpgradeAuth({ projectRoot: root, dryRun: false });
		expect(second.changes.every((c) => c.action === 'unchanged')).toBe(true);
	});
});
