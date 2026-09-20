/**
 * The Studio HTTP server (STUDIO-0, #698).
 *
 * `node:http` rather than a framework or a Bun-only API: the same file serves
 * `codegen studio` under either runtime, and the server has no dependency of
 * its own to add to the package.
 *
 * Bound to 127.0.0.1 only, which keeps the socket unreachable from off the
 * machine. That is necessary but NOT sufficient: the attacker who matters is a
 * malicious page open in a browser ON this machine, which can post to
 * localhost without ever reading the response. `readJsonBody` accepts any
 * content-type, so such a post is a CORS "simple request" and is never
 * preflighted — the browser sends it, the side effect happens, and only the
 * response is withheld.
 *
 * So state-changing requests are checked against {@link isOriginAllowed}: an
 * `Origin` header that is present and foreign is rejected 403 before any
 * handler runs. A request with no `Origin` (curl, the test harness, a non-
 * browser client) is allowed — a browser always sends one on a cross-origin
 * POST/PUT, so absence cannot be forged by the attack this defends against.
 *
 * Routing order is `/api/*` first, then the static UI, so a UI route can never
 * shadow an endpoint.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
	STUDIO_DEFAULT_PORT,
	type ApiErrorResponse,
	type FileWriteRequest,
	type HealthResponse,
} from '../shared/api.js';
import { CliFailureError, getGraph, validateProject } from './graph.js';
import { getDiff } from './diff.js';
import {
	FileNotFoundError,
	UnknownFileKindError,
	listFiles,
	readFile,
	writeFile,
} from './files.js';
import { PathSafetyError, realProjectDir } from './paths.js';
import {
	RunConflictError,
	RunRegistry,
	executeRun,
	parseSteps,
} from './runs.js';
import {
	RelationshipRequestError,
	parseRelationshipRequest,
	previewRelationship,
	writeRelationship,
} from './relationships.js';

export interface StudioServerOptions {
	/** The project Studio operates on. Every path is resolved inside it. */
	projectDir: string;
	/** Port to bind on 127.0.0.1. 0 picks a free one (tests). */
	port?: number;
	/**
	 * Built UI to serve. Defaults to the repo's `tools/studio/dist` when it
	 * exists; a missing directory is not an error — the API still serves.
	 */
	uiDir?: string;
	/** Dev only: origin of the Vite server to proxy non-API requests to. */
	viteOrigin?: string;
	/** CLI version reported by `/api/health`. */
	cliVersion?: string;
}

export interface StudioServer {
	port: number;
	url: string;
	close(): Promise<void>;
}

const HOST = '127.0.0.1';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
		'cache-control': 'no-store',
	});
	res.end(payload);
}

function sendError(res: http.ServerResponse, status: number, error: string, detail?: string): void {
	const body: ApiErrorResponse = detail ? { error, detail } : { error };
	sendJson(res, status, body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		// A definition file that large is not a definition file.
		if (size > 8 * 1024 * 1024) throw new Error('request body too large');
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString('utf-8');
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
	const raw = await readBody(req);
	if (raw.trim() === '') return {} as T;
	try {
		return JSON.parse(raw) as T;
	} catch (err: unknown) {
		throw new BadRequestError(
			`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

class BadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BadRequestError';
	}
}

/** Resolve the built UI directory, or null when there is nothing to serve. */
function resolveUiDir(explicit?: string): string | null {
	if (explicit) return fs.existsSync(explicit) ? explicit : null;
	// `src/studio/server` → repo root → tools/studio/dist
	const candidate = path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'studio', 'dist');
	return fs.existsSync(candidate) ? candidate : null;
}

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.map': 'application/json; charset=utf-8',
};

export function createStudioServer(options: StudioServerOptions): Promise<StudioServer> {
	const projectDir = realProjectDir(options.projectDir);
	if (!fs.existsSync(projectDir)) {
		return Promise.reject(new Error(`Project directory does not exist: ${options.projectDir}`));
	}

	const uiDir = resolveUiDir(options.uiDir);
	const viteOrigin = options.viteOrigin;
	const cliVersion = options.cliVersion ?? 'unknown';
	const registry = new RunRegistry();
	// Known only after listen(), and needed to recognise the UI's own
	// same-origin requests when the server serves the built UI itself.
	let boundPort = 0;

	function isStateChanging(method: string | undefined): boolean {
		return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
	}

	/**
	 * Whether a state-changing request carrying this `Origin` may proceed.
	 *
	 * Allowed: no Origin at all (curl, the test harness — a browser always
	 * sends one cross-origin, so its absence is not something the attack can
	 * arrange), this server's own origin (the UI it serves, same-origin), and
	 * the dev Vite origin when one is configured. Everything else is refused.
	 */
	function isOriginAllowed(origin: string | undefined): boolean {
		if (!origin) return true;
		if (viteOrigin && origin === viteOrigin) return true;
		return [
			`http://${HOST}:${boundPort}`,
			`http://localhost:${boundPort}`,
			`http://[::1]:${boundPort}`,
		].includes(origin);
	}

	const server = http.createServer((req, res) => {
		handle(req, res).catch((err: unknown) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			sendError(res, 500, 'internal error', err instanceof Error ? err.message : String(err));
		});
	});

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', `http://${HOST}`);
		const pathname = url.pathname;

		// The dev Vite origin is the only cross-origin caller there is.
		if (viteOrigin) {
			res.setHeader('access-control-allow-origin', viteOrigin);
			res.setHeader('access-control-allow-methods', 'GET,PUT,POST,OPTIONS');
			res.setHeader('access-control-allow-headers', 'content-type');
			res.setHeader('vary', 'origin');
			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}
		}

		// Cross-site request forgery: a page on any origin can POST here
		// without a preflight, and the bind address does not stop it because
		// the browser making the request is already on this machine.
		if (isStateChanging(req.method) && !isOriginAllowed(req.headers.origin)) {
			sendError(
				res,
				403,
				`cross-origin ${req.method} from ${req.headers.origin} is refused`,
			);
			return;
		}

		if (pathname.startsWith('/api/')) {
			await handleApi(req, res, url);
			return;
		}
		await serveStatic(req, res, pathname);
	}

	async function handleApi(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		url: URL,
	): Promise<void> {
		const method = req.method ?? 'GET';
		const pathname = url.pathname;

		try {
			// --- health ---------------------------------------------------
			if (pathname === '/api/health' && method === 'GET') {
				const body: HealthResponse = { ok: true, projectDir, cliVersion };
				sendJson(res, 200, body);
				return;
			}

			// --- graph ----------------------------------------------------
			if (pathname === '/api/graph' && method === 'GET') {
				sendJson(res, 200, await getGraph(projectDir));
				return;
			}

			// --- validate -------------------------------------------------
			if (pathname === '/api/validate' && method === 'POST') {
				sendJson(res, 200, await validateProject(projectDir));
				return;
			}

			// --- diff -----------------------------------------------------
			if (pathname === '/api/diff' && method === 'GET') {
				sendJson(res, 200, getDiff(projectDir));
				return;
			}

			// --- files ----------------------------------------------------
			if (pathname === '/api/files' && method === 'GET') {
				sendJson(res, 200, listFiles(projectDir));
				return;
			}
			if (pathname.startsWith('/api/files/')) {
				// One URL-encoded segment holding a project-relative POSIX path.
				const relPath = decodeURIComponent(pathname.slice('/api/files/'.length));
				if (method === 'GET') {
					sendJson(res, 200, readFile(projectDir, relPath));
					return;
				}
				if (method === 'PUT') {
					const body = await readJsonBody<FileWriteRequest>(req);
					if (typeof body.content !== 'string') {
						throw new BadRequestError('`content` must be a string');
					}
					const outcome = writeFile(projectDir, relPath, body.content);
					if (outcome.ok) sendJson(res, 200, { ok: true });
					else sendJson(res, 422, { issues: outcome.issues });
					return;
				}
			}

			// --- relationships --------------------------------------------
			if (pathname === '/api/relationships' && (method === 'POST' || method === 'PUT')) {
				const request = parseRelationshipRequest(await readJsonBody(req));
				if (method === 'POST') {
					sendJson(res, 200, { preview: previewRelationship(projectDir, request) });
				} else {
					sendJson(res, 200, { written: writeRelationship(projectDir, request) });
				}
				return;
			}

			// --- runs -----------------------------------------------------
			if (pathname === '/api/generate' && method === 'POST') {
				const steps = parseSteps(await readJsonBody(req));
				const run = registry.begin(steps);
				sendJson(res, 202, { runId: run.id });
				// Deliberately not awaited: the response is the run's id, and the
				// output arrives over the stream.
				void executeRun({ projectDir, registry, run });
				return;
			}
			const streamMatch = /^\/api\/runs\/([^/]+)\/stream$/.exec(pathname);
			if (streamMatch && method === 'GET') {
				streamRun(req, res, decodeURIComponent(streamMatch[1]));
				return;
			}

			sendError(res, 404, `no such endpoint: ${method} ${pathname}`);
		} catch (err: unknown) {
			respondToError(res, err);
		}
	}

	function respondToError(res: http.ServerResponse, err: unknown): void {
		if (err instanceof PathSafetyError) {
			sendError(res, 400, err.message);
			return;
		}
		if (err instanceof BadRequestError || err instanceof RelationshipRequestError) {
			sendError(res, 400, err.message);
			return;
		}
		if (err instanceof FileNotFoundError) {
			sendError(res, 404, err.message);
			return;
		}
		if (err instanceof UnknownFileKindError) {
			sendError(res, 400, err.message);
			return;
		}
		if (err instanceof RunConflictError) {
			sendJson(res, 409, { error: err.message, runId: err.runId });
			return;
		}
		if (err instanceof CliFailureError) {
			sendError(res, 502, err.message, err.detail);
			return;
		}
		if (err instanceof Error && err.message.startsWith('`steps`')) {
			sendError(res, 400, err.message);
			return;
		}
		if (err instanceof Error && err.message.startsWith('unknown step')) {
			sendError(res, 400, err.message);
			return;
		}
		sendError(res, 500, 'internal error', err instanceof Error ? err.message : String(err));
	}

	function streamRun(req: http.IncomingMessage, res: http.ServerResponse, runId: string): void {
		const run = registry.get(runId);
		if (!run) {
			sendError(res, 404, `no such run: ${runId}`);
			return;
		}

		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			// Defeats any buffering proxy between here and the browser.
			'x-accel-buffering': 'no',
		});
		// Flush the headers before the first event so EventSource opens promptly.
		res.flushHeaders?.();

		const unsubscribe = registry.subscribe(run, (event) => {
			// One `data:` line per event, flushed immediately — the point of the
			// stream is that a log line reaches the browser while the step that
			// produced it is still running.
			res.write(`data: ${JSON.stringify(event)}\n\n`);
			if (event.type === 'done') {
				unsubscribe();
				res.end();
			}
		});

		// A run that had already finished replays through subscribe() and ends
		// there; this covers the client disconnecting mid-run.
		req.on('close', unsubscribe);
	}

	async function serveStatic(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		pathname: string,
	): Promise<void> {
		if (viteOrigin) {
			await proxyToVite(req, res, pathname);
			return;
		}
		if (!uiDir) {
			sendError(
				res,
				404,
				'The Studio UI is not built. Run `just studio` for dev mode, or build tools/studio.',
			);
			return;
		}

		// The static root is its own containment boundary, same rule as the
		// project surface: nothing may be served from outside `uiDir`.
		const rel = pathname.replace(/^\/+/, '');
		const candidate = path.resolve(uiDir, rel === '' ? 'index.html' : rel);
		const withinUi =
			candidate === uiDir || candidate.startsWith(uiDir + path.sep);
		const file =
			withinUi && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
				? candidate
				: path.join(uiDir, 'index.html'); // SPA fallback

		if (!fs.existsSync(file)) {
			sendError(res, 404, 'not found');
			return;
		}
		const body = fs.readFileSync(file);
		res.writeHead(200, {
			'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
			'content-length': body.length,
		});
		res.end(body);
	}

	async function proxyToVite(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		pathname: string,
	): Promise<void> {
		const target = new URL(pathname + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), viteOrigin);
		try {
			const upstream = await fetch(target, {
				method: req.method,
				headers: { accept: req.headers.accept ?? '*/*' },
			});
			const buf = Buffer.from(await upstream.arrayBuffer());
			const headers: Record<string, string> = {};
			const contentType = upstream.headers.get('content-type');
			if (contentType) headers['content-type'] = contentType;
			headers['content-length'] = String(buf.length);
			res.writeHead(upstream.status, headers);
			res.end(buf);
		} catch (err: unknown) {
			sendError(
				res,
				502,
				`Vite dev server is not reachable at ${viteOrigin}`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	return new Promise<StudioServer>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? STUDIO_DEFAULT_PORT, HOST, () => {
			server.removeListener('error', reject);
			const port = (server.address() as AddressInfo).port;
			boundPort = port;
			resolve({
				port,
				url: `http://${HOST}:${port}`,
				close: () =>
					new Promise<void>((done, fail) => {
						server.close((err) => (err ? fail(err) : done()));
						server.closeAllConnections?.();
					}),
			});
		});
	});
}
