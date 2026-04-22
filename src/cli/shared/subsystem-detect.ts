/**
 * Detect which subsystems (events/jobs/cache/storage) are already installed
 * in the user's project. A subsystem is "installed" when a `<name>.protocol.ts`
 * exists under a known install root.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.js';

export type SubsystemName = 'events' | 'jobs' | 'cache' | 'storage' | 'sync' | 'bridge';
export type SubsystemBackend = 'drizzle' | 'memory' | 'local' | 'unknown';

export interface InstalledSubsystem {
	name: SubsystemName;
	path: string;
	backend: SubsystemBackend;
}

export interface SubsystemDescriptor {
	name: SubsystemName;
	description: string;
	backends: SubsystemBackend[];
	defaultBackend: SubsystemBackend;
}

export const SUBSYSTEMS: SubsystemDescriptor[] = [
	{
		name: 'events',
		description: 'Domain event bus (transactional outbox)',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		name: 'jobs',
		description: 'Background job queue',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		name: 'cache',
		description: 'Key-value cache with TTL',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		name: 'storage',
		description: 'File/object storage',
		backends: ['local', 'memory'],
		defaultBackend: 'local',
	},
	{
		name: 'sync',
		description: 'External-system sync engine (IChangeSource<T> + orchestrator + audit log)',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
	{
		name: 'bridge',
		description: 'Event-to-job bridge (durable async fanout via @JobHandler.triggers)',
		backends: ['drizzle', 'memory'],
		defaultBackend: 'drizzle',
	},
];

const KNOWN_NAMES = SUBSYSTEMS.map((s) => s.name);

function candidateRoots(cwd: string, configured?: string): string[] {
	const roots = [
		...(configured ? [path.resolve(cwd, configured)] : []),
		path.resolve(cwd, 'src/shared/subsystems'),
		path.resolve(cwd, 'src/subsystems'),
		path.resolve(cwd, 'shared/subsystems'),
	];
	// Deduplicate while preserving order
	return Array.from(new Set(roots));
}

function inferBackend(dir: string, name: SubsystemName): SubsystemBackend {
	const hasDrizzle = fs.existsSync(path.join(dir, `${name.replace(/s$/, '')}-bus.drizzle-backend.ts`))
		|| fs.readdirSync(dir).some((f) => f.endsWith('.drizzle-backend.ts'));
	const hasMemory = fs.readdirSync(dir).some((f) => f.endsWith('.memory-backend.ts'));
	const hasLocal = fs.readdirSync(dir).some((f) => f.includes('local'));
	if (hasDrizzle && hasMemory) return 'drizzle'; // both present → drizzle is the active one
	if (hasDrizzle) return 'drizzle';
	if (hasLocal) return 'local';
	if (hasMemory) return 'memory';
	return 'unknown';
}

export async function detectInstalledSubsystems(ctx: Context): Promise<InstalledSubsystem[]> {
	const configured = ctx.config?.paths?.subsystems as string | undefined;
	const roots = candidateRoots(ctx.cwd, configured);

	const found: InstalledSubsystem[] = [];
	const seen = new Set<SubsystemName>();

	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		for (const name of KNOWN_NAMES) {
			if (seen.has(name)) continue;
			const dir = path.join(root, name);
			if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
			// A subsystem is installed when the directory contains any *.protocol.ts
			const files = fs.readdirSync(dir);
			const hasProtocol = files.some((f) => f.endsWith('.protocol.ts'));
			if (!hasProtocol) continue;
			seen.add(name);
			found.push({
				name,
				path: dir,
				backend: inferBackend(dir, name),
			});
		}
	}

	return found;
}
