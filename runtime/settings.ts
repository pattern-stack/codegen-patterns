/**
 * Settings, loaded and checked once (SET-1). Framework-free: nothing here imports Nest.
 *
 * A project's settings are declared once, in the YAML (a provider's `settings:`, a subsystem's own), and codegen writes
 * them as data: `<generated>/settings.ts`'s `SETTINGS`, a {@link SettingsSpec}. {@link loadSettings} reads every value
 * through one {@link SettingsSource}, checks them with one Zod schema, and throws once, naming every value that is
 * missing or malformed. The generated `settings` system calls it, so a pattern-stack app fails at compose with the
 * whole list, not at the first part that needs one.
 *
 * A source is the seam for where values come from: the environment today ({@link processEnvSource}), a `.env` file
 * ({@link dotEnvFileSource}, what `codegen project settings` also reads), later a sops-decrypted file or a committed
 * config file. A source is asked for a setting by its whole reference (`group`, `key`, `env`), so a file keyed by
 * `group.key` is a source too, not a second kind of setting. Sources compose with {@link layered}: the first that has
 * a value wins.
 */
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

/** One setting: the env var it is read from, whether it is a secret, its default, and what it is for. */
export interface SettingSpec {
  readonly env: string;
  readonly secret: boolean;
  /** Used when the source has no value. None ⇒ required. */
  readonly default?: string;
  /** `url` values are checked as absolute URLs. */
  readonly format?: 'string' | 'url';
  readonly description?: string;
}

/** Every setting, by group (`salesforce`, `database`) then key (`clientId`). */
export type SettingsSpec = { readonly [group: string]: { readonly [key: string]: SettingSpec } };

/** The typed settings a spec describes: every value a string. */
export type SettingsOf<S extends SettingsSpec> = { readonly [G in keyof S]: { readonly [K in keyof S[G]]: string } };

/** The setting a source is asked for. An env source reads `env`; a config file keyed by setting reads `group.key`. */
export interface SettingRef {
  readonly group: string;
  readonly key: string;
  readonly env: string;
}

/** Where values come from: the setting's value, or undefined. */
export type SettingsSource = (setting: SettingRef) => string | undefined;

/** The process environment. An empty value counts as unset. */
export const processEnvSource: SettingsSource = ({ env }) => {
  const value = typeof process === 'undefined' ? undefined : process.env[env];
  return value === '' ? undefined : value;
};

/** A source that reads nothing. */
export const emptySource: SettingsSource = () => undefined;

/**
 * A `.env` file: `KEY=value` lines, `#` comments, an optional `export `, and single- or double-quoted values. A missing
 * file reads as empty. Read once, when the source is made.
 */
export function dotEnvFileSource(file: string): SettingsSource {
  const values = existsSync(file) ? parseDotEnv(readFileSync(file, 'utf8')) : new globalThis.Map<string, string>();
  return ({ env }) => values.get(env);
}

export function parseDotEnv(text: string): globalThis.Map<string, string> {
  const values = new globalThis.Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const rest = match[2]!;
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(rest);
    const value = quoted ? quoted[2]! : rest.replace(/\s+#.*$/, '');
    if (value !== '') values.set(match[1]!, value);
  }
  return values;
}

/**
 * A project's source, the one the generated `settings` system and `codegen project settings` both read: the
 * environment, then `<dir>/.env`, then `<dir>/.env.config` (where the auth install writes its key). So a value the
 * check counts as set is one the app finds, on Node as on Bun.
 */
export function projectSource(dir: string = typeof process === 'undefined' ? '.' : process.cwd()): SettingsSource {
  return layered(processEnvSource, dotEnvFileSource(`${dir}/.env`), dotEnvFileSource(`${dir}/.env.config`));
}

/** The first source with a value wins. */
export function layered(...sources: SettingsSource[]): SettingsSource {
  return (setting) => {
    for (const source of sources) {
      const value = source(setting);
      if (value !== undefined) return value;
    }
    return undefined;
  };
}

/** One value that failed to load. */
export interface SettingProblem {
  readonly group: string;
  readonly key: string;
  readonly env: string;
  readonly problem: 'missing' | 'invalid';
  readonly message: string;
}

/** Every setting that failed, in one error. */
export class SettingsError extends Error {
  constructor(readonly problems: readonly SettingProblem[]) {
    super(
      `${problems.length} setting${problems.length === 1 ? '' : 's'} could not be loaded:\n` +
        problems.map((p) => `  - ${p.env} (${p.group}.${p.key}): ${p.message}`).join('\n') +
        '\nSet them in the environment, or the project\'s .env or .env.config (`codegen project settings` lists every one).',
    );
    this.name = 'SettingsError';
  }
}

function schemaFor(spec: Pick<SettingSpec, 'format'>) {
  return spec.format === 'url' ? z.string().url() : z.string().min(1);
}

/** Why `raw` is not a valid value for `spec`, or null (the one rule {@link loadSettings} and the check apply). */
export function settingValueProblem(spec: Pick<SettingSpec, 'format'>, raw: string): string | null {
  const parsed = schemaFor(spec).safeParse(raw);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid');
}

/**
 * Read and check every setting of `spec` through `source`: one Zod schema over them all. Throws a
 * {@link SettingsError} naming each missing or malformed value; never stops at the first.
 */
export function loadSettings<S extends SettingsSpec>(spec: S, source: SettingsSource = projectSource()): SettingsOf<S> {
  const problems: SettingProblem[] = [];
  const out: { [group: string]: { [key: string]: string } } = {};
  for (const [group, settings] of globalThis.Object.entries(spec)) {
    out[group] = {};
    for (const [key, setting] of globalThis.Object.entries(settings)) {
      const raw = source({ group, key, env: setting.env }) ?? setting.default;
      if (raw === undefined) {
        problems.push({ group, key, env: setting.env, problem: 'missing', message: 'not set' });
        continue;
      }
      const problem = settingValueProblem(setting, raw);
      if (problem) {
        problems.push({ group, key, env: setting.env, problem: 'invalid', message: setting.secret ? problem : `${problem} (got '${raw}')` });
        continue;
      }
      out[group]![key] = raw;
    }
  }
  if (problems.length > 0) throw new SettingsError(problems);
  return out as SettingsOf<S>;
}
