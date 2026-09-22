/**
 * The project's definition files, as the Studio file surface sees them
 * (STUDIO-0, #698).
 *
 * Discovery reuses the CLI's own directory rules — `projectLayout` for
 * `paths.entities` / `paths.providers`, `junctionsDirFor` for junctions — so
 * Studio can never list a file the CLI would not read (charter I1).
 *
 * A write is validated against the matching schema BEFORE it touches disk.
 * The Zod issues are narrowed to {@link ZodIssueLike} here rather than going
 * through `loadEntityFromYaml`, which flattens them to strings and loses the
 * `path` the editor needs to put the marker on the right line.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { findYamlFiles } from '../../utils/find-yaml-files.js';
import { projectLayout } from '../../cli/shared/project-layout.js';
import { junctionsDirFor } from '../../config/junctions-dir.js';
import { loadProjectConfig } from '../../config/project-config.js';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema.js';
import { JunctionDefinitionSchema } from '../../schema/junction-definition.schema.js';
import { RelationshipDefinitionSchema } from '../../schema/relationship-definition.schema.js';
import { CodegenConfigSchema } from '../../schema/codegen-config.schema.js';
import type { StudioFile, StudioFileKind, ZodIssueLike } from '../shared/api.js';
import { resolveProjectPath, toProjectRelative } from './paths.js';

export const CONFIG_FILENAME = 'codegen.config.yaml';

/** The directories Studio reads definitions from, all absolute. */
export interface DefinitionDirs {
	entities: string;
	providers: string;
	junctions: string;
	relationships: string;
}

export function definitionDirs(projectDir: string): DefinitionDirs {
	const config = loadProjectConfig(projectDir);
	const layout = projectLayout(projectDir, config);
	return {
		entities: layout.entities,
		providers: layout.providers,
		junctions: junctionsDirFor(projectDir),
		relationships: path.resolve(projectDir, 'relationships'),
	};
}

function yamlsIn(dir: string, excludeDirs: string[] = []): string[] {
	if (!fs.existsSync(dir)) return [];
	try {
		return findYamlFiles(dir, { excludeDirs });
	} catch {
		return [];
	}
}

/** The definition name inside a YAML file, or the file stem when unreadable. */
function displayName(file: string, kind: StudioFileKind): string {
	const stem = path.basename(file).replace(/\.ya?ml$/, '');
	if (kind === 'config') return CONFIG_FILENAME;
	try {
		const parsed = parseYaml(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
		if (!parsed || typeof parsed !== 'object') return stem;
		if (kind === 'entity' || kind === 'junction') {
			const entity = parsed.entity as Record<string, unknown> | undefined;
			const name = entity?.name ?? parsed.name;
			if (typeof name === 'string' && name.length > 0) return name;
		}
		if (kind === 'relationship') {
			const rel = parsed.relationship as Record<string, unknown> | undefined;
			if (typeof rel?.name === 'string' && rel.name.length > 0) return rel.name;
		}
	} catch {
		// Unparseable file still gets listed — Studio is how you go fix it.
	}
	return stem;
}

/** Every definition file Studio exposes, sorted by kind then path. */
export function listFiles(projectDir: string): StudioFile[] {
	const dirs = definitionDirs(projectDir);
	const out: StudioFile[] = [];

	const add = (file: string, kind: StudioFileKind) => {
		out.push({ kind, path: toProjectRelative(projectDir, file), name: displayName(file, kind) });
	};

	// Providers, junctions and relationships may be nested under the entities
	// root; excluding them keeps each file in exactly one bucket.
	for (const f of yamlsIn(dirs.entities, [dirs.providers, dirs.junctions, dirs.relationships])) {
		add(f, 'entity');
	}
	for (const f of yamlsIn(dirs.junctions)) add(f, 'junction');
	for (const f of yamlsIn(dirs.relationships)) add(f, 'relationship');

	const configPath = path.join(projectDir, CONFIG_FILENAME);
	if (fs.existsSync(configPath)) add(configPath, 'config');

	const order: Record<StudioFileKind, number> = {
		entity: 0,
		junction: 1,
		relationship: 2,
		config: 3,
	};
	return out.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
}

/**
 * Which schema governs a file, from its location. Location, not content: a
 * half-written entity YAML that no longer parses must still validate as an
 * entity, or the editor could never report why it is broken.
 */
export function kindForPath(projectDir: string, relPath: string): StudioFileKind | null {
	const abs = resolveProjectPath(projectDir, relPath);
	const dirs = definitionDirs(projectDir);
	const under = (dir: string) => {
		const rel = path.relative(dir, abs);
		return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
	};

	if (abs === path.join(projectDir, CONFIG_FILENAME)) return 'config';
	if (under(dirs.junctions)) return 'junction';
	if (under(dirs.relationships)) return 'relationship';
	if (under(dirs.providers)) return null; // provider YAML is not a Studio surface
	if (under(dirs.entities)) return 'entity';
	return null;
}

const SCHEMAS: Record<StudioFileKind, z.ZodTypeAny> = {
	entity: EntityDefinitionSchema,
	junction: JunctionDefinitionSchema,
	relationship: RelationshipDefinitionSchema,
	config: CodegenConfigSchema,
};

export type ValidationOutcome =
	| { ok: true }
	| { ok: false; issues: ZodIssueLike[] };

/**
 * Validate file content against the schema for `kind`.
 *
 * A YAML *syntax* error is reported through the same channel as a schema
 * error — one synthesized issue with an empty `path` and the parser's
 * line/column message — so the editor has a single error surface (#698).
 */
export function validateContent(kind: StudioFileKind, content: string): ValidationOutcome {
	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch (err: unknown) {
		return {
			ok: false,
			issues: [
				{
					path: [],
					code: 'custom',
					message: err instanceof Error ? err.message : String(err),
				},
			],
		};
	}

	const result = SCHEMAS[kind].safeParse(parsed);
	if (result.success) return { ok: true };
	return {
		ok: false,
		issues: result.error.issues.map((i) => ({
			path: [...i.path] as (string | number)[],
			message: i.message,
			code: i.code,
		})),
	};
}

export function readFile(projectDir: string, relPath: string): { path: string; content: string } {
	const abs = resolveProjectPath(projectDir, relPath);
	if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
		throw new FileNotFoundError(relPath);
	}
	return { path: toProjectRelative(projectDir, abs), content: fs.readFileSync(abs, 'utf-8') };
}

export class FileNotFoundError extends Error {
	constructor(relPath: string) {
		super(`No such file in this project: ${relPath}`);
		this.name = 'FileNotFoundError';
	}
}

export class UnknownFileKindError extends Error {
	constructor(relPath: string) {
		super(
			`${relPath} is not an entity, junction, relationship or config file — Studio will not write it.`,
		);
		this.name = 'UnknownFileKindError';
	}
}

/**
 * Validate, then write. Returns the issues instead of writing when the content
 * does not satisfy its schema — the file on disk is never left invalid by
 * Studio.
 */
export function writeFile(
	projectDir: string,
	relPath: string,
	content: string,
): ValidationOutcome {
	const kind = kindForPath(projectDir, relPath);
	if (!kind) throw new UnknownFileKindError(relPath);

	const outcome = validateContent(kind, content);
	if (!outcome.ok) return outcome;

	const abs = resolveProjectPath(projectDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
	return { ok: true };
}
