/**
 * Naming Convention Detector
 *
 * Detects file naming conventions and patterns by analyzing TypeScript files.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DetectionResult } from './types.js';

export type FileCaseType = 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case';
export type FileGroupingType = 'separate' | 'grouped';

export interface NamingDetectionResult {
	fileCase: DetectionResult<FileCaseType>;
	suffixes: string[];
	fileGrouping: DetectionResult<FileGroupingType>;
}

interface SuffixCount {
	suffix: string;
	count: number;
}

/**
 * Patterns for detecting case styles.
 * Each pattern must match the entire filename (without extension).
 */
const CASE_PATTERNS: Record<FileCaseType, RegExp> = {
	'kebab-case': /^[a-z]+(-[a-z0-9]+)*$/,
	'camelCase': /^[a-z]+([A-Z][a-z0-9]*)*$/,
	'PascalCase': /^[A-Z][a-z0-9]*([A-Z][a-z0-9]*)*$/,
	'snake_case': /^[a-z]+(_[a-z0-9]+)*$/,
};

/**
 * Common file suffixes to detect
 */
const COMMON_SUFFIXES = [
	'.entity',
	'.service',
	'.controller',
	'.repository',
	'.module',
	'.dto',
	'.use-case',
	'.query',
	'.command',
	'.interface',
	'.types',
	'.schema',
	'.model',
	'.config',
	'.constants',
	'.utils',
	'.helpers',
];

/**
 * Recursively get all TypeScript files in a directory, excluding unwanted paths
 */
function getAllTsFiles(dir: string, files: string[] = []): string[] {
	if (!existsSync(dir)) return files;

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			// Skip excluded directories
			if (
				entry.name === 'node_modules' ||
				entry.name === 'dist' ||
				entry.name === 'build' ||
				entry.name === 'coverage' ||
				entry.name.startsWith('.')
			) {
				continue;
			}

			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				getAllTsFiles(fullPath, files);
			} else if (entry.isFile() && entry.name.endsWith('.ts')) {
				// Exclude test and type definition files
				if (
					!entry.name.endsWith('.test.ts') &&
					!entry.name.endsWith('.spec.ts') &&
					!entry.name.endsWith('.d.ts')
				) {
					files.push(fullPath);
				}
			}
		}
	} catch (err) {
		// Silently skip directories we can't read
		return files;
	}

	return files;
}

/**
 * Extract the base name without extension and without suffix
 */
function extractBaseName(filename: string): string {
	// Remove .ts extension
	let name = filename.replace(/\.ts$/, '');

	// Try to remove known suffixes
	for (const suffix of COMMON_SUFFIXES) {
		if (name.endsWith(suffix)) {
			name = name.slice(0, -suffix.length);
			break;
		}
	}

	return name;
}

/**
 * Detect which case style a filename uses
 */
function detectFileCase(filename: string): FileCaseType | null {
	const baseName = extractBaseName(filename);

	// Skip index files as they don't contribute to case detection
	if (baseName === 'index') {
		return null;
	}

	for (const [caseType, pattern] of Object.entries(CASE_PATTERNS)) {
		if (pattern.test(baseName)) {
			return caseType as FileCaseType;
		}
	}

	return null;
}

/**
 * Extract suffix from filename (e.g., ".entity" from "user.entity.ts")
 */
function extractSuffix(filename: string): string | null {
	// Remove .ts extension
	const withoutExt = filename.replace(/\.ts$/, '');

	// Check for known suffixes
	for (const suffix of COMMON_SUFFIXES) {
		if (withoutExt.endsWith(suffix)) {
			return suffix;
		}
	}

	return null;
}

/**
 * Check if a file is a barrel export (index.ts with multiple exports)
 */
function isBarrelExport(filePath: string): boolean {
	if (basename(filePath) !== 'index.ts') {
		return false;
	}

	try {
		const content = readFileSync(filePath, 'utf-8');

		// Count export statements
		const exportMatches = content.match(/^export\s+(.*from|{|class|interface|type|const|function)/gm);

		// A barrel export typically has multiple export statements
		return (exportMatches?.length || 0) >= 2;
	} catch {
		return false;
	}
}

/**
 * Detect file naming conventions in a project
 */
export async function detectNaming(projectPath: string): Promise<NamingDetectionResult> {
	const tsFiles = getAllTsFiles(projectPath);

	if (tsFiles.length === 0) {
		return {
			fileCase: {
				detected: 'kebab-case',
				confidence: 0,
				evidence: ['No TypeScript files found'],
			},
			suffixes: [],
			fileGrouping: {
				detected: 'separate',
				confidence: 0,
				evidence: ['No TypeScript files found'],
			},
		};
	}

	// Count case styles
	const caseCounts: Record<FileCaseType, number> = {
		'kebab-case': 0,
		'camelCase': 0,
		'PascalCase': 0,
		'snake_case': 0,
	};

	const caseEvidence: Record<FileCaseType, Set<string>> = {
		'kebab-case': new Set(),
		'camelCase': new Set(),
		'PascalCase': new Set(),
		'snake_case': new Set(),
	};

	// Count suffixes
	const suffixCounts = new Map<string, number>();

	// Count barrel exports vs separate files
	let barrelExports = 0;
	let separateFiles = 0;
	const barrelFiles: string[] = [];
	const separateFileExamples: string[] = [];

	// Analyze each file
	for (const file of tsFiles) {
		const filename = basename(file);

		// Detect case style
		const caseType = detectFileCase(filename);
		if (caseType) {
			caseCounts[caseType]++;
			caseEvidence[caseType].add(file.replace(projectPath, '').replace(/^\//, ''));
		}

		// Detect suffix
		const suffix = extractSuffix(filename);
		if (suffix) {
			suffixCounts.set(suffix, (suffixCounts.get(suffix) || 0) + 1);
			separateFiles++;
			if (separateFileExamples.length < 3) {
				separateFileExamples.push(file.replace(projectPath, '').replace(/^\//, ''));
			}
		}

		// Detect barrel exports
		if (isBarrelExport(file)) {
			barrelExports++;
			barrelFiles.push(file.replace(projectPath, '').replace(/^\//, ''));
		}
	}

	// Determine dominant case style
	let detectedCase: FileCaseType = 'kebab-case';
	let maxCaseCount = 0;

	for (const [caseType, count] of Object.entries(caseCounts)) {
		if (count > maxCaseCount) {
			maxCaseCount = count;
			detectedCase = caseType as FileCaseType;
		}
	}

	// Calculate case confidence
	const analyzedFiles = Object.values(caseCounts).reduce((sum, count) => sum + count, 0);
	const caseConfidence = analyzedFiles > 0
		? Math.round((maxCaseCount / analyzedFiles) * 100)
		: 0;

	// Get evidence for detected case
	const caseEvidenceArray = Array.from(caseEvidence[detectedCase]).slice(0, 5);

	// Sort suffixes by count and extract top ones
	const sortedSuffixes: SuffixCount[] = Array.from(suffixCounts.entries())
		.map(([suffix, count]) => ({ suffix, count }))
		.sort((a, b) => b.count - a.count);

	const detectedSuffixes = sortedSuffixes.map(s => s.suffix);

	// Determine file grouping style
	const totalFiles = tsFiles.length;
	const groupingRatio = barrelExports / totalFiles;
	const separateRatio = separateFiles / totalFiles;

	let detectedGrouping: FileGroupingType;
	let groupingConfidence: number;
	let groupingEvidence: string[];

	if (barrelExports === 0 && separateFiles === 0) {
		// No clear pattern
		detectedGrouping = 'separate';
		groupingConfidence = 50;
		groupingEvidence = ['No clear grouping pattern detected'];
	} else if (groupingRatio > separateRatio) {
		// More barrel exports than separate files
		detectedGrouping = 'grouped';
		groupingConfidence = Math.min(100, Math.round(groupingRatio * 100));
		groupingEvidence = barrelFiles.slice(0, 5);
	} else {
		// More separate files
		detectedGrouping = 'separate';
		groupingConfidence = Math.min(100, Math.round(separateRatio * 100));
		groupingEvidence = separateFileExamples;
	}

	return {
		fileCase: {
			detected: detectedCase,
			confidence: caseConfidence,
			evidence: caseEvidenceArray.length > 0
				? caseEvidenceArray
				: ['No clear case pattern detected'],
		},
		suffixes: detectedSuffixes,
		fileGrouping: {
			detected: detectedGrouping,
			confidence: groupingConfidence,
			evidence: groupingEvidence,
		},
	};
}
