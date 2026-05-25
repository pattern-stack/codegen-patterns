/**
 * Tests for the subsystem noun — summary, install (dry-run + real), list,
 * remove stub. Uses a temp fixture project as the install target so we
 * never touch the user's actual cwd.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Cli } from 'clipanion';

import subsystemNoun from '../../cli/commands/subsystem.js';
import { buildNounSummaryCommand } from '../../cli/noun-module.js';
import { setJsonMode } from '../../cli/ui/json.js';
import {
	detectInstalledSubsystems,
	SUBSYSTEMS,
} from '../../cli/shared/subsystem-detect.js';
import { copyRuntime } from '../../cli/shared/runtime-copier.js';
import { loadContext } from '../../cli/shared/context.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'runtime');

function mkTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsystem-cli-'));
	fs.writeFileSync(
		path.join(dir, 'codegen.config.yaml'),
		'paths:\n  subsystems: src/shared/subsystems\n'
	);
	return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {}
	}
	tempDirs.length = 0;
});

function buildCli() {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const Cls of subsystemNoun.commandClasses) cli.register(Cls);
	cli.register(buildNounSummaryCommand(subsystemNoun));
	return cli;
}

function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((data: string | Uint8Array) => {
		chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
		return true;
	}) as typeof process.stdout.write;

	const origLog = console.log;
	const origWarn = console.warn;
	const origErr = console.error;
	console.log = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' ') + '\n');
	};
	console.warn = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' ') + '\n');
	};
	console.error = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' ') + '\n');
	};

	return (async () => {
		try {
			const result = await fn();
			return { result, out: chunks.join('') };
		} finally {
			process.stdout.write = original;
			console.log = origLog;
			console.warn = origWarn;
			console.error = origErr;
		}
	})();
}

// ---------------------------------------------------------------------------

describe('subsystem — descriptor', () => {
	test('knows all subsystems (six + openapi-config + observability + auth + auth-integrations)', () => {
		// OPENAPI-4: `openapi-config` is a config-only pseudo-subsystem.
		// OBS-7: `observability` is a combiner pseudo-subsystem (ADR-025) —
		// composes sibling read ports via @Optional() DI. Listed here so
		// `codegen subsystem list` / `codegen subsystem` summary surface
		// them alongside the real subsystems.
		// #287: `auth` (runtime subsystem from PR #289) and `auth-integrations`
		// (vendored starter from PR #290) are listed here too.
		expect(SUBSYSTEMS.map((s) => s.name).sort()).toEqual(
			[
				'auth',
				'auth-integrations',
				'bridge',
				'cache',
				'events',
				'jobs',
				'observability',
				'openapi-config',
				'storage',
				'sync',
			].sort()
		);
	});
});

describe('subsystem — summary + list', () => {
	test('summary on a fresh project reports 0 installed', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await capture(() => cli.run(['subsystem', '--cwd', root]));
		expect(result).toBe(0);
		expect(out).toContain('subsystems');
		expect(out).toContain('No subsystems installed yet.');
	});

	test('list --format json emits structured rows', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { out } = await capture(() =>
			cli.run(['subsystem', 'list', '--format', 'json', '--cwd', root])
		);
		const parsed = JSON.parse(out);
		expect(parsed.command).toBe('subsystem list');
		expect(parsed.subsystems).toHaveLength(10); // +openapi-config (OPENAPI-4), +observability (OBS-7), +auth +auth-integrations (#287)
		for (const row of parsed.subsystems) {
			expect(row.status).toBe('available');
		}
	});
});

describe('subsystem — install (dry-run)', () => {
	test('reports planned files without touching disk', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'events',
				'--dry-run',
				'--force',
				'--json',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.subsystem).toBe('events');
		expect(parsed.dryRun).toBe(true);
		expect(parsed.files.planned.length).toBeGreaterThan(0);
		// nothing should have been written
		expect(fs.existsSync(path.join(root, 'src/shared/subsystems/events'))).toBe(false);
	});

	test('rejects unknown subsystem name', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run(['subsystem', 'install', 'unknown-thing', '--cwd', root])
		);
		expect(result).toBe(2);
	});

	test('rejects invalid --backend for subsystem', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--backend', 'local', '--cwd', root])
		);
		expect(result).toBe(2);
	});
});

describe('subsystem — install (real)', () => {
	test('copies runtime/subsystems/events into target + follows deps', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'events',
				'--force',
				'--json',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(0);
		const installDir = path.join(root, 'src/shared/subsystems/events');
		expect(fs.existsSync(installDir)).toBe(true);
		// Core files present
		expect(fs.existsSync(path.join(installDir, 'events.module.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'event-bus.protocol.ts'))).toBe(true);
		// Dependencies (runtime/types/drizzle.ts) copied to parallel tree
		expect(fs.existsSync(path.join(root, 'src/shared/types/drizzle.ts'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'src/shared/constants/tokens.ts'))).toBe(true);
	});

	test('memory backend skips .drizzle-backend.ts; schema is still emitted via Hygen', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'events',
				'--backend',
				'memory',
				'--force',
				'--json',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(0);
		const installDir = path.join(root, 'src/shared/subsystems/events');
		expect(fs.existsSync(path.join(installDir, 'event-bus.memory-backend.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'event-bus.drizzle-backend.ts'))).toBe(false);
		// EVT-8: copyRuntime skips `domain-events.schema.ts` so the Hygen
		// template (which gates the tenancy column on `events.multi_tenant`)
		// is the sole emitter. It uses `force: true` regardless of backend —
		// switching to the drizzle backend later must not require a
		// follow-up scaffold step.
		expect(fs.existsSync(path.join(installDir, 'domain-events.schema.ts'))).toBe(true);
	});

	test('second install is idempotent without --force', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root])
		);
		// Second run
		const { result, out } = await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--json', '--cwd', root])
		);
		expect(result).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.status).toBe('already-installed');
	});

	// #294: mirror the events idempotency check for `auth` and
	// `auth-integrations`. Confirms second-run no-op behaviour survives
	// future template changes — no duplicate config blocks, no duplicate
	// env vars, no duplicate app.module.ts imports.
	test('second auth install is idempotent without --force', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run(['subsystem', 'install', 'auth', '--force', '--cwd', root]),
		);

		const configPath = path.join(root, 'codegen.config.yaml');
		const envConfigPath = path.join(root, '.env.config');
		const appModulePath = path.join(root, 'src/app.module.ts');
		const configBefore = fs.readFileSync(configPath, 'utf-8');
		const envBefore = fs.readFileSync(envConfigPath, 'utf-8');
		const appModuleBefore = fs.existsSync(appModulePath)
			? fs.readFileSync(appModulePath, 'utf-8')
			: '';

		// Second run — no --force.
		const { result, out } = await capture(() =>
			cli.run(['subsystem', 'install', 'auth', '--json', '--cwd', root]),
		);
		expect(result).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.status).toBe('already-installed');

		// Files unchanged — no duplicate auth: block, INTEGRATION_TOKEN_ENCRYPTION_KEY
		// not regenerated, no duplicate AuthModule TODO.
		expect(fs.readFileSync(configPath, 'utf-8')).toBe(configBefore);
		expect(fs.readFileSync(envConfigPath, 'utf-8')).toBe(envBefore);
		const tokenLines = envBefore.match(/^INTEGRATION_TOKEN_ENCRYPTION_KEY=/gm) ?? [];
		expect(tokenLines.length).toBe(1);
		if (fs.existsSync(appModulePath)) {
			expect(fs.readFileSync(appModulePath, 'utf-8')).toBe(appModuleBefore);
		}
	});

	test('second auth-integrations install is idempotent without --force', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'auth-integrations',
				'--force',
				'--cwd',
				root,
			]),
		);

		const appModulePath = path.join(root, 'src/app.module.ts');
		const integrationYamlPath = path.join(
			root,
			'definitions/entities/integration.yaml',
		);
		const appModuleBefore = fs.existsSync(appModulePath)
			? fs.readFileSync(appModulePath, 'utf-8')
			: '';
		const yamlBefore = fs.existsSync(integrationYamlPath)
			? fs.readFileSync(integrationYamlPath, 'utf-8')
			: '';

		const { result, out } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'auth-integrations',
				'--json',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.status).toBe('already-installed');

		// Vendored YAML + app.module.ts unchanged on second run; no duplicate
		// IntegrationsAuthModule TODO appended.
		if (fs.existsSync(integrationYamlPath)) {
			expect(fs.readFileSync(integrationYamlPath, 'utf-8')).toBe(yamlBefore);
		}
		if (fs.existsSync(appModulePath)) {
			const after = fs.readFileSync(appModulePath, 'utf-8');
			expect(after).toBe(appModuleBefore);
			const matches = after.match(/IntegrationsAuthModule/g) ?? [];
			// At most one occurrence (the TODO from first install).
			expect(matches.length).toBeLessThanOrEqual(1);
		}
	});
	// #303: vendored adapters must NOT keep bare-package imports — those
	// fail to resolve through the package's `exports` map and would pin
	// against the publisher's compiled token Symbols rather than the
	// consumer's vendored auth subsystem (duplicate-DI hazard).
	test('auth-integrations install rewrites bare auth imports to relative paths', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'auth-integrations',
				'--force',
				'--cwd',
				root,
			]),
		);

		const integrationsDir = path.join(root, 'src/modules/integrations');
		const files = fs
			.readdirSync(integrationsDir, { withFileTypes: true, recursive: true })
			.filter((d) => d.isFile() && d.name.endsWith('.ts'))
			.map((d) =>
				path.join(
					(d as fs.Dirent & { parentPath?: string }).parentPath ??
						integrationsDir,
					d.name,
				),
			);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const src = fs.readFileSync(file, 'utf-8');
			expect(src).not.toContain('@pattern-stack/codegen/runtime/subsystems/auth');
		}

		// And at least one file should now import from a relative
		// `…/subsystems/auth` path.
		const moduleSrc = fs.readFileSync(
			path.join(integrationsDir, 'integrations-auth.module.ts'),
			'utf-8',
		);
		expect(moduleSrc).toMatch(/from\s+['"]\.\.[^'"]*subsystems\/auth['"]/);
	});

	// #303 fix #5: vendor target lives under <modules>/integrations/, with
	// adapters/, facade/, and oauth/use-cases/ subfolders, alongside the
	// codegen-emitted integration entity module.
	test('auth-integrations install vendors under <modules>/integrations with subfolder layout', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'auth-integrations',
				'--force',
				'--cwd',
				root,
			]),
		);

		const base = path.join(root, 'src/modules/integrations');
		expect(
			fs.existsSync(
				path.join(base, 'adapters/integration-reader.adapter.ts'),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(base, 'adapters/integration-token-writer.adapter.ts'),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(base, 'adapters/integration-grant-sink.adapter.ts'),
			),
		).toBe(true);
		expect(fs.existsSync(path.join(base, 'facade/integrations.service.ts'))).toBe(
			true,
		);
		expect(
			fs.existsSync(
				path.join(
					base,
					'oauth/use-cases/create-or-update-from-oauth-grant.use-case.ts',
				),
			),
		).toBe(true);
		expect(fs.existsSync(path.join(base, 'integrations-auth.module.ts'))).toBe(
			true,
		);

		// The legacy <shared>/integrations/ vendor target must be empty —
		// the new layout replaces it.
		expect(
			fs.existsSync(path.join(root, 'src/shared/integrations')),
		).toBe(false);
	});

	test('auth-integrations install honors paths.modules_dir override', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		// Override modules_dir.
		const configPath = path.join(root, 'codegen.config.yaml');
		fs.writeFileSync(
			configPath,
			'paths:\n  subsystems: src/shared/subsystems\n  modules_dir: src/features\n',
		);
		const cli = buildCli();
		await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'auth-integrations',
				'--force',
				'--cwd',
				root,
			]),
		);
		expect(
			fs.existsSync(
				path.join(
					root,
					'src/features/integrations/integrations-auth.module.ts',
				),
			),
		).toBe(true);
	});
});

describe('subsystem — detection', () => {
	test('detectInstalledSubsystems finds events after install', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root])
		);
		const ctx = await loadContext({ cwd: root, skipDetection: true });
		const installed = await detectInstalledSubsystems(ctx);
		expect(installed.map((i) => i.name)).toContain('events');
	});
});

describe('subsystem — remove stub', () => {
	test('exits 1 with a not-implemented message', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await capture(() =>
			cli.run(['subsystem', 'remove', 'events', '--cwd', root])
		);
		expect(result).toBe(1);
		expect(out.toLowerCase()).toContain('not yet implemented');
	});
});

describe('subsystem — install F13 (config-block preservation)', () => {
	test('--force alone preserves an existing events block (multi_tenant user setting)', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		// First install emits default events block (multi_tenant: false).
		await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root]),
		);

		// Simulate a user edit: nothing fancy — append a sentinel comment so we
		// can detect clobber/preservation without depending on YAML formatting.
		const configPath = path.join(root, 'codegen.config.yaml');
		const original = fs.readFileSync(configPath, 'utf-8');
		const edited =
			original + '\n  # USER-SENTINEL: preserved across --force re-install\n';
		fs.writeFileSync(configPath, edited, 'utf-8');

		// Second install with --force alone — should NOT clobber.
		const { result, out } = await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root]),
		);
		expect(result).toBe(0);

		const after = fs.readFileSync(configPath, 'utf-8');
		expect(after).toContain('USER-SENTINEL');
		expect(out).toContain('already exists');
		expect(out).toContain('--force-config');
	});

	test('--force --force-config overwrites the existing block back to defaults', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root]),
		);

		const configPath = path.join(root, 'codegen.config.yaml');
		const original = fs.readFileSync(configPath, 'utf-8');
		fs.writeFileSync(
			configPath,
			original + '\n  # USER-SENTINEL: should NOT survive --force-config\n',
			'utf-8',
		);

		const { result, out } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'events',
				'--force',
				'--force-config',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(0);

		const after = fs.readFileSync(configPath, 'utf-8');
		expect(after).not.toContain('USER-SENTINEL');
		// Default block must be back.
		expect(after).toContain('events:');
		expect(after).toContain('multi_tenant: false');
		expect(out).toContain('overwriting existing');
	});

	test('parse-error in codegen.config.yaml bails with non-zero exit', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		// Corrupt the YAML before the first install so the config detector hits
		// parse-error. (Must be install-time detectable — runtime copy still
		// runs first, which is fine; we're only asserting the config injection
		// refuses to proceed.)
		const configPath = path.join(root, 'codegen.config.yaml');
		fs.writeFileSync(
			configPath,
			'paths:\n  subsystems: "unterminated\n',
			'utf-8',
		);

		const { result, out } = await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root]),
		);
		expect(result).toBe(1);
		expect(out).toContain('not valid YAML');
		expect(out).toContain('refusing to inject');
	});

	test('first install (no block yet) injects defaults — baseline path still works', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		const { result } = await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root]),
		);
		expect(result).toBe(0);

		const after = fs.readFileSync(
			path.join(root, 'codegen.config.yaml'),
			'utf-8',
		);
		expect(after).toContain('events:');
		expect(after).toContain('backend: drizzle');
	});
});

describe('subsystem — install sync (SYNC-7)', () => {
	test('copies runtime/subsystems/sync into target + follows deps', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run(['subsystem', 'install', 'sync', '--force', '--json', '--cwd', root])
		);
		expect(result).toBe(0);
		const installDir = path.join(root, 'src/shared/subsystems/sync');
		expect(fs.existsSync(installDir)).toBe(true);
		// Core files present.
		expect(fs.existsSync(path.join(installDir, 'sync.module.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'sync-change-source.protocol.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'execute-sync.use-case.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'deep-equal.differ.ts'))).toBe(true);
		// Drizzle backends present (default backend).
		expect(fs.existsSync(path.join(installDir, 'sync-cursor-store.drizzle-backend.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'sync-run-recorder.drizzle-backend.ts'))).toBe(true);
		// Memory backends present too — always copied for tests.
		expect(fs.existsSync(path.join(installDir, 'sync-cursor-store.memory-backend.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'sync-run-recorder.memory-backend.ts'))).toBe(true);
		// Shared deps copied to parallel tree.
		expect(fs.existsSync(path.join(root, 'src/shared/types/drizzle.ts'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'src/shared/constants/tokens.ts'))).toBe(true);
	});

	test('schema is emitted via Hygen (not copyRuntime), with tenant_id always present', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run(['subsystem', 'install', 'sync', '--force', '--json', '--cwd', root])
		);
		expect(result).toBe(0);
		const schemaPath = path.join(
			root,
			'src/shared/subsystems/sync/sync-audit.schema.ts',
		);
		expect(fs.existsSync(schemaPath)).toBe(true);
		const schema = fs.readFileSync(schemaPath, 'utf8');
		// Hygen-templated (not copyRuntime): the generator banner is present.
		expect(schema).toContain('subsystem sync generator');
		// tenant_id is ALWAYS emitted now (even under multi_tenant: false): the
		// runtime sync code references it unconditionally, so the previously-gated
		// form broke multi_tenant:false consumers' typecheck. SYNC_MULTI_TENANT
		// gates enforcement, not the column's existence.
		expect(schema).toContain("text('tenant_id')");
	});

	test('config block appended to codegen.config.yaml', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run(['subsystem', 'install', 'sync', '--force', '--cwd', root]),
		);
		const after = fs.readFileSync(path.join(root, 'codegen.config.yaml'), 'utf8');
		expect(after).toContain('sync:');
		expect(after).toContain('backend: drizzle');
		expect(after).toContain('multi_tenant: false');
	});

	test('memory backend skips .drizzle-backend.ts; schema still emitted via Hygen', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'sync',
				'--backend',
				'memory',
				'--force',
				'--json',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(0);
		const installDir = path.join(root, 'src/shared/subsystems/sync');
		expect(
			fs.existsSync(path.join(installDir, 'sync-cursor-store.drizzle-backend.ts')),
		).toBe(false);
		expect(
			fs.existsSync(path.join(installDir, 'sync-run-recorder.drizzle-backend.ts')),
		).toBe(false);
		// Memory backends are always present.
		expect(
			fs.existsSync(path.join(installDir, 'sync-cursor-store.memory-backend.ts')),
		).toBe(true);
		// Schema still emitted (Hygen-driven, backend-independent).
		expect(
			fs.existsSync(path.join(installDir, 'sync-audit.schema.ts')),
		).toBe(true);
	});

	test('detectInstalledSubsystems finds sync after install', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run(['subsystem', 'install', 'sync', '--force', '--cwd', root]),
		);
		const ctx = await loadContext({ cwd: root, skipDetection: true });
		const installed = await detectInstalledSubsystems(ctx);
		expect(installed.map((i) => i.name)).toContain('sync');
	});

	test('multi_tenant: true in config emits tenant_id columns in schema', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		// Hand-write a config with sync.multi_tenant: true.
		fs.writeFileSync(
			path.join(root, 'codegen.config.yaml'),
			'paths:\n  subsystems: src/shared/subsystems\nsync:\n  backend: drizzle\n  multi_tenant: true\n',
		);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run(['subsystem', 'install', 'sync', '--force', '--cwd', root]),
		);
		expect(result).toBe(0);
		const schema = fs.readFileSync(
			path.join(root, 'src/shared/subsystems/sync/sync-audit.schema.ts'),
			'utf8',
		);
		expect(schema).toContain("text('tenant_id')");
	});
});

describe('runtime-copier unit', () => {
	test('dry-run populates planned[] without writing', async () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), 'copier-'));
		tempDirs.push(target);
		const result = await copyRuntime({
			sourceDir: path.join(RUNTIME_ROOT, 'subsystems', 'events'),
			targetDir: path.join(target, 'events'),
			resolveDeps: false,
			dryRun: true,
		});
		expect(result.planned.length).toBeGreaterThan(0);
		expect(result.written).toHaveLength(0);
		expect(fs.existsSync(path.join(target, 'events'))).toBe(false);
	});

	test('non-dry-run writes files and reports unchanged on second run', async () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), 'copier2-'));
		tempDirs.push(target);
		const r1 = await copyRuntime({
			sourceDir: path.join(RUNTIME_ROOT, 'subsystems', 'cache'),
			targetDir: path.join(target, 'cache'),
			resolveDeps: false,
		});
		expect(r1.written.length).toBeGreaterThan(0);
		const r2 = await copyRuntime({
			sourceDir: path.join(RUNTIME_ROOT, 'subsystems', 'cache'),
			targetDir: path.join(target, 'cache'),
			resolveDeps: false,
		});
		expect(r2.unchanged.length).toBe(r1.written.length);
		expect(r2.written.length).toBe(0);
	});
});
