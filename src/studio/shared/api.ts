/**
 * Studio API contract (STUDIO-0, #698).
 *
 * The single source of truth for the wire shapes exchanged between the Studio
 * server (`src/studio/server/**`) and the Studio UI (`tools/studio/**`). Both
 * halves import these types — the UI through its `@studio-shared` path alias —
 * so a change here is a change both sides typecheck against.
 *
 * Everything in this file is types only: it must stay free of runtime imports
 * so the UI bundle never pulls the generator into the browser.
 */

export type { SerializedDomainGraph } from '../../analyzer/serialize-graph.js';
import type { SerializedDomainGraph } from '../../analyzer/serialize-graph.js';

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

export interface HealthResponse {
	ok: true;
	/** Absolute path of the project the server was started against. */
	projectDir: string;
	/** Version of the codegen CLI backing this server. */
	cliVersion: string;
}

// ---------------------------------------------------------------------------
// GET /api/graph
// ---------------------------------------------------------------------------

/**
 * `codegen project graph --json`'s `graph` payload, plus the three counts the
 * UI puts in its header. The counts are siblings of `graph` rather than spread
 * into it because `SerializedDomainGraph.entities` is already the entity map.
 */
export interface GraphResponse {
	graph: SerializedDomainGraph;
	entities: number;
	junctions: number;
	relationships: number;
}

// ---------------------------------------------------------------------------
// GET /api/files, GET|PUT /api/files/:path
// ---------------------------------------------------------------------------

export type StudioFileKind = 'entity' | 'junction' | 'relationship' | 'config';

export interface StudioFile {
	kind: StudioFileKind;
	/** Path relative to the project dir, POSIX separators. URL-encode before use. */
	path: string;
	/** Display name — the entity/junction/relationship name, or the file stem. */
	name: string;
}

export type FileListResponse = StudioFile[];

export interface FileReadResponse {
	path: string;
	content: string;
}

export interface FileWriteRequest {
	content: string;
}

export interface FileWriteResponse {
	ok: true;
}

/**
 * A Zod issue flattened to what crosses the wire. `zod`'s own `ZodIssue` is a
 * discriminated union whose members carry runtime-only helpers; the server
 * narrows each issue to this shape before responding 422.
 */
export interface ZodIssueLike {
	path: (string | number)[];
	message: string;
	code: string;
}

/** Body of a 422 from `PUT /api/files/:path`. */
export interface FileValidationErrorResponse {
	issues: ZodIssueLike[];
}

// ---------------------------------------------------------------------------
// POST /api/validate
// ---------------------------------------------------------------------------

export interface ValidationIssue {
	entity?: string;
	path?: string;
	message: string;
}

export interface ValidateResponse {
	valid: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// POST /api/generate, GET /api/runs/:id/stream
// ---------------------------------------------------------------------------

export type RunStepName = 'generate' | 'dbPush' | 'restart';

export interface GenerateRequest {
	steps: RunStepName[];
}

export interface GenerateResponse {
	runId: string;
}

/** Body of a 409 from `POST /api/generate` while another run is in flight. */
export interface RunConflictResponse {
	error: string;
	/** The run already occupying the registry. */
	runId: string;
}

export type RunStepStatus = 'running' | 'ok' | 'failed' | 'skipped';

export interface RunLogEvent {
	type: 'log';
	line: string;
}

export interface RunStepEvent {
	type: 'step';
	name: RunStepName;
	status: RunStepStatus;
}

export interface RunDoneEvent {
	type: 'done';
	ok: boolean;
	/** Working-tree diff of the project after the run — same shape as `/api/diff`. */
	diff: DiffResponse;
}

export type RunEvent = RunLogEvent | RunStepEvent | RunDoneEvent;

// ---------------------------------------------------------------------------
// GET /api/diff
// ---------------------------------------------------------------------------

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface DiffFile {
	/** Path relative to the project dir. */
	path: string;
	status: DiffStatus;
	/** Unified diff for this file. */
	patch: string;
}

export interface DiffResponse {
	files: DiffFile[];
}

// ---------------------------------------------------------------------------
// POST|PUT /api/relationships
// ---------------------------------------------------------------------------

export type RelationshipKind = 'belongs_to' | 'has_many' | 'has_one' | 'many_to_many';

export interface RelationshipRequest {
	from: string;
	to: string;
	kind: RelationshipKind;
	options?: RelationshipOptions;
}

export interface RelationshipOptions {
	/** Relationship / FK name override. */
	name?: string;
	/** Inverse accessor name on the target entity. */
	inverse?: string;
	/** Junction table name for `many_to_many`. */
	through?: string;
	/** Whether the foreign key is required. */
	required?: boolean;
	onDelete?: 'cascade' | 'set null' | 'restrict';
}

export interface RelationshipPreviewFile {
	/** Path relative to the project dir. */
	path: string;
	content: string;
}

/** `POST /api/relationships` — dry run, writes nothing. */
export interface RelationshipPreviewResponse {
	preview: RelationshipPreviewFile[];
}

/** `PUT /api/relationships` — same payload, files written. */
export interface RelationshipWriteResponse {
	written: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Every non-2xx response that is not a 422 validation failure uses this shape. */
export interface ApiErrorResponse {
	error: string;
	/** Captured stderr / stdout when the failure came from a CLI invocation. */
	detail?: string;
}

/** Default port `codegen studio` binds on 127.0.0.1. */
export const STUDIO_DEFAULT_PORT = 5178;
