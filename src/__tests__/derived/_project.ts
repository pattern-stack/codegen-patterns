/**
 * The whole-set derivation over a definition set, through the CLI's own input path: the set is written as YAML
 * into a scratch project (`entities/`, `junctions/`, `relationships/`) and read back by `loadProjectApiContext`,
 * which is REL-1's `loadRelationsEmitContext` — so a test derives exactly what `codegen project surface` would.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'yaml';

import { deriveProjectApiSurface, loadProjectApiContext } from '../../derived/api/project';
import type { ProjectApiSurface } from '../../derived/api/types';
import { BASELINE_CONFIG_FILE, REPO_ROOT, type DefinitionSet } from './_inputs';
import { loadCodegenConfig } from '../../config/project-config';

export interface ProjectSet extends DefinitionSet {
	/** `relationship:` definitions, written to `relationships/` as-is. */
	relationships?: Record<string, unknown>[];
}

export function deriveProjectFromSet(set: ProjectSet): ProjectApiSurface {
	const dir = mkdtempSync(join(tmpdir(), 'api-surface-project-'));
	try {
		for (const [sub, docs, nameOf] of [
			['entities', set.entities, (d: Record<string, unknown>) => (d.entity as { name: string }).name],
			['junctions', set.junctions, (d: Record<string, unknown>) => (d.between as string[]).join('_')],
			['relationships', set.relationships ?? [], (d: Record<string, unknown>) => (d.relationship as { name: string }).name],
		] as const) {
			mkdirSync(join(dir, sub));
			for (const doc of docs as unknown as Record<string, unknown>[]) {
				writeFileSync(join(dir, sub, `${nameOf(doc)}.yaml`), yaml.stringify(doc));
			}
		}
		return deriveProjectApiSurface(
			loadProjectApiContext(dir, null, { junctionsDir: join(dir, 'junctions'), relationshipsDir: join(dir, 'relationships') }),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The baseline fixture set, read as `just test-baseline` reads it: project root = the repo root, the baseline's
 * config (whose `paths.entities` is `test/fixtures/entities`). The repo root has no `junctions/` or
 * `relationships/`, matching `baselineSet()`'s empty junction set.
 */
export function deriveBaselineProject(): ProjectApiSurface {
	return deriveProjectApiSurface(
		loadProjectApiContext(REPO_ROOT, loadCodegenConfig(BASELINE_CONFIG_FILE), {
			junctionsDir: join(REPO_ROOT, 'junctions'),
			relationshipsDir: join(REPO_ROOT, 'relationships'),
		}),
	);
}
