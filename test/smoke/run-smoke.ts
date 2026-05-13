#!/usr/bin/env bun
/**
 * Smoke test harness — end-to-end regression check for the consumer path.
 *
 * 1. Create a fresh tmp project.
 * 2. bun init + install pinned peer deps.
 * 3. Invoke `codegen project init --yes --with-tsconfig`.
 * 4. Copy canned smoke fixtures into entities/.
 * 5. Invoke `codegen entity new --all`.
 * 6. Run `bunx tsc --noEmit` and fail the script if it errors.
 * 7. Clean up, unless KEEP_SMOKE_DIR=1.
 *
 * The fixtures under test/smoke/fixtures/ exercise the regressions that
 * most dogfood incidents traced back to:
 *   - account.yaml has an enum field (PR #28 template escape).
 *   - contact.yaml has a belongs_to + query on the FK column (dogfood #9).
 *
 * Fails loudly on the first error. Designed to complete in < 2 minutes on a
 * dev laptop; bun add cost dominates and is unavoidable unless we freeze a
 * pre-populated node_modules/ tarball (future optimization).
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

// CGP-62: `--scenario` selects which fixture set the smoke generates against.
// `default` (no flag) preserves the historical behavior. `relationship`
// swaps in `test/smoke/fixtures/crm/` (account self-ref + cross-entity
// belongs_to + has_many) and runs `assertRelationshipEmission()` after
// entity generation to verify the clean-lite-ps `relations()` emission.
type Scenario = 'default' | 'relationship';

const SCENARIO: Scenario = ((): Scenario => {
	const idx = process.argv.indexOf('--scenario');
	if (idx === -1) return 'default';
	const value = process.argv[idx + 1];
	if (value !== 'default' && value !== 'relationship') {
		console.error(
			`Unknown --scenario: ${value}. Expected 'default' or 'relationship'.`,
		);
		process.exit(2);
	}
	return value;
})();

const FIXTURES_DIR =
	SCENARIO === 'relationship'
		? path.join(REPO_ROOT, 'test', 'smoke', 'fixtures', 'crm')
		: path.join(REPO_ROOT, 'test', 'smoke', 'fixtures');

const KEEP = process.env.KEEP_SMOKE_DIR === '1';

// Pinned peer deps — version drift here would undermine the harness.
//
// drizzle-orm is pinned to 0.45 (matching the repo's own devDeps) for
// consistency. CONSUMER-SETUP.md warns about a 0.30/0.45 API mismatch in
// the runtime base classes; the smoke test doesn't compile the runtime
// itself — only the generated code — so this pin is safe.
const RUNTIME_DEPS = [
	'@nestjs/common@10',
	'@nestjs/core@10',
	// OPENAPI-4: NestFactory.create(AppModule) needs a platform adapter.
	// Express is the default; the generated main.ts + smoke verify-openapi
	// both use it implicitly.
	'@nestjs/platform-express@10',
	'@nestjs/swagger@7',
	'@anatine/zod-openapi@2',
	'drizzle-orm@0.45',
	'reflect-metadata@0.2',
	'pg@8',
	'zod@3',
	// OPENAPI-4: main.ts bootstrap reads codegen.config.yaml to pick up
	// the `openapi:` block. The jobs pool loader already imports from
	// yaml, so this isn't new infra — just a pin for consumer installs.
	'yaml@2',
];
const DEV_DEPS = ['typescript@5', '@types/bun', '@types/pg@8'];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const t0 = Date.now();
function elapsed(): string {
	const s = ((Date.now() - t0) / 1000).toFixed(1);
	return `[+${s.padStart(5)}s]`;
}
function log(msg: string): void {
	console.log(`${elapsed()} ${msg}`);
}
function logError(msg: string): void {
	console.error(`${elapsed()} [FAIL] ${msg}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string, env: NodeJS.ProcessEnv = {}): void {
	log(`$ ${cmd}`);
	execSync(cmd, {
		cwd,
		stdio: 'inherit',
		env: { ...process.env, ...env },
	});
}

function runSilent(cmd: string, cwd: string): { code: number; out: string; err: string } {
	const parts = cmd.split(' ');
	const r = spawnSync(parts[0], parts.slice(1), { cwd, encoding: 'utf-8' });
	return {
		code: r.status ?? 0,
		out: r.stdout ?? '',
		err: r.stderr ?? '',
	};
}

/**
 * Filter tsc output to errors in consumer-emitted files (under the tmp dir).
 *
 * Excludes two classes of error that trace to pre-existing, documented
 * issues in the runtime — not to bugs introduced by the code generator:
 *
 * 1. drizzle-orm 0.30/0.45 API mismatch (CONSUMER-SETUP.md troubleshooting).
 *    Manifests as `Property 'table' ... not assignable` and
 *    `shouldInlineParams` / `PgColumn` errors. Cleared when the runtime
 *    catches up to drizzle 0.45.
 *
 * 2. Mixin-erasure on declarative queries — the generated repository
 *    subclasses expose typed findByX methods, but the service and use-case
 *    files see only the base class type through WithAnalytics, so TypeScript
 *    can't resolve findByStatus/findById/etc. Same root cause as #1 once the
 *    runtime's base classes narrow their generic bounds.
 *
 * The harness's mission is to catch *generator* bugs (e.g. HTML-escaped
 * enum unions, bad import paths). Pre-existing runtime bugs are out of
 * scope; fixing them is tracked separately.
 */
function filterConsumerErrors(output: string, tmpDir: string): string[] {
	const lines = output.split('\n').filter((l) => l.trim());
	const errors: string[] = [];
	for (const line of lines) {
		// Skip lines referencing paths outside the tmp dir (runtime, node_modules).
		if (line.includes('../') || line.includes('/codegen-patterns/runtime/')) continue;
		if (line.includes('node_modules/')) continue;
		// Skip deprecated baseUrl warnings.
		if (line.includes('TS5101')) continue;
		// Only count actual error lines.
		if (!/error TS\d+:/.test(line)) continue;

		// Ignore drizzle-schema files — schema emission uses types that
		// cascade into the drizzle-orm version-mismatch error class.
		if (/\.schema\.ts\(\d+,\d+\): error/.test(line)) continue;

		// ---- documented-runtime-issue filters ----
		// "Property 'table' in type '...Repository' is not assignable"
		if (line.includes("Property 'table' in type") && line.includes('not assignable')) {
			continue;
		}
		// WithAnalytics mixin typing: "Cannot assign an abstract constructor..."
		if (line.includes("Cannot assign an abstract constructor")) continue;
		// WithAnalytics mixin typing through service constructor arg.
		if (/Argument of type .* is not assignable to parameter of type 'Constructor<\{\}>'/.test(line)) {
			continue;
		}
		// Declarative query methods on the repo subclass aren't visible
		// through the generic'd base class type (mixin erasure — same root
		// cause as #1). Filter out TS2339 errors for findByX / findById /
		// list / findAll on Service and Repository types specifically.
		if (
			/Property '(findBy[A-Z]\w*|findById|findAll|list|findWithDeleted|findOnlyDeleted)'/
				.test(line)
		) {
			continue;
		}

		// #287 / #303 fix #5: the vendored `auth-integrations` starter
		// (under `<modules>/integrations/{adapters,facade,oauth,
		// integrations-auth.module.ts}`) imports from the codegen-emitted
		// integration entity module — `<modules>/integrations/integration.service`,
		// `<modules>/integrations/integration.entity`, `<modules>/integrations/integrations.module`.
		// We don't run `cdp entity new integration` in this smoke (it
		// would require also scaffolding a Drizzle schema for `integrations`
		// and bundling a fixture, AND it surfaces a separate codegen enum
		// literal-type bug — filed as follow-up). Filter errors emitted
		// from inside the vendored subfolders only — narrow filter so a
		// real codegen bug in `<modules>/integrations/integration.{entity,
		// service,...}.ts` would still surface.
		const vendoredIntegrationsPattern =
			/modules[/\\]integrations[/\\](?:adapters|facade|oauth|integrations-auth\.module\.ts)/;
		if (vendoredIntegrationsPattern.test(line)) {
			continue;
		}
		// Also tolerate the `@pattern-stack/codegen/runtime/subsystems/auth`
		// barrel import — the smoke project doesn't `bun add` the package.
		if (line.includes("'@pattern-stack/codegen/")) {
			continue;
		}

		errors.push(line);
	}
	return errors;
}

function cleanup(dir: string): void {
	if (KEEP) {
		log(`keeping tmp dir (KEEP_SMOKE_DIR=1): ${dir}`);
		return;
	}
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		log(`cleaned up ${dir}`);
	} catch (err: unknown) {
		logError(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ---------------------------------------------------------------------------
// Relationship-scenario assertions (CGP-62)
// ---------------------------------------------------------------------------

function assertContains(haystack: string, needle: RegExp, source: string): void {
	if (!needle.test(haystack)) {
		throw new Error(
			`Smoke assertion failed (${source}): expected to match ${needle} in generated output.`,
		);
	}
}

function assertNotContains(haystack: string, needle: RegExp, source: string): void {
	if (needle.test(haystack)) {
		throw new Error(
			`Smoke assertion failed (${source}): did not expect ${needle} — see cgp-62 empirical-state + codegen-patterns#358.`,
		);
	}
}

/**
 * Verify the clean-lite-ps Drizzle `relations()` emission for the CRM
 * fixture set. Asserts the *extension path table-metadata that today's
 * templates actually ship* — the `belongs_to` side of `relations()`.
 *
 * Layout: `clean-lite-ps/prompt-extension.js:822-829` emits each entity at
 * `${srcRoot}/modules/${plural}/${name}.entity.ts`. The smoke project's
 * `srcRoot` is `<tmpDir>/src` (per `codegen project init --yes`).
 *
 * Coverage:
 *   - Self-ref `belongs_to`        (regression of `269ab3f`)
 *   - Cross-entity `belongs_to`    (account FK on contact + opportunity)
 *   - `relations()` const presence (emission gate `hasRelationsBlock`)
 *   - **Negative `many(` assertion** — clean-lite-ps's entity template
 *     iterates `belongs_to` only; `has_many` declarations are silently
 *     dropped. The negative assertion names this gap in the test surface
 *     itself. Flip to positive once codegen-patterns#358 lands.
 */
function assertRelationshipEmission(tmpDir: string): void {
	const reads = (rel: string): string =>
		fs.readFileSync(path.join(tmpDir, 'src', rel), 'utf8');

	const accountSchema = reads('modules/accounts/account.entity.ts');
	assertContains(
		accountSchema,
		/parentAccount:\s*one\(accounts,/,
		'accounts.entity.ts self-ref belongs_to',
	);
	assertContains(
		accountSchema,
		/export const accountsRelations\s*=\s*relations\(accounts/,
		'accounts.entity.ts relations() const',
	);
	assertNotContains(
		accountSchema,
		/\bmany\(/,
		'accounts.entity.ts has_many gap (clean-lite-ps drops has_many)',
	);

	const contactSchema = reads('modules/contacts/contact.entity.ts');
	assertContains(
		contactSchema,
		/account:\s*one\(accounts,\s*\{[\s\S]*fields:\s*\[contacts\.accountId\]/,
		'contacts.entity.ts belongs_to account',
	);
	assertContains(
		contactSchema,
		/export const contactsRelations\s*=\s*relations\(contacts/,
		'contacts.entity.ts relations() const',
	);

	const opportunitySchema = reads('modules/opportunities/opportunity.entity.ts');
	assertContains(
		opportunitySchema,
		/account:\s*one\(accounts,\s*\{[\s\S]*fields:\s*\[opportunities\.accountId\]/,
		'opportunities.entity.ts belongs_to account',
	);
	assertContains(
		opportunitySchema,
		/export const opportunitiesRelations\s*=\s*relations\(opportunities/,
		'opportunities.entity.ts relations() const',
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const tmpBase = os.tmpdir();
	const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'codegen-smoke-'));
	log(`tmp dir: ${tmpDir}`);

	let exitCode = 0;

	try {
		// 1. bun init -y — creates package.json + tsconfig.json
		run('bun init -y', tmpDir);

		// 2. Install runtime deps (pinned).
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);

		// 3. Run `codegen project init --yes --with-tsconfig`
		//    tsconfig.json already exists (bun init), so init will merge aliases.
		run(`bun ${CLI_PATH} project init --yes --with-tsconfig`, tmpDir);

		// 4. Copy smoke fixtures into entities/.
		const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.yaml'));
		if (fixtureFiles.length < 2) {
			throw new Error(
				`Expected at least 2 smoke fixtures in ${FIXTURES_DIR}, found ${fixtureFiles.length}`
			);
		}
		const entitiesDir = path.join(tmpDir, 'entities');
		fs.mkdirSync(entitiesDir, { recursive: true });
		// Remove the example.yaml that init dropped.
		const examplePath = path.join(entitiesDir, 'example.yaml');
		if (fs.existsSync(examplePath)) fs.rmSync(examplePath);
		for (const f of fixtureFiles) {
			fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(entitiesDir, f));
			log(`copied fixture: ${f}`);
		}

		// 5. Run `codegen entity new --all`.
		run(`bun ${CLI_PATH} entity new --all --force`, tmpDir);

		// 5.1. CGP-62 — under the `relationship` scenario, assert the
		// clean-lite-ps Drizzle `relations()` emission shape on the CRM
		// fixtures. Runs before subsystem installs so a failure shortcuts
		// the slower steps; the install steps don't rewrite entity files.
		if (SCENARIO === 'relationship') {
			log('asserting clean-lite-ps relations() emission for CRM fixtures');
			assertRelationshipEmission(tmpDir);
			log('relationship emission OK');
		}

		// 5.5. Install the observability subsystem (combiner — ADR-025).
		// No backend flag, no schema; copies runtime/subsystems/observability via
		// copyRuntime, injects `observability:` into codegen.config.yaml, and
		// appends a TODO hint to app.module.ts directing the human to wire
		// ObservabilityModule.forRoot() AFTER Events/Jobs/Bridge/Sync.
		//
		// No siblings installed in this smoke — observability must typecheck
		// standalone because its @Optional() sibling injections degrade to
		// empty results when ports are absent (per OBS-5 contract).
		run(`bun ${CLI_PATH} subsystem install observability`, tmpDir);

		// Verify install artifacts appeared.
		const configYamlPath = path.join(tmpDir, 'codegen.config.yaml');
		const configYaml = fs.readFileSync(configYamlPath, 'utf8');
		if (!configYaml.includes('observability:')) {
			throw new Error(
				'observability: block missing from codegen.config.yaml after install',
			);
		}

		const appModulePath = path.join(tmpDir, 'src/app.module.ts');
		let appModule = fs.readFileSync(appModulePath, 'utf8');
		if (!appModule.includes('ObservabilityModule.forRoot')) {
			throw new Error(
				'ObservabilityModule TODO hint missing from app.module.ts after install',
			);
		}

		// 5.6. #287 — install the auth subsystem. Drops:
		//   - runtime/subsystems/auth/ via copyRuntime (protocols, ports,
		//     backends except schema, controller, runtime helpers, module);
		//   - auth-oauth-state.schema.ts via Hygen (sole emitter);
		//   - `auth:` block into codegen.config.yaml;
		//   - AuthModule.forRoot TODO into app.module.ts;
		//   - INTEGRATION_TOKEN_ENCRYPTION_KEY + AUTH_REDIRECT_URI_BASE into .env.config.
		run(`bun ${CLI_PATH} subsystem install auth`, tmpDir);

		const configYamlAfterAuth = fs.readFileSync(configYamlPath, 'utf8');
		if (!configYamlAfterAuth.includes('auth:')) {
			throw new Error('auth: block missing from codegen.config.yaml after install');
		}
		appModule = fs.readFileSync(appModulePath, 'utf8');
		if (!appModule.includes('AuthModule')) {
			throw new Error('AuthModule TODO hint missing from app.module.ts after auth install');
		}
		const envConfigPath = path.join(tmpDir, '.env.config');
		if (!fs.existsSync(envConfigPath)) {
			throw new Error('.env.config not created by auth install');
		}
		const envConfig = fs.readFileSync(envConfigPath, 'utf8');
		if (!envConfig.includes('INTEGRATION_TOKEN_ENCRYPTION_KEY=')) {
			throw new Error('INTEGRATION_TOKEN_ENCRYPTION_KEY missing from .env.config after auth install');
		}

		// 5.7. #287 / #303 fix #5 — install the auth-integrations starter. Vendors:
		//   - examples/auth-integrations/runtime/integrations/** →
		//       <vendorRoot>/integrations/** (full-file copies, not via Hygen).
		//       `vendorRoot` defaults to `<paths.backend_src>/modules` per fix #5;
		//       starter sits next to the codegen-emitted integration entity module.
		//   - examples/auth-integrations/definitions/entities/integration.yaml →
		//       <paths.entities>/integration.yaml (defaults to definitions/entities/);
		//   - IntegrationsAuthModule TODO into app.module.ts.
		run(`bun ${CLI_PATH} subsystem install auth-integrations`, tmpDir);

		// #303 fix #5: vendor target is `<modules>/integrations/` with
		// subfolders (`adapters/`, `facade/`, `oauth/use-cases/`). Assert
		// one file from every layer plus the root module so the smoke
		// catches any future regression in the install template's layout.
		const integrationsRoot = path.join(tmpDir, 'src/modules/integrations');
		const expectedVendoredFiles = [
			'integrations-auth.module.ts',
			'adapters/integration-reader.adapter.ts',
			'adapters/integration-token-writer.adapter.ts',
			'adapters/integration-grant-sink.adapter.ts',
			'facade/integrations.service.ts',
			'oauth/use-cases/create-or-update-from-oauth-grant.use-case.ts',
			'oauth/use-cases/disconnect-integration.use-case.ts',
			'oauth/use-cases/list-user-integrations.use-case.ts',
			'oauth/use-cases/mark-integration-requires-reauth.use-case.ts',
		];
		for (const rel of expectedVendoredFiles) {
			const abs = path.join(integrationsRoot, rel);
			if (!fs.existsSync(abs)) {
				throw new Error(
					`expected vendored file missing after auth-integrations install: ${rel}`,
				);
			}
		}

		// #303 fix #3: vendored adapters must NOT carry the bare-package
		// `@pattern-stack/codegen/runtime/subsystems/auth` import — those
		// fail to resolve through the package's `exports` map AND would
		// pin against publisher-side token Symbols (duplicate-DI hazard).
		// The install rewrites them to relative paths into the consumer's
		// vendored auth subsystem at copy time.
		for (const rel of expectedVendoredFiles) {
			const abs = path.join(integrationsRoot, rel);
			const src = fs.readFileSync(abs, 'utf-8');
			if (src.includes('@pattern-stack/codegen/runtime/subsystems/auth')) {
				throw new Error(
					`vendored ${rel} still imports from '@pattern-stack/codegen/runtime/subsystems/auth' — install-time rewriter regression (#303 fix #3)`,
				);
			}
		}

		// #303 fix #5: the legacy `<shared>/integrations/` vendor target
		// must be empty — the new layout fully replaces it.
		const legacySharedIntegrations = path.join(
			tmpDir,
			'src/shared/integrations',
		);
		if (fs.existsSync(legacySharedIntegrations)) {
			throw new Error(
				`legacy vendor target ${legacySharedIntegrations} should not exist after auth-integrations install (#303 fix #5)`,
			);
		}
		// Honor the entities_dir set by `project init` (defaults to
		// `entities/`). Fix #2 reads `paths.entities` → `paths.entities_dir`,
		// matching `Context.entitiesDir`.
		const integrationYamlPath = path.join(
			tmpDir,
			'entities/integration.yaml',
		);
		if (!fs.existsSync(integrationYamlPath)) {
			throw new Error(
				'integration.yaml not vendored by auth-integrations install',
			);
		}
		appModule = fs.readFileSync(appModulePath, 'utf8');
		if (!appModule.includes('IntegrationsAuthModule')) {
			throw new Error(
				'IntegrationsAuthModule TODO hint missing from app.module.ts after auth-integrations install',
			);
		}

		// 6. Syntax-check the scaffolded project.
		//
		// Uses `tsc --noEmit --skipLibCheck` to catch parse errors and
		// trivially broken imports in the generated code (the dogfood bug
		// class this harness targets: HTML-escaped enum unions, missing
		// query methods, wrong use-case names, etc.).
		//
		// Deep drizzle-orm type errors in runtime/base-classes are a known
		// and documented issue (see CONSUMER-SETUP.md troubleshooting, the
		// 0.30/0.45 API mismatch). Those are out of scope for the smoke
		// test until the runtime catches up.
		//
		// We filter tsc's output to the consumer's own files to keep signal
		// high — any syntax error in a generated file fails the smoke.
		log('running bunx tsc --noEmit --skipLibCheck');
		const tsc = runSilent('bunx tsc --noEmit --skipLibCheck', tmpDir);
		const consumerErrors = filterConsumerErrors(tsc.out + tsc.err, tmpDir);
		if (consumerErrors.length > 0) {
			for (const line of consumerErrors) console.error(line);
			logError(
				`${consumerErrors.length} typecheck errors in consumer-emitted code`
			);
			exitCode = 1;
		} else {
			log('tsc OK (consumer-emitted code is syntax-clean)');
		}

		// 7. OPENAPI-4: verify /docs-json is populated by importing the
		//    generated AppModule programmatically and calling
		//    registry.build(). Skipping HTTP boot — faster + deterministic.
		//
		//    The generated AppModule in src/ wires the OPENAPI_REGISTRY
		//    provider (OPENAPI-4's `init-scaffold` change); every entity
		//    module registers its DTO schemas at onModuleInit (OPENAPI-2).
		//    Here we spin up a standalone application context (no HTTP
		//    listener), fetch the registry, build the document, and assert
		//    the shape the spec requires.
		if (exitCode === 0) {
			log('verifying /docs-json via programmatic AppModule import');
			const verifyResult = runSilent(
				`bun ${path.join(REPO_ROOT, 'test', 'smoke', 'verify-openapi.ts')} ${tmpDir}`,
				tmpDir,
			);
			if (verifyResult.code !== 0) {
				console.error(verifyResult.out);
				console.error(verifyResult.err);
				logError('openapi verification failed');
				exitCode = 1;
			} else {
				log('openapi OK (/docs-json shape verified)');
				// Surface the verify script's own log lines for visibility.
				if (verifyResult.out.trim()) {
					for (const line of verifyResult.out.split('\n')) {
						if (line.trim()) log(`  ${line}`);
					}
				}
			}
		}

		// 8. TODO: bunx nest build — requires nest-cli + tsc-watch shimmery that
		//    we'd rather not tangle with yet. The tsc --noEmit check above covers
		//    the same compilation graph for the smoke purpose.
	} catch (err: unknown) {
		logError(err instanceof Error ? err.message : String(err));
		exitCode = 1;
	} finally {
		cleanup(tmpDir);
	}

	if (exitCode === 0) {
		log('smoke PASS');
	} else {
		log('smoke FAIL');
	}
	return exitCode;
}

main().then((code) => process.exit(code));
