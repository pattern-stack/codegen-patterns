/**
 * Package-mode (`runtime: package`, ADR-037) consumer wiring for the checkout
 * smokes. The generated tree imports `@pattern-stack/codegen/runtime/*` and
 * `@pattern-stack/codegen/subsystems`, which are unresolvable in checkout mode
 * (the package is not installed). Alias them to the in-repo runtime SOURCES —
 * the contract under test — and pin `@nestjs/*` to the project's own copy so
 * there is exactly one Nest identity. Same technique as
 * `test/smoke-integration/run.ts`. The tarball smoke (`just test-post-publish`)
 * covers the installed-package form.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'runtime');
const RUNTIME_BARREL = path.join(RUNTIME_ROOT, 'subsystems/index.ts');
const RUNTIME_SUBSYSTEMS = path.join(RUNTIME_ROOT, 'subsystems');

export function aliasPackageRuntime(tmpDir: string): void {
	const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
	const tsconfig = JSON.parse(
		fs.readFileSync(tsconfigPath, 'utf-8').replace(/\/\/.*$/gm, ''),
	) as { compilerOptions?: { paths?: Record<string, string[]> } };
	tsconfig.compilerOptions ??= {};
	tsconfig.compilerOptions.paths ??= {};
	const paths = tsconfig.compilerOptions.paths;
	paths['@pattern-stack/codegen/runtime/*'] = [`${RUNTIME_ROOT}/*`];
	// The generated `main.ts` bootstraps off the subsystems barrel.
	paths['@pattern-stack/codegen/subsystems'] = [RUNTIME_BARREL];
	paths['@pattern-stack/codegen/subsystems/*'] = [`${RUNTIME_SUBSYSTEMS}/*`];
	paths['@nestjs/*'] = [path.join(tmpDir, 'node_modules/@nestjs/*')];
	fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
}
