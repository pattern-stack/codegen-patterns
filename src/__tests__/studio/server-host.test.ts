/**
 * Serving Studio on a non-loopback address (#698 follow-up).
 *
 * The default is loopback and stays loopback. `--host` widens it for an owner
 * who cannot reach the machine, and at that point the bind was the only thing
 * protecting an unauthenticated API — so the Origin check has to keep working
 * against the NEW address rather than silently accepting everything, which is
 * what a header-rewriting proxy in front of the old build would have done.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	createStudioServer,
	isLoopbackHost,
	nonLoopbackWarning,
	originFor,
	selfOrigins,
	validateAllowedOrigin,
} from '../../studio/server/index';

let projectDir: string;

beforeAll(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-host-'));
	fs.mkdirSync(path.join(projectDir, 'entities'), { recursive: true });
});

afterAll(() => {
	fs.rmSync(projectDir, { recursive: true, force: true });
});

/** A real non-loopback IPv4 on this machine, or null when there is none. */
function lanAddress(): string | null {
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (!a.internal && a.family === 'IPv4') return a.address;
		}
	}
	return null;
}

/** A state-changing request that fails on its MERITS when the Origin is accepted. */
async function post(url: string, origin?: string): Promise<number> {
	const res = await fetch(`${url}/api/relationships`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(origin ? { origin } : {}),
		},
		body: JSON.stringify({ from: 'nope', to: 'nope', kind: 'belongs_to' }),
	});
	return res.status;
}

describe('host classification', () => {
	it('recognises loopback addresses', () => {
		for (const h of ['127.0.0.1', '127.0.0.53', 'localhost', '::1']) {
			expect(isLoopbackHost(h)).toBe(true);
		}
	});

	it('does not mistake a LAN or public address for loopback', () => {
		for (const h of ['10.88.111.45', '192.168.1.5', '0.0.0.0', '8.8.8.8']) {
			expect(isLoopbackHost(h)).toBe(false);
		}
	});

	it('brackets a bare IPv6 literal when building an origin', () => {
		expect(originFor('::1', 5178)).toBe('http://[::1]:5178');
		expect(originFor('10.0.0.5', 5178)).toBe('http://10.0.0.5:5178');
	});

	it('builds the self-origin list from the BOUND host, not a constant', () => {
		expect(selfOrigins('10.0.0.5', 5178)).toEqual(['http://10.0.0.5:5178']);
		expect(selfOrigins('127.0.0.1', 5178)).toContain('http://localhost:5178');
	});

	it('enumerates local addresses for a wildcard bind rather than allowing all', () => {
		const origins = selfOrigins('0.0.0.0', 5178);
		expect(origins).toContain('http://127.0.0.1:5178');
		expect(origins).not.toContain('*');
		// Still an exact list — a foreign origin is not in it.
		expect(origins).not.toContain('http://evil.example:5178');
	});
});

describe('--allow-origin validation', () => {
	it('accepts a plain origin', () => {
		expect(validateAllowedOrigin('http://box.tailnet.ts.net:5178')).toBe(
			'http://box.tailnet.ts.net:5178',
		);
		expect(validateAllowedOrigin('https://studio.example.com')).toBe('https://studio.example.com');
	});

	it('REFUSES a wildcard in any form — a pattern language is how an allowlist rots', () => {
		expect(() => validateAllowedOrigin('*')).toThrow('wildcard');
		expect(() => validateAllowedOrigin('http://*.example.com')).toThrow('wildcard');
	});

	it('refuses a value carrying a path or query', () => {
		expect(() => validateAllowedOrigin('http://box:5178/studio')).toThrow('no path or query');
	});

	it('refuses a non-http scheme and unparseable junk', () => {
		expect(() => validateAllowedOrigin('ftp://box:5178')).toThrow('http or https');
		expect(() => validateAllowedOrigin('box.tailnet:5178')).toThrow();
	});

	it('rejects the whole server start on a bad value rather than dropping it', async () => {
		await expect(
			createStudioServer({ projectDir, port: 0, allowOrigins: ['*'] }),
		).rejects.toThrow('wildcard');
	});
});

describe('the default posture is unchanged', () => {
	it('binds loopback and refuses a foreign Origin when no flags are passed', async () => {
		const s = await createStudioServer({ projectDir, port: 0 });
		try {
			expect(s.host).toBe('127.0.0.1');
			expect(s.loopback).toBe(true);
			expect(s.url.startsWith('http://127.0.0.1:')).toBe(true);
			expect(await post(s.url, 'https://evil.example')).toBe(403);
			// ...and still accepts its own origin.
			expect(await post(s.url, s.url)).toBe(400);
		} finally {
			await s.close();
		}
	});

	it('emits no warning for the default bind', async () => {
		const warnings: string[] = [];
		const s = await createStudioServer({ projectDir, port: 0, warn: (m) => warnings.push(m) });
		try {
			expect(warnings).toEqual([]);
		} finally {
			await s.close();
		}
	});
});

describe('binding a non-loopback address', () => {
	const lan = lanAddress();
	const t = lan ? it : it.skip;

	t('accepts a SAME-ORIGIN state-changing request on the new address', async () => {
		const warnings: string[] = [];
		const s = await createStudioServer({
			projectDir,
			port: 0,
			host: lan!,
			warn: (m) => warnings.push(m),
		});
		try {
			expect(s.host).toBe(lan);
			expect(s.loopback).toBe(false);
			// Same-origin browsing works with NO --allow-origin given.
			expect(await post(s.url, originFor(lan!, s.port))).toBe(400);
		} finally {
			await s.close();
		}
	});

	t('still refuses a foreign Origin — the widened bind is not a widened allowlist', async () => {
		const s = await createStudioServer({ projectDir, port: 0, host: lan!, warn: () => {} });
		try {
			expect(await post(s.url, 'https://evil.example')).toBe(403);
			// The old loopback origin is not this server's origin any more.
			expect(await post(s.url, `http://127.0.0.1:${s.port}`)).toBe(403);
		} finally {
			await s.close();
		}
	});

	t('accepts an --allow-origin value, for a browser reaching it by NAME', async () => {
		const named = 'http://box.tailnet.ts.net:5178';
		const s = await createStudioServer({
			projectDir,
			port: 0,
			host: lan!,
			allowOrigins: [named],
			warn: () => {},
		});
		try {
			expect(await post(s.url, named)).toBe(400);
			// One name allowed is not every name allowed.
			expect(await post(s.url, 'http://other.tailnet.ts.net:5178')).toBe(403);
		} finally {
			await s.close();
		}
	});

	t('WARNS at startup that the API is unauthenticated and reachable', async () => {
		const warnings: string[] = [];
		const s = await createStudioServer({
			projectDir,
			port: 0,
			host: lan!,
			warn: (m) => warnings.push(m),
		});
		try {
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('UNAUTHENTICATED');
			expect(warnings[0]).toContain(lan!);
			// It must name the safer alternative, not just scold.
			expect(warnings[0]).toContain('ssh -L');
		} finally {
			await s.close();
		}
	});

	t('is actually reachable on that address', async () => {
		const s = await createStudioServer({ projectDir, port: 0, host: lan!, warn: () => {} });
		try {
			const res = await fetch(`${originFor(lan!, s.port)}/api/health`);
			expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
		} finally {
			await s.close();
		}
	});
});

describe('the warning text', () => {
	it('names the address, the risk and the safer option', () => {
		const w = nonLoopbackWarning('10.0.0.5', 5178);
		expect(w).toContain('10.0.0.5:5178');
		expect(w).toContain('UNAUTHENTICATED');
		expect(w).toContain('generate / dbPush / restart');
		expect(w).toContain('ssh -L 5178:127.0.0.1:5178');
	});
});
