/**
 * Integration tests for `codegen project upgrade-openapi`.
 *
 * Runs the `runUpgradeOpenapi` function directly (same entry point the
 * Clipanion command uses) against tmp fixtures representing pre-0.4.0
 * consumer projects.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runUpgradeOpenapi } from '../../cli/commands/project-upgrade-openapi.js';

let tempRoots: string[] = [];

function mkTempDir(prefix: string): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), `upgrade-oapi-${prefix}-`));
	tempRoots.push(d);
	return d;
}

afterEach(() => {
	for (const r of tempRoots) {
		try {
			fs.rmSync(r, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
	tempRoots = [];
});

function seedPre041(cwd: string): void {
	fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, 'src', 'app.module.ts'),
		`import { Module } from '@nestjs/common';
import { DatabaseModule } from './shared/database/database.module';
import { GENERATED_MODULES } from './generated/modules';

/**
 * AppModule — pre-0.4.0 shape (no OpenApiModule).
 */
@Module({
  imports: [DatabaseModule, ...GENERATED_MODULES],
})
export class AppModule {}
`
	);
	fs.writeFileSync(
		path.join(cwd, 'src', 'main.ts'),
		`import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}

bootstrap();
`
	);
	fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"consumer-pre-041"}');
}

describe('runUpgradeOpenapi', () => {
	test('patches a pre-0.4.0 app.module.ts + main.ts', async () => {
		const cwd = mkTempDir('happy');
		seedPre041(cwd);

		const report = await runUpgradeOpenapi({ projectRoot: cwd, dryRun: false, force: false });
		expect(report.bail).toBeUndefined();

		const appText = fs.readFileSync(path.join(cwd, 'src', 'app.module.ts'), 'utf-8');
		expect(appText).toContain("import { Module, Global } from '@nestjs/common'");
		expect(appText).toContain("from './shared/openapi'");
		expect(appText).toContain('class OpenApiModule {}');
		// OpenApiModule must appear BEFORE the spread (convention).
		const openIdx = appText.indexOf('OpenApiModule, ...GENERATED_MODULES');
		expect(openIdx).toBeGreaterThan(-1);

		const mainText = fs.readFileSync(path.join(cwd, 'src', 'main.ts'), 'utf-8');
		expect(mainText).toMatch(/SwaggerModule\.setup/);
		expect(mainText).toContain("from './shared/openapi'");

		// Vendored files created
		expect(fs.existsSync(path.join(cwd, 'src', 'shared', 'openapi', 'registry.ts'))).toBe(true);
		expect(fs.existsSync(path.join(cwd, 'src', 'shared', 'openapi', 'index.ts'))).toBe(true);

		// Summary reports at least one created + one updated change.
		const updated = report.changes.filter((c) => c.action === 'updated');
		const created = report.changes.filter((c) => c.action === 'created');
		expect(updated.some((c) => c.path === 'src/app.module.ts')).toBe(true);
		expect(updated.some((c) => c.path === 'src/main.ts')).toBe(true);
		expect(created.length).toBeGreaterThan(0);
	});

	test('is idempotent — running twice leaves files byte-identical', async () => {
		const cwd = mkTempDir('idempotent');
		seedPre041(cwd);

		await runUpgradeOpenapi({ projectRoot: cwd, dryRun: false, force: false });
		const afterFirst = {
			app: fs.readFileSync(path.join(cwd, 'src', 'app.module.ts'), 'utf-8'),
			main: fs.readFileSync(path.join(cwd, 'src', 'main.ts'), 'utf-8'),
		};

		const report2 = await runUpgradeOpenapi({
			projectRoot: cwd,
			dryRun: false,
			force: false,
		});
		expect(report2.bail).toBeUndefined();

		const afterSecond = {
			app: fs.readFileSync(path.join(cwd, 'src', 'app.module.ts'), 'utf-8'),
			main: fs.readFileSync(path.join(cwd, 'src', 'main.ts'), 'utf-8'),
		};
		expect(afterSecond.app).toBe(afterFirst.app);
		expect(afterSecond.main).toBe(afterFirst.main);

		// Every change from the second run must be unchanged / skipped
		// (nothing should be re-updated).
		const nonNoop = report2.changes.filter(
			(c) => c.action !== 'unchanged' && c.action !== 'skipped'
		);
		expect(nonNoop.length).toBe(0);
	});

	test('dry-run writes no files', async () => {
		const cwd = mkTempDir('dryrun');
		seedPre041(cwd);
		const appBefore = fs.readFileSync(path.join(cwd, 'src', 'app.module.ts'), 'utf-8');
		const mainBefore = fs.readFileSync(path.join(cwd, 'src', 'main.ts'), 'utf-8');

		const report = await runUpgradeOpenapi({
			projectRoot: cwd,
			dryRun: true,
			force: false,
		});
		expect(report.bail).toBeUndefined();

		expect(fs.readFileSync(path.join(cwd, 'src', 'app.module.ts'), 'utf-8')).toBe(appBefore);
		expect(fs.readFileSync(path.join(cwd, 'src', 'main.ts'), 'utf-8')).toBe(mainBefore);
		expect(fs.existsSync(path.join(cwd, 'src', 'shared', 'openapi', 'registry.ts'))).toBe(
			false
		);
		// But the report still lists the planned changes.
		expect(report.changes.some((c) => c.action === 'updated' || c.action === 'created')).toBe(
			true
		);
	});

	test('bails with clear message when AppModule is missing', async () => {
		const cwd = mkTempDir('bail');
		fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
		fs.writeFileSync(path.join(cwd, 'package.json'), '{}');

		const report = await runUpgradeOpenapi({
			projectRoot: cwd,
			dryRun: false,
			force: false,
		});
		expect(report.bail).toBeDefined();
		expect(report.bail?.file).toBe('src/app.module.ts');
	});

	test('bails with snippet when AppModule uses a non-array imports', async () => {
		const cwd = mkTempDir('bail-exotic');
		fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
		fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
		fs.writeFileSync(
			path.join(cwd, 'src', 'app.module.ts'),
			`import { Module } from '@nestjs/common';
const ALL_IMPORTS = [];
@Module({ imports: ALL_IMPORTS })
export class AppModule {}
`
		);

		const report = await runUpgradeOpenapi({
			projectRoot: cwd,
			dryRun: false,
			force: false,
		});
		expect(report.bail).toBeDefined();
		expect(report.bail?.snippet).toContain('OpenApiModule');
	});

	test('skips main.ts cleanly when SwaggerModule.setup already wired', async () => {
		const cwd = mkTempDir('main-already');
		seedPre041(cwd);
		// Replace main.ts with one that already has Swagger wired.
		fs.writeFileSync(
			path.join(cwd, 'src', 'main.ts'),
			`import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  SwaggerModule.setup('/docs', app, SwaggerModule.createDocument(app, new DocumentBuilder().build()));
  await app.listen(3000);
}
bootstrap();
`
		);
		const before = fs.readFileSync(path.join(cwd, 'src', 'main.ts'), 'utf-8');

		const report = await runUpgradeOpenapi({
			projectRoot: cwd,
			dryRun: false,
			force: false,
		});
		expect(report.bail).toBeUndefined();

		expect(fs.readFileSync(path.join(cwd, 'src', 'main.ts'), 'utf-8')).toBe(before);
		const mainChange = report.changes.find((c) => c.path === 'src/main.ts');
		expect(mainChange?.action).toBe('unchanged');
	});
});
