#!/usr/bin/env bun
/**
 * Junction smoke test harness — end-to-end regression check for the
 * junction codegen pipeline.
 *
 * Accepts a `--scenario` flag:
 *   --scenario junction              (default) intra-domain: opportunity × contact
 *   --scenario junction-cross-domain cross-domain: opportunity × activity
 *
 * Each scenario × both architectures (clean-lite-ps by default; pass
 * --architecture clean for the second pass) = four total code paths.
 *
 * Flow per scenario + architecture:
 *   1. Create a fresh tmp project.
 *   2. bun init + install pinned peer deps.
 *   3. codegen project init --yes --with-tsconfig
 *   4. Copy scenario entities into entities/.
 *   5. codegen entity new --all --force (generates parent entity files).
 *   6. Copy scenario junctions into junctions/.
 *   7. codegen junction new --all --force (generates junction files).
 *   8. bunx tsc --noEmit --skipLibCheck.
 *   9. Grep assertions on generated output.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const VALID_SCENARIOS = ['junction', 'junction-cross-domain'] as const;
type Scenario = (typeof VALID_SCENARIOS)[number];

const VALID_ARCHITECTURES = ['clean-lite-ps', 'clean'] as const;
type Architecture = (typeof VALID_ARCHITECTURES)[number];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return fallback;
}

const scenarioArg = getArg('--scenario', 'junction') as Scenario;
if (!VALID_SCENARIOS.includes(scenarioArg)) {
  console.error(`Unknown --scenario: ${scenarioArg}. Valid: ${VALID_SCENARIOS.join(', ')}`);
  process.exit(2);
}

const architectureArg = getArg('--architecture', 'clean-lite-ps') as Architecture;
if (!VALID_ARCHITECTURES.includes(architectureArg)) {
  console.error(`Unknown --architecture: ${architectureArg}. Valid: ${VALID_ARCHITECTURES.join(', ')}`);
  process.exit(2);
}

const KEEP = process.env.KEEP_SMOKE_DIR === '1';

// Fixture directories per scenario
const FIXTURES_DIR_MAP: Record<Scenario, string> = {
  'junction':              path.join(REPO_ROOT, 'test', 'smoke', 'fixtures-junction'),
  'junction-cross-domain': path.join(REPO_ROOT, 'test', 'smoke', 'fixtures-junction-cross-domain'),
};

// Expected junction + left/right entity names per scenario
const SCENARIO_META: Record<Scenario, { junctionName: string; leftEnt: string; rightEnt: string; hasRole: boolean }> = {
  'junction':              { junctionName: 'opportunity_contact', leftEnt: 'opportunity', rightEnt: 'contact', hasRole: true },
  'junction-cross-domain': { junctionName: 'opportunity_activity', leftEnt: 'opportunity', rightEnt: 'activity', hasRole: false },
};

// Pinned deps (same as run-smoke.ts)
const RUNTIME_DEPS = [
  '@nestjs/common@10',
  '@nestjs/core@10',
  '@nestjs/platform-express@10',
  '@nestjs/swagger@7',
  '@anatine/zod-openapi@2',
  'drizzle-orm@0.45',
  'reflect-metadata@0.2',
  'pg@8',
  'zod@3',
  'yaml@2',
];
const DEV_DEPS = ['typescript@5', '@types/bun', '@types/pg@8'];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const t0 = Date.now();
function elapsed(): string {
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  return `[+${s.padStart(5)}s]`;
}
function log(msg: string): void { console.log(`${elapsed()} ${msg}`); }
function logError(msg: string): void { console.error(`${elapsed()} [FAIL] ${msg}`); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string, env: NodeJS.ProcessEnv = {}): void {
  log(`$ ${cmd}`);
  execSync(cmd, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

function runSilent(cmd: string, cwd: string): { code: number; out: string; err: string } {
  const parts = cmd.split(' ');
  const r = spawnSync(parts[0], parts.slice(1), { cwd, encoding: 'utf-8' });
  return {
    code: r.status ?? 0,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
  };
}

function filterConsumerErrors(output: string): string[] {
  const lines = output.split('\n').filter((l) => l.trim());
  const errors: string[] = [];
  for (const line of lines) {
    if (line.includes('../') || line.includes('/codegen-patterns/runtime/')) continue;
    if (line.includes('node_modules/')) continue;
    if (line.includes('TS5101')) continue;
    if (!/error TS\d+:/.test(line)) continue;
    if (/\.schema\.ts\(\d+,\d+\): error/.test(line)) continue;
    if (line.includes("Property 'table' in type") && line.includes('not assignable')) continue;
    if (line.includes("Cannot assign an abstract constructor")) continue;
    if (/Argument of type .* is not assignable to parameter of type 'Constructor<\{\}>'/.test(line)) continue;
    if (/Property '(findBy[A-Z]\w*|findById|findAll|list|findWithDeleted|findOnlyDeleted)'/.test(line)) continue;
    if (line.includes("'@pattern-stack/codegen/")) continue;
    errors.push(line);
  }
  return errors;
}

function cleanup(dir: string): void {
  if (KEEP) {
    log(`keeping tmp dir (KEEP_SMOKE_DIR=1): ${dir}`);
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`cleaned up ${dir}`);
  } catch (err: unknown) {
    logError(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function pascalCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

function camelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertContains(haystack: string, needle: RegExp, label: string): void {
  if (!needle.test(haystack)) {
    throw new Error(
      `Smoke assertion failed [${label}]: expected to find ${needle} in generated output.\n` +
      `First 300 chars of file:\n${haystack.slice(0, 300)}`,
    );
  }
}

function assertAbsent(haystack: string, needle: RegExp, label: string): void {
  if (needle.test(haystack)) {
    throw new Error(
      `Smoke assertion failed [${label}]: expected NOT to find ${needle} in generated output. ` +
      `This leaf must not emit fan-out association methods — they land via #60.`,
    );
  }
}

function assertJunctionEmission(
  generatedSrc: string,
  scenario: Scenario,
  architecture: Architecture,
): void {
  const reads = (p: string): string => {
    const fullPath = path.join(generatedSrc, p);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Expected generated file not found: ${fullPath}`);
    }
    return fs.readFileSync(fullPath, 'utf8');
  };

  const { junctionName, leftEnt, rightEnt, hasRole } = SCENARIO_META[scenario];
  const pluralName = junctionName.endsWith('y')
    ? junctionName.slice(0, -1) + 'ies'
    : junctionName + 's';

  // Architecture-specific expected directory
  const junctionDir = architecture === 'clean-lite-ps'
    ? `src/modules/${pluralName}`
    : `app/backend/src/domain/${pluralName}`;

  const leftCamel = camelCase(`${leftEnt}_id`);
  const rightCamel = camelCase(`${rightEnt}_id`);
  const leftPascal = pascalCase(leftEnt);
  const rightPascal = pascalCase(rightEnt);

  // ── Entity file ──────────────────────────────────────────────────────────
  const entityFile = reads(`${junctionDir}/${junctionName}.entity.ts`);

  // Composite PK on left + right FK columns
  assertContains(
    entityFile,
    /primaryKey\(\{\s*columns:\s*\[table\.\w+Id,\s*table\.\w+Id\]/,
    'entity: composite PK',
  );

  // BaseJunctionFields: is_primary always present
  assertContains(entityFile, /is_primary|isPrimary/, 'entity: is_primary column');

  // Temporal (default: true)
  assertContains(entityFile, /started_at|startedAt/, 'entity: started_at column');
  assertContains(entityFile, /ended_at|endedAt/, 'entity: ended_at column');

  // Sourced (default: true)
  assertContains(entityFile, /sourced_from|sourcedFrom/, 'entity: sourced_from column');
  assertContains(entityFile, /confidence.*numeric|numeric.*confidence/, 'entity: confidence column');
  assertContains(entityFile, /matched_at|matchedAt/, 'entity: matched_at column');

  // relations() extension const
  assertContains(
    entityFile,
    new RegExp(`${pluralName}Relations\\s*=\\s*relations\\(${camelCase(pluralName)}`),
    'entity: relations() extension const',
  );

  if (hasRole) {
    // Role enum declared in fixture
    assertContains(entityFile, /role.*pgEnum|pgEnum.*role/, 'entity: role pgEnum');
  }

  // ── Repository file ──────────────────────────────────────────────────────
  const repoDir = architecture === 'clean-lite-ps'
    ? junctionDir
    : `app/backend/src/infrastructure/persistence/drizzle`;
  const repoFile = reads(
    architecture === 'clean-lite-ps'
      ? `${junctionDir}/${junctionName}.repository.ts`
      : `app/backend/src/infrastructure/persistence/drizzle/${junctionName.replace(/_/g, '-')}.repository.ts`,
  );

  assertContains(repoFile, /extends BaseRepository<\w+>/, 'repo: extends BaseRepository');
  assertContains(
    repoFile,
    new RegExp(`findBy${leftPascal}Id\\s*\\(`),
    'repo: findByLeftId method',
  );
  assertContains(
    repoFile,
    new RegExp(`findBy${rightPascal}Id\\s*\\(`),
    'repo: findByRightId method',
  );
  // Pagination shape { cursor?, limit? }
  assertContains(repoFile, /cursor\?:\s*string/, 'repo: cursor pagination param');
  assertContains(repoFile, /limit\?:\s*number/, 'repo: limit pagination param');

  // ── Service file ─────────────────────────────────────────────────────────
  const svcDir = architecture === 'clean-lite-ps'
    ? junctionDir
    : `app/backend/src/application/${pluralName}`;
  const svcFile = reads(
    architecture === 'clean-lite-ps'
      ? `${junctionDir}/${junctionName}.service.ts`
      : `app/backend/src/application/${pluralName}/${junctionName}.service.ts`,
  );

  assertContains(svcFile, /extends WithAnalytics\(\s*BaseService</, 'service: extends WithAnalytics(BaseService<');
  assertContains(svcFile, /protected override readonly entityName/, 'service: entityName override');
  assertContains(svcFile, /@Optional\(\)\s*@Inject\(EVENT_BUS\)/, 'service: @Optional() EVENT_BUS injection');

  // Load-bearing comment block
  assertContains(
    svcFile,
    /Fan-out association methods.*are NOT\s+\/\/ emitted here/s,
    'service: fan-out comment block present',
  );

  // Anti-regression: fan-out methods MUST NOT appear
  assertAbsent(svcFile, /async\s+attach\s*\(/, 'service: no attach() method');
  assertAbsent(svcFile, /async\s+detach\s*\(/, 'service: no detach() method');
  assertAbsent(svcFile, /async\s+setPrimary\s*\(/, 'service: no setPrimary() method');

  log(`assertions passed: ${scenario}/${architecture}`);
}

function assertBarrelIncludes(generatedSrc: string, pluralName: string, architecture: Architecture): void {
  const modulesBarrel = path.join(generatedSrc, 'src/generated/modules.ts');
  const schemaBarrel = path.join(generatedSrc, 'src/generated/schema.ts');

  if (!fs.existsSync(modulesBarrel)) {
    throw new Error(`modules barrel not found: ${modulesBarrel}`);
  }
  if (!fs.existsSync(schemaBarrel)) {
    throw new Error(`schema barrel not found: ${schemaBarrel}`);
  }

  const modulesContent = fs.readFileSync(modulesBarrel, 'utf8');
  const schemaContent = fs.readFileSync(schemaBarrel, 'utf8');

  const moduleClass = pascalCase(pluralName) + 'Module';
  assertContains(modulesContent, new RegExp(moduleClass), `modules barrel: includes ${moduleClass}`);
  assertContains(schemaContent, new RegExp(pluralName), `schema barrel: includes ${pluralName}`);

  log(`barrel assertions passed: ${pluralName}`);
}

// ---------------------------------------------------------------------------
// codegen.config.yaml injection for architecture override
// ---------------------------------------------------------------------------

function writeCodegenConfig(tmpDir: string, architecture: Architecture): void {
  const configPath = path.join(tmpDir, 'codegen.config.yaml');
  // Minimal config that sets the architecture and leaves other settings to
  // defaults. project init creates this file; we overwrite the generate block.
  const content = [
    'generate:',
    `  architecture: ${architecture}`,
    'paths:',
    '  backend_src: src',
    '  entities: entities',
    '  generated: src/generated',
  ].join('\n') + '\n';

  fs.writeFileSync(configPath, content);
  log(`wrote codegen.config.yaml (architecture: ${architecture})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  log(`smoke-junction scenario=${scenarioArg} architecture=${architectureArg}`);

  const fixturesDir = FIXTURES_DIR_MAP[scenarioArg];
  if (!fs.existsSync(fixturesDir)) {
    logError(`Fixtures directory not found: ${fixturesDir}`);
    return 1;
  }

  const tmpBase = os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tmpBase, `codegen-smoke-junction-`));
  log(`tmp dir: ${tmpDir}`);

  let exitCode = 0;

  try {
    // 1. bun init -y
    run('bun init -y', tmpDir);

    // 2. Install runtime deps
    run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
    run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);

    // 3. codegen project init
    run(`bun ${CLI_PATH} project init --yes --with-tsconfig`, tmpDir);

    // Overwrite codegen.config.yaml to set the target architecture.
    writeCodegenConfig(tmpDir, architectureArg);

    // 4. Copy entity fixtures into entities/
    const entityFixturesDir = path.join(fixturesDir, 'entities');
    const entitiesDir = path.join(tmpDir, 'entities');
    fs.mkdirSync(entitiesDir, { recursive: true });
    // Remove example.yaml that init dropped
    const examplePath = path.join(entitiesDir, 'example.yaml');
    if (fs.existsSync(examplePath)) fs.rmSync(examplePath);
    for (const f of fs.readdirSync(entityFixturesDir)) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      fs.copyFileSync(path.join(entityFixturesDir, f), path.join(entitiesDir, f));
      log(`copied entity fixture: ${f}`);
    }

    // 5. codegen entity new --all
    run(`bun ${CLI_PATH} entity new --all --force`, tmpDir);

    // 6. Copy junction fixtures into junctions/
    const junctionFixturesDir = path.join(fixturesDir, 'junctions');
    const junctionsDir = path.join(tmpDir, 'junctions');
    fs.mkdirSync(junctionsDir, { recursive: true });
    for (const f of fs.readdirSync(junctionFixturesDir)) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      fs.copyFileSync(path.join(junctionFixturesDir, f), path.join(junctionsDir, f));
      log(`copied junction fixture: ${f}`);
    }

    // 7. codegen junction new --all
    run(`bun ${CLI_PATH} junction new --all --force`, tmpDir);

    // 8. bunx tsc --noEmit --skipLibCheck
    log('running bunx tsc --noEmit --skipLibCheck');
    const tsc = runSilent('bunx tsc --noEmit --skipLibCheck', tmpDir);
    const consumerErrors = filterConsumerErrors(tsc.out + tsc.err);
    if (consumerErrors.length > 0) {
      for (const line of consumerErrors) console.error(line);
      logError(`${consumerErrors.length} typecheck errors in consumer-emitted code`);
      exitCode = 1;
    } else {
      log('tsc OK');
    }

    // 9. Grep assertions on generated output
    if (exitCode === 0) {
      const { junctionName } = SCENARIO_META[scenarioArg];
      const pluralName = junctionName.endsWith('y')
        ? junctionName.slice(0, -1) + 'ies'
        : junctionName + 's';

      assertJunctionEmission(tmpDir, scenarioArg, architectureArg);
      assertBarrelIncludes(tmpDir, pluralName, architectureArg);
    }

  } catch (err: unknown) {
    logError(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    exitCode = 1;
  } finally {
    cleanup(tmpDir);
  }

  if (exitCode === 0) {
    log(`smoke-junction PASS (${scenarioArg}/${architectureArg})`);
  } else {
    log(`smoke-junction FAIL (${scenarioArg}/${architectureArg})`);
  }
  return exitCode;
}

main().then((code) => process.exit(code));
