#!/usr/bin/env bun
/**
 * ADR-043: verify the closed-by-default data plane end-to-end against the REAL
 * vendored auth runtime in the smoke project.
 *
 * Runs inside the smoke harness's tmp project (passed as argv[2]) AFTER
 * `subsystem install auth` has vendored the auth runtime and `verify-auth-boot`
 * has copied `auth-probe.module.ts` into `src/`.
 *
 * Boots a real HTTP app from the AuthProbeModule (which imports AuthModule —
 * binding the global AuthenticatedGuard — and a dev IUserContext), wires the
 * RequesterContext boundary, and asserts BOTH directions:
 *
 *   - negative: GET /probe/guarded with NO Authorization → 401 (the #557 guard).
 *   - positive: GET /probe/guarded WITH Authorization → 200 AND the body carries
 *     the ambient userId — proving the verified principal propagated THROUGH the
 *     guard into handler-scope ALS context (what BaseRepository scopes off).
 *   - public:   GET /probe/public with no auth → 200 (the @Public escape hatch).
 *
 * Why a probe module, not the generated AppModule? AuthModule.forRoot constructs
 * EnvEncryptionKey at init and the generated AppModule wires DB-backed modules;
 * the probe isolates the PR2 mechanism (guard + boundary + ALS) cheaply and
 * deterministically.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(msg: string): never {
  console.error(`[auth-verify] FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const tmpDir = process.argv[2];
  if (!tmpDir) fail('usage: verify-auth-boot.ts <tmpDir>');
  process.chdir(tmpDir);

  // EnvEncryptionKey (AuthModule encryptionKey: 'env') needs a 32-byte base64 key.
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??
    Buffer.alloc(32, 7).toString('base64');

  const nestCoreUrl = pathToFileURL(
    path.join(tmpDir, 'node_modules', '@nestjs', 'core', 'index.js'),
  ).href;
  const nestCommonUrl = pathToFileURL(
    path.join(tmpDir, 'node_modules', '@nestjs', 'common', 'index.js'),
  ).href;
  const { NestFactory } = (await import(nestCoreUrl)) as typeof import('@nestjs/core');
  await import(nestCommonUrl);

  const probeUrl = pathToFileURL(
    path.join(tmpDir, 'src', 'auth-probe.module.ts'),
  ).href;
  const authUrl = pathToFileURL(
    path.join(tmpDir, 'src', 'shared', 'subsystems', 'auth', 'index.ts'),
  ).href;
  const { AuthProbeModule } = (await import(probeUrl)) as { AuthProbeModule: unknown };
  const { installRequesterContext } = (await import(authUrl)) as {
    installRequesterContext: (app: unknown) => void;
  };

  const app = (await NestFactory.create(AuthProbeModule as never, {
    logger: false,
    abortOnError: false,
  })) as {
    use: (...args: unknown[]) => unknown;
    listen: (port: number) => Promise<unknown>;
    getUrl: () => Promise<string>;
    close: () => Promise<void>;
  };
  installRequesterContext(app);
  await app.listen(0);
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  try {
    // ── negative: guarded route, no credentials → 401 ──
    const anon = await fetch(`${base}/probe/guarded`);
    if (anon.status !== 401) {
      fail(`guarded route without auth: expected 401, got ${anon.status}`);
    }

    // ── positive: guarded route, with credentials → 200 + ambient userId ──
    const authed = await fetch(`${base}/probe/guarded`, {
      headers: { authorization: 'Bearer probe-token' },
    });
    if (authed.status !== 200) {
      fail(`guarded route with auth: expected 200, got ${authed.status}`);
    }
    const body = (await authed.json()) as { userId?: string | null };
    if (body.userId !== 'probe-user') {
      fail(
        `guarded route with auth: principal did not propagate through the guard ` +
          `into ALS (expected userId 'probe-user', got ${JSON.stringify(body.userId)})`,
      );
    }

    // ── @Public escape hatch: reachable with no credentials → 200 ──
    const pub = await fetch(`${base}/probe/public`);
    if (pub.status !== 200) {
      fail(`@Public route without auth: expected 200, got ${pub.status}`);
    }

    console.log('auth boot OK (401 unauth · 200 authed+scoped · 200 public)');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[auth-verify] unexpected error:', err);
  process.exit(1);
});
