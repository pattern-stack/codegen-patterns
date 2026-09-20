/**
 * Server routing and the dev proxy (STUDIO-0, #698).
 *
 * These are the properties `just test-studio` structurally cannot cover: its
 * end-to-end run drives the API directly and never goes through Vite, so the
 * whole dev-serving path — which is what the owner actually looks at — has no
 * gate there. It has one here.
 *
 * The concrete defect this pins: `just studio` started Vite with no `--host`,
 * so Vite bound `[::1]` while the server proxied to `127.0.0.1`, and every UI
 * request came back as a 502 JSON body instead of the app. The recipe now pins
 * Vite to the address the server dials; these tests pin the proxy contract that
 * made the mismatch fatal — API routes handled locally, everything else
 * forwarded, and a clear 502 when the upstream is down.
 */
import { describe, it, expect, afterAll, beforeAll } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createStudioServer } from '../../studio/server/index';

let projectDir: string;

beforeAll(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-routing-'));
	fs.mkdirSync(path.join(projectDir, 'entities'), { recursive: true });
});

afterAll(() => {
	fs.rmSync(projectDir, { recursive: true, force: true });
});

/** A stand-in upstream that echoes the path it was asked for. */
async function fakeUpstream(): Promise<{ origin: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end(`<html>upstream:${req.url}</html>`);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

describe('serving the built UI', () => {
	it('answers /api even with no UI to serve, and 404s the UI with a build hint', async () => {
		const s = await createStudioServer({ projectDir, port: 0, uiDir: '/nonexistent' });
		try {
			const health = await fetch(`${s.url}/api/health`);
			expect(health.status).toBe(200);
			expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

			const ui = await fetch(`${s.url}/`);
			expect(ui.status).toBe(404);
			expect(((await ui.json()) as { error: string }).error).toContain('not built');
		} finally {
			await s.close();
		}
	});

	it('serves index.html for an unknown path (SPA fallback) but never for /api', async () => {
		const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ui-'));
		fs.writeFileSync(path.join(uiDir, 'index.html'), '<html>app</html>');
		const s = await createStudioServer({ projectDir, port: 0, uiDir });
		try {
			expect(await (await fetch(`${s.url}/graph`)).text()).toContain('app');
			// An unknown /api route must 404 as JSON, not fall through to the SPA.
			const api = await fetch(`${s.url}/api/nope`);
			expect(api.status).toBe(404);
			expect(api.headers.get('content-type')).toContain('application/json');
		} finally {
			await s.close();
			fs.rmSync(uiDir, { recursive: true, force: true });
		}
	});

	it('refuses to serve a file from outside the UI directory', async () => {
		const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ui-'));
		fs.writeFileSync(path.join(uiDir, 'index.html'), '<html>app</html>');
		fs.writeFileSync(path.join(path.dirname(uiDir), 'secret.txt'), 'nope');
		const s = await createStudioServer({ projectDir, port: 0, uiDir });
		try {
			const res = await fetch(`${s.url}/../secret.txt`);
			expect(await res.text()).not.toContain('nope');
		} finally {
			await s.close();
			fs.rmSync(uiDir, { recursive: true, force: true });
		}
	});
});

describe('dev proxy', () => {
	it('forwards non-API requests to the Vite origin, querystring intact', async () => {
		const up = await fakeUpstream();
		const s = await createStudioServer({ projectDir, port: 0, viteOrigin: up.origin });
		try {
			expect(await (await fetch(`${s.url}/`)).text()).toContain('upstream:/');
			// A Vite asset request carries a cache-busting query that must survive.
			expect(await (await fetch(`${s.url}/src/main.tsx?t=1`)).text()).toContain(
				'upstream:/src/main.tsx?t=1',
			);
		} finally {
			await s.close();
			await up.close();
		}
	});

	it('handles /api LOCALLY rather than forwarding it to Vite', async () => {
		const up = await fakeUpstream();
		const s = await createStudioServer({ projectDir, port: 0, viteOrigin: up.origin });
		try {
			const res = await fetch(`${s.url}/api/health`);
			expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
		} finally {
			await s.close();
			await up.close();
		}
	});

	it('allows the dev Vite origin by CORS, and answers preflight', async () => {
		const up = await fakeUpstream();
		const s = await createStudioServer({ projectDir, port: 0, viteOrigin: up.origin });
		try {
			const res = await fetch(`${s.url}/api/health`);
			expect(res.headers.get('access-control-allow-origin')).toBe(up.origin);
			const pre = await fetch(`${s.url}/api/files`, { method: 'OPTIONS' });
			expect(pre.status).toBe(204);
		} finally {
			await s.close();
			await up.close();
		}
	});

	it('reports an unreachable Vite as a 502 NAMING the origin', async () => {
		// The shape of the failure the missing `--host` produced: the server is
		// fine, the upstream is not where it was dialed. The message has to say
		// where it looked, or the cause is invisible.
		const up = await fakeUpstream();
		const origin = up.origin;
		await up.close();
		const s = await createStudioServer({ projectDir, port: 0, viteOrigin: origin });
		try {
			const res = await fetch(`${s.url}/`);
			expect(res.status).toBe(502);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain(origin);
		} finally {
			await s.close();
		}
	});
});

describe('cross-site request forgery', () => {
	/**
	 * The bind address does not defend against this: the browser making the
	 * request is already on this machine. `readJsonBody` accepts any
	 * content-type, so a form POST from any page is a CORS "simple request" —
	 * never preflighted, sent regardless, side effect performed, only the
	 * response withheld. Before the Origin check, `Origin: https://evil.example`
	 * on `POST /api/generate` returned 202 and really generated.
	 */
	it('REFUSES a state-changing request from a foreign Origin', async () => {
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			const res = await fetch(`${s.url}/api/generate`, {
				method: 'POST',
				headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
				body: JSON.stringify({ steps: ['generate'] }),
			});
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: string }).error).toContain('evil.example');
		} finally {
			await s.close();
		}
	});

	it('refuses a foreign Origin on a form-encoded POST — the unpreflighted case', async () => {
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			const res = await fetch(`${s.url}/api/generate`, {
				method: 'POST',
				// text/plain is CORS-safelisted: no preflight, so the browser's
				// own checks never run and only this one stands between the page
				// and a real generate.
				headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
				body: JSON.stringify({ steps: ['generate'] }),
			});
			expect(res.status).toBe(403);
		} finally {
			await s.close();
		}
	});

	it('refuses a foreign Origin on PUT /api/files too, not just generate', async () => {
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			const res = await fetch(`${s.url}/api/files/${encodeURIComponent('entities/x.yaml')}`, {
				method: 'PUT',
				headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
				body: JSON.stringify({ content: 'entity:\n  name: x\n' }),
			});
			expect(res.status).toBe(403);
			expect(fs.existsSync(path.join(projectDir, 'entities', 'x.yaml'))).toBe(false);
		} finally {
			await s.close();
		}
	});

	it('ALLOWS a request with no Origin — curl, the harness, any non-browser client', async () => {
		// A browser always sends Origin on a cross-origin POST, so its absence
		// is not something the attack can arrange.
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			const res = await fetch(`${s.url}/api/relationships`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ from: 'nope', to: 'nope', kind: 'belongs_to' }),
			});
			// Rejected on its merits (no such entity), NOT by the Origin check.
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).not.toContain('cross-origin');
		} finally {
			await s.close();
		}
	});

	it("ALLOWS the server's own origin — the UI it serves is same-origin", async () => {
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			const res = await fetch(`${s.url}/api/relationships`, {
				method: 'POST',
				headers: { origin: s.url, 'content-type': 'application/json' },
				body: JSON.stringify({ from: 'nope', to: 'nope', kind: 'belongs_to' }),
			});
			expect(res.status).toBe(400);
		} finally {
			await s.close();
		}
	});

	it('ALLOWS the localhost alias of its own origin', async () => {
		// Someone who types `localhost:5178` rather than `127.0.0.1:5178` gets
		// an Origin the loopback-IP comparison alone would refuse — and only
		// writes would break, while every read kept working.
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			const port = new URL(s.url).port;
			const res = await fetch(`${s.url}/api/relationships`, {
				method: 'POST',
				headers: { origin: `http://localhost:${port}`, 'content-type': 'application/json' },
				body: JSON.stringify({ from: 'nope', to: 'nope', kind: 'belongs_to' }),
			});
			// Rejected on its merits, NOT by the Origin check.
			expect(res.status).toBe(400);
		} finally {
			await s.close();
		}
	});

	it('refuses the right port but the wrong host, and the right host but the wrong port', async () => {
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			const port = new URL(s.url).port;
			for (const origin of [`http://evil.example:${port}`, `http://127.0.0.1:${Number(port) + 1}`]) {
				const res = await fetch(`${s.url}/api/generate`, {
					method: 'POST',
					headers: { origin, 'content-type': 'application/json' },
					body: JSON.stringify({ steps: ['generate'] }),
				});
				expect(res.status).toBe(403);
			}
		} finally {
			await s.close();
		}
	});

	it('ALLOWS the configured dev Vite origin', async () => {
		const up = await fakeUpstream();
		const s = await createStudioServer({ projectDir, port: 0, viteOrigin: up.origin });
		try {
			const res = await fetch(`${s.url}/api/relationships`, {
				method: 'POST',
				headers: { origin: up.origin, 'content-type': 'application/json' },
				body: JSON.stringify({ from: 'nope', to: 'nope', kind: 'belongs_to' }),
			});
			expect(res.status).toBe(400);
		} finally {
			await s.close();
			await up.close();
		}
	});

	it('leaves GET alone — a cross-origin read cannot see the response anyway', async () => {
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			const res = await fetch(`${s.url}/api/health`, {
				headers: { origin: 'https://evil.example' },
			});
			expect(res.status).toBe(200);
		} finally {
			await s.close();
		}
	});
});

describe('bind address', () => {
	it('binds 127.0.0.1 only — the bind address IS the security boundary', async () => {
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			expect(s.url.startsWith('http://127.0.0.1:')).toBe(true);
		} finally {
			await s.close();
		}
	});
});
