#!/usr/bin/env bun
/**
 * Studio end-to-end harness (STUDIO-0 §6, #698).
 *
 * Boots the real Studio server against a real demo project and drives the
 * owner's loop over HTTP — no mocks, no fixtures of the server's own output:
 *
 *   1. GET  /api/health                     server is up, pointed at the demo
 *   2. GET  /api/graph                      3 entities, 4 edges, no relationships
 *   3. GET  /api/files                      the demo's YAML is listed
 *   4. GET  /api/files/entities%2Fcontact.yaml
 *   5. PUT  same path, deliberate schema error  → 422 with the exact Zod issue
 *   6.      …and the file on disk is untouched
 *   7. PUT  same path, corrected               → 200
 *   8. POST /api/relationships                 → preview only, nothing written
 *   9. PUT  /api/relationships                 → relationships/contact_opportunity.yaml
 *  10. POST /api/generate + GET /api/runs/:id/stream, consumed to `done`
 *  11.      the run's diff carries the new module
 *  12. GET  /api/graph                        → 5 edges, the N:M edge is there
 *
 * Every expectation is named and exact — an entity count, a Zod issue path, a
 * file path, an edge's cardinality. Nothing here filters or pattern-matches
 * loosely, so a regression surfaces as a specific failed expectation rather
 * than a quiet pass (charter I9).
 *
 * What this harness does NOT prove: that the generated code compiles. The demo
 * project installs no peer dependencies and nothing runs `tsc` over it — that
 * is `just test-smoke`'s job, and duplicating it here would trade the seconds
 * this takes for the minutes that one does. This proves the Studio loop.
 *
 * Runs in a private TMPDIR by construction (#691): the CLI reaches hygen
 * through a bare `bunx`, whose cache is machine-wide, so two concurrent gates
 * can read each other's half-written cache. Setting TMPDIR here rather than
 * asking the caller to remember means `just test-studio` is parallel-safe
 * however it is invoked.
 *
 * KEEP_STUDIO_DIR=1 preserves the demo project for inspection.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// A private TMPDIR must be in place before anything spawns the CLI, so this
// runs before the server import's side effects and before the demo is built.
const PRIVATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-e2e-'));
process.env.TMPDIR = PRIVATE_TMP;

import { materializeDemoProject } from '../../src/studio/demo/materialize.js';
import { createStudioServer } from '../../src/studio/server/index.js';
import type {
	DiffResponse,
	FileListResponse,
	FileReadResponse,
	FileValidationErrorResponse,
	GraphResponse,
	HealthResponse,
	RelationshipPreviewResponse,
	RelationshipRequest,
	RelationshipWriteResponse,
	RunEvent,
	RunStepName,
} from '../../src/studio/shared/api.js';

// ---------------------------------------------------------------------------
// Expectations — the demo project's exact shape, before and after.
// Sourced from the demo entity set (src/studio/demo/entities/), which declares
// account has_many {contacts, opportunities} and contact/opportunity each
// belongs_to account, with contact↔opportunity deliberately absent.
// ---------------------------------------------------------------------------

const DEMO_ENTITY_NAMES = ['account', 'contact', 'opportunity'];
const EXPECTED_EDGES_BEFORE = 4;
const EXPECTED_EDGES_AFTER = 5;

// These two move in lockstep with the demo entity set. #709 (adding a fourth
// entity so the demo can show a `role` edge — the one edge kind no real graph
// here confirms) derives an extra `belongs_to`, so it raises both by one. Change
// them together with the fixture, and read #709's constraint 3 first: the
// capability mixins resolve through `@shared/*`, which the demo's package
// runtime mode does not provide.

const CONTACT_YAML_PATH = 'entities/contact.yaml';
const RELATIONSHIP_YAML_PATH = 'relationships/contact_opportunity.yaml';
const RELATIONSHIP_NAME = 'contact_opportunity';
/**
 * One of the 11 files `relationship new` emits — the Drizzle table is the
 * load-bearing one.
 *
 * Kebab-case in both halves since #710: the filesystem is kebab, the database
 * is snake. `contact_opportunity` is multi-word, so the folder and the stem
 * both moved when #710 landed beneath this branch — note that the relationship
 * YAML above is still `contact_opportunity.yaml` and the junction table is
 * still `contact_opportunities`, because neither is a filename. If this
 * assertion goes red, update the value; an exact path is the point of it.
 */
const RELATIONSHIP_MODULE_FILE =
	'src/modules/contact-opportunities/contact-opportunity.entity.ts';

/** The deliberate error: `contact.title.type` is a string; `strng` is not a field type. */
const BAD_FIELD = 'title';
const BAD_TYPE = 'strng';
const EXPECTED_ISSUE_PATH = ['fields', BAD_FIELD, 'type'];
const EXPECTED_ISSUE_CODE = 'invalid_enum_value';

const RELATIONSHIP_REQUEST: RelationshipRequest = {
	from: 'contact',
	to: 'opportunity',
	kind: 'many_to_many',
	options: { name: RELATIONSHIP_NAME },
};

const GENERATE_STEPS: RunStepName[] = ['generate'];

/** A hung SSE stream must fail the gate, not hang the CI job. */
const STREAM_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Logging + assertions
// ---------------------------------------------------------------------------

const t0 = Date.now();
function elapsed(): string {
	return `[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;
}
function log(msg: string): void {
	console.log(`${elapsed()} ${msg}`);
}
function step(msg: string): void {
	console.log(`${elapsed()} ── ${msg}`);
}

let checks = 0;

class ExpectationError extends Error {}

function pass(label: string): void {
	checks++;
	console.log(`${elapsed()}    ✓ ${label}`);
}

function assert(condition: boolean, label: string, detail: string): void {
	if (!condition) throw new ExpectationError(`${label}\n       ${detail}`);
	pass(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
	assert(
		actual === expected,
		label,
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
	);
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
	assert(
		JSON.stringify(actual) === JSON.stringify(expected),
		label,
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
	);
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	assert(
		haystack.includes(needle),
		label,
		`${JSON.stringify(needle)} not found in: ${JSON.stringify(haystack.slice(0, 400))}`,
	);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let baseUrl = '';

/** Project-relative path → the `:path` segment the contract expects. */
function filePath(relative: string): string {
	return encodeURIComponent(relative);
}

interface Res<T> {
	status: number;
	body: T;
}

/**
 * Every request carries the server's own `Origin`, as a browser would.
 *
 * The server refuses a state-changing request whose `Origin` is present and
 * foreign (403), and allows one with no `Origin` at all — a non-browser client
 * cannot be the CSRF victim this defends against. Sending none would therefore
 * have exercised a different path than the UI does, and a regression that
 * refused same-origin writes would have left this harness green while the
 * Studio was broken in the browser.
 */
async function api<T>(
	method: string,
	route: string,
	body?: unknown,
	origin: string = baseUrl,
): Promise<Res<T>> {
	const headers: Record<string, string> = { origin };
	if (body !== undefined) headers['content-type'] = 'application/json';
	const response = await fetch(`${baseUrl}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text.length === 0 ? undefined : JSON.parse(text);
	} catch {
		throw new ExpectationError(
			`${method} ${route} returned ${response.status} with a non-JSON body:\n       ${text.slice(0, 400)}`,
		);
	}
	return { status: response.status, body: parsed as T };
}

/** Same, but fails the gate unless the status matches — the common case. */
async function expectApi<T>(
	method: string,
	route: string,
	expectedStatus: number,
	body?: unknown,
): Promise<T> {
	const res = await api<T>(method, route, body);
	if (res.status !== expectedStatus) {
		throw new ExpectationError(
			`${method} ${route} expected HTTP ${expectedStatus}, got ${res.status}\n` +
				`       body: ${JSON.stringify(res.body).slice(0, 400)}`,
		);
	}
	return res.body;
}

/**
 * Consume an SSE run stream to its terminal `done` frame.
 *
 * The contract's end-of-stream signal is a frame with `type: 'done'`, not the
 * socket closing, so this reads until that frame arrives and never relies on a
 * quiet period to decide the run finished.
 */
async function consumeRunStream(runId: string): Promise<RunEvent[]> {
	const response = await fetch(`${baseUrl}/api/runs/${runId}/stream`);
	if (!response.ok || response.body === null) {
		throw new ExpectationError(
			`GET /api/runs/${runId}/stream failed: HTTP ${response.status}`,
		);
	}

	const events: RunEvent[] = [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let done = false;

	const deadline = setTimeout(() => {
		void reader.cancel();
	}, STREAM_TIMEOUT_MS);

	try {
		while (!done) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });

			// SSE frames are separated by a blank line; each carries one `data:` line.
			let split = buffer.indexOf('\n\n');
			while (split !== -1) {
				const frame = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				for (const line of frame.split('\n')) {
					if (!line.startsWith('data:')) continue;
					const event = JSON.parse(line.slice(5).trim()) as RunEvent;
					events.push(event);
					if (event.type === 'log') log(`       │ ${event.line}`);
					if (event.type === 'step') log(`       │ step ${event.name}: ${event.status}`);
					if (event.type === 'done') done = true;
				}
				split = buffer.indexOf('\n\n');
			}
		}
	} finally {
		clearTimeout(deadline);
		await reader.cancel().catch(() => {});
	}

	if (!done) {
		throw new ExpectationError(
			`run stream ended without a 'done' frame after ${events.length} events ` +
				`(timeout ${STREAM_TIMEOUT_MS}ms)`,
		);
	}
	return events;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const projectDir = path.join(PRIVATE_TMP, 'demo');
	log(`tmp dir: ${PRIVATE_TMP}`);

	step('materialize the demo project');
	materializeDemoProject({ targetDir: projectDir, git: true });
	log(`demo project: ${projectDir}`);

	const reads = (relative: string): string =>
		fs.readFileSync(path.join(projectDir, relative), 'utf-8');

	const server = await createStudioServer({ projectDir, port: 0 });
	baseUrl = server.url.replace(/\/$/, '');
	log(`studio server: ${baseUrl}`);

	try {
		// ── 1. health ────────────────────────────────────────────────────────
		step('GET /api/health');
		const health = await expectApi<HealthResponse>('GET', '/api/health', 200);
		assertEqual(health.ok, true, 'health.ok is true');
		assertEqual(
			path.resolve(health.projectDir),
			path.resolve(projectDir),
			'health.projectDir is the demo project',
		);

		// ── 2. the graph before ──────────────────────────────────────────────
		step('GET /api/graph — the demo set, before');
		const before = await expectApi<GraphResponse>('GET', '/api/graph', 200);
		assertEqual(before.entities, DEMO_ENTITY_NAMES.length, 'graph reports 3 entities');
		assertDeepEqual(
			Object.keys(before.graph.entities).sort(),
			[...DEMO_ENTITY_NAMES].sort(),
			'graph entities are exactly account, contact, opportunity',
		);
		assertEqual(before.relationships, 0, 'graph reports 0 relationships');
		assertEqual(
			before.graph.edges.length,
			EXPECTED_EDGES_BEFORE,
			'graph has 4 edges (2 has_many + 2 belongs_to)',
		);
		assertEqual(
			before.graph.edges.filter((e) => e.from === 'contact' && e.to === 'opportunity')
				.length,
			0,
			'there is no contact → opportunity edge yet',
		);

		// ── 3. the file list ─────────────────────────────────────────────────
		step('GET /api/files');
		const files = await expectApi<FileListResponse>('GET', '/api/files', 200);
		const contactEntry = files.find((f) => f.path === CONTACT_YAML_PATH);
		assert(
			contactEntry !== undefined,
			`/api/files lists ${CONTACT_YAML_PATH}`,
			`listed paths: ${JSON.stringify(files.map((f) => f.path))}`,
		);
		assertEqual(contactEntry?.kind, 'entity', 'contact.yaml is kind "entity"');
		assertEqual(contactEntry?.name, 'contact', 'contact.yaml is named "contact"');

		// ── 4. read it ───────────────────────────────────────────────────────
		step(`GET /api/files/${CONTACT_YAML_PATH}`);
		const read = await expectApi<FileReadResponse>(
			'GET',
			`/api/files/${filePath(CONTACT_YAML_PATH)}`,
			200,
		);
		assertEqual(read.path, CONTACT_YAML_PATH, 'read echoes the project-relative path');
		assertEqual(
			read.content,
			reads(CONTACT_YAML_PATH),
			'read content matches the file on disk',
		);
		assertIncludes(read.content, `  ${BAD_FIELD}:`, `contact.yaml declares a ${BAD_FIELD} field`);

		// ── 5. write it back broken ──────────────────────────────────────────
		step(`PUT /api/files/${CONTACT_YAML_PATH} — deliberate schema error`);
		const broken = read.content.replace(
			new RegExp(`(  ${BAD_FIELD}:\\n    type: )string`),
			`$1${BAD_TYPE}`,
		);
		assert(
			broken !== read.content,
			`the harness actually corrupted ${BAD_FIELD}.type`,
			'the replacement did not match — the demo fixture shape changed',
		);
		const rejection = await expectApi<FileValidationErrorResponse>(
			'PUT',
			`/api/files/${filePath(CONTACT_YAML_PATH)}`,
			422,
			{ content: broken },
		);
		const issue = rejection.issues.find(
			(i) => JSON.stringify(i.path) === JSON.stringify(EXPECTED_ISSUE_PATH),
		);
		assert(
			issue !== undefined,
			`422 carries an issue at ${EXPECTED_ISSUE_PATH.join('.')}`,
			`issues: ${JSON.stringify(rejection.issues)}`,
		);
		assertEqual(issue?.code, EXPECTED_ISSUE_CODE, 'the issue code is invalid_enum_value');
		assertIncludes(
			issue?.message ?? '',
			`received '${BAD_TYPE}'`,
			'the issue message names the rejected value',
		);

		// ── 6. …and nothing was written ──────────────────────────────────────
		assertEqual(
			reads(CONTACT_YAML_PATH),
			read.content,
			'the rejected write did not touch the file on disk',
		);

		// ── 6b. a write from a foreign origin is refused ─────────────────────
		// The same valid content that succeeds below must be refused when it
		// arrives with someone else's Origin, or a page on any site could drive
		// the owner's generator. Asserted here rather than only in the server's
		// unit tests because this proves the guard is wired into the running
		// server, ahead of every handler.
		step('PUT /api/files — foreign Origin is refused');
		const forged = await api(
			'PUT',
			`/api/files/${filePath(CONTACT_YAML_PATH)}`,
			{ content: read.content },
			'https://evil.example',
		);
		assertEqual(forged.status, 403, 'a cross-origin write is refused with 403');
		assertEqual(
			reads(CONTACT_YAML_PATH),
			read.content,
			'the refused cross-origin write did not touch the file on disk',
		);

		// ── 7. fix it ────────────────────────────────────────────────────────
		step(`PUT /api/files/${CONTACT_YAML_PATH} — corrected`);
		await expectApi('PUT', `/api/files/${filePath(CONTACT_YAML_PATH)}`, 200, {
			content: read.content,
		});
		assertEqual(
			reads(CONTACT_YAML_PATH),
			read.content,
			'the accepted write restored the valid YAML',
		);

		// ── 8. preview the relationship ──────────────────────────────────────
		step('POST /api/relationships — preview, writes nothing');
		const preview = await expectApi<RelationshipPreviewResponse>(
			'POST',
			'/api/relationships',
			200,
			RELATIONSHIP_REQUEST,
		);
		assertDeepEqual(
			preview.preview.map((f) => f.path),
			[RELATIONSHIP_YAML_PATH],
			'preview is exactly one file, the relationship YAML',
		);
		const previewed = parseYaml(preview.preview[0].content) as {
			relationship?: { name?: string; from?: string; to?: string };
		};
		assertEqual(
			previewed.relationship?.name,
			RELATIONSHIP_NAME,
			'previewed YAML declares relationship.name',
		);
		assertEqual(previewed.relationship?.from, 'contact', 'previewed YAML is from contact');
		assertEqual(previewed.relationship?.to, 'opportunity', 'previewed YAML is to opportunity');
		assertEqual(
			fs.existsSync(path.join(projectDir, RELATIONSHIP_YAML_PATH)),
			false,
			'the preview wrote nothing to disk',
		);

		// ── 9. write it ──────────────────────────────────────────────────────
		step('PUT /api/relationships — write');
		const written = await expectApi<RelationshipWriteResponse>(
			'PUT',
			'/api/relationships',
			200,
			RELATIONSHIP_REQUEST,
		);
		assertDeepEqual(
			written.written,
			[RELATIONSHIP_YAML_PATH],
			'the write reports exactly the relationship YAML',
		);
		assertEqual(
			fs.existsSync(path.join(projectDir, RELATIONSHIP_YAML_PATH)),
			true,
			'the relationship YAML is on disk',
		);

		// ── 10. generate ─────────────────────────────────────────────────────
		step('POST /api/generate + consume the run stream');
		// 202, not 200: the run is accepted and proceeds asynchronously — the
		// result arrives on the stream, not in this response.
		const run = await expectApi<{ runId: string }>('POST', '/api/generate', 202, {
			steps: GENERATE_STEPS,
		});
		assert(
			typeof run.runId === 'string' && run.runId.length > 0,
			'generate returns a runId',
			`got ${JSON.stringify(run.runId)}`,
		);
		const events = await consumeRunStream(run.runId);

		const doneEvent = events.find((e) => e.type === 'done');
		assert(doneEvent !== undefined, 'the run stream terminated with a done frame', 'no done frame');
		if (doneEvent?.type !== 'done') throw new ExpectationError('unreachable');
		assertEqual(doneEvent.ok, true, 'the run reports ok: true');

		// A step reports `running` first and its outcome last, so the terminal
		// status is the LAST frame for that step, not the first.
		const generateSteps = events.filter(
			(e): e is Extract<RunEvent, { type: 'step' }> =>
				e.type === 'step' && e.name === 'generate',
		);
		assert(
			generateSteps.length > 0,
			'the stream carried a step frame for "generate"',
			`events: ${JSON.stringify(events.map((e) => e.type))}`,
		);
		assertEqual(
			generateSteps[generateSteps.length - 1].status,
			'ok',
			'the generate step finished ok',
		);

		// ── 11. the diff carries the new module ──────────────────────────────
		step('the run diff');
		assertDiffContains(doneEvent.diff, RELATIONSHIP_YAML_PATH, 'the relationship YAML');
		assertDiffContains(doneEvent.diff, RELATIONSHIP_MODULE_FILE, 'the generated Drizzle table');

		// ── 12. the graph after ──────────────────────────────────────────────
		step('GET /api/graph — the new edge');
		const after = await expectApi<GraphResponse>('GET', '/api/graph', 200);
		assertEqual(after.entities, DEMO_ENTITY_NAMES.length, 'still 3 entities');
		assertEqual(after.relationships, 1, 'graph reports 1 relationship');
		assertEqual(
			after.graph.edges.length,
			EXPECTED_EDGES_AFTER,
			'graph has 5 edges — the four from before plus one',
		);

		const newEdge = after.graph.edges.find(
			(e) => e.from === 'contact' && e.to === 'opportunity',
		);
		assert(
			newEdge !== undefined,
			'there is a contact → opportunity edge',
			`edges: ${JSON.stringify(after.graph.edges.map((e) => `${e.from}->${e.to}`))}`,
		);
		assertEqual(newEdge?.cardinality, 'N:M', 'the new edge is N:M');
		assertEqual(
			newEdge?.relationship.name,
			RELATIONSHIP_NAME,
			'the new edge names the relationship',
		);

		const definition = after.graph.relationshipDefinitions[RELATIONSHIP_NAME];
		assert(
			definition !== undefined,
			`graph.relationshipDefinitions carries ${RELATIONSHIP_NAME}`,
			`keys: ${JSON.stringify(Object.keys(after.graph.relationshipDefinitions))}`,
		);
		assertEqual(definition?.table, 'contact_opportunities', 'the junction table is named');
		assertEqual(definition?.fromColumn, 'contact_id', 'the from column is contact_id');
		assertEqual(definition?.toColumn, 'opportunity_id', 'the to column is opportunity_id');

		console.log('');
		log(`PASS — ${checks} expectations held`);
		return 0;
	} finally {
		await server.close();
	}
}

function assertDiffContains(diff: DiffResponse, relative: string, label: string): void {
	const entry = diff.files.find((f) => f.path === relative);
	assert(
		entry !== undefined,
		`the diff includes ${label} (${relative})`,
		`diff paths: ${JSON.stringify(diff.files.map((f) => f.path))}`,
	);
	assert(
		(entry?.patch ?? '').length > 0,
		`${label} has a non-empty patch`,
		'patch was empty — untracked files need an all-added patch synthesized',
	);
}

const keep = process.env.KEEP_STUDIO_DIR === '1';

main()
	.then((code) => {
		if (keep) console.log(`\nKEEP_STUDIO_DIR=1 — demo project left at ${PRIVATE_TMP}`);
		else fs.rmSync(PRIVATE_TMP, { recursive: true, force: true });
		process.exit(code);
	})
	.catch((err) => {
		console.error('');
		if (err instanceof ExpectationError) {
			console.error(`${elapsed()} [FAIL] expectation did not hold:\n       ${err.message}`);
		} else {
			console.error(`${elapsed()} [FAIL] ${err instanceof Error ? err.stack : String(err)}`);
		}
		console.error(`${elapsed()} ${checks} expectations held before the failure`);
		console.error(`${elapsed()} demo project left at ${PRIVATE_TMP} for inspection`);
		process.exit(1);
	});
