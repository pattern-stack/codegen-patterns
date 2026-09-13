#!/usr/bin/env bun
/**
 * Tarball Smoke (#190 — packaging-drift class)
 *
 * Smoke tests run against the repo checkout; this runner tests what consumers
 * actually receive from npm. Two releases shipped broken because of exactly
 * this gap:
 *   - 0.3.0: `runtimeRoot()` assumed top-level `runtime/`; the tarball only
 *     had `dist/runtime/`.
 *   - 0.4.1: `VENDORED_RUNTIME_FILES` read raw `.ts` source, but `files:`
 *     excluded `runtime/`, so tarballs had only compiled `.js`.
 *
 * What it does:
 *   1. Builds + `npm pack`s every publishable package (root + workspace
 *      packages with `publishConfig.access: public`).
 *   2. Installs ALL tarballs together into a fresh tmp project via npm —
 *      which also exercises the surface packages' peerDependency range
 *      against the root tarball's actual version.
 *   3. Verifies the installed root package: files-manifest essentials
 *      (dist/runtime, raw runtime/*.ts, templates/, consumer-skills/),
 *      every `exports` entry imports under node, both bins run `--help`.
 *   4. Verifies each surface package's `.` and `./testing` exports import.
 *   5. Runs the full consumer workflow FROM the tarball (test/smoke/run-smoke.ts
 *      in SMOKE_TARBALL mode): project init → entity new --all → subsystem
 *      installs → tsc → /docs-json. Contents checks (1-4) prove the files
 *      ship; this proves they work (0.3.0 / 0.4.1 / 0.6.0-#266 bug classes).
 *
 * Run via `just test-post-publish`; gates uploads inside `just publish-ci`.
 * Self-contained on a fresh checkout (builds everything it packs).
 */

import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
if (!existsSync(join(ROOT, 'justfile')) || !existsSync(join(ROOT, 'templates'))) {
  throw new Error(`ROOT does not look like the codegen-patterns repo root: ${ROOT}`);
}

interface Pkg {
  dir: string;
  name: string;
  version: string;
}

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

/** Run a command, returning { ok, output } instead of throwing. */
function tryRun(cmd: string[], cwd: string): { ok: boolean; output: string } {
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf-8' });
  return {
    ok: res.status === 0,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim(),
  };
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? `\n      ${detail.split('\n').join('\n      ')}` : ''}`);
    failures.push(label);
  }
}

// ─── 1. Discover publishable packages ────────────────────────────────────────

const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const rootPkg: Pkg = { dir: ROOT, name: rootManifest.name, version: rootManifest.version };

const surfacePkgs: Pkg[] = readdirSync(join(ROOT, 'packages'))
  .map((entry) => join(ROOT, 'packages', entry))
  .filter((dir) => existsSync(join(dir, 'package.json')))
  .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) }))
  .filter(({ manifest }) => manifest.private !== true && manifest.publishConfig?.access === 'public')
  .map(({ dir, manifest }) => ({ dir, name: manifest.name, version: manifest.version }));

console.log(`Tarball smoke: ${rootPkg.name}@${rootPkg.version} + ${surfacePkgs.length} surface packages\n`);

// ─── 2. Build + pack everything ──────────────────────────────────────────────

const stageDir = mkdtempSync(join(tmpdir(), 'codegen-tarball-smoke-'));
process.on('exit', () => rmSync(stageDir, { recursive: true, force: true }));

/**
 * Extract the packed tarball name from `npm pack --json`, tolerating BOTH
 * output shapes.
 *
 * npm <=10 prints an ARRAY of entries; npm >=11 prints an OBJECT. This script
 * destructured the array form (`const [{ filename }] = ...`), so under npm 11
 * it died with `TypeError: {} is not iterable` — a message that names neither
 * npm, nor `pack`, nor the shape it actually received.
 *
 * CI is pinned to the moving target on purpose: `.github/workflows/ci.yml`
 * runs `npm install -g npm@latest` because trusted publishing needs >= 11.5.1.
 * So the publish job will keep meeting whatever npm ships next, and this
 * function is where that gets absorbed. Local npm 10 returns the array form,
 * which is why this passed every local run and failed only on merge to main.
 *
 * Throws with the RAW payload rather than a shape assertion — the previous
 * failure cost a CI round trip precisely because the error described the
 * symptom (`{}` is not iterable) and not the input.
 */
function packedFilename(packJson: string): string {
  const parsed: unknown = JSON.parse(packJson);

  const asEntry = (v: unknown): string | null =>
    typeof v === 'object' && v !== null && typeof (v as { filename?: unknown }).filename === 'string'
      ? (v as { filename: string }).filename
      : null;

  if (Array.isArray(parsed)) {
    const name = asEntry(parsed[0]);
    if (name) return name;
  } else {
    // npm >= 11: either the entry itself, or an object keyed by package id.
    const direct = asEntry(parsed);
    if (direct) return direct;
    if (typeof parsed === 'object' && parsed !== null) {
      for (const v of Object.values(parsed)) {
        const name = asEntry(v);
        if (name) return name;
      }
    }
  }

  throw new Error(
    `npm pack --json returned no recognisable { filename } entry.\n` +
      `npm --version: ${execSync('npm --version', { encoding: 'utf-8' }).trim()}\n` +
      `raw output:\n${packJson}`,
  );
}

// Root builds first — the surface packages' .d.ts builds resolve
// @pattern-stack/codegen/subsystems against its dist/ (ADR-036 §8).
console.log('Building + packing...');
const tarballs: string[] = [];
for (const pkg of [rootPkg, ...surfacePkgs]) {
  run('bun run build', pkg.dir);
  const packJson = execSync(`npm pack --json --pack-destination ${stageDir}`, {
    cwd: pkg.dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const filename = packedFilename(packJson);
  tarballs.push(join(stageDir, filename));
  console.log(`  packed ${pkg.name}@${pkg.version}`);
}

// ─── 3. Install all tarballs into a fresh tmp project ───────────────────────

// One combined install: surface packages resolve their @pattern-stack/codegen
// peer against the ROOT TARBALL's version, so a stale peer range fails here
// instead of in a consumer's session. npm auto-installs the root's peers
// (NestJS, hygen, ...), exercising peer resolution end-to-end.
const projectDir = join(stageDir, 'consumer');
console.log('\nInstalling tarballs into fresh consumer project...');
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(projectDir, 'package.json'),
  JSON.stringify({ name: 'tarball-smoke-consumer', private: true, type: 'module' }, null, 2),
);
run(
  `npm install --no-audit --no-fund --loglevel=error ${tarballs.map((t) => `"${t}"`).join(' ')}`,
  projectDir,
);

// ─── 4. Verify the installed root package ────────────────────────────────────

const installedRoot = join(projectDir, 'node_modules', '@pattern-stack', 'codegen');

console.log(`\n${rootPkg.name} — files manifest:`);
check('dist/src/index.js', existsSync(join(installedRoot, 'dist/src/index.js')));
check(
  'dist/runtime/subsystems/index.js (0.3.0 bug class)',
  existsSync(join(installedRoot, 'dist/runtime/subsystems/index.js')),
);
const rawRuntimeTs = existsSync(join(installedRoot, 'runtime'))
  ? readdirSync(join(installedRoot, 'runtime'), { recursive: true }).filter((f) =>
      String(f).endsWith('.ts'),
    )
  : [];
check(
  `runtime/ ships raw .ts sources (0.4.1 bug class) — ${rawRuntimeTs.length} files`,
  rawRuntimeTs.length > 0,
);
check('templates/entity/new/prompt.js', existsSync(join(installedRoot, 'templates/entity/new/prompt.js')));
check('consumer-skills/', existsSync(join(installedRoot, 'consumer-skills')));

console.log(`\n${rootPkg.name} — exports resolve under node:`);
for (const spec of [
  '@pattern-stack/codegen',
  '@pattern-stack/codegen/subsystems',
  '@pattern-stack/codegen/runtime/shared/openapi',
]) {
  const res = tryRun(['node', '--input-type=module', '-e', `await import('${spec}')`], projectDir);
  check(`import('${spec}')`, res.ok, res.ok ? undefined : res.output);
}

console.log(`\n${rootPkg.name} — bins execute:`);
for (const bin of ['codegen', 'cdp']) {
  const res = tryRun([join(projectDir, 'node_modules', '.bin', bin), '--help'], projectDir);
  check(`${bin} --help`, res.ok, res.ok ? undefined : res.output);
}

// ─── 5. Verify each surface package's exports ───────────────────────────────

for (const pkg of surfacePkgs) {
  console.log(`\n${pkg.name}@${pkg.version} — exports resolve under node:`);
  for (const spec of [pkg.name, `${pkg.name}/testing`]) {
    const res = tryRun(['node', '--input-type=module', '-e', `await import('${spec}')`], projectDir);
    check(`import('${spec}')`, res.ok, res.ok ? undefined : res.output);
  }
}

// ─── 6. Consumer-workflow smoke from the tarball (#190 full scope) ──────────

// Re-run the end-to-end smoke harness in tarball mode: project init →
// entity new --all → subsystem installs → tsc → /docs-json, with the CLI,
// templates, vendored runtime, and examples/ all coming from the packed
// tarball instead of the checkout. This is what actually exercises
// runtimeRoot() resolution (0.3.0), vendoring from runtime/*.ts (0.4.1),
// and template-time src/ imports (0.6.0 / #266) — the contents checks above
// prove the files ship; this proves they work.
console.log('\nConsumer-workflow smoke from tarball (test/smoke/run-smoke.ts, SMOKE_TARBALL):');
{
  const res = spawnSync('bun', [join(ROOT, 'test/smoke/run-smoke.ts')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SMOKE_TARBALL: tarballs[0] },
  });
  check('consumer workflow from tarball (init → entity new → subsystems → tsc → openapi)', res.status === 0);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.error(`✗ Tarball smoke FAILED — ${failures.length} check(s):`);
  for (const f of failures) console.error(`    - ${f}`);
  process.exit(1);
}
console.log('✓ Tarball smoke passed — published tarballs match the consumer contract.');
