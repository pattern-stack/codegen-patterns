/**
 * Context — shared CLI execution state.
 *
 * Loaded once per invocation and passed to every noun's summary/hints/commands.
 * Commands should not re-read config or re-run detection; use the Context.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { scanProject } from '../../scanner/index.js';
import type { ProjectProfile } from '../../scanner/types.js';

export interface CodegenConfig {
	paths?: {
		entities?: string;
		entities_dir?: string;
		events_dir?: string;
		subsystems?: string;
		backend_src?: string;
		frontend_src?: string;
		/** Directory codegen writes barrel files into. Default: 'src/generated'. */
		generated?: string;
	};
	generate?: Record<string, unknown>;
	framework?: string;
	orm?: string;
	[key: string]: unknown;
}

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

/**
 * Walk upward from `start` looking for a `codegen.config.yaml`. Returns the
 * absolute path or null if none is found before reaching the filesystem root.
 */
function findConfigUpward(start: string): string | null {
	let dir = path.resolve(start);
	const root = path.parse(dir).root;
	while (true) {
		const candidate = path.join(dir, 'codegen.config.yaml');
		if (fs.existsSync(candidate)) return candidate;
		if (dir === root) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function loadConfigFromPath(configPath: string): CodegenConfig | null {
	try {
		const content = fs.readFileSync(configPath, 'utf-8');
		const parsed = yaml.parse(content);
		if (parsed && typeof parsed === 'object') {
			return parsed as CodegenConfig;
		}
		return null;
	} catch {
		return null;
	}
}

function resolveEntitiesDir(cwd: string, config: CodegenConfig | null): string | null {
	const fromConfig =
		(config?.paths?.entities as string | undefined) ??
		(config?.paths?.entities_dir as string | undefined);
	const candidates: string[] = [];
	if (fromConfig) candidates.push(path.resolve(cwd, fromConfig));
	candidates.push(path.resolve(cwd, 'entities'));

	for (const c of candidates) {
		if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
	}
	return null;
}

function countEntityYamls(entitiesDir: string | null): number {
	if (!entitiesDir || !fs.existsSync(entitiesDir)) return 0;
	try {
		return fs.readdirSync(entitiesDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
			.length;
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
	const configured = config?.paths?.subsystems as string | undefined;
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
	const config = configPath ? loadConfigFromPath(configPath) : null;

	const entitiesDir = resolveEntitiesDir(cwd, config);
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
