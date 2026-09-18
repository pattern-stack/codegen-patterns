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
import { consumerErrors as scopeToConsumer } from './_consumer-errors';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

// #190 tarball mode: when SMOKE_TARBALL points at a packed
// @pattern-stack/codegen tarball, the smoke installs it into the tmp project
// and runs the CLI from node_modules — so the CLI, hygen templates, vendored
// runtime sources, and examples/ all come from what consumers actually
// receive, not the repo checkout. This is the only mode that catches the
// works-from-checkout-broken-from-tarball class (0.3.0 runtimeRoot, 0.4.1
// missing runtime/*.ts, 0.6.0 prompt.js importing unshipped src/ — #266).
// Run under bun, matching real consumers (`.js`→`.ts` extension resolution
// inside templates only exists in bun).
const TARBALL = process.env.SMOKE_TARBALL ?? '';
if (TARBALL && !fs.existsSync(TARBALL)) {
	console.error(`SMOKE_TARBALL does not exist: ${TARBALL}`);
	process.exit(2);
}
const INSTALLED_CLI = 'node_modules/@pattern-stack/codegen/dist/src/cli/index.js';

/** CLI invocation prefix — repo checkout by default, installed package in tarball mode. */
function cli(tmpDir: string): string {
	return TARBALL ? `bun ${path.join(tmpDir, INSTALLED_CLI)}` : `bun ${CLI_PATH}`;
}

// CGP-62: `--scenario` selects which fixture set the smoke generates against.
// `default` (no flag) preserves the historical behavior. `relationship`
// swaps in `test/smoke/fixtures/crm/` (account self-ref + cross-entity
// belongs_to + has_many) and runs `assertRelationshipEmission()` after
// entity generation to verify the clean-lite-ps relationship emission:
// FK columns + service composition, and the ABSENCE of the v1 Drizzle
// `relations()` const (DRZ-1, #583).
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
// drizzle-orm is pinned EXACTLY to the prerelease the repo's own devDeps
// pin (charter §8: prerelease pins are exact in harnesses). The generated
// project must compile against the same drizzle the runtime base classes
// were type-checked against — one identity, no range drift.
const RUNTIME_DEPS = [
	'@nestjs/common@10',
	'@nestjs/core@10',
	// OPENAPI-4: NestFactory.create(AppModule) needs a platform adapter.
	// Express is the default; the generated main.ts + smoke verify-openapi
	// both use it implicitly.
	'@nestjs/platform-express@10',
	'@nestjs/swagger@7',
	'@anatine/zod-openapi@2',
	'drizzle-orm@1.0.0-rc.4',
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
			`Smoke assertion failed (${source}): did not expect to match ${needle} in generated output.`,
		);
	}
}

/**
 * DRZ-1 (#583) — assert an emitted entity file carries no v1 Drizzle
 * `relations()` surface: neither the const nor the `drizzle-orm` root import
 * that Drizzle 1.0 removes. The only drizzle-orm root import left is the
 * type-only `InferSelectModel`.
 */
function assertNoV1Relations(source: string, label: string): void {
	// NB: `\w+Relations`, not `\bRelations` — the emitted name is
	// `<plural>Relations` (e.g. `accountsRelations`), so there is no word
	// boundary before the capital R and `\b` would never match.
	assertNotContains(
		source,
		/\w+Relations\s*=\s*relations\(/,
		`${label} must not emit a v1 relations() const (DRZ-1)`,
	);
	assertNotContains(
		source,
		/import\s*\{[^}]*\brelations\b[^}]*\}\s*from\s*'drizzle-orm'/,
		`${label} must not import relations from drizzle-orm (DRZ-1)`,
	);
	assertContains(
		source,
		/import \{ type InferSelectModel \} from 'drizzle-orm';/,
		`${label} type-only drizzle-orm root import`,
	);
}

/**
 * Verify the clean-lite-ps relationship emission for the CRM fixture set.
 *
 * Layout: `clean-lite-ps/prompt-extension.js` emits each entity at
 * `${srcRoot}/modules/${plural}/${name}.entity.ts`. The smoke project's
 * `srcRoot` is `<tmpDir>/src` (per `codegen project init --yes`).
 *
 * Coverage:
 *   - Self-ref `belongs_to`     → FK column with a self-referencing
 *                                 `.references()` (regression of `269ab3f`)
 *   - Cross-entity `belongs_to` → account FK column on contact + opportunity
 *   - Service composition methods: `contacts(accountId, opts)` on AccountService
 *   - Service composition methods: `account(contactId)` on ContactService
 *   - Absence of `include?`, `With`, `findByIdWithRelations` (CGP-358 destructive cleanup)
 *   - **Absence of the v1 Drizzle `relations()` const and its `drizzle-orm`
 *     root import** (DRZ-1, #583). Drizzle 1.0 removes the v1 API; the slot is
 *     deliberately empty until REL-1 (#586) emits a v2 `defineRelations()`
 *     manifest. These assertions were the CGP-62/CGP-358b presence checks,
 *     inverted rather than deleted so the harness still names the contract.
 */
/**
 * SEM-2 — assert the emitted semantic model (`src/generated/semantic/`).
 *
 * The consumer `tsc` pass already proves the tree COMPILES against the real
 * schema barrel under the consumer tsconfig, which is the gate that matters.
 * These assertions pin that it is not vacuously correct: the tags survived, the
 * catalog carries composites and no atomic entries, and the table identifiers
 * are the ones the barrel actually exports.
 */
function assertSemanticEmission(tmpDir: string): void {
	const dir = path.join(tmpDir, 'src/generated/semantic');
	for (const file of ['model.ts', 'types.ts', 'index.ts']) {
		if (!fs.existsSync(path.join(dir, file))) {
			throw new Error(`semantic model: expected ${file} in src/generated/semantic`);
		}
	}

	const model = fs.readFileSync(path.join(dir, 'model.ts'), 'utf8');

	// Tables come from the generated schema barrel, by the barrel's own export
	// names — the registry-resolved plural, never a re-pluralized string.
	assertContains(model, /opportunity: schema\.opportunities,/, 'semantic tables → schema.opportunities');
	assertContains(model, /account: schema\.accounts,/, 'semantic tables → schema.accounts');

	// Both catalog key shapes: `aggs:` → field.agg, single `agg:` → bare field.
	assertContains(
		model,
		/amount: \{ type: 'number', role: 'measure', aggs: \['sum', 'avg'\], additivity: 'additive'/,
		'opportunity.amount measure tags',
	);
	assertContains(
		model,
		/health_score: \{ type: 'number', role: 'measure', agg: 'avg', additivity: 'non'/,
		'account.health_score measure tags',
	);

	// The time axis and a declared value domain.
	assertContains(model, /closed_at: \{ type: 'datetime', role: 'dimension', time: true/, 'time axis');
	assertContains(model, /hasDeclaredDomain: true/, 'enum dimension declared domain');

	// Relationships, keyed by the YAML name.
	assertContains(
		model,
		/parent_account: \{ kind: 'belongs_to', target: 'account', fk: 'parent_account_id' \}/,
		'self-ref belongs_to descriptor',
	);
	assertContains(
		model,
		/contacts: \{ kind: 'has_many', target: 'contact', fk: 'account_id' \}/,
		'has_many descriptor',
	);

	// Composites present, atomic entries absent — the package derives those.
	assertContains(model, /win_rate: \{ kind: 'ratio'/, 'ratio metric');
	assertContains(model, /pipeline_gap: \{ kind: 'derived'/, 'derived metric');
	assertNotContains(model, /kind: 'atomic'/, 'semantic model must not emit atomic catalog entries');

	// The model is a function, so importing it cannot run before the barrel is up.
	assertContains(
		model,
		/export function buildAggregateModel\(\): AggregateModel/,
		'buildAggregateModel export',
	);
}

function assertRelationshipEmission(tmpDir: string): void {
	const reads = (rel: string): string =>
		fs.readFileSync(path.join(tmpDir, 'src', rel), 'utf8');

	// ── account.entity.ts ───────────────────────────────────────────────────
	const accountSchema = reads('modules/accounts/account.entity.ts');
	// Self-ref belongs_to still drives a self-referencing FK column.
	assertContains(
		accountSchema,
		/parentAccountId:\s*uuid\('parent_account_id'\)[^\n]*?\.references\(\(\): AnyPgColumn => accounts\.id/,
		'accounts.entity.ts self-ref belongs_to FK column',
	);
	// DRZ-1 (#583): no v1 relations() const, no drizzle-orm root `relations` import.
	assertNoV1Relations(accountSchema, 'accounts.entity.ts');
	// has_many contributes no entity-file emission any more — only the
	// service-layer composition method below.
	assertNotContains(
		accountSchema,
		/\bmany\(/,
		'accounts.entity.ts must not emit many() (DRZ-1)',
	);

	// ── account.service.ts ──────────────────────────────────────────────────
	const accountService = reads('modules/accounts/account.service.ts');
	// CGP-358b: composition method for has_many contacts
	assertContains(
		accountService,
		/async contacts\(accountId: string, opts\?:/,
		'accounts.service.ts contacts(accountId, opts) composition method',
	);
	// No eager-load shape
	assertNotContains(
		accountService,
		/AccountsWith|findByIdWithRelations|include\?:/,
		'accounts.service.ts must not reference eager-load shape',
	);

	// ── contact.entity.ts ───────────────────────────────────────────────────
	const contactSchema = reads('modules/contacts/contact.entity.ts');
	assertContains(
		contactSchema,
		/accountId:\s*uuid\('account_id'\)[^\n]*?\.references\(\(\) => accounts\.id/,
		'contacts.entity.ts belongs_to account FK column',
	);
	assertNoV1Relations(contactSchema, 'contacts.entity.ts');

	// ── contact.service.ts ──────────────────────────────────────────────────
	const contactService = reads('modules/contacts/contact.service.ts');
	// CGP-358b: composition method for belongs_to account
	assertContains(
		contactService,
		/async account\(contactId: string\)/,
		'contacts.service.ts account(contactId) composition method',
	);

	// ── opportunity.entity.ts ───────────────────────────────────────────────
	const opportunitySchema = reads('modules/opportunities/opportunity.entity.ts');
	assertContains(
		opportunitySchema,
		/accountId:\s*uuid\('account_id'\)[^\n]*?\.references\(\(\) => accounts\.id/,
		'opportunities.entity.ts belongs_to account FK column',
	);
	assertNoV1Relations(opportunitySchema, 'opportunities.entity.ts');
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

		// 2.5. Tarball mode (#190): install the packed @pattern-stack/codegen —
		// every subsequent CLI call runs from node_modules, exercising the
		// published files manifest instead of the checkout.
		if (TARBALL) {
			run(`bun add ${TARBALL}`, tmpDir);
			log(`tarball mode: CLI runs from ${INSTALLED_CLI}`);
		}

		// 3. Run `codegen project init --yes --with-tsconfig`
		//    tsconfig.json already exists (bun init), so init will merge aliases.
		//    `--runtime vendored` (ADR-037): this smoke is the VENDORED consumer
		//    flow — it vendors the runtime into `src/shared/**`, installs auth /
		//    connections (which vendor more), and compiles against `@shared/*`. The
		//    new `package` default would skip vendoring and break the base-class
		//    imports, so the mode is pinned to match what this flow exercises.
		run(`${cli(tmpDir)} project init --yes --with-tsconfig --runtime vendored`, tmpDir);

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

		// 4.5. SEM-2: switch the semantic emitter on for the relationship
		// scenario. The CRM fixtures carry analytics tags, so `entity new` emits
		// `src/generated/semantic/{types,model,index}.ts` — and the `tsc` pass
		// below then type-checks the emitted model under the CONSUMER tsconfig,
		// against the real schema barrel. That compile is the actual gate for
		// this emitter; the golden snapshot only pins its text.
		if (SCENARIO === 'relationship') {
			const configPath = path.join(tmpDir, 'codegen.config.yaml');
			const config = fs.readFileSync(configPath, 'utf8');
			if (!/^generate:/m.test(config)) {
				throw new Error('codegen.config.yaml has no generate: block to extend');
			}
			fs.writeFileSync(
				configPath,
				config.replace(/^generate:\n/m, 'generate:\n  semantic: true\n'),
			);
			log('enabled generate.semantic for the relationship scenario');
		}

		// 5. Run `codegen entity new --all`.
		//
		// For the relationship scenario, run TWICE (two-pass) so cross-entity
		// `has_many` targets are on disk for the second pass — this seeds
		// `clpExistingHasMany`, which drives the service-layer composition
		// methods for all targets, not just those generated first. (It no
		// longer drives any entity-file emission — DRZ-1 deleted the many()
		// const.)
		// (Mirrors the baseline test's two-pass strategy in test/run-test.ts.)
		run(`${cli(tmpDir)} entity new --all --force`, tmpDir);
		if (SCENARIO === 'relationship') {
			log('second pass (relationship scenario — seeds clpExistingHasMany)');
			run(`${cli(tmpDir)} entity new --all --force`, tmpDir);
		}

		// 5.1. CGP-62 — under the `relationship` scenario, assert the
		// clean-lite-ps relationship emission shape on the CRM fixtures:
		// FK columns + service composition present, v1 relations() const
		// absent (DRZ-1). Runs before subsystem installs so a failure
		// shortcuts the slower steps; the install steps don't rewrite
		// entity files.
		if (SCENARIO === 'relationship') {
			log('asserting clean-lite-ps relationship emission for CRM fixtures');
			assertRelationshipEmission(tmpDir);
			log('relationship emission OK');
		}

		// 5.2. SEM-2 — the emitted semantic model. `tsc` proves it COMPILES;
		// these assertions prove it says the right thing, so a silently-empty
		// or mis-keyed model cannot pass by compiling.
		if (SCENARIO === 'relationship') {
			log('asserting semantic model emission for CRM fixtures');
			assertSemanticEmission(tmpDir);
			log('semantic emission OK');
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
		run(`${cli(tmpDir)} subsystem install observability`, tmpDir);

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
		run(`${cli(tmpDir)} subsystem install auth`, tmpDir);

		const configYamlAfterAuth = fs.readFileSync(configYamlPath, 'utf8');
		if (!configYamlAfterAuth.includes('auth:')) {
			throw new Error('auth: block missing from codegen.config.yaml after install');
		}
		appModule = fs.readFileSync(appModulePath, 'utf8');
		if (!appModule.includes('AuthModule')) {
			throw new Error('AuthModule TODO hint missing from app.module.ts after auth install');
		}

		// 5.6a. ADR-043 — wire the auth subsystem via the AST codemod, then
		// assert it landed: AuthModule.forRoot in app.module.ts imports +
		// installRequesterContext + boot-fail in main.ts. Idempotent (run twice).
		run(`${cli(tmpDir)} project upgrade-auth`, tmpDir);
		run(`${cli(tmpDir)} project upgrade-auth`, tmpDir); // idempotency
		const appModuleAfterUpgrade = fs.readFileSync(appModulePath, 'utf8');
		if (!/imports:\s*\[[^\]]*AuthModule\.forRoot/.test(appModuleAfterUpgrade)) {
			throw new Error('project upgrade-auth did not add AuthModule.forRoot to AppModule.imports');
		}
		const mainTsAfterUpgrade = fs.readFileSync(path.join(tmpDir, 'src/main.ts'), 'utf8');
		if (!mainTsAfterUpgrade.includes('installRequesterContext(app)')) {
			throw new Error('project upgrade-auth did not wire installRequesterContext into main.ts');
		}
		if ((mainTsAfterUpgrade.match(/installRequesterContext\(app\)/g) ?? []).length !== 1) {
			throw new Error('project upgrade-auth is not idempotent — installRequesterContext wired more than once');
		}

		// 5.6b. Copy the auth-probe module into src/ so step 7.5 can boot it
		// over HTTP against the vendored auth runtime (ADR-043 both-direction
		// assertion). Lives in src/ so tsc (step 6) validates it too.
		fs.copyFileSync(
			path.join(REPO_ROOT, 'test', 'smoke', 'fixtures', 'auth-probe', 'auth-probe.module.ts'),
			path.join(tmpDir, 'src', 'auth-probe.module.ts'),
		);

		const envConfigPath = path.join(tmpDir, '.env.config');
		if (!fs.existsSync(envConfigPath)) {
			throw new Error('.env.config not created by auth install');
		}
		const envConfig = fs.readFileSync(envConfigPath, 'utf8');
		if (!envConfig.includes('INTEGRATION_TOKEN_ENCRYPTION_KEY=')) {
			throw new Error('INTEGRATION_TOKEN_ENCRYPTION_KEY missing from .env.config after auth install');
		}

		// 5.7. #287 / #303 fix #5 — install the auth-integrations starter. Vendors:
		//   - examples/auth-integrations/runtime/connections/** →
		//       <vendorRoot>/connections/** (full-file copies, not via Hygen).
		//       `vendorRoot` defaults to `<paths.backend_src>/modules` per fix #5;
		//       starter sits next to the codegen-emitted integration entity module.
		//   - examples/auth-integrations/definitions/entities/connection.yaml →
		//       <paths.entities>/integration.yaml (defaults to definitions/entities/);
		//   - ConnectionsAuthModule TODO into app.module.ts.
		run(`${cli(tmpDir)} subsystem install auth-integrations`, tmpDir);

		// #303 fix #5: vendor target is `<modules>/connections/` with
		// subfolders (`adapters/`, `facade/`, `oauth/use-cases/`). Assert
		// one file from every layer plus the root module so the smoke
		// catches any future regression in the install template's layout.
		const connectionsRoot = path.join(tmpDir, 'src/modules/connections');
		const expectedVendoredFiles = [
			'connections-auth.module.ts',
			'adapters/connection-reader.adapter.ts',
			'adapters/connection-token-writer.adapter.ts',
			'adapters/connection-grant-sink.adapter.ts',
			'facade/connections.service.ts',
			'oauth/use-cases/create-or-update-from-oauth-grant.use-case.ts',
			'oauth/use-cases/disconnect-connection.use-case.ts',
			'oauth/use-cases/list-user-connections.use-case.ts',
			'oauth/use-cases/mark-connection-requires-reauth.use-case.ts',
		];
		for (const rel of expectedVendoredFiles) {
			const abs = path.join(connectionsRoot, rel);
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
			const abs = path.join(connectionsRoot, rel);
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
		const connectionYamlPath = path.join(
			tmpDir,
			'entities/connection.yaml',
		);
		if (!fs.existsSync(connectionYamlPath)) {
			throw new Error(
				'connection.yaml not vendored by auth-integrations install',
			);
		}
		appModule = fs.readFileSync(appModulePath, 'utf8');
		if (!appModule.includes('ConnectionsAuthModule')) {
			throw new Error(
				'ConnectionsAuthModule TODO hint missing from app.module.ts after auth-integrations install',
			);
		}

		// 5.8. Generate the codegen layer the vendored starter imports.
		//
		// `subsystem install auth-integrations` vendors `connection.yaml` into
		// entities/ AFTER step 5's `entity new --all` ran, and its own next-step
		// output tells the operator to run `entity new connection`. Until this
		// step existed the smoke stopped one command short of the documented
		// consumer flow, so the starter's imports of
		// `<modules>/connections/connection.{entity,service}` and
		// `<modules>/connections/connections.module` could not resolve — 13
		// TS2307s that the old message-matching tsc filter hid by excluding the
		// vendored subfolders wholesale (#576). Completing the flow is the fix;
		// the exclusion is gone.
		run(`${cli(tmpDir)} entity new ${path.join('entities', 'connection.yaml')} --force`, tmpDir);
		const connectionService = path.join(connectionsRoot, 'connection.service.ts');
		if (!fs.existsSync(connectionService)) {
			throw new Error(
				`entity new connection did not emit ${connectionService} — the vendored starter imports it`,
			);
		}

		// 6. Typecheck the scaffolded project.
		//
		// `tsc --noEmit --skipLibCheck` catches parse errors, broken imports
		// and real type errors in the generated code (the dogfood bug class
		// this harness targets: HTML-escaped enum unions, missing query
		// methods, wrong use-case names, unresolvable relative imports).
		//
		// Diagnostics are scoped to files inside the generated project — by
		// LOCATION, never by message. See test/smoke/_consumer-errors.ts:
		// there are no error-class exclusions, and none may be added (I9).
		log('running bunx tsc --noEmit --skipLibCheck');
		const tsc = runSilent('bunx tsc --noEmit --skipLibCheck', tmpDir);
		const consumerErrors = scopeToConsumer(tsc.out + tsc.err, tmpDir);
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

		// 7.5. ADR-043: boot the auth-probe module over HTTP against the vendored
		// auth runtime and assert the closed-by-default data plane both ways —
		// unauth → 401, authed → 200 + ALS-scoped principal, @Public → 200.
		if (exitCode === 0) {
			log('verifying closed-by-default auth boot (probe module over HTTP)');
			const authVerify = runSilent(
				`bun ${path.join(REPO_ROOT, 'test', 'smoke', 'verify-auth-boot.ts')} ${tmpDir}`,
				tmpDir,
			);
			if (authVerify.code !== 0) {
				console.error(authVerify.out);
				console.error(authVerify.err);
				logError('auth boot verification failed');
				exitCode = 1;
			} else {
				log('auth OK (closed-by-default data plane verified)');
				if (authVerify.out.trim()) {
					for (const line of authVerify.out.split('\n')) {
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
