/**
 * CFG-0 (#640) issue gate 2 — every `codegen.config.yaml` key the source reads
 * is declared in `CodegenConfigSchema`. Grep-asserted, so a new reader of an
 * undeclared key fails here rather than silently reading `undefined`.
 *
 * Sweeps over `src/` (tests excluded), `templates/` and `runtime/`:
 *   1. `paths.<key>` read off a config object → declared in `PathsConfigSchema`.
 *   2. `<block>` read off the parsed config (named, bare `config.`, or literal
 *      bracket access) → a top-level key of the schema; a computed
 *      `config[name]` only in the one narrowed reader.
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
function reads(pattern: RegExp, fileFilter: (text: string) => boolean = () => true): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const file of sourceFiles()) {
		const text = fs.readFileSync(file, 'utf-8');
		if (!fileFilter(text)) continue;
		const lines = text.split('\n');
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
 * `projectConfig` / `resolvedConfig` / `getProjectConfig()`, the junction
 * prompt's `config_`, the schema defaults `DEFAULT_CODEGEN_CONFIG` and
 * `configOrDefaults(…)` (PATH-0).
 */
const CONFIG = String.raw`(?:\bctx\.config|\bconfig_?|\bcfg|\bprojectConfig|\bresolvedConfig|\bDEFAULT_CODEGEN_CONFIG|\bconfigOrDefaults\([^)]*\)|getProjectConfig\(\))`;

/**
 * Files whose `config` is the parsed codegen config, so a bare `config.<block>`
 * is a config read: a `config` typed `CodegenConfig` / `Context['config']`, or
 * typed `Record<string, unknown>` in a file about `codegen.config.yaml`.
 */
function holdsCodegenConfig(text: string): boolean {
	if (/\bconfig\??\s*:\s*(?:CodegenConfig\b|Context\['config'\])/.test(text)) return true;
	return /codegen\.config\.yaml/.test(text) && /\bconfig\??\s*:\s*Record<string, unknown>/.test(text);
}

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
		// `project-layout.ts` reads the block it resolved itself
		// (`ResolvedPathsSchema.parse`) as a plain `paths.<key>` (PATH-0).
		for (const [key, at] of reads(/\bpaths\.([a-z]\w*)/g, (t) => /ResolvedPathsSchema\.parse/.test(t))) {
			found.set(key, [...(found.get(key) ?? []), ...at]);
		}
		const undeclared = [...found].filter(([key]) => !declared.has(key));
		expect(undeclared).toEqual([]);
		// And the converse: every declared key has a reader (a key nothing reads
		// is deleted, CFG-0).
		expect([...declared].filter((key) => !found.has(key))).toEqual([]);
	});

	it('every top-level block read off the parsed config is declared', () => {
		const declared = new Set(Object.keys(CodegenConfigSchema.shape));
		// The CLI's `ctx.config` is nullable, so it is always read with `?.`
		// (the frontend emitter's own `ctx.config.` is its flat emit config).
		const found = reads(
			new RegExp(
				String.raw`(?:\bctx\.config\?|\bprojectConfig\??|\bresolvedConfig|\bDEFAULT_CODEGEN_CONFIG|\bconfigOrDefaults\([^)]*\)|getProjectConfig\(\)\??|\bconfig_\??)\.([A-Za-z_]\w*)`,
				'g',
			),
		);
		// #644 review (a): a bare `config.<block>` / `config?.<block>` — how the
		// scaffold-locals resolvers read the parsed config they are handed — and
		// literal bracket access `config['<block>']`, in every file that holds a
		// `CodegenConfig`.
		for (const [key, at] of reads(/(?<![\w.$-])config\??\.(?!\[|yaml\b)([A-Za-z_]\w*)/g, holdsCodegenConfig)) {
			found.set(key, [...(found.get(key) ?? []), ...at]);
		}
		for (const [key, at] of reads(/\bconfig\??\.?\[\s*['"]([A-Za-z_][\w-]*)['"]\s*\]/g, holdsCodegenConfig)) {
			found.set(key, [...(found.get(key) ?? []), ...at]);
		}
		expect(found.size).toBeGreaterThanOrEqual(10);
		const undeclared = [...found].filter(([key]) => !declared.has(key));
		expect(undeclared).toEqual([]);
	});

	it('a dynamic config[<name>] read happens only where it is narrowed', () => {
		// A computed key escapes both sweeps above. The one reader indexes the
		// parsed config by a subsystem name from `COMPOSABLE_ORDER`, every one a
		// declared block; the list is exact, so a new dynamic read fails here.
		const dynamic = [...reads(/\bconfig\??\.?\[\s*(?!['"\s])([A-Za-z_]\w*)\s*\]/g, holdsCodegenConfig).values()]
			.flat()
			.map((at) => at.replace(/:\d+$/, ''));
		expect([...new Set(dynamic)].sort()).toEqual(['src/cli/shared/subsystem-barrel-generator.ts']);
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
