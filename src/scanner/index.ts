import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectFramework } from './framework-detector.js';
import { detectORM } from './orm-detector.js';
import { detectArchitecture } from './architecture-detector.js';
import { detectNaming } from './naming-detector.js';
import type { ProjectProfile, ScanOptions } from './types.js';

/**
 * Find the src directory in a project.
 * Checks for common source directories: src/, app/, lib/
 */
function findSrcDirectory(projectPath: string): string | null {
	const candidates = ['src', 'app', 'lib'];

	for (const candidate of candidates) {
		const fullPath = join(projectPath, candidate);
		try {
			const stats = statSync(fullPath);
			if (stats.isDirectory()) {
				return fullPath;
			}
		} catch {
			// Directory doesn't exist, continue
		}
	}

	return null;
}

/**
 * Scan a project and detect its patterns, conventions, and architecture.
 */
export async function scanProject(options: ScanOptions): Promise<ProjectProfile> {
	const { directory } = options;

	// Validate directory exists
	if (!existsSync(directory)) {
		throw new Error(`Directory not found: ${directory}`);
	}

	// Run all detectors in parallel for efficiency
	const [framework, orm, architecture, naming] = await Promise.all([
		detectFramework(directory),
		detectORM(directory),
		detectArchitecture(directory),
		detectNaming(directory),
	]);

	return {
		framework,
		orm,
		architecture,
		naming,
		paths: {
			root: directory,
			src: findSrcDirectory(directory),
		},
	};
}

export * from './types.js';
export * from './framework-detector.js';
export * from './orm-detector.js';
export * from './architecture-detector.js';
export * from './naming-detector.js';
export * from './config-generator.js';
