import type { ProjectProfile } from './types.js';

export interface ProposedConfig {
	// Core settings
	framework: 'nestjs' | 'fastify' | 'express' | 'plain';
	orm: 'drizzle' | 'prisma' | 'typeorm' | 'none';

	// Layout settings (matching existing codegen.config.yaml schema)
	folder_structure: 'nested' | 'flat';
	file_grouping: 'separate' | 'grouped';

	// Naming conventions
	naming: {
		fileCase: 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case';
		suffixes: string[];
	};

	// Paths (inferred from architecture)
	paths: {
		backend_src: string;
		domain: string;
		application: string;
		infrastructure: string;
		presentation: string;
	};

	// Confidence summary
	confidence: {
		overall: number;
		framework: number;
		orm: number;
		architecture: number;
		naming: number;
	};
}

/**
 * Generate a proposed codegen configuration from detected project profile.
 *
 * Takes detector results and produces a configuration matching the
 * codegen.config.yaml schema with confidence scores for transparency.
 *
 * @param profile - Detected project characteristics from scanProject
 * @returns Proposed configuration with confidence metrics
 */
export function generateConfig(profile: ProjectProfile): ProposedConfig {
	// 1. Framework & ORM: Direct passthrough from detection
	const framework = profile.framework.detected;
	const orm = profile.orm.detected;

	// 2. Folder Structure: Based on architecture
	const folder_structure = inferFolderStructure(profile.architecture.detected);

	// 3. File Grouping: Direct from naming detection
	const file_grouping = profile.naming.fileGrouping.detected;

	// 4. Paths: Map from architecture detection
	const paths = inferPaths(profile);

	// 5. Naming conventions
	const naming = {
		fileCase: profile.naming.fileCase.detected,
		suffixes: profile.naming.suffixes,
	};

	// 6. Confidence: Calculate overall confidence
	const confidence = calculateConfidence(profile);

	return {
		framework,
		orm,
		folder_structure,
		file_grouping,
		naming,
		paths,
		confidence,
	};
}

/**
 * Infer folder structure preference from architecture type.
 *
 * Clean and feature architectures benefit from nested structures.
 * MVC and flat architectures typically use flat layouts.
 */
function inferFolderStructure(architecture: 'clean' | 'feature' | 'mvc' | 'flat'): 'nested' | 'flat' {
	switch (architecture) {
		case 'clean':
		case 'feature':
			return 'nested';
		case 'mvc':
		case 'flat':
		default:
			return 'flat';
	}
}

/**
 * Infer project paths from architecture detection and project structure.
 *
 * Maps architecture patterns to expected directory structure:
 * - Clean: domain/, application/, infrastructure/, presentation/
 * - Feature: features/ or modules/
 * - MVC: models/, controllers/, services/
 * - Flat: src/ (fallback)
 */
function inferPaths(profile: ProjectProfile): ProposedConfig['paths'] {
	const root = profile.paths.root;
	const srcBase = profile.paths.src || root;
	const architecture = profile.architecture.detected;

	// Default paths structure
	const defaultPaths = {
		backend_src: srcBase,
		domain: `${srcBase}/domain`,
		application: `${srcBase}/application`,
		infrastructure: `${srcBase}/infrastructure`,
		presentation: `${srcBase}/presentation`,
	};

	// Architecture-specific path overrides
	switch (architecture) {
		case 'clean': {
			// Clean architecture: Check evidence for actual folder names
			const evidence = profile.architecture.evidence;
			return {
				backend_src: srcBase,
				domain: findPathInEvidence(evidence, ['domain'], srcBase),
				application: findPathInEvidence(
					evidence,
					['application', 'applications', 'use-cases'],
					srcBase
				),
				infrastructure: findPathInEvidence(evidence, ['infrastructure'], srcBase),
				presentation: findPathInEvidence(evidence, ['presentation', 'controllers'], srcBase),
			};
		}

		case 'feature': {
			// Feature-based: Use features/ or modules/ as base
			const evidence = profile.architecture.evidence;
			const featureBase = findPathInEvidence(evidence, ['features', 'modules'], srcBase);
			return {
				backend_src: srcBase,
				domain: `${featureBase}/{feature}/domain`,
				application: `${featureBase}/{feature}/application`,
				infrastructure: `${featureBase}/{feature}/infrastructure`,
				presentation: `${featureBase}/{feature}/presentation`,
			};
		}

		case 'mvc': {
			// MVC architecture
			return {
				backend_src: srcBase,
				domain: `${srcBase}/models`,
				application: `${srcBase}/services`,
				infrastructure: `${srcBase}/lib`,
				presentation: `${srcBase}/controllers`,
			};
		}

		case 'flat':
		default: {
			// Flat structure: Everything in src/
			return {
				backend_src: srcBase,
				domain: srcBase,
				application: srcBase,
				infrastructure: srcBase,
				presentation: srcBase,
			};
		}
	}
}

/**
 * Find the actual path from evidence, falling back to default.
 *
 * Evidence contains folder names found during detection.
 * We look for matches in the candidates list and construct full path.
 */
function findPathInEvidence(
	evidence: string[],
	candidates: string[],
	srcBase: string
): string {
	for (const candidate of candidates) {
		// Look for exact match in evidence
		if (evidence.includes(candidate)) {
			return `${srcBase}/${candidate}`;
		}

		// Look for path-like match (e.g., "features/auth")
		const pathMatch = evidence.find(e => e.includes(candidate));
		if (pathMatch) {
			return `${srcBase}/${pathMatch.split('/')[0]}`;
		}
	}

	// Fallback to first candidate
	return `${srcBase}/${candidates[0]}`;
}

/**
 * Calculate confidence scores from all detections.
 *
 * Overall confidence is the average of individual detector confidences.
 * Provides transparency into which aspects are well-detected vs uncertain.
 */
function calculateConfidence(profile: ProjectProfile): ProposedConfig['confidence'] {
	const framework = profile.framework.confidence;
	const orm = profile.orm.confidence;
	const architecture = profile.architecture.confidence;
	const naming = Math.round(
		(profile.naming.fileCase.confidence + profile.naming.fileGrouping.confidence) / 2
	);

	const overall = Math.round((framework + orm + architecture + naming) / 4);

	return {
		overall,
		framework,
		orm,
		architecture,
		naming,
	};
}
