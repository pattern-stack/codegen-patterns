/**
 * ZOD-0: where each Zod is imported. TEMPORARY: ZOD-0 step 2 moves the emitted side to Zod 4 and deletes this test.
 *
 * - **Codegen's side** runs inside the generator: `src/**` and the generation-time JS under `templates/` (`prompt.js`,
 *   `entity-locals.js`, the `_shared/*.mjs` helpers). It is on Zod 4, through ONE module, `src/schema/zod.ts`, the
 *   only importer of the `zod4` dependency.
 * - **The emitted side** is what generated apps import: `runtime/**` and the `.ejs.t` templates' text. It stays on
 *   the `zod` dependency (Zod 3) until step 2.
 *
 * Imports are read with Bun's own scanner (`Bun.Transpiler.scanImports`): static imports over any number of lines,
 * re-exports, `import()` and `require()`. Type-only imports load nothing at run time and are not counted. Template
 * text (`.t`) is not JavaScript, so it is matched as text.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Glob } from 'bun';

const REPO = path.resolve(import.meta.dir, '../../..');
const scanner = new Bun.Transpiler({ loader: 'ts' });

/** Every runtime import of every file matching `patterns`: `{ file, spec }`. */
function importsOf(patterns: string[]): Array<{ file: string; spec: string }> {
	const out: Array<{ file: string; spec: string }> = [];
	for (const pattern of patterns) {
		for (const file of new Glob(pattern).scanSync({ cwd: REPO })) {
			if (file.includes('node_modules/')) continue;
			// A script's `#!` line is not JavaScript; the scanner refuses it.
			const text = fs.readFileSync(path.join(REPO, file), 'utf-8').replace(/^#!.*/, '');
			for (const { path: spec } of scanner.scanImports(text)) out.push({ file, spec });
		}
	}
	return out;
}

const isZod4Package = (spec: string) => spec === 'zod4' || spec.startsWith('zod4/') || spec.startsWith('zod/v4');
const isZod3Package = (spec: string) => spec === 'zod' || (spec.startsWith('zod/') && !spec.startsWith('zod/v4'));
/** `src/schema/zod`, by any relative path, with or without an extension. */
const isCodegenZodModule = (spec: string) => /(^|\/)schema\/zod(\.[cm]?[jt]s)?$/.test(spec);

const CODEGEN_SIDE = ['src/**/*.{ts,mts,js,mjs}', 'templates/**/*.{ts,js,mjs}'];
const EMITTED_JS = ['runtime/**/*.{ts,mts,js,mjs}'];

describe('the Zod boundary (ZOD-0, temporary)', () => {
	it('only src/schema/zod.ts imports the zod4 package', () => {
		const offenders = importsOf(CODEGEN_SIDE.concat(EMITTED_JS)).filter(
			({ file, spec }) => isZod4Package(spec) && file !== 'src/schema/zod.ts',
		);
		expect(offenders).toEqual([]);
	});

	it("codegen's side does not import Zod 3", () => {
		// Tests may: they run runtime/'s Zod 3 schemas, or build a consumer-style Zod 3 pattern schema.
		const offenders = importsOf(CODEGEN_SIDE).filter(
			({ file, spec }) => isZod3Package(spec) && !file.startsWith('src/__tests__/'),
		);
		expect(offenders).toEqual([]);
	});

	it("runtime/ (emitted apps' code) never imports codegen's Zod 4", () => {
		const offenders = importsOf(EMITTED_JS).filter(({ spec }) => isZod4Package(spec) || isCodegenZodModule(spec));
		expect(offenders).toEqual([]);
	});

	it("the .ejs.t templates (emitted apps' text) never print an import of codegen's Zod 4", () => {
		const specifier = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*['"]([^'"]+)['"]/g;
		const offenders: Array<{ file: string; spec: string }> = [];
		for (const file of new Glob('templates/**/*.t').scanSync({ cwd: REPO })) {
			const text = fs.readFileSync(path.join(REPO, file), 'utf-8');
			for (const [, spec] of text.matchAll(specifier)) {
				if (isZod4Package(spec!) || isCodegenZodModule(spec!)) offenders.push({ file, spec: spec! });
			}
		}
		expect(offenders).toEqual([]);
	});

	it('the checks see what they guard: multi-line, dynamic and require imports, and any extension', () => {
		const seen = scanner
			.scanImports(
				"import {\n  a,\n} from 'zod4';\nawait import('zod');\nrequire('zod/v4');\nexport * from '../src/schema/zod.ts';",
			)
			.map((i) => i.path);
		expect(seen.filter(isZod4Package)).toEqual(['zod4', 'zod/v4']);
		expect(seen.filter(isZod3Package)).toEqual(['zod']);
		expect(seen.filter(isCodegenZodModule)).toEqual(['../src/schema/zod.ts']);
	});
});
