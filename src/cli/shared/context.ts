/**
 * Context — shared CLI execution state.
 *
 * Loaded once per invocation and passed to every noun's summary/hints/commands.
 * Commands should not re-read config or re-run detection; use the Context.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findYamlFiles } from '../../utils/find-yaml-files.js';
import { findConfigUpward, resolveEntitiesDir } from '../../config/entities-dir.js';
import { loadCodegenConfig, type CodegenConfig } from '../../config/project-config.js';
import { scanProject } from '../../scanner/index.js';
import type { ProjectProfile } from '../../scanner/types.js';

/**
 * The parsed `codegen.config.yaml` — `CodegenConfigSchema`'s output, defaults
 * applied (`src/schema/codegen-config.schema.ts`, the single source of truth
 * for every key). Parsed once, by `src/config/project-config.ts` (CFG-0).
 */
export type { CodegenConfig };

export interface Context {
	cwd: string;
	configPath: string | null;
	config: CodegenConfig | null;
	isInitialized: boolean;
	framework: ProjectProfile | null;
	installedSubsystems: string[];
	entityCount: number;
	entitiesDir: string | null;
	json: boolean;
	verbose: boolean;
}

export interface LoadContextOptions {
	cwd?: string;
	configPath?: string;
	json?: boolean;
	verbose?: boolean;
	/**
	 * Skip scanner / subsystem detection. Useful for fast command paths
	 * and tests that don't need full project analysis.
	 */
	skipDetection?: boolean;
}

function countEntityYamls(entitiesDir: string | null): number {
	if (!entitiesDir || !fs.existsSync(entitiesDir)) return 0;
	try {
		return findYamlFiles(entitiesDir).length;
	} catch {
		return 0;
	}
}

const KNOWN_SUBSYSTEMS = ['events', 'jobs', 'cache', 'storage'] as const;

/**
 * Cheap subsystem detection — scans common install paths for a protocol file.
 * The richer {@link ../shared/subsystem-detect.ts} implementation returns
 * full metadata; loadContext() only needs names for the summary.
 */
function detectInstalledSubsystemNames(
	cwd: string,
	config: CodegenConfig | null
): string[] {
	const configured = config?.paths?.subsystems;
	const roots = [
		...(configured ? [path.resolve(cwd, configured)] : []),
		path.resolve(cwd, 'src/shared/subsystems'),
		path.resolve(cwd, 'src/subsystems'),
		path.resolve(cwd, 'shared/subsystems'),
	];

	const found = new Set<string>();
	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		for (const name of KNOWN_SUBSYSTEMS) {
			const dir = path.join(root, name);
			if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
			const hasProtocol = fs
				.readdirSync(dir)
				.some((f) => f.endsWith('.protocol.ts'));
			if (hasProtocol) found.add(name);
		}
	}
	return Array.from(found);
}

export async function loadContext(overrides: LoadContextOptions = {}): Promise<Context> {
	const cwd = overrides.cwd ? path.resolve(overrides.cwd) : process.cwd();

	const explicit = overrides.configPath ? path.resolve(cwd, overrides.configPath) : null;
	const configPath = explicit && fs.existsSync(explicit) ? explicit : findConfigUpward(cwd);
	// Throws `CodegenConfigError` (unknown key, bad value, bad YAML): Clipanion
	// prints it and the command exits 1. No command runs on an invalid config.
	const config = configPath ? loadCodegenConfig(configPath) : null;

	const entitiesDir = resolveEntitiesDir(cwd, config?.paths);
	const entityCount = countEntityYamls(entitiesDir);

	const isInitialized = Boolean(configPath) || entityCount > 0;

	let framework: ProjectProfile | null = null;
	let installedSubsystems: string[] = [];

	if (!overrides.skipDetection && isInitialized) {
		try {
			framework = await scanProject({ directory: cwd });
		} catch {
			framework = null;
		}
		installedSubsystems = detectInstalledSubsystemNames(cwd, config);
	}

	return {
		cwd,
		configPath,
		config,
		isInitialized,
		framework,
		installedSubsystems,
		entityCount,
		entitiesDir,
		json: Boolean(overrides.json),
		verbose: Boolean(overrides.verbose),
	};
}
