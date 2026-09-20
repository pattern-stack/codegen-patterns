/**
 * The Studio HTTP server (STUDIO-0, #698).
 *
 * `node:http` rather than a framework or a Bun-only API: the same file serves
 * `codegen studio` under either runtime, and the server has no dependency of
 * its own to add to the package.
 *
 * Bound to 127.0.0.1 by default, which keeps the socket unreachable from off
 * the machine. `host` can widen that for a remote owner, and then the bind is
 * the ONLY thing that was protecting an unauthenticated API — hence the
 * startup warning and the SSH-tunnel recommendation in it.
 *
 * The loopback bind is necessary but NOT sufficient even on its own: the
 * attacker who matters is a
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
import os from 'node:os';
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
	/** Port to bind. 0 picks a free one (tests). */
	port?: number;
	/**
	 * Address to bind. Defaults to 127.0.0.1 — the safe posture, and the one
	 * you keep unless you deliberately need to reach Studio from another
	 * machine. A non-loopback bind exposes an UNAUTHENTICATED API that can run
	 * generate / dbPush / restart, so it emits a warning through {@link warn}.
	 */
	host?: string;
	/**
	 * Extra origins accepted on state-changing requests, in addition to the
	 * server's own and the dev Vite origin. Exact string match only — no
	 * wildcards, no patterns, no `*`. Needed when the browser reaches a
	 * non-loopback bind by a NAME rather than the bound address, since the
	 * Origin header then carries the name.
	 */
	allowOrigins?: string[];
	/** Where startup warnings go. Defaults to stderr. */
	warn?: (message: string) => void;
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
	/** The address actually bound. */
	host: string;
	url: string;
	/** False when the bind is reachable from off this machine. */
	loopback: boolean;
	/** Every origin accepted on a state-changing request, for display. */
	allowedOrigins: string[];
	close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
/** Binds that mean "every interface" — the browser's origin cannot be predicted. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);

/** True for an address only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
	return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** `http://host:port`, bracketing a bare IPv6 literal. */
export function originFor(host: string, port: number): string {
	return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/**
 * The origins that are "this server", by the address it bound.
 *
 * A wildcard bind is reachable at every local address, so each one is
 * enumerated rather than waved through: the rule stays exact-match, and an
 * origin that is not one of this machine's addresses is still refused.
 */
export function selfOrigins(host: string, port: number): string[] {
	const loopback = [
		originFor('127.0.0.1', port),
		originFor('localhost', port),
		originFor('::1', port),
	];
	if (WILDCARD_HOSTS.has(host)) {
		const local: string[] = [];
		for (const addrs of Object.values(os.networkInterfaces())) {
			for (const a of addrs ?? []) {
				if (!a.internal) local.push(originFor(a.address, port));
			}
		}
		return [...loopback, ...local];
	}
	if (isLoopbackHost(host)) return loopback;
	return [originFor(host, port)];
}

/**
 * Validate an `--allow-origin` value. An origin and nothing else: a scheme, a
 * host, an optional port. No path, no wildcard, no `*` — a pattern language
 * here is how an allowlist quietly becomes "allow anything".
 */
export function validateAllowedOrigin(value: string): string {
	if (value === '*' || value.includes('*')) {
		throw new Error(`--allow-origin does not accept wildcards: ${value}`);
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`--allow-origin must be a full origin like http://host:port, got: ${value}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`--allow-origin must be http or https, got: ${value}`);
	}
	if (parsed.origin !== value.replace(/\/$/, '')) {
		throw new Error(
			`--allow-origin must be an origin with no path or query, got: ${value} (did you mean ${parsed.origin}?)`,
		);
	}
	return parsed.origin;
}

/** The warning a non-loopback bind prints. Exported so the CLI renders the same text. */
export function nonLoopbackWarning(host: string, port: number): string {
	return [
		`Studio is bound to ${host}:${port}, which is reachable from other machines.`,
		'The API is UNAUTHENTICATED: anyone who can reach this address can read and',
		'write this project\u2019s YAML and run generate / dbPush / restart in it.',
		'Prefer an SSH tunnel (ssh -L 5178:127.0.0.1:5178 <host>) and the default',
		'loopback bind, or restrict who can reach this address.',
	].join('\n');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
		'cache-control': 'no-store',
	});
	res.end(payload);
}

/** Send a file with the content type its extension implies. */
function sendFile(res: http.ServerResponse, file: string): void {
	const body = fs.readFileSync(file);
	res.writeHead(200, {
		'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
		'content-length': body.length,
	});
	res.end(body);
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
/** Thrown when `--ui-dir` names something that is not a built UI. */
export class UiDirError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UiDirError';
	}
}

/**
 * The built UI to serve, or null when there is none to serve.
 *
 * ABSOLUTE and symlink-resolved, always. Returning the path as given meant a
 * relative `--ui-dir tools/studio/dist` was compared against an absolute
 * candidate in the containment check below, which then failed for EVERY
 * request — so every asset fell through to index.html and the UI was a black
 * screen with "Failed to load module script" (#716). The dev proxy path has no
 * such check, which is why only the built-UI path broke.
 *
 * An EXPLICIT `--ui-dir` that is missing or unbuilt throws rather than
 * starting: `tools/studio/dist` is gitignored and built on demand, so pointing
 * at a checkout where nobody ran the build would otherwise serve 404s and name
 * no cause — the same failure shape as #716. Asking for a UI and silently
 * getting none is a different thing from not asking.
 */
function resolveUiDir(explicit?: string): string | null {
	const real = (p: string) => {
		try {
			return fs.realpathSync(p);
		} catch {
			return p;
		}
	};

	if (explicit) {
		const candidate = path.resolve(explicit);
		if (!fs.existsSync(candidate)) {
			throw new UiDirError(
				`no built UI at ${candidate} — run \`bun run build\` in tools/studio, or omit --ui-dir`,
			);
		}
		if (!fs.statSync(candidate).isDirectory()) {
			throw new UiDirError(`--ui-dir is not a directory: ${candidate}`);
		}
		if (!fs.existsSync(path.join(candidate, 'index.html'))) {
			throw new UiDirError(
				`${candidate} has no index.html — it is not a built UI. Run \`bun run build\` in tools/studio.`,
			);
		}
		return real(candidate);
	}

	// `src/studio/server` → repo root → tools/studio/dist. Absent is fine here:
	// nobody asked for a UI, and the API alone is useful (`just studio` relies
	// on this when tools/studio is not in the checkout).
	const candidate = path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'studio', 'dist');
	if (!fs.existsSync(candidate)) return null;
	if (!fs.existsSync(path.join(candidate, 'index.html'))) return null;
	return real(candidate);
}

/**
 * Content types for a built Vite tree. A wrong type here is fatal rather than
 * cosmetic: a browser refuses a module script that does not arrive as
 * JavaScript, so `text/html` on an `.js` request is a blank page (#716).
 */
const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.cjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
};

/**
 * Whether a request that matched no file should get the SPA shell.
 *
 * A missing asset must NOT fall back to index.html — HTML arriving where
 * JavaScript was expected is how #716 presented, and a 404 says what is
 * actually wrong. But the extension cannot decide this: Studio routes on
 * `/files/entities/contact.yaml`, which is a navigation, not a YAML asset.
 *
 * What distinguishes them is what the CLIENT says it wants. A navigation sends
 * `Sec-Fetch-Dest: document` (and `Accept: text/html,…`); a module script or a
 * stylesheet sends its own dest and `Accept: *​/*`. The extension is consulted
 * only for a client that sends neither, i.e. not a browser.
 */
function wantsHtmlShell(req: http.IncomingMessage, pathname: string): boolean {
	const dest = req.headers['sec-fetch-dest'];
	if (typeof dest === 'string' && dest.length > 0) return dest === 'document';

	const accept = req.headers.accept ?? '';
	if (accept.includes('text/html')) return true;
	if (accept !== '' && accept !== '*/*') return false;

	// No browser signals at all — fall back to the shape of the path.
	const ext = path.extname(pathname);
	return ext === '' || ext === '.html';
}

export function createStudioServer(options: StudioServerOptions): Promise<StudioServer> {
	const projectDir = realProjectDir(options.projectDir);
	if (!fs.existsSync(projectDir)) {
		return Promise.reject(new Error(`Project directory does not exist: ${options.projectDir}`));
	}

	let uiDir: string | null;
	try {
		uiDir = resolveUiDir(options.uiDir);
	} catch (err: unknown) {
		return Promise.reject(err instanceof Error ? err : new Error(String(err)));
	}
	const viteOrigin = options.viteOrigin;
	const cliVersion = options.cliVersion ?? 'unknown';
	const registry = new RunRegistry();
	const host = options.host ?? DEFAULT_HOST;
	const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
	let extraOrigins: string[];
	try {
		extraOrigins = (options.allowOrigins ?? []).map(validateAllowedOrigin);
	} catch (err: unknown) {
		return Promise.reject(err instanceof Error ? err : new Error(String(err)));
	}
	// Known only after listen(), and needed to recognise the UI's own
	// same-origin requests when the server serves the built UI itself.
	let boundPort = 0;
	let ownOrigins: string[] = [];

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
		if (extraOrigins.includes(origin)) return true;
		return ownOrigins.includes(origin);
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
		// Base is a parsing placeholder — only pathname and search are read.
		const url = new URL(req.url ?? '/', 'http://studio.invalid');
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
		// project surface: nothing may be served from outside `uiDir`. Both
		// sides of this comparison are absolute and symlink-resolved
		// (`resolveUiDir`), or it silently rejects everything (#716).
		let decoded: string;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			sendError(res, 400, `malformed path: ${pathname}`);
			return;
		}
		const rel = decoded.replace(/^\/+/, '');
		const candidate = path.resolve(uiDir, rel === '' ? 'index.html' : rel);
		const withinUi = candidate === uiDir || candidate.startsWith(uiDir + path.sep);

		if (!withinUi) {
			sendError(res, 403, 'path escapes the UI directory');
			return;
		}

		// A real file under the UI root wins — always, and before any fallback.
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			sendFile(res, candidate);
			return;
		}

		// No file matched. A navigation falls back to the SPA shell so
		// client-side routing works; a subresource request gets a 404.
		if (!wantsHtmlShell(req, decoded)) {
			sendError(res, 404, `no such file in the Studio UI: ${rel}`);
			return;
		}

		const shell = path.join(uiDir, 'index.html');
		if (!fs.existsSync(shell)) {
			sendError(res, 404, `the Studio UI at ${uiDir} has no index.html`);
			return;
		}
		sendFile(res, shell);
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
		server.listen(options.port ?? STUDIO_DEFAULT_PORT, host, () => {
			server.removeListener('error', reject);
			const port = (server.address() as AddressInfo).port;
			boundPort = port;
			ownOrigins = selfOrigins(host, port);
			const loopback = isLoopbackHost(host);
			// Emitted here rather than in the CLI so a programmatic caller
			// cannot bind the world and skip the notice.
			if (!loopback) warn(nonLoopbackWarning(host, port));
			resolve({
				port,
				host,
				loopback,
				allowedOrigins: [...ownOrigins, ...extraOrigins, ...(viteOrigin ? [viteOrigin] : [])],
				url: originFor(isLoopbackHost(host) ? DEFAULT_HOST : host, port),
				close: () =>
					new Promise<void>((done, fail) => {
						server.close((err) => (err ? fail(err) : done()));
						server.closeAllConnections?.();
					}),
			});
		});
	});
}
