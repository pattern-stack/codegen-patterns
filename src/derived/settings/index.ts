/**
 * The project's settings, derived once from the YAML (SET-1, `docs/specs/SET-1.md`).
 *
 * A setting is one value the app reads at startup: a provider's (its YAML's `settings:` block, and its
 * `client.base_url`), a subsystem's (the table below), or the project's (the database URL). Every output that names
 * one prints from this list: `codegen project settings`, `<generated>/settings.ts`, `.env.example`, the provider
 * factory, the auth install's `.env.config` lines. None re-lists a name.
 *
 * Each setting carries its provenance (`source`: the YAML or table that declared it), as `src/derived/api` does.
 */

import type { TargetWiring } from '../../targets/apps.js';
import { rowFor } from '../../utils/keyed-row.js';
import path from 'node:path';

import { camelCase } from '../../config/file-naming.js';
import type { LoadedProvider } from '../../parser/validate-providers.js';
import { isActiveProvider } from '../../schema/provider-definition.schema.js';
import { TOKEN_ENCRYPTION_KEY_ENV } from '../../../runtime/subsystems/auth/backends/encryption-key/env.js';
import type { SettingFormat } from '../../../runtime/settings.js';

export interface ProjectSetting {
	/** Where it sits in the typed settings: `settings.<group>.<key>`. */
	group: string;
	key: string;
	/** The env var it is read from. */
	env: string;
	secret: boolean;
	/** Used when unset; none ⇒ required. */
	default?: string;
	format: SettingFormat;
	description: string;
	owner: { kind: 'project' | 'subsystem' | 'provider'; name: string };
	/** What declared it: a provider YAML's path (`settings.client_id`), or the subsystem table. */
	source: string;
}

/** The key a provider's client base URL (`client.base_url`) is read under: the setting the client, not the auth, takes. */
export const PROVIDER_BASE_URL_KEY = 'baseUrl';

/** How each kind of owner is named in messages, settings.ts and .env.example. */
const OWNER_LABEL: Readonly<Record<ProjectSetting['owner']['kind'], (name: string) => string>> = {
	project: () => 'the project',
	subsystem: (name) => `subsystem ${name}`,
	provider: (name) => `provider ${name}`,
};

/** A setting's owner, as every surface names it. */
export function settingOwnerLabel(owner: ProjectSetting['owner']): string {
	return OWNER_LABEL[owner.kind](owner.name);
}

/** The project's database URL: the env var every generated database file reads, and the dev default. */
export const DATABASE_URL_ENV = 'DATABASE_URL';
export const DEFAULT_DATABASE_URL = 'postgresql://localhost:5432/app_dev';

/** The auth subsystem's redirect base: its env var and default (the auth install writes both to `.env.config`). */
export const AUTH_REDIRECT_URI_BASE_ENV = 'AUTH_REDIRECT_URI_BASE';
export const DEFAULT_AUTH_REDIRECT_URI_BASE = 'http://localhost:3000';

type Declared = Omit<ProjectSetting, 'owner' | 'source'>;

/** The env var a pattern-stack app's `jobs` system reads its worker flag from (J-1). */
export const JOBS_WORKER_ENV = 'JOBS_WORKER';

const TABLE = 'src/derived/settings (codegen)';

/** The project's own settings: every project has a database. */
export const PROJECT_SETTINGS: readonly Declared[] = [
	{
		group: 'database',
		key: 'url',
		env: DATABASE_URL_ENV,
		secret: true,
		default: DEFAULT_DATABASE_URL,
		format: 'string',
		description: 'The Postgres connection string (the default is the local dev database).',
	},
];


/**
 * Each subsystem's settings, included when it is installed. Events and integration read none today. Jobs' worker flag
 * is read under pattern-stack only (a Nest app's `main.ts` / `worker.ts` pass it). `REDIS_URL` joins with the BullMQ
 * executor, and the logger's `LOG_LEVEL` when the logger reads one.
 */
export const SUBSYSTEM_SETTINGS: Readonly<Record<string, readonly Declared[]>> = {
		auth: [
		{
			group: 'auth',
			key: 'tokenEncryptionKey',
			env: TOKEN_ENCRYPTION_KEY_ENV,
			secret: true,
			format: 'string',
			description: 'Encrypts stored OAuth tokens: 32 bytes, base64 (`openssl rand -base64 32`). Never rotate in place.',
		},
		{
			group: 'auth',
			key: 'redirectUriBase',
			env: AUTH_REDIRECT_URI_BASE_ENV,
			secret: false,
			default: DEFAULT_AUTH_REDIRECT_URI_BASE,
			format: 'url',
			description: 'The public base URL OAuth providers redirect back to.',
		},
	],
};

/**
 * The subsystem settings one wiring reads and the other doesn't, by `target.wiring` (J-1). Jobs' worker flag is read by
 * a pattern-stack app's `jobs` system; a Nest app's `main.ts` / `worker.ts` pass theirs.
 */
export const SUBSYSTEM_SETTINGS_BY_WIRING: Readonly<Record<TargetWiring, Readonly<Record<string, readonly Declared[]>>>> = {
	nest: {},
	'pattern-stack': {
		jobs: [
			{
				group: 'jobs',
				key: 'worker',
				env: JOBS_WORKER_ENV,
				secret: false,
				default: 'true',
				format: 'boolean',
				description: "Whether this process runs the jobs executor's loop (false in a process that only starts runs).",
			},
		],
	},
};

/** `salesforce` → `SALESFORCE`; `google-workspace` → `GOOGLE_WORKSPACE`. */
function constantCase(s: string): string {
	return s.replace(/-/g, '_').toUpperCase();
}

/** A provider's settings group: its slug, camelCased (`google-workspace` → `googleWorkspace`). */
export function providerSettingsGroup(slug: string): string {
	return camelCase(slug.replace(/-/g, '_'));
}

/** A provider's settings: `client.base_url`, then its YAML's `settings:` (an entry overrides `base_url`). */
export function providerSettings(provider: LoadedProvider, cwd?: string): ProjectSetting[] {
	const def = provider.definition;
	// A planned provider is a catalog stub: nothing is built from it, so it needs nothing at startup.
	if (!isActiveProvider(def)) return [];
	const group = providerSettingsGroup(def.slug);
	const file = cwd ? path.relative(cwd, provider.filePath) : provider.filePath;
	const owner = { kind: 'provider' as const, name: def.slug };
	const declared = new Map<string, ProjectSetting>();
	{
		declared.set('base_url', {
			group,
			key: PROVIDER_BASE_URL_KEY,
			env: `${constantCase(def.slug)}_BASE_URL`,
			secret: false,
			default: def.client.base_url,
			format: 'url',
			description: `The ${def.display_name ?? def.slug} API's base URL (the YAML's client.base_url).`,
			owner,
			source: `${file}: client.base_url`,
		});
	}
	for (const [name, s] of Object.entries(def.settings ?? {})) {
		const prior = declared.get(name);
		declared.set(name, {
			group,
			key: camelCase(name),
			env: s.env ?? `${constantCase(def.slug)}_${name.toUpperCase()}`,
			secret: s.secret ?? false,
			...(s.default !== undefined ? { default: s.default } : prior?.default !== undefined && !s.secret ? { default: prior.default } : {}),
			format: prior?.format ?? 'string',
			description: s.description ?? prior?.description ?? `${def.display_name ?? def.slug}: ${name.replace(/_/g, ' ')}.`,
			owner,
			source: `${file}: settings.${name}`,
		});
	}
	return [...declared.values()];
}

export interface DeriveProjectSettingsInput {
	/** The loaded provider YAMLs (active and planned; a planned one has no settings). */
	providers: readonly LoadedProvider[];
	/** The installed subsystems' names (`subsystems.install`, or detected). */
	installedSubsystems: readonly string[];
	/** For provenance paths. */
	cwd?: string;
	/** The project's `target.wiring`: a subsystem setting read under one wiring only is listed under that one. */
	wiring?: TargetWiring;
}

/**
 * Every setting the project needs, in a stable order: the project's, each installed subsystem's, then each provider's
 * (by slug). Throws when two settings would share a `group.key` or an env var, naming both.
 */
export function deriveProjectSettings(input: DeriveProjectSettingsInput): ProjectSetting[] {
	const out: ProjectSetting[] = PROJECT_SETTINGS.map((s) => ({ ...s, owner: { kind: 'project', name: 'project' }, source: TABLE }));
	const byWiring = rowFor('target.wiring', SUBSYSTEM_SETTINGS_BY_WIRING, input.wiring ?? 'nest');
	for (const name of [...new Set([...Object.keys(SUBSYSTEM_SETTINGS), ...Object.keys(byWiring)])].sort()) {
		if (!input.installedSubsystems.includes(name)) continue;
		for (const s of [...(SUBSYSTEM_SETTINGS[name] ?? []), ...(byWiring[name] ?? [])]) {
			out.push({ ...s, owner: { kind: 'subsystem', name }, source: `${TABLE}: ${name}` });
		}
	}
	const reserved = new Set(out.map((s) => s.group));
	for (const p of [...input.providers].sort((a, b) => a.definition.slug.localeCompare(b.definition.slug))) {
		const group = providerSettingsGroup(p.definition.slug);
		if (reserved.has(group)) {
			throw new Error(
				`[codegen] settings: provider '${p.definition.slug}' would be the settings group '${group}', which ` +
					`${out.find((s) => s.group === group)!.owner.name} already uses; rename the provider`,
			);
		}
		out.push(...providerSettings(p, input.cwd));
	}
	const byKey = new Map<string, ProjectSetting>();
	const byEnv = new Map<string, ProjectSetting>();
	for (const s of out) {
		const k = `${s.group}.${s.key}`;
		const other = byKey.get(k) ?? byEnv.get(s.env);
		if (other) {
			throw new Error(
				`[codegen] settings: ${s.source} and ${other.source} are both ` +
					`${byKey.has(k) ? `'${k}'` : `read from ${s.env}`}; rename one`,
			);
		}
		byKey.set(k, s);
		byEnv.set(s.env, s);
	}
	return out;
}

/** The settings grouped as `settings.ts`'s `SETTINGS` prints them: group → key → setting. */
export function settingsByGroup(settings: readonly ProjectSetting[]): Map<string, ProjectSetting[]> {
	const groups = new Map<string, ProjectSetting[]>();
	for (const s of settings) {
		const list = groups.get(s.group) ?? [];
		list.push(s);
		groups.set(s.group, list);
	}
	return groups;
}
