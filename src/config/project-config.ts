/**
 * The ONE loader for `codegen.config.yaml` (CFG-0, #640).
 *
 * Reads, parses and validates the file through `CodegenConfigSchema` — once per
 * file text — for every reader: the CLI context (`src/cli/shared/context.ts`) and
 * the hygen side (`src/config/config-loader.mjs` → `paths.mjs`,
 * `runtime-mode.mjs`, `templates/_shared/entity-naming.mjs`,
 * the entity and junction prompts). Nothing else parses the file.
 *
 * An unknown or removed key, or a value of the wrong shape, is a
 * {@link CodegenConfigError} naming every offending key path and the file —
 * never a warning, never a silent default.
 *
 * Ships in the package's `files` (the templates import it, `.ts` resolved by
 * bun), so it may import only node built-ins, `yaml`, `zod` and other shipped
 * modules.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { z } from 'zod';
import {
	CodegenConfigSchema,
	type CodegenConfig,
} from '../schema/codegen-config.schema.js';
import { findConfigUpward } from './entities-dir.js';

export type { CodegenConfig };

/**
 * Environment variable the CLI sets for the hygen subprocess, so the prompts
 * read the file the CLI resolved (an explicit `--config` included).
 */
export const CONFIG_PATH_ENV = 'CODEGEN_CONFIG_PATH';

export class CodegenConfigError extends Error {
	/** Clipanion prints `<name>: <message>` without a stack for a `none` meta. */
	readonly clipanion = { type: 'none' as const };

	constructor(
		readonly configPath: string,
		readonly issues: string[],
	) {
		super(
			`${configPath} is not a valid codegen.config.yaml:\n` +
				issues.map((issue) => `  - ${issue}`).join('\n'),
		);
		this.name = 'CodegenConfigError';
	}
}

/** Strip the wrappers that do not change an object's key set. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
	let s = schema;
	for (;;) {
		if (s instanceof z.ZodDefault) s = s._def.innerType;
		else if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
		else if (s instanceof z.ZodEffects) s = s.innerType();
		else return s;
	}
}

/** The keys the schema accepts at `at` (an object path), for the error message. */
function keysAt(at: (string | number)[]): string[] {
	let s: z.ZodTypeAny = unwrap(CodegenConfigSchema);
	for (const segment of at) {
		if (s instanceof z.ZodObject) s = unwrap(s.shape[segment] ?? z.never());
		else if (s instanceof z.ZodRecord) s = unwrap(s.valueSchema);
		else if (s instanceof z.ZodArray) s = unwrap(s.element);
		else return [];
	}
	return s instanceof z.ZodObject ? Object.keys(s.shape) : [];
}

function formatIssues(error: z.ZodError): string[] {
	const out: string[] = [];
	for (const issue of error.issues) {
		const where = issue.path.join('.');
		if (issue.code === 'unrecognized_keys') {
			const expected = keysAt(issue.path);
			const hint = expected.length > 0 ? ` (expected one of: ${expected.join(', ')})` : '';
			for (const key of issue.keys) {
				out.push(`${where ? `${where}.` : ''}${key}: unknown key${hint}`);
			}
		} else {
			out.push(`${where || '(root)'}: ${issue.message}`);
		}
	}
	return out;
}

/**
 * Validate an already-parsed YAML value. An empty file (`null`) is `{}`.
 * Throws {@link CodegenConfigError}.
 */
export function parseCodegenConfig(raw: unknown, configPath: string): CodegenConfig {
	const result = CodegenConfigSchema.safeParse(raw ?? {});
	if (!result.success) throw new CodegenConfigError(configPath, formatIssues(result.error));
	return result.data;
}

/** Parsed configs by path, each with the file text it was parsed from. */
const cache = new Map<string, { text: string; config: CodegenConfig }>();

/**
 * Read + parse + validate the file at `configPath`. The parse is cached per
 * path and reused while the file's text is unchanged — `subsystem install`
 * edits the file and re-reads it in the same process. Throws
 * {@link CodegenConfigError}.
 */
export function loadCodegenConfig(configPath: string): CodegenConfig {
	const abs = path.resolve(configPath);
	const text = fs.readFileSync(abs, 'utf-8');
	const cached = cache.get(abs);
	if (cached && cached.text === text) return cached.config;
	let raw: unknown;
	try {
		raw = yaml.parse(text);
	} catch (err) {
		throw new CodegenConfigError(abs, [`not valid YAML: ${(err as Error).message}`]);
	}
	const config = parseCodegenConfig(raw, abs);
	cache.set(abs, { text, config });
	return config;
}

/**
 * The config file for a project rooted at `cwd`: `$CODEGEN_CONFIG_PATH` when
 * the CLI set it, else the nearest `codegen.config.yaml` walking upward (the
 * CLI's own rule). `null` when there is none.
 */
export function resolveConfigPath(cwd: string = process.cwd()): string | null {
	const fromEnv = process.env[CONFIG_PATH_ENV];
	if (fromEnv) return path.resolve(fromEnv);
	return findConfigUpward(cwd);
}

/**
 * The parsed config for the project at `cwd`, or `null` when it has no
 * `codegen.config.yaml`. Throws {@link CodegenConfigError}.
 */
export function loadProjectConfig(cwd: string = process.cwd()): CodegenConfig | null {
	const configPath = resolveConfigPath(cwd);
	return configPath ? loadCodegenConfig(configPath) : null;
}

/**
 * The config a project with no `codegen.config.yaml` gets: every schema
 * default, `paths.*` resolved (PATH-0, #642). The one fallback every reader
 * uses — no reader carries its own default literal.
 */
export const DEFAULT_CODEGEN_CONFIG: CodegenConfig = Object.freeze(CodegenConfigSchema.parse({}));

/** `config`, or {@link DEFAULT_CODEGEN_CONFIG} when the project has no file. */
export function configOrDefaults(config: CodegenConfig | null | undefined): CodegenConfig {
	return config ?? DEFAULT_CODEGEN_CONFIG;
}
