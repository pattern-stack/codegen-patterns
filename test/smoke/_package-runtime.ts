/**
 * Package-mode (`runtime: package`, ADR-037) consumer wiring for the checkout
 * smokes. The generated tree imports `@pattern-stack/codegen/runtime/*` and
 * `@pattern-stack/codegen/subsystems`, which are unresolvable in checkout mode
 * (the package is not installed). Alias them to a copy of the in-repo runtime
 * SOURCES — the contract under test — placed in the project's `node_modules`, and pin `@nestjs/*` to the
 * project's own copy so there is exactly one Nest identity. Same technique as
 * `test/smoke-integration/run.ts`. The tarball smoke (`just test-post-publish`)
 * covers the installed-package form.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_RUNTIME = path.join(REPO_ROOT, 'runtime');

/**
 * The in-repo runtime SOURCES, copied into the project's `node_modules` (JOBS-3). Aliasing the repo's own `runtime/`
 * made every bare import in it (`@nestjs/core`, `@pattern-stack/jobs`, `drizzle-orm`) resolve against the REPO's
 * `node_modules` at run time, whatever the project's tsconfig says: a second `@nestjs/core`, so a class token such as
 * `ModuleRef` could not inject. A copy under the project resolves them as an installed package's would: from the
 * project. Being under `node_modules`, its diagnostics stay outside the smoke gate, as the repo's did.
 */
function copyRuntime(tmpDir: string): string {
	const dest = path.join(tmpDir, 'node_modules', '.codegen-checkout', 'runtime');
	fs.rmSync(dest, { recursive: true, force: true });
	fs.cpSync(REPO_RUNTIME, dest, {
		recursive: true,
		filter: (src) => !src.split(path.sep).includes('__tests__') && !src.includes(`${path.sep}node_modules`),
	});
	return dest;
}

export function aliasPackageRuntime(tmpDir: string): void {
	const RUNTIME_ROOT = copyRuntime(tmpDir);
	const RUNTIME_BARREL = path.join(RUNTIME_ROOT, 'subsystems/index.ts');
	const RUNTIME_SUBSYSTEMS = path.join(RUNTIME_ROOT, 'subsystems');
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

const JOBS_PACKAGE = path.join(REPO_ROOT, 'packages/jobs');
let jobsTarball: string | undefined;

/**
 * `@pattern-stack/jobs` (JOBS-3) into a smoke project, as a consumer installs it: a packed tarball from the
 * workspace package (built first), so the project gets a real copy whose peers (`@nestjs/common`, `drizzle-orm`)
 * resolve to the project's own — one Nest identity — rather than a symlink back into the repo. Packed once per
 * process. The generated jobs runtime and the generated job files import it in both runtime modes.
 */
export function addJobsPackage(tmpDir: string, run: (cmd: string, cwd: string) => unknown): void {
	if (!jobsTarball) {
		const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jobs-pack-'));
		run(`just build-jobs`, REPO_ROOT);
		run(`bun pm pack --destination ${out}`, JOBS_PACKAGE);
		const tgz = fs.readdirSync(out).find((f) => f.endsWith('.tgz'));
		if (!tgz) throw new Error(`bun pm pack wrote no tarball to ${out}`);
		jobsTarball = path.join(out, tgz);
	}
	run(`bun add ${jobsTarball}`, tmpDir);
}
