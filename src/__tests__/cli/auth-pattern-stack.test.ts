/**
 * Auth under `wiring: pattern-stack` (S-2): the install (refusals, the Nest-free file filter, the schema barrel), the
 * `auth` and `connections` systems in the composition, the provider factory taking the connection store, and the
 * runtime pieces (`EnvEncryptionKey({ key })`, `oauthCallbackUrl`, `createConnectionStore`). `test-smoke-pattern-stack`
 * compiles and runs the whole; this pins the text.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { patternStackFileFilter, patternStackSubsystemRefusal } from '../../cli/shared/pattern-stack-subsystems';
import { buildSubsystemSchemaBarrel } from '../../cli/shared/subsystem-schema-generator';
import {
	emitPatternStackIntegrations,
	generateProviderFactory,
	generateProviderSystem,
} from '../../cli/shared/pattern-stack-integrations';
import { loadEntitiesFromYaml } from '../../utils/yaml-loader';
import { loadProjectApiContext } from '../../derived/api/project';
import { planComposition } from '../../emitters/composition/emit-composition';
import { providerSettings } from '../../derived/settings';
import { findYamlFiles } from '../../utils/find-yaml-files';
import { loadProvidersFromYaml } from '../../utils/yaml-loader';
import type { ActiveProviderDefinition } from '../../schema/provider-definition.schema';
import { EnvEncryptionKey, oauthCallbackUrl } from '../../../runtime/subsystems/auth/core';
import { createConnectionStore } from '../../../examples/auth-integrations/runtime/connections/connection-store';
import type { ConnectionRows } from '../../../examples/auth-integrations/runtime/connections/connection-rows';

const REPO = path.resolve(import.meta.dir, '../../..');
const ROOT = '/app/src';
const NEST = /@nestjs\/|@Inject|@Injectable/;
const KEY = Buffer.alloc(32, 7).toString('base64');

describe('subsystem install auth under pattern-stack', () => {
	it('allows auth on drizzle and the starter; refuses auth on memory (the OAuth state must outlive its process)', () => {
		expect(patternStackSubsystemRefusal('auth', 'drizzle')).toBeNull();
		expect(patternStackSubsystemRefusal('auth', 'memory')).toMatch(/memory backend .* outlive the process/);
		expect(patternStackSubsystemRefusal('auth-integrations', 'drizzle')).toBeNull();
		// A subsystem still unsupported names the supported ones, auth among them (jobs is supported since J-1).
		expect(patternStackSubsystemRefusal('cache', 'drizzle')).toMatch(/Supported: .*auth, auth-integrations/);
		expect(patternStackSubsystemRefusal('jobs', 'drizzle')).toBeNull();
		expect(patternStackSubsystemRefusal('cache', 'drizzle')).toMatch(/Supported: .*auth, auth-integrations/);
	});

	it("vendors no Nest file: the module, the barrel, the controller, the guard, @Public, the requester middleware", () => {
		const filter = patternStackFileFilter('auth', () => true);
		for (const f of [
			'auth.module.ts',
			'index.ts',
			'controllers/auth.controller.ts',
			'auth.controller.ts',
			'guards/authenticated.guard.ts',
			'guards/public.decorator.ts',
			'middleware/requester-context.ts',
		]) {
			expect(filter(f)).toBe(false);
		}
		for (const f of [
			'core.ts',
			'auth.tokens.ts',
			// A nested file that only shares a root skip's name is kept (it isn't the root barrel).
			'protocols/index.ts',
			'backends/state-store.drizzle-backend.ts',
			'backends/encryption-key/env.ts',
			'runtime/oauth2-refresh.strategy.ts',
			'runtime/oauth-callback-url.ts',
			'protocols/user-context.ts',
		]) {
			expect(filter(f)).toBe(true);
		}
	});

	it('every file core.ts reaches survives the filter (the vendored closure compiles)', () => {
		const authDir = path.join(REPO, 'runtime/subsystems/auth');
		const filter = patternStackFileFilter('auth', () => true);
		const seen = new Set<string>();
		const visit = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			const rel = path.relative(authDir, file);
			if (!rel.startsWith('..')) expect([rel, filter(rel) || filter(path.basename(rel))]).toEqual([rel, true]);
			const text = fs.readFileSync(file, 'utf8');
			for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
				const target = path.resolve(path.dirname(file), m[1]!);
				const ts = fs.existsSync(`${target}.ts`) ? `${target}.ts` : path.join(target, 'index.ts');
				if (ts.startsWith(authDir) && fs.existsSync(ts)) visit(ts);
			}
		};
		visit(path.join(authDir, 'core.ts'));
		expect(seen.size).toBeGreaterThan(10);
	});

	it("re-exports auth_oauth_state from the Nest-free entry under pattern-stack; Nest's barrel is unchanged (#284)", () => {
		const auth = [{ name: 'auth' as const, path: '', backend: 'drizzle' as const, status: 'installed' as const }];
		expect(buildSubsystemSchemaBarrel(auth, '../shared/subsystems', 'vendored', 'pattern-stack').content).toContain(
			"export { authOAuthState } from '../shared/subsystems/auth/core';",
		);
		expect(buildSubsystemSchemaBarrel(auth, '../shared/subsystems', 'package', 'pattern-stack').content).toContain(
			"export { authOAuthState } from '@pattern-stack/codegen/runtime/subsystems/auth/core';",
		);
		expect(buildSubsystemSchemaBarrel(auth, '../shared/subsystems', 'vendored', 'nest').content).not.toContain('authOAuthState');
	});
});

/** The pattern-stack smoke's fixtures plus the starter's connection.yaml, in a temp entities dir. */
function entitiesWithConnection(mutate: (yaml: string) => string = (y) => y): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-ps-'));
	const fixtures = path.join(REPO, 'test/smoke/fixtures-pattern-stack');
	for (const f of fs.readdirSync(fixtures)) fs.copyFileSync(path.join(fixtures, f), path.join(dir, f));
	const yaml = fs.readFileSync(path.join(REPO, 'examples/auth-integrations/definitions/entities/connection.yaml'), 'utf8');
	fs.writeFileSync(path.join(dir, 'connection.yaml'), mutate(yaml));
	return dir;
}

function compose(opts: { entitiesDir: string; auth?: boolean; connections?: boolean }) {
	const files = planComposition({
		relations: loadProjectApiContext(ROOT, null, {
			entitiesDir: opts.entitiesDir,
			junctionsDir: '/nonexistent/junctions',
			relationshipsDir: '/nonexistent/relationships',
		}).relations,
		modulesDir: `${ROOT}/modules`,
		generatedDir: `${ROOT}/generated`,
		drizzleTypeImport: '@shared/types/drizzle',
		openApiImport: '@shared/openapi',
		banner: '// @generated',
		// The fixtures' invoice emits an event, so the smoke's events install (S-1) comes too.
		events: {
			backend: 'drizzle',
			multiTenant: false,
			listenNotify: false,
			backendImport: '@shared/subsystems/events/event-bus.drizzle-backend',
			coreImport: '@shared/subsystems/events/core',
			generatedEventsDir: `${ROOT}/shared/subsystems/events/generated`,
		},
		auth: opts.auth === false ? null : { coreImport: '@shared/subsystems/auth/core' },
		connections: opts.connections === false ? null : { storeFile: `${ROOT}/modules/connections/connection-store.ts` },
		dryRun: true,
	});
	return (suffix: string) => files.find((f) => f.path.endsWith(suffix))?.content ?? null;
}

describe('the auth and connections systems', () => {
	const file = compose({ entitiesDir: entitiesWithConnection() });

	it("auth: the key from settings, the Drizzle state store, callbackUrl over the redirect base", () => {
		const auth = file('/generated/auth-system.ts')!;
		expect(auth).toContain(
			"import { DrizzleOAuthStateStore, EnvEncryptionKey, oauthCallbackUrl, type IEncryptionKey, type IOAuthStateStore } from '@shared/subsystems/auth/core';",
		);
		expect(auth).toContain("name: 'auth',\n  uses: ['settings', 'database'],");
		expect(auth).toContain('encryptionKey: new EnvEncryptionKey({ key: settings.auth.tokenEncryptionKey }),');
		expect(auth).toContain('oauthState: new DrizzleOAuthStateStore(database.db),');
		expect(auth).toContain('callbackUrl: (provider) => oauthCallbackUrl(settings.auth.redirectUriBase, provider),');
		expect(auth).not.toMatch(NEST);
	});

	it('connections: the starter\'s store over its own connection repository and the auth key', () => {
		const c = file('/generated/connections-system.ts')!;
		expect(c).toContain("import { createConnectionStore, type ConnectionStore } from '../modules/connections/connection-store';");
		expect(c).toContain("import { createConnectionRepository } from '../modules/connections/connection.wiring';");
		expect(c).toContain("name: 'connections',\n  uses: ['database', 'auth'],");
		expect(c).toContain('createConnectionStore(createConnectionRepository(database.db), auth.encryptionKey)');
	});

	it('both are listed in SYSTEMS and SystemApis, auth before connections', () => {
		expect(file('/generated/composition.ts')).toContain('authSystem, connectionsSystem] as const;');
		const wiring = file('/generated/wiring.ts')!;
		expect(wiring).toContain("import type { AuthApi } from './auth-system';");
		expect(wiring).toContain("import type { ConnectionStore } from '../modules/connections/connection-store';");
		expect(wiring).toContain('  auth: AuthApi;\n  connections: ConnectionStore;\n');
	});

	it('neither without its install', () => {
		const none = compose({ entitiesDir: path.join(REPO, 'test/smoke/fixtures-pattern-stack'), auth: false, connections: false });
		expect(none('/generated/auth-system.ts')).toBeNull();
		expect(none('/generated/connections-system.ts')).toBeNull();
		expect(none('/generated/wiring.ts')).not.toContain('auth: AuthApi');
	});

	it('refuses the store without auth, without a connection entity, and for a connection that is EAV or in a context', () => {
		expect(() => compose({ entitiesDir: entitiesWithConnection(), auth: false })).toThrow(/run `codegen subsystem install auth`/i);
		expect(() => compose({ entitiesDir: path.join(REPO, 'test/smoke/fixtures-pattern-stack') })).toThrow(
			/no 'connection' entity/,
		);
		expect(() => compose({ entitiesDir: entitiesWithConnection((y) => y.replace('  pattern: Base', '  pattern: Base\n  context: integrations_ctx')) })).toThrow(
			/generates into .*drop `context:`/,
		);
		expect(() => compose({ entitiesDir: entitiesWithConnection((y) => `${y}\neav: true\n`) })).toThrow(/is EAV/);
	});
});

describe('the provider factory takes the connection store (S-2)', () => {
	const FIXTURE = path.join(REPO, 'test/fixtures/integration-patterns/definitions');
	const sf = loadProvidersFromYaml(findYamlFiles(path.join(FIXTURE, 'providers'))).successes.find(
		(p) => p.definition.slug === 'salesforce',
	)!.definition as ActiveProviderDefinition;
	const d = { ...sf, settings: { client_id: { secret: true } } } as ActiveProviderDefinition;
	const own = providerSettings({ definition: d, filePath: '' });
	const FACTORY = `${ROOT}/integrations/providers/salesforce/salesforce.provider.factory.ts`;
	const STORE = `${ROOT}/modules/connections/connection-store.ts`;

	it('with the store: a second parameter, its type import, and the refresh strategy\'s arguments in the comment', () => {
		const f = generateProviderFactory(d, own, FACTORY, `${ROOT}/generated/settings.ts`, STORE);
		expect(f).toContain("import type { ConnectionStore } from '../../../modules/connections/connection-store';");
		expect(f).toContain(
			"export function createSalesforceProvider(settings: Settings['salesforce'], connections: ConnectionStore): SalesforceProvider {",
		);
		expect(f).toContain('  void connections;\n');
		expect(f).toContain(
			'new SalesforceOAuthStrategy({ clientId: settings.clientId, connectionReader: connections.reader, tokenWriter: connections.tokenWriter })',
		);
	});

	it('without it, byte for byte what SET-1 writes', () => {
		expect(generateProviderFactory(d, own, FACTORY, `${ROOT}/generated/settings.ts`, null)).toBe(
			generateProviderFactory(d, own, FACTORY, `${ROOT}/generated/settings.ts`),
		);
		const file = `${ROOT}/integrations/providers/salesforce/salesforce.provider.ts`;
		expect(generateProviderSystem(d, file, `${ROOT}/generated/wiring.ts`, false)).toBe(
			generateProviderSystem(d, file, `${ROOT}/generated/wiring.ts`),
		);
	});

	it('the system uses connections and passes it', () => {
		const system = generateProviderSystem(d, `${ROOT}/integrations/providers/salesforce/salesforce.provider.ts`, `${ROOT}/generated/wiring.ts`, true);
		expect(system).toContain(
			"uses: ['settings', 'connections'],\n  create: ({ settings, connections }): SalesforceProvider => createSalesforceProvider(settings.salesforce, connections),",
		);
	});
});


describe('runtime', () => {
	it('EnvEncryptionKey takes the key itself, and names the env var when it is bad', async () => {
		const key = new EnvEncryptionKey({ key: KEY, env: {} });
		expect(await key.decrypt(await key.encrypt('tok'))).toBe('tok');
		expect(() => new EnvEncryptionKey({ key: 'c2hvcnQ=' })).toThrow(/INTEGRATION_TOKEN_ENCRYPTION_KEY must decode to 32 bytes/);
		expect(() => new EnvEncryptionKey({ key: '' })).toThrow(/INTEGRATION_TOKEN_ENCRYPTION_KEY is not set/);
	});

	it('oauthCallbackUrl trims the base and encodes the provider', () => {
		expect(oauthCallbackUrl('https://app.example.com/', 'salesforce')).toBe('https://app.example.com/auth/salesforce/callback');
		expect(oauthCallbackUrl('http://localhost:3000', 'a b')).toBe('http://localhost:3000/auth/a%20b/callback');
	});

	it('createConnectionStore: a grant is stored encrypted, read back decrypted, refreshed and disconnected', async () => {
		type Row = Record<string, unknown> & { id: string };
		const rows = new Map<string, Row>();
		let n = 0;
		const store: ConnectionRows = {
			findById: async (id) => (rows.get(id) as never) ?? null,
			findByUserIdAndProvider: async (u, p) => ([...rows.values()].find((r) => r.userId === u && r.provider === p) as never) ?? null,
			findByUserId: async (u) => [...rows.values()].filter((r) => r.userId === u) as never,
			create: async (input) => {
				const row = { ...input, id: `c${++n}` } as Row;
				rows.set(row.id, row);
				return row as never;
			},
			update: async (id, input) => {
				const row = { ...rows.get(id)!, ...input } as Row;
				rows.set(id, row);
				return row as never;
			},
		};
		const s = createConnectionStore(store, new EnvEncryptionKey({ key: KEY }));
		await s.grantSink.createOrUpdateFromOAuthGrant({ userId: 'u1', provider: 'salesforce', accessToken: 'a1', refreshToken: 'r1' });
		const row = [...rows.values()][0]!;
		expect(row.accessTokenEncrypted).not.toBe('a1');
		expect(await s.reader.findByIdDecrypted(row.id)).toMatchObject({ accessToken: 'a1', refreshToken: 'r1', provider: 'salesforce' });
		await s.tokenWriter.persistRefresh({ connectionId: row.id, accessToken: 'a2', refreshToken: 'r2', expiresAt: new Date(0) });
		expect(await s.connections.findByUserAndProvider('u1', 'salesforce')).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', status: 'active' });
		await s.connections.disconnect(row.id);
		expect(rows.get(row.id)).toMatchObject({ status: 'revoked', accessTokenEncrypted: null });
		expect((await s.connections.listByUser('u1'))[0]).not.toHaveProperty('accessTokenEncrypted');
	});
});
