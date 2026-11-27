/**
 * Switching `target.wiring` (PW-3a): the other wiring's generated files are removed, so a project that changes
 * target doesn't keep files importing a framework it no longer installs.
 *
 * Only files codegen wrote are touched: a file is removed only when its first line is one of codegen's banners. A
 * hand-written file is never removed, whatever its name.
 *
 * - Going **pattern-stack**: the Nest-only files — `*.controller.ts` and `*.module.ts` under `modules_dir` (not a context's
 *   `module.ts`) and `<generated>/modules.ts` — plus any context `module.ts` the current composition no longer writes
 *   (a context renamed or emptied).
 * - Going **nest**: the pattern-stack files — every context `module.ts`, every `*.wiring.ts`, `<generated>/wiring.ts`,
 *   `<generated>/composition.ts` and `<generated>/openapi.ts`.
 * - Under `<backend_src>/integrations` (S-3): going pattern-stack, the Nest integration files (`*.module.ts`,
 *   `*.tokens.ts`, the adapters barrels); going nest, the pattern-stack ones (`*.system.ts`, `<slug>.provider.ts`, the
 *   `integrations` module). The author-owned scaffolds of the other wiring stay: `otherWiringScaffolds` names them.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { TargetWiring } from '../../targets/apps.js';
import { isCodegenBanner } from '../../utils/generated-file.js';
import { COMPOSITION_GENERATED_FILES, GENERATED_SYSTEM_FILES } from './emit-composition.js';

function isGenerated(file: string): boolean {
	return isCodegenBanner(fs.readFileSync(file, 'utf8').split('\n', 1)[0] ?? '');
}

function walk(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? walk(p) : [p];
	});
}

/** The other wiring's generated files under `modulesDir` / `generatedDir`, removed unless `dryRun`. */
export function removeOtherWiringFiles(input: {
	wiring: TargetWiring;
	modulesDir: string;
	generatedDir: string;
	/** Pattern-stack only: the composition files this run writes, which are kept. */
	keep?: ReadonlySet<string>;
	/** `<backend_src>/integrations` (S-3). */
	integrationsDir?: string;
	dryRun?: boolean;
}): string[] {
	const { wiring, modulesDir, generatedDir } = input;
	const keep = input.keep ?? new Set<string>();
	const underModules = walk(modulesDir);
	const underIntegrations = input.integrationsDir ? walk(input.integrationsDir) : [];
	const integrationCandidates =
		wiring === 'pattern-stack'
			? underIntegrations.filter(
					(f) => f.endsWith('.module.ts') || f.endsWith('.tokens.ts') || (path.basename(f) === 'index.ts' && path.basename(path.dirname(f)) === 'adapters'),
				)
			: underIntegrations.filter(
					(f) =>
						f.endsWith('.system.ts') ||
						f.endsWith('.provider.ts') ||
						f === path.join(input.integrationsDir!, 'module.ts'),
				);
	const candidates =
		wiring === 'pattern-stack'
			? [
					...underModules.filter(
						(f) => f.endsWith('.controller.ts') || (f.endsWith('.module.ts') && path.basename(f) !== 'module.ts'),
					),
					...underModules.filter((f) => path.basename(f) === 'module.ts' && !keep.has(f)),
					path.join(generatedDir, 'modules.ts'),
					// S-1 / S-3: the events and integration systems, once their subsystem is no longer installed.
					...GENERATED_SYSTEM_FILES.map((f) => path.join(generatedDir, f)).filter((f) => !keep.has(f)),
				]
			: [
					...underModules.filter((f) => path.basename(f) === 'module.ts' || f.endsWith('.wiring.ts')),
					...Object.values(COMPOSITION_GENERATED_FILES).map((f) => path.join(generatedDir, f)),
					...GENERATED_SYSTEM_FILES.map((f) => path.join(generatedDir, f)),
				];
	const stale = [...candidates, ...integrationCandidates].filter((f) => !keep.has(f) && fs.existsSync(f) && isGenerated(f));
	if (!input.dryRun) for (const f of stale) fs.rmSync(f);
	return stale;
}

/**
 * The other wiring's author-owned integration scaffolds (S-3), which a switch leaves: going pattern-stack, an adapter
 * scaffold that imports `@nestjs` (codegen skips an existing scaffold, so it is not rewritten); going nest, the
 * provider factories and the plain adapter scaffolds. The CLI names them, so the author ports or deletes them.
 */
export function otherWiringScaffolds(wiring: 'nest' | 'pattern-stack', integrationsDir: string): string[] {
	return walk(integrationsDir).filter((f) => {
		if (wiring === 'nest' && f.endsWith('.provider.factory.ts')) return true;
		if (!f.endsWith('.adapter.ts')) return false;
		const nest = /from '@nestjs\//.test(fs.readFileSync(f, 'utf8'));
		return wiring === 'nest' ? !nest : nest;
	});
}
