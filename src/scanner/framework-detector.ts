/**
 * Framework Detector
 *
 * Detects which framework a project uses by scanning for telltale imports and patterns.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectionResult } from './types.js';

export type FrameworkType = 'nestjs' | 'fastify' | 'express' | 'plain';

interface FrameworkMarkers {
	imports: RegExp[];
	patterns: RegExp[];
	filePatterns: RegExp[];
}

const FRAMEWORK_MARKERS: Record<FrameworkType, FrameworkMarkers> = {
	nestjs: {
		imports: [
			/@nestjs\/common/,
			/@nestjs\/core/,
		],
		patterns: [
			/@Controller\(/,
			/@Injectable\(/,
			/@Module\(/,
			/@Get\(/,
			/@Post\(/,
			/@Put\(/,
			/@Delete\(/,
		],
		filePatterns: [
			/\.module\.ts$/,
			/\.controller\.ts$/,
		],
	},
	fastify: {
		imports: [
			/from ['"]fastify['"]/,
			/require\(['"]fastify['"]\)/,
		],
		patterns: [
			/fastify\(\)/i,
			/Fastify\(\)/,
			/app\.register\(/,
			/fastify\.register\(/,
		],
		filePatterns: [],
	},
	express: {
		imports: [
			/from ['"]express['"]/,
			/require\(['"]express['"]\)/,
		],
		patterns: [
			/express\(\)/,
			/app\.use\(/,
			/app\.get\(/,
			/app\.post\(/,
			/Router\(\)/,
		],
		filePatterns: [],
	},
	plain: {
		imports: [],
		patterns: [],
		filePatterns: [],
	},
};

/**
 * Recursively get all TypeScript files in a directory, excluding node_modules
 */
function getAllTsFiles(dir: string, files: string[] = []): string[] {
	if (!existsSync(dir)) return files;

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			// Skip node_modules and hidden directories
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
				continue;
			}

			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				getAllTsFiles(fullPath, files);
			} else if (entry.isFile() && entry.name.endsWith('.ts')) {
				files.push(fullPath);
			}
		}
	} catch (err) {
		// Silently skip directories we can't read
		return files;
	}

	return files;
}

/**
 * Count framework markers in a file
 */
function countMarkersInFile(filePath: string, markers: FrameworkMarkers): number {
	try {
		const content = readFileSync(filePath, 'utf-8');
		let count = 0;

		// Check imports
		for (const importPattern of markers.imports) {
			if (importPattern.test(content)) {
				count++;
			}
		}

		// Check patterns
		for (const pattern of markers.patterns) {
			if (pattern.test(content)) {
				count++;
			}
		}

		// Check file name patterns
		for (const filePattern of markers.filePatterns) {
			if (filePattern.test(filePath)) {
				count++;
			}
		}

		return count;
	} catch (err) {
		// Skip files we can't read
		return 0;
	}
}

/**
 * Detect which framework a project uses
 */
export async function detectFramework(projectPath: string): Promise<DetectionResult<FrameworkType>> {
	const tsFiles = getAllTsFiles(projectPath);

	if (tsFiles.length === 0) {
		return {
			detected: 'plain',
			confidence: 0,
			evidence: ['No TypeScript files found'],
		};
	}

	// Count markers for each framework
	const frameworkScores: Record<FrameworkType, { count: number; files: Set<string> }> = {
		nestjs: { count: 0, files: new Set() },
		fastify: { count: 0, files: new Set() },
		express: { count: 0, files: new Set() },
		plain: { count: 0, files: new Set() },
	};

	// Scan all files
	for (const file of tsFiles) {
		for (const framework of ['nestjs', 'fastify', 'express'] as const) {
			const markers = FRAMEWORK_MARKERS[framework];
			const count = countMarkersInFile(file, markers);
			if (count > 0) {
				frameworkScores[framework].count += count;
				frameworkScores[framework].files.add(file);
			}
		}
	}

	// Find framework with highest score
	let detectedFramework: FrameworkType = 'plain';
	let maxScore = 0;

	for (const framework of ['nestjs', 'fastify', 'express'] as const) {
		if (frameworkScores[framework].count > maxScore) {
			maxScore = frameworkScores[framework].count;
			detectedFramework = framework;
		}
	}

	// Build evidence array
	const evidence: string[] = [];
	if (detectedFramework !== 'plain') {
		const files = Array.from(frameworkScores[detectedFramework].files);
		evidence.push(...files.map(f => f.replace(projectPath, '').replace(/^\//, '')));
	} else {
		evidence.push('No framework-specific patterns detected');
	}

	// Calculate confidence
	// Confidence = (marker count / total files scanned) * 100, capped at 100
	const confidence = Math.min(100, Math.round((maxScore / tsFiles.length) * 100));

	return {
		detected: detectedFramework,
		confidence,
		evidence,
	};
}
