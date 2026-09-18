/**
 * CFG-0 (#640) issue gate 2 — every `codegen.config.yaml` key the source reads
 * is declared in `CodegenConfigSchema`. Grep-asserted, so a new reader of an
 * undeclared key fails here rather than silently reading `undefined`.
 *
 * Three sweeps over `src/` (tests excluded), `templates/` and `runtime/`:
 *   1. `paths.<key>` read off a config object → declared in `PathsConfigSchema`.
 *   2. `<block>` read off the parsed config → a top-level key of the schema.
 *   3. No second loader: nothing but `project-config.ts` both locates the file
 *      and parses YAML, bar the code emitted into the consumer's app.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { CodegenConfigSchema, PathsConfigSchema } from '../../schema/codegen-config.schema';

const REPO = path.resolve(import.meta.dir, '../../..');
const ROOTS = ['src', 'templates', 'runtime'];
const EXTENSIONS = /\.(ts|js|mjs|t)$/;

function sourceFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
				walk(full);
			} else if (EXTENSIONS.test(entry.name)) {
				out.push(full);
			}
		}
	};
	for (const root of ROOTS) walk(path.join(REPO, root));
	return out;
}

/** Every `(key, file:line)` a regex's first group captures across the sweep. */
function reads(pattern: RegExp): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const file of sourceFiles()) {
		const lines = fs.readFileSync(file, 'utf-8').split('\n');
		lines.forEach((line, i) => {
			for (const m of line.matchAll(pattern)) {
				const at = `${path.relative(REPO, file)}:${i + 1}`;
				found.set(m[1]!, [...(found.get(m[1]!) ?? []), at]);
			}
		});
	}
	return found;
}

/**
 * A config object: the CLI's `ctx.config` / `config` / `cfg`, the hygen side's
 * `projectConfig` / `getProjectConfig()`, the junction prompt's `config_`, the
 * frontend emitter's `config`.
 */
const CONFIG = String.raw`(?:\bctx\.config|\bconfig_?|\bcfg|\bprojectConfig|getProjectConfig\(\))`;

describe('config key census (CFG-0 gate 2)', () => {
	it('every paths.<key> read is declared in PathsConfigSchema', () => {
		const declared = new Set(Object.keys(PathsConfigSchema.shape));
		const found = reads(new RegExp(String.raw`${CONFIG}\??\.paths\??\.([A-Za-z_]\w*)`, 'g'));
		// A bare `paths?.<key>` is a `paths` block already taken off the config
		// (`entities-dir.ts`, `orchestration.ts`). Templates' `paths.<layer>`
		// (no `?.`) is the BACKEND_LAYERS local, not config.
		for (const [key, at] of reads(/\bpaths\?\.([A-Za-z_]\w*)/g)) {
			found.set(key, [...(found.get(key) ?? []), ...at]);
		}
		expect(found.size).toBeGreaterThanOrEqual(8);
		const undeclared = [...found].filter(([key]) => !declared.has(key));
		expect(undeclared).toEqual([]);
	});

	it('every top-level block read off the parsed config is declared', () => {
		const declared = new Set(Object.keys(CodegenConfigSchema.shape));
		// The CLI's `ctx.config` is nullable, so it is always read with `?.`
		// (the frontend emitter's own `ctx.config.` is its flat emit config).
		const found = reads(
			new RegExp(String.raw`(?:\bctx\.config\?|\bprojectConfig\??|getProjectConfig\(\)\??|\bconfig_\??)\.([A-Za-z_]\w*)`, 'g'),
		);
		expect(found.size).toBeGreaterThanOrEqual(5);
		const undeclared = [...found].filter(([key]) => !declared.has(key));
		expect(undeclared).toEqual([]);
	});

	it('nothing but the loader locates and parses codegen.config.yaml', () => {
		// A file that builds the config file's path itself AND calls a YAML
		// parser is a second loader — unless the code is emitted into the
		// consumer's app (generated `main.ts`, the jobs runtime), which runs
		// where the generator's loader is not a dependency (CFG-0 § out of scope).
		const consumerRuntime = new Set([
			'src/cli/shared/init-scaffold.ts',
			'src/cli/commands/project-upgrade-auth.ts',
			'src/cli/commands/project-upgrade-openapi.ts',
			'runtime/subsystems/jobs/pool-config.loader.ts',
		]);
		const locates = /(?:(?:resolve|join)\([^)]*['"]codegen\.config\.yaml['"]|\/codegen\.config\.yaml`)/;
		const parses = /\b(?:yaml\.parse|parseYaml|parseDocument)\(/;
		const loaders = sourceFiles()
			.map((f) => path.relative(REPO, f))
			.filter((rel) => {
				const text = fs.readFileSync(path.join(REPO, rel), 'utf-8');
				return locates.test(text) && parses.test(text);
			});
		expect(loaders.filter((rel) => !consumerRuntime.has(rel))).toEqual([]);
		// The consumer-runtime list is exact: a stale entry fails too.
		expect(loaders.sort()).toEqual([...consumerRuntime].sort());
	});
});
