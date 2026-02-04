import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectionResult } from './types.js';

export type ORMType = 'drizzle' | 'prisma' | 'typeorm' | 'none';

interface ORMMarkers {
	drizzle: string[];
	prisma: string[];
	typeorm: string[];
}

/**
 * Detect which ORM a project uses by scanning for imports, schema files, and patterns.
 */
export async function detectORM(projectPath: string): Promise<DetectionResult<ORMType>> {
	const markers: ORMMarkers = {
		drizzle: [],
		prisma: [],
		typeorm: [],
	};

	// Fast path: Check for Prisma schema file
	const prismaSchemaPath = join(projectPath, 'prisma', 'schema.prisma');
	if (existsSync(prismaSchemaPath)) {
		markers.prisma.push('prisma/schema.prisma');
	}

	// Get all TypeScript files (skip node_modules)
	const tsFiles = findTypeScriptFiles(projectPath);

	// Scan files for ORM patterns
	for (const filePath of tsFiles) {
		try {
			const content = readFileSync(filePath, 'utf-8');
			const relPath = filePath.replace(projectPath, '').replace(/^\//, '');

			// Check for Drizzle patterns
			if (content.includes('drizzle-orm')) {
				markers.drizzle.push(`${relPath} (imports drizzle-orm)`);
			}
			if (/pgTable|sqliteTable|mysqlTable/.test(content)) {
				markers.drizzle.push(`${relPath} (table definition)`);
			}
			if (/drizzle\(/.test(content)) {
				markers.drizzle.push(`${relPath} (drizzle instance)`);
			}
			if (filePath.endsWith('.schema.ts')) {
				markers.drizzle.push(`${relPath} (schema file)`);
			}

			// Check for Prisma patterns
			if (content.includes('@prisma/client')) {
				markers.prisma.push(`${relPath} (imports @prisma/client)`);
			}
			if (/new PrismaClient\(/.test(content)) {
				markers.prisma.push(`${relPath} (PrismaClient instantiation)`);
			}

			// Check for TypeORM patterns
			if (content.includes('typeorm')) {
				markers.typeorm.push(`${relPath} (imports typeorm)`);
			}
			if (/@Entity|@Column|@PrimaryGeneratedColumn/.test(content)) {
				markers.typeorm.push(`${relPath} (entity decorators)`);
			}
			if (/createConnection|DataSource/.test(content)) {
				markers.typeorm.push(`${relPath} (connection setup)`);
			}
		} catch (err) {
			// Skip files that can't be read
			continue;
		}
	}

	// Determine which ORM has the most evidence
	const counts = {
		drizzle: new Set(markers.drizzle).size,
		prisma: new Set(markers.prisma).size,
		typeorm: new Set(markers.typeorm).size,
	};

	// Find the ORM with most markers
	const maxCount = Math.max(counts.drizzle, counts.prisma, counts.typeorm);

	if (maxCount === 0) {
		return {
			detected: 'none',
			confidence: 100,
			evidence: ['No ORM-specific patterns detected'],
		};
	}

	let detected: ORMType;
	let evidence: string[];

	if (counts.drizzle === maxCount) {
		detected = 'drizzle';
		evidence = Array.from(new Set(markers.drizzle));
	} else if (counts.prisma === maxCount) {
		detected = 'prisma';
		evidence = Array.from(new Set(markers.prisma));
	} else {
		detected = 'typeorm';
		evidence = Array.from(new Set(markers.typeorm));
	}

	// Calculate confidence based on marker density
	const totalFiles = tsFiles.length;
	const markerFiles = evidence.length;
	const confidence = Math.min(100, Math.round((markerFiles / Math.max(1, totalFiles * 0.1)) * 100));

	return {
		detected,
		confidence,
		evidence: evidence.slice(0, 10), // Limit to 10 examples
	};
}

/**
 * Recursively find all TypeScript files, excluding node_modules and common ignore patterns
 */
function findTypeScriptFiles(dir: string, files: string[] = []): string[] {
	if (!existsSync(dir)) {
		return files;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			// Skip common ignore patterns
			if (shouldSkip(entry.name)) {
				continue;
			}

			const fullPath = join(dir, entry.name);

			if (entry.isDirectory()) {
				findTypeScriptFiles(fullPath, files);
			} else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
				files.push(fullPath);
			}
		}
	} catch (err) {
		// Skip directories we can't read
		return files;
	}

	return files;
}

/**
 * Check if a directory or file should be skipped
 */
function shouldSkip(name: string): boolean {
	const skipPatterns = [
		'node_modules',
		'.git',
		'dist',
		'build',
		'coverage',
		'.next',
		'.turbo',
		'.cache',
		'vendor',
	];

	return skipPatterns.includes(name);
}
