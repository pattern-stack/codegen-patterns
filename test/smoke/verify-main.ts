#!/usr/bin/env bun
/**
 * CFG-1 (#643) gate: run the generated `main.ts` and assert the boot-time
 * config values reached the running app.
 *
 * The app never parses `codegen.config.yaml`; the generator writes `openapi.*` /
 * `auth.devAllowAnonymous` into `<generated>/app-config.ts`, which `main.ts`
 * imports. So the proof is the real entrypoint serving what the config
 * declared:
 *
 *   - `GET <openapi.path>-json` answers with `info.title` / `info.version` as
 *     configured (a non-default path, so the mount point is proven too);
 *   - `--expect-anonymous-warning`: the process logged the
 *     `auth.devAllowAnonymous=true` warning and kept serving instead of
 *     refusing to boot. Only where `main.ts` wires the boot-fail check (package
 *     mode; vendored defers it to `project upgrade-auth`).
 *
 * Usage: verify-main.ts <tmpDir> <main.ts, project-relative> <openapi-json>
 *        [--expect-anonymous-warning]
 * `<openapi-json>` is `{ path, title, version }`. DATABASE_URL is stubbed as in
 * verify-boot.ts — pg.Pool never connects during boot.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

function fail(msg: string): never {
	console.error(`[main-verify] FAIL: ${msg}`);
	process.exit(1);
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

async function main(): Promise<void> {
	const [tmpDir, mainRel, openapiJson, ...flags] = process.argv.slice(2);
	if (!tmpDir || !mainRel || !openapiJson) {
		fail('usage: verify-main.ts <tmpDir> <main.ts> <openapi-json> [--expect-anonymous-warning]');
	}
	const openapi = JSON.parse(openapiJson) as { path: string; title: string; version: string };
	const expectAnonymousWarning = flags.includes('--expect-anonymous-warning');
	const port = await freePort();

	const child = spawn('bun', [mainRel], {
		cwd: tmpDir,
		env: {
			...process.env,
			PORT: String(port),
			DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://stub:stub@127.0.0.1:1/stub',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout.on('data', (d) => (output += d));
	child.stderr.on('data', (d) => (output += d));
	let exited: number | null = null;
	child.on('exit', (code) => (exited = code ?? -1));

	const stop = () => {
		if (exited === null) child.kill('SIGKILL');
	};
	try {
		const url = `http://127.0.0.1:${port}${openapi.path}-json`;
		const deadline = Date.now() + 90_000;
		let doc: { info?: { title?: string; version?: string } } | null = null;
		while (Date.now() < deadline) {
			if (exited !== null) fail(`main.ts exited (${exited}) before serving:\n${output}`);
			try {
				const res = await fetch(url);
				if (res.ok) {
					doc = (await res.json()) as typeof doc;
					break;
				}
			} catch {
				// not listening yet
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		if (!doc) fail(`no answer from ${url} within 90s:\n${output}`);
		if (doc.info?.title !== openapi.title) fail(`info.title: expected '${openapi.title}', got '${doc.info?.title}'`);
		if (doc.info?.version !== openapi.version) {
			fail(`info.version: expected '${openapi.version}', got '${doc.info?.version}'`);
		}
		console.log(`[main-verify] OK — ${openapi.path}-json serves '${openapi.title}' ${openapi.version}`);

		if (expectAnonymousWarning) {
			if (!output.includes('auth.devAllowAnonymous=true')) {
				fail(`expected the devAllowAnonymous warning in the boot output:\n${output}`);
			}
			console.log('[main-verify] OK — auth.devAllowAnonymous reached the boot-fail check (served with the warning)');
		}
	} finally {
		stop();
	}
	process.exit(0);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
