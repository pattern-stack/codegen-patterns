/**
 * `GET /api/graph` and `POST /api/validate` (STUDIO-0, #698).
 *
 * Both shell the real CLI — `project graph --json` and `entity validate
 * --json` — and reshape its payload. The server holds no second copy of the
 * analyzer: what Studio draws is exactly what the CLI reports.
 */

import fs from 'node:fs';

import type { SerializedDomainGraph } from '../../analyzer/serialize-graph.js';
import type { GraphResponse, ValidateResponse } from '../shared/api.js';
import { runCliJson } from './cli-runner.js';
import { definitionDirs } from './files.js';

/** The `project graph --json` envelope, as the CLI prints it. */
interface GraphCliPayload {
	command: string;
	entities: number;
	relationshipDefinitions: number;
	edges: number;
	graph: SerializedDomainGraph;
}

interface ValidateCliPayload {
	command: string;
	directory: string;
	valid: boolean;
	errors: Array<{ entity?: string; path?: string; message: string }>;
	warnings: Array<{ entity?: string; path?: string; message: string }>;
}

export class CliFailureError extends Error {
	readonly detail: string;
	constructor(what: string, detail: string) {
		super(`${what} failed`);
		this.name = 'CliFailureError';
		this.detail = detail;
	}
}

/** Junction YAML count — the CLI's graph envelope reports edges, not junctions. */
function countJunctions(projectDir: string): number {
	const dir = definitionDirs(projectDir).junctions;
	if (!fs.existsSync(dir)) return 0;
	try {
		return fs
			.readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile() && /\.ya?ml$/.test(e.name)).length;
	} catch {
		return 0;
	}
}

export async function getGraph(projectDir: string): Promise<GraphResponse> {
	const result = await runCliJson<GraphCliPayload>(['project', 'graph'], { cwd: projectDir });
	if (!result.payload) {
		throw new CliFailureError('project graph', result.stderr || result.stdout);
	}
	return {
		graph: result.payload.graph,
		entities: result.payload.entities,
		junctions: countJunctions(projectDir),
		relationships: result.payload.relationshipDefinitions,
	};
}

export async function validateProject(projectDir: string): Promise<ValidateResponse> {
	const result = await runCliJson<ValidateCliPayload>(['entity', 'validate'], { cwd: projectDir });
	// `entity validate` exits 1 when the project has errors — that is a valid
	// answer, not a failure. Only a missing payload is a failure.
	if (!result.payload) {
		throw new CliFailureError('entity validate', result.stderr || result.stdout);
	}
	return {
		valid: result.payload.valid,
		errors: result.payload.errors ?? [],
		warnings: result.payload.warnings ?? [],
	};
}

/** True when the project has any relationship YAML to regenerate. */
export function hasRelationshipYamls(projectDir: string): boolean {
	const dir = definitionDirs(projectDir).relationships;
	if (!fs.existsSync(dir)) return false;
	try {
		return fs
			.readdirSync(dir, { recursive: true, withFileTypes: true })
			.some((e) => e.isFile() && /\.ya?ml$/.test(e.name));
	} catch {
		return false;
	}
}
