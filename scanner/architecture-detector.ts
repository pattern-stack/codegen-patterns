import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectionResult } from './types.js';

export type ArchitectureType = 'clean' | 'feature' | 'mvc' | 'flat';

interface ArchitectureScore {
	type: ArchitectureType;
	score: number;
	matchedFolders: string[];
	expectedFolders: string[];
}

/**
 * Detect project architecture by analyzing folder structure.
 *
 * Supports detection of:
 * - Clean Architecture (domain/application/infrastructure/presentation)
 * - Feature-based (features/* or modules/* with mixed concerns)
 * - MVC (models/views/controllers)
 * - Flat (fallback when no pattern detected)
 */
export async function detectArchitecture(
	projectPath: string
): Promise<DetectionResult<ArchitectureType>> {
	const scores: ArchitectureScore[] = [
		detectCleanArchitecture(projectPath),
		detectFeatureArchitecture(projectPath),
		detectMVCArchitecture(projectPath),
	];

	// Sort by score descending
	scores.sort((a, b) => b.score - a.score);

	const winner = scores[0];

	// If no architecture scored above 0, return flat
	if (winner.score === 0) {
		return {
			detected: 'flat',
			confidence: 100,
			evidence: ['No architectural pattern detected'],
		};
	}

	// Calculate confidence as percentage of expected folders found
	const confidence = Math.min(
		100,
		Math.round((winner.matchedFolders.length / winner.expectedFolders.length) * 100)
	);

	return {
		detected: winner.type,
		confidence,
		evidence: winner.matchedFolders.length > 0
			? winner.matchedFolders
			: ['No architectural pattern detected'],
	};
}

/**
 * Detect Clean Architecture pattern.
 * Looks for: domain/, application(s)/, infrastructure/, presentation/
 */
function detectCleanArchitecture(projectPath: string): ArchitectureScore {
	const expectedFolders = [
		'domain',
		'application',
		'applications',
		'infrastructure',
		'presentation',
		'use-cases',
		'commands',
		'queries',
	];

	const coreFolders = ['domain', 'application', 'applications', 'infrastructure', 'presentation'];
	const matchedFolders = findMatchingFolders(projectPath, expectedFolders);

	// Count matches from core folders
	const coreMatches = coreFolders.filter(folder => matchedFolders.includes(folder));

	// Must have at least 2 clean architecture layers
	// Common patterns: domain+infrastructure, application+infrastructure, infrastructure+presentation
	const hasCleanPattern = coreMatches.length >= 2;

	const score = hasCleanPattern ? matchedFolders.length : 0;

	return {
		type: 'clean',
		score,
		matchedFolders,
		expectedFolders: ['infrastructure', 'application'], // Minimum expected
	};
}

/**
 * Detect Feature-based architecture.
 * Looks for: features/* or modules/* with subfolders
 */
function detectFeatureArchitecture(projectPath: string): ArchitectureScore {
	const featureFolders = ['features', 'modules'];
	const matchedFolders: string[] = [];

	for (const baseFolder of featureFolders) {
		const basePath = findFolder(projectPath, baseFolder);
		if (basePath) {
			try {
				const subfolders = readdirSync(basePath, { withFileTypes: true })
					.filter(dirent => dirent.isDirectory())
					.map(dirent => `${baseFolder}/${dirent.name}`);

				if (subfolders.length > 0) {
					matchedFolders.push(baseFolder);
					matchedFolders.push(...subfolders.slice(0, 3)); // Sample first 3
				}
			} catch {
				// Ignore read errors
			}
		}
	}

	return {
		type: 'feature',
		score: matchedFolders.length,
		matchedFolders,
		expectedFolders: featureFolders,
	};
}

/**
 * Detect MVC architecture.
 * Looks for: models/, views/, controllers/
 */
function detectMVCArchitecture(projectPath: string): ArchitectureScore {
	const expectedFolders = [
		'models',
		'model',
		'views',
		'view',
		'controllers',
		'controller',
	];

	const coreFolders = ['models', 'views', 'controllers'];
	const matchedFolders = findMatchingFolders(projectPath, expectedFolders);

	// Must have at least 2 of the 3 core MVC folders
	const coreMatches = coreFolders.filter(folder =>
		matchedFolders.includes(folder) || matchedFolders.includes(folder.slice(0, -1))
	);

	const score = coreMatches.length >= 2 ? matchedFolders.length : 0;

	return {
		type: 'mvc',
		score,
		matchedFolders,
		expectedFolders: coreFolders,
	};
}

/**
 * Find matching folders in project root or src/ directory.
 * Returns relative paths of matched folders.
 */
function findMatchingFolders(
	projectPath: string,
	folderNames: string[]
): string[] {
	const matched: string[] = [];

	for (const folderName of folderNames) {
		const foundPath = findFolder(projectPath, folderName);
		if (foundPath) {
			matched.push(folderName);
		}
	}

	return matched;
}

/**
 * Find a folder by name in project root or src/ subdirectory.
 * Returns absolute path if found, null otherwise.
 * Handles symlinks gracefully.
 */
function findFolder(projectPath: string, folderName: string): string | null {
	const candidates = [
		join(projectPath, folderName),
		join(projectPath, 'src', folderName),
	];

	for (const candidate of candidates) {
		try {
			const stats = statSync(candidate);
			if (stats.isDirectory() || stats.isSymbolicLink()) {
				return candidate;
			}
		} catch {
			// Folder doesn't exist, continue
		}
	}

	return null;
}
