/**
 * Serving the BUILT UI from `--ui-dir` (#716).
 *
 * This is the path a LAN/tailnet instance uses, and it had no gate: the
 * routing tests cover the dev Vite proxy, which shares none of this code. The
 * consequence was a black screen — every request fell through to index.html,
 * so `/assets/main.js` arrived as `text/html` and the browser refused the
 * module script.
 *
 * The cause was that `--ui-dir` was used as given, so a RELATIVE path was
 * compared against an absolute candidate in the containment check and matched
 * nothing. Hence the fixture here is addressed both ways: a test that only
 * ever passes an absolute temp dir is exactly the test that missed this.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStudioServer } from '../../studio/server/index';

let root: string;
let projectDir: string;
let distDir: string;

const MAIN_JS = 'import "./vendor.js";\nexport const app = 1;\n';
const MAIN_CSS = ':root { color: red; }\n';

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-static-'));
	projectDir = path.join(root, 'project');
	distDir = path.join(root, 'dist');
	fs.mkdirSync(path.join(projectDir, 'entities'), { recursive: true });
	fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });

	// A realistic Vite build output.
	fs.writeFileSync(
		path.join(distDir, 'index.html'),
		'<!doctype html><html><head><script type="module" src="/assets/main.js"></script></head><body><div id="root"></div></body></html>',
	);
	fs.writeFileSync(path.join(distDir, 'assets', 'main.js'), MAIN_JS);
	fs.writeFileSync(path.join(distDir, 'assets', 'main.css'), MAIN_CSS);
	fs.writeFileSync(path.join(distDir, 'assets', 'main.js.map'), '{"version":3}');
	fs.writeFileSync(path.join(distDir, 'assets', 'logo.svg'), '<svg/>');
	fs.writeFileSync(path.join(distDir, 'assets', 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
	fs.writeFileSync(path.join(distDir, 'favicon.ico'), Buffer.from([0x00, 0x00, 0x01, 0x00]));
	// The file a traversal would try to reach.
	fs.writeFileSync(path.join(root, 'secret.txt'), 'not for the browser');
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

async function withServer(uiDir: string, fn: (url: string) => Promise<void>): Promise<void> {
	const s = await createStudioServer({ projectDir, port: 0, uiDir });
	try {
		await fn(s.url);
	} finally {
		await s.close();
	}
}

describe('assets are served as real files, with real content types', () => {
	it('serves a JS module as JavaScript, not as the SPA shell', async () => {
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/assets/main.js`);
			expect(res.status).toBe(200);
			// Both halves matter: the bytes AND the type. A browser refuses a
			// module script that does not arrive as JavaScript.
			expect(res.headers.get('content-type')).toContain('text/javascript');
			expect(await res.text()).toBe(MAIN_JS);
		});
	});

	it('serves CSS, source maps, SVG, woff2 and .ico with their own types', async () => {
		await withServer(distDir, async (url) => {
			const cases: Array<[string, string, string?]> = [
				['/assets/main.css', 'text/css', MAIN_CSS],
				['/assets/main.js.map', 'application/json'],
				['/assets/logo.svg', 'image/svg+xml'],
				['/assets/font.woff2', 'font/woff2'],
				['/favicon.ico', 'image/x-icon'],
			];
			for (const [p, type, body] of cases) {
				const res = await fetch(`${url}${p}`);
				expect(res.status).toBe(200);
				expect(res.headers.get('content-type')).toContain(type);
				if (body) expect(await res.text()).toBe(body);
			}
		});
	});

	it('serves index.html at the root', async () => {
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/`);
			expect(res.headers.get('content-type')).toContain('text/html');
			expect(await res.text()).toContain('id="root"');
		});
	});

	it('works when --ui-dir is RELATIVE — the exact shape of #716', async () => {
		// `--ui-dir tools/studio/dist` is what the owner typed, and every
		// request fell through to index.html because of it.
		const cwd = process.cwd();
		try {
			process.chdir(root);
			await withServer('dist', async (url) => {
				const res = await fetch(`${url}/assets/main.js`);
				expect(res.headers.get('content-type')).toContain('text/javascript');
				expect(await res.text()).toBe(MAIN_JS);
			});
		} finally {
			process.chdir(cwd);
		}
	});

	it('works when --ui-dir has a trailing slash', async () => {
		await withServer(`${distDir}${path.sep}`, async (url) => {
			const res = await fetch(`${url}/assets/main.js`);
			expect(res.headers.get('content-type')).toContain('text/javascript');
		});
	});
});

describe('SPA fallback, narrowed to routes', () => {
	/** What a browser actually sends when you type a URL or click a link. */
	const NAVIGATION = {
		accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		'sec-fetch-dest': 'document',
	};
	/** What a browser sends fetching a module script. */
	const SCRIPT = { accept: '*/*', 'sec-fetch-dest': 'script' };

	it('returns index.html for an unknown ROUTE', async () => {
		await withServer(distDir, async (url) => {
			for (const route of ['/graph', '/deeply/nested/route']) {
				const res = await fetch(`${url}${route}`, { headers: NAVIGATION });
				expect(res.status).toBe(200);
				expect(res.headers.get('content-type')).toContain('text/html');
				expect(await res.text()).toContain('id="root"');
			}
		});
	});

	it('returns index.html for a route that LOOKS like a file — /files/…/contact.yaml', async () => {
		// Studio routes on the file path it is editing, so the extension alone
		// cannot decide this; what the client asked for can.
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/files/entities/contact.yaml`, { headers: NAVIGATION });
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('id="root"');
		});
	});

	it('404s a MISSING ASSET instead of handing back HTML', async () => {
		// The fallback returning HTML here is what produced "Failed to load
		// module script" rather than a legible error.
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/assets/does-not-exist.js`, { headers: SCRIPT });
			expect(res.status).toBe(404);
			expect(res.headers.get('content-type')).toContain('application/json');
		});
	});

	it('404s a missing asset for a plain client too, by the shape of the path', async () => {
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/assets/does-not-exist.js`);
			expect(res.status).toBe(404);
		});
	});

	it('never lets a UI route shadow /api', async () => {
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/api/health`);
			expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
		});
	});
});

describe('containment', () => {
	it('REFUSES a traversal out of the UI directory', async () => {
		await withServer(distDir, async (url) => {
			// Encoded so the path survives to the server rather than being
			// normalised away by fetch.
			const res = await fetch(`${url}/${encodeURIComponent('../secret.txt')}`);
			expect(res.status).toBe(403);
			expect(await res.text()).not.toContain('not for the browser');
		});
	});

	it('refuses a deep traversal to an absolute system path', async () => {
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/${encodeURIComponent('../../../../../../etc/passwd')}`);
			expect(res.status).toBe(403);
		});
	});

	it('refuses a malformed percent-encoding rather than throwing', async () => {
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/%E0%A4%A`);
			expect(res.status).toBe(400);
		});
	});

	it('does not serve a sibling directory that merely shares the prefix', async () => {
		// `<root>/dist-secret` must not be reachable from a `<root>/dist` root.
		const sibling = `${distDir}-secret`;
		fs.mkdirSync(sibling, { recursive: true });
		fs.writeFileSync(path.join(sibling, 'leak.js'), 'leaked');
		await withServer(distDir, async (url) => {
			const res = await fetch(`${url}/${encodeURIComponent('../dist-secret/leak.js')}`);
			expect(res.status).toBe(403);
		});
	});
});
