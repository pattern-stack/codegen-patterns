/**
 * Settings, declared once (SET-1): the derivation, the loader and its sources, the generated text, and the one-edit
 * rule — a provider YAML that names a setting puts it in the check, `settings.ts` and `.env.example`, nothing else.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deriveProjectSettings, providerSettings, type ProjectSetting } from '../../../derived/settings';
import { envExampleContent, settingsContent } from '../../../emitters/settings/emit-settings';
import { loadContext } from '../../../cli/shared/context';
import { checkSource, projectSettings, settingRows, writeEnvExample } from '../../../cli/shared/project-settings';
import { formatSettingRows } from '../../../cli/commands/project-settings';
import { ProviderDefinitionSchema } from '../../../schema/provider-definition.schema';
import {
	dotEnvFileSource,
	emptySource,
	layered,
	loadSettings,
	parseDotEnv,
	projectSource,
	SettingsError,
	type SettingsSource,
} from '../../../../runtime/settings';

const provider = (yaml: Record<string, unknown>) => ({
	definition: ProviderDefinitionSchema.parse({
		slug: 'acme',
		auth: { type: 'api-key', strategy: '@app/acme.strategy#AcmeStrategy' },
		client: { class: '@app/acme.client#AcmeClient', base_url: 'https://api.acme.test' },
		surfaces: ['crm'],
		...yaml,
	}),
	filePath: '/p/definitions/providers/acme.yaml',
});

const key = (s: ProjectSetting) => `${s.group}.${s.key}`;

describe('the derivation', () => {
	it("a provider's client.base_url is a setting, defaulting to the YAML's; its settings: block adds the rest", () => {
		const settings = providerSettings(provider({ settings: { api_key: { secret: true }, region: { default: 'eu', env: 'ACME_AREA' } } }), '/p');
		expect(settings.map((s) => [key(s), s.env, s.secret, s.default])).toEqual([
			['acme.baseUrl', 'ACME_BASE_URL', false, 'https://api.acme.test'],
			['acme.apiKey', 'ACME_API_KEY', true, undefined],
			['acme.region', 'ACME_AREA', false, 'eu'],
		]);
		expect(settings[0]!.format).toBe('url');
		expect(settings[1]!.source).toBe('definitions/providers/acme.yaml: settings.api_key');
	});

	it('a settings.base_url entry renames the env var and keeps the YAML default', () => {
		const [base] = providerSettings(provider({ settings: { base_url: { env: 'ACME_URL' } } }));
		expect([key(base!), base!.env, base!.default, base!.format]).toEqual(['acme.baseUrl', 'ACME_URL', 'https://api.acme.test', 'url']);
	});

	it("the project's database, an installed subsystem's, then the providers' by slug", () => {
		const all = deriveProjectSettings({ providers: [provider({})], installedSubsystems: ['auth', 'events'] });
		expect(all.map(key)).toEqual(['database.url', 'auth.tokenEncryptionKey', 'auth.redirectUriBase', 'acme.baseUrl']);
		expect(all.find((s) => s.key === 'tokenEncryptionKey')!.env).toBe('INTEGRATION_TOKEN_ENCRYPTION_KEY');
		expect(deriveProjectSettings({ providers: [], installedSubsystems: [] }).map(key)).toEqual(['database.url']);
	});

	it('refuses a provider whose group is a subsystem\'s, and two settings on one env var', () => {
		const database = { ...provider({}), definition: { ...provider({}).definition, slug: 'database' } };
		expect(() => deriveProjectSettings({ providers: [database], installedSubsystems: [] })).toThrow(/settings group 'database'/);
		const clash = provider({ settings: { token: { env: 'DATABASE_URL' } } });
		expect(() => deriveProjectSettings({ providers: [clash], installedSubsystems: [] })).toThrow(/read from DATABASE_URL/);
	});

	it('the YAML refuses a secret with a default, and an env name that is not UPPER_SNAKE', () => {
		expect(() => provider({ settings: { k: { secret: true, default: 'x' } } })).toThrow(/a secret setting has no default/);
		expect(() => provider({ settings: { k: { env: 'lower' } } })).toThrow(/UPPER_SNAKE_CASE/);
		expect(() => provider({ settings: { k: { default: 'a\nb' } } })).toThrow(/must be one line/);
	});
});

describe('the loader', () => {
	const SPEC = {
		acme: {
			apiKey: { env: 'ACME_API_KEY', secret: true },
			baseUrl: { env: 'ACME_BASE_URL', secret: false, default: 'https://api.acme.test', format: 'url' as const },
			region: { env: 'ACME_REGION', secret: false },
		},
	};
	const from = (values: Record<string, string>): SettingsSource => ({ env }) => values[env];

	it('reads every value through the source, a default when unset', () => {
		expect(loadSettings(SPEC, from({ ACME_API_KEY: 'k', ACME_REGION: 'eu' }))).toEqual({
			acme: { apiKey: 'k', baseUrl: 'https://api.acme.test', region: 'eu' },
		});
	});

	it('fails once, naming every missing and malformed value; never prints a secret', () => {
		let err: unknown;
		try {
			loadSettings(SPEC, from({ ACME_BASE_URL: 'not a url' }));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(SettingsError);
		const problems = (err as SettingsError).problems.map((p) => [p.env, p.problem]);
		expect(problems).toEqual([['ACME_API_KEY', 'missing'], ['ACME_BASE_URL', 'invalid'], ['ACME_REGION', 'missing']]);
		expect((err as Error).message).toMatch(/^3 settings could not be loaded/);
		expect((err as Error).message).toContain("(got 'not a url')");
	});

	it('rejects a secret with a malformed value without printing it', () => {
		const spec = { acme: { webhook: { env: 'ACME_WEBHOOK', secret: true, format: 'url' as const } } };
		let err: unknown;
		try {
			loadSettings(spec, from({ ACME_WEBHOOK: 'hunter2-not-a-url' }));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(SettingsError);
		expect((err as SettingsError).problems.map((p) => [p.env, p.problem])).toEqual([['ACME_WEBHOOK', 'invalid']]);
		expect((err as Error).message).not.toContain('hunter2');
		expect((err as Error).message).not.toContain('got');
	});

	it('sources: .env parsing, layering (first wins), and a config file keyed by group.key is just a source', () => {
		expect([...parseDotEnv('# c\nexport A=1\nB="two words"\nC=3 # note\nD=\n')]).toEqual([['A', '1'], ['B', 'two words'], ['C', '3']]);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
		fs.writeFileSync(path.join(dir, '.env'), 'ACME_API_KEY=from-file\nACME_REGION=file\n');
		const config: SettingsSource = ({ group, key }) => ({ 'acme.region': 'config' })[`${group}.${key}`];
		const source = layered(from({ ACME_API_KEY: 'from-env' }), config, dotEnvFileSource(path.join(dir, '.env')), emptySource);
		expect(loadSettings(SPEC, source).acme).toEqual({ apiKey: 'from-env', baseUrl: 'https://api.acme.test', region: 'config' });
		expect(dotEnvFileSource(path.join(dir, 'none'))({ group: 'a', key: 'b', env: 'X' })).toBeUndefined();
	});
});

describe('the generated text', () => {
	const settings = deriveProjectSettings({ providers: [provider({ settings: { api_key: { secret: true } } })], installedSubsystems: [] });

	it('settings.ts: the declaration as data, the typed settings, the loader and the settings system', () => {
		const text = settingsContent(settings, '@shared/settings', '// @generated');
		expect(text).toContain("import { loadSettings as load, projectSource, type SettingsOf, type SettingsSource } from '@shared/settings';");
		expect(text).toContain("    apiKey: { env: 'ACME_API_KEY', secret: true, format: 'string' },");
		expect(text).toContain("    baseUrl: { env: 'ACME_BASE_URL', secret: false, default: 'https://api.acme.test', format: 'url' },");
		expect(text).toContain('export type Settings = SettingsOf<typeof SETTINGS>;');
		expect(text).toContain("name: 'settings',\n  uses: [],\n  create: (): Settings => loadSettings(),");
	});

	it('.env.example: secrets blank, defaults commented out, by owner', () => {
		const text = envExampleContent(settings);
		expect(text).toContain('# ── the project ──\n');
		expect(text).toContain('# DATABASE_URL=postgresql://localhost:5432/app_dev\n');
		expect(text).toContain('# ── provider acme ──\n');
		expect(text).toContain('# acme.apiKey (secret): acme: api key.\nACME_API_KEY=\n');
		expect(text).toContain('# ACME_BASE_URL=https://api.acme.test\n');
	});
});

describe('one edit: a setting a provider YAML names is in the check, settings.ts and .env.example', () => {
	it('with nothing else changed', async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-project-'));
		fs.writeFileSync(path.join(cwd, 'codegen.config.yaml'), 'paths:\n  providers: definitions/providers\n');
		fs.mkdirSync(path.join(cwd, 'definitions/providers'), { recursive: true });
		const yaml = (extra: string) =>
			"slug: acme\nauth: { type: api-key, strategy: '@app/a.strategy#A' }\nclient: { class: '@app/a.client#C', base_url: https://api.acme.test }\nsurfaces: [crm]\n" +
			extra;
		fs.writeFileSync(path.join(cwd, 'definitions/providers/acme.yaml'), yaml(''));
		const ctx = await loadContext({ cwd, skipDetection: true });
		expect(projectSettings(ctx).map(key)).toEqual(['database.url', 'acme.baseUrl']);

		fs.writeFileSync(path.join(cwd, 'definitions/providers/acme.yaml'), yaml('settings:\n  webhook_secret: { secret: true }\n'));
		const settings = projectSettings(ctx);
		const rows = settingRows(settings, checkSource(ctx));
		expect(rows.find((r) => r.env === 'ACME_WEBHOOK_SECRET')).toMatchObject({ group: 'acme', key: 'webhookSecret', status: 'missing' });
		expect(formatSettingRows(rows).some((l) => /^ACME_WEBHOOK_SECRET\s+acme\.webhookSecret\s+provider acme\s+secret\s+MISSING$/.test(l))).toBe(true);
		expect(settingsContent(settings, '@shared/settings', '//')).toContain("webhookSecret: { env: 'ACME_WEBHOOK_SECRET', secret: true, format: 'string' },");
		expect(envExampleContent(settings)).toContain('\nACME_WEBHOOK_SECRET=\n');

		// Set in the project's .env: the check sees it, and never prints a secret's value.
		fs.writeFileSync(path.join(cwd, '.env'), 'ACME_WEBHOOK_SECRET=shh\n');
		const after = settingRows(projectSettings(ctx), checkSource(ctx));
		expect(after.find((r) => r.env === 'ACME_WEBHOOK_SECRET')).toMatchObject({ status: 'set' });
		expect(formatSettingRows(after).join('\n')).not.toContain('shh');
	});
});

/** The review's cases (SET-1). */
describe('edges', () => {
	it('a quoted .env value followed by a comment loses its quotes', () => {
		expect(parseDotEnv('A="https://x.test" # prod\nB=\'q\' # c\n').get('A')).toBe('https://x.test');
		expect(parseDotEnv("B='q' # c\n").get('B')).toBe('q');
	});

	it('a planned provider needs nothing at startup', () => {
		const planned = provider({ status: 'planned', settings: { api_key: { secret: true } } });
		expect(providerSettings(planned)).toEqual([]);
	});

	it('the project source reads the environment, then .env, then .env.config (the auth install writes its key there)', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-src-'));
		fs.writeFileSync(path.join(dir, '.env.config'), 'INTEGRATION_TOKEN_ENCRYPTION_KEY=k\nX=config\n');
		fs.writeFileSync(path.join(dir, '.env'), 'X=env-file\n');
		const source = projectSource(dir);
		expect(source({ group: 'auth', key: 'tokenEncryptionKey', env: 'INTEGRATION_TOKEN_ENCRYPTION_KEY' })).toBe('k');
		expect(source({ group: 'x', key: 'x', env: 'X' })).toBe('env-file');
	});

	it('the check applies the rule startup applies: a base URL that is not a URL is invalid, not set', () => {
		const settings = deriveProjectSettings({ providers: [provider({})], installedSubsystems: [] });
		const rows = settingRows(settings, ({ env }) => (env === 'ACME_BASE_URL' ? 'api.acme.test' : undefined));
		expect(rows.find((r) => r.env === 'ACME_BASE_URL')).toMatchObject({ status: 'invalid', value: 'api.acme.test' });
		expect(formatSettingRows(rows).find((l) => l.startsWith('ACME_BASE_URL'))).toMatch(/INVALID \(/);
	});

	it('a description cannot close the comment or break a line in either file', () => {
		const settings = deriveProjectSettings({
			providers: [provider({ settings: { path: { description: 'like /api/*/v2\nKEY=oops' } } })],
			installedSubsystems: [],
		});
		const ts = settingsContent(settings, '@shared/settings', '//');
		expect(ts).toContain('/** like /api/*\\/v2 KEY=oops (provider acme) */');
		expect(envExampleContent(settings)).toContain('# acme.path: like /api/*\\/v2 KEY=oops\nACME_PATH=\n');
	});

	it(".env.example codegen didn't write is left as it is", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-example-'));
		fs.writeFileSync(path.join(cwd, 'codegen.config.yaml'), '{}\n');
		fs.writeFileSync(path.join(cwd, '.env.example'), 'REDIS_URL=\n');
		const ctx = await loadContext({ cwd, skipDetection: true });
		expect(writeEnvExample(ctx, projectSettings(ctx))).toBeNull();
		expect(fs.readFileSync(path.join(cwd, '.env.example'), 'utf8')).toBe('REDIS_URL=\n');
		fs.rmSync(path.join(cwd, '.env.example'));
		expect(writeEnvExample(ctx, projectSettings(ctx))).toBe(path.join(cwd, '.env.example'));
		expect(writeEnvExample(ctx, [])).toBe(path.join(cwd, '.env.example')); // codegen's own: rewritten
	});
});
