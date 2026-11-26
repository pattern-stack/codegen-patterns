/**
 * ZOD-0: where each Zod is imported. Codegen's own code is on Zod 4, through ONE module (`src/schema/zod.ts`, the
 * `zod4` dependency); the code emitted apps import (`runtime/`, `templates/`) stays on the `zod` dependency (Zod 3)
 * until step 2 moves the generated code, a major. This holds the line until then, so neither side drifts across it.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Glob } from 'bun';

const REPO = path.resolve(import.meta.dir, '../../..');

/** Every `import … from '<spec>'` / `export … from '<spec>'` at the start of a line, with the file it is in. */
function importsUnder(pattern: string): Array<{ file: string; spec: string; line: string }> {
	const out: Array<{ file: string; spec: string; line: string }> = [];
	for (const file of new Glob(pattern).scanSync({ cwd: REPO })) {
		const text = fs.readFileSync(path.join(REPO, file), 'utf-8');
		for (const line of text.split('\n')) {
			const m = /^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]/.exec(line);
			if (m) out.push({ file, spec: m[1]!, line: line.trim() });
		}
	}
	return out;
}

const isCodegenZod = (spec: string) => spec === 'zod4' || spec.startsWith('zod4/') || spec.startsWith('zod/v4');
const isBareZod = (spec: string) => spec === 'zod' || (spec.startsWith('zod/') && !spec.startsWith('zod/v4'));

describe('the Zod boundary (ZOD-0)', () => {
	it('only src/schema/zod.ts imports the zod4 package', () => {
		const offenders = importsUnder('src/**/*.ts')
			.filter(({ spec }) => isCodegenZod(spec))
			.filter(({ file }) => file !== 'src/schema/zod.ts');
		expect(offenders).toEqual([]);
	});

	it("codegen's own code does not import Zod 3", () => {
		// Allowed: tests of `runtime/` (they run its Zod 3 schemas), tests that build a consumer-style Zod 3 schema,
		// and the bridge that hosts a runtime Zod 3 schema in a Zod 4 one (type import only).
		const offenders = importsUnder('src/**/*.ts')
			.filter(({ spec }) => isBareZod(spec))
			.filter(({ file }) => !file.startsWith('src/__tests__/'))
			.filter(({ file, line }) => !(file === 'src/schema/zod3-schema.ts' && line.startsWith('import type')));
		expect(offenders).toEqual([]);
	});

	it.each(['runtime/**/*.ts', 'templates/**/*.t', 'templates/**/*.ts', 'templates/**/*.js', 'templates/**/*.mjs'])(
		"%s (emitted apps' code) never imports codegen's Zod 4",
		(pattern) => {
			const offenders = importsUnder(pattern).filter(
				({ spec }) => isCodegenZod(spec) || /(^|\/)src\/schema\/zod(\.js)?$/.test(spec),
			);
			expect(offenders).toEqual([]);
		},
	);
});
