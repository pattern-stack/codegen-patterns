/**
 * `GET /api/surface` (STUDIO-2, ADR-046).
 *
 * Shells the real CLI — `project surface --json` — and returns its `surface`
 * payload. The derivation is the generator's (`src/derived/api/`); the server
 * holds no second copy of it, and a fresh process per call means a pattern or
 * capability edited on disk is never served stale from a process-global
 * registry.
 *
 * Its own route rather than a field on `/api/graph`: an invalid include
 * allowlist is a generation error, and a surface failure must not blank the
 * canvas.
 */

import type { ProjectApiSurface, SurfaceResponse } from '../shared/api.js';
import { runCliJson } from './cli-runner.js';
import { CliFailureError } from './graph.js';

/** The `project surface --json` envelope, as the CLI prints it. */
interface SurfaceCliPayload {
	command: string;
	entities: number;
	surface: ProjectApiSurface;
}

export async function getSurface(projectDir: string): Promise<SurfaceResponse> {
	const result = await runCliJson<SurfaceCliPayload>(['project', 'surface'], { cwd: projectDir });
	// A missing payload — or one without its `surface` — is a failure, never `{}`.
	if (!result.payload?.surface) {
		throw new CliFailureError('project surface', result.stderr || result.stdout);
	}
	return { surface: result.payload.surface };
}
