#!/usr/bin/env bun
/**
 * Junction smoke test harness — end-to-end regression check for the
 * junction codegen pipeline.
 *
 * Accepts a `--scenario` flag:
 *   --scenario junction              (default) intra-domain: opportunity × contact
 *   --scenario junction-cross-domain cross-domain: opportunity × activity
 *
 * clean-lite-ps is the only backend pipeline (ARCH-0, #677), so there is no
 * architecture axis.
 *
 * `--runtime vendored|package` (default vendored) picks the ADR-037 runtime
 * mode. `just test-smoke-junction` runs both, so the `package` default — whose
 * imports no junction gate compiled before #624 — cannot regress.
 *
 * `--layout default|custom` (default `default`, PATH-0). `custom` sets every
 * path non-default (`paths.backend_src: apps/backend/src`, `paths.generated`,
 * `paths.entities`) in a config written BEFORE `project init`, runs
 * `subsystem install events` + `jobs`, and asserts nothing lands at the default locations —
 * the #566 / #612 gate. `just test-smoke-junction` runs it in both modes.
 *
 * Bootstrap (tmp project, deps, codegen run) is delegated to
 * `test/junction/_helpers.ts` so snapshot tests can share the same path.
 * This file owns the compile + grep gate.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tscGateErrors } from './_consumer-errors';

import {
  bootstrapJunctionProject,
  CLI_PATH,
  CUSTOM_LAYOUT_APP_PATTERN,
  CUSTOM_LAYOUT_BOOT_CONFIG,
  LAYOUT_PATHS,
  SCENARIO_META,
  VALID_LAYOUTS,
  VALID_RUNTIMES,
  VALID_SCENARIOS,
  type Layout,
  type LayoutPaths,
  type RuntimeMode,
  type Scenario,
} from '../junction/_helpers';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regeneration contract (JUNC-0, #678)
// ---------------------------------------------------------------------------
// A junction is mirrored onto both parents' service + module. The parents' OWN
// templates render that fan-out from the junction YAML set (`entity new`), and
// `junction new` re-renders both parents through the same path — nothing is
// injected. So for a fixed YAML set the parent files are a pure function of it:
// `entity new` ↔ `junction new` in any order, any number of times, give the
// same bytes, and deleting a junction YAML removes its fan-out. Step 12 checks
// the round trip + removal on this project; step 13 bootstraps a second one
// with the junction YAMLs present before the first `entity new` (order swap).
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

const runtimeArg = getArg('--runtime', 'vendored') as RuntimeMode;
if (!VALID_RUNTIMES.includes(runtimeArg)) {
  console.error(`Unknown --runtime: ${runtimeArg}. Valid: ${VALID_RUNTIMES.join(', ')}`);
  process.exit(2);
}

const layoutArg = getArg('--layout', 'default') as Layout;
if (!VALID_LAYOUTS.includes(layoutArg)) {
  console.error(`Unknown --layout: ${layoutArg}. Valid: ${VALID_LAYOUTS.join(', ')}`);
  process.exit(2);
}
const P: LayoutPaths = LAYOUT_PATHS[layoutArg];

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

function runSilent(cmd: string, cwd: string): { code: number | null; out: string; err: string } {
  const parts = cmd.split(' ');
  const r = spawnSync(parts[0], parts.slice(1), { cwd, encoding: 'utf-8' });
  return {
    // `null` (killed / never started) is kept, never mapped to success (#688).
    code: r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
  };
}

/** `runSilent` with an argv array — for arguments that carry spaces (JSON). */
function runArgv(argv: string[], cwd: string): { code: number; out: string; err: string } {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
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
      `Smoke assertion failed [${label}]: expected NOT to find ${needle} in generated output.`,
    );
  }
}

function assertJunctionEmission(
  generatedSrc: string,
  scenario: Scenario,
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

  const junctionDir = `${P.modules}/${pluralName}`;

  const leftPascal = pascalCase(leftEnt);
  const rightPascal = pascalCase(rightEnt);

  // ── Entity file ──────────────────────────────────────────────────────────
  const entityFile = reads(`${junctionDir}/${junctionName}.entity.ts`);

  // Composite PK on left + right FK columns. When the junction carries a role
  // discriminator (#372), the role column joins the PK as a third member.
  assertContains(
    entityFile,
    hasRole
      ? /primaryKey\(\{\s*columns:\s*\[table\.\w+Id,\s*table\.\w+Id,\s*table\.role\]/
      : /primaryKey\(\{\s*columns:\s*\[table\.\w+Id,\s*table\.\w+Id\]/,
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

  // DRZ-1 (#583): the v1 Drizzle `relations()` extension const is no longer
  // emitted — Drizzle 1.0 removes the v1 root export. This was a presence
  // assertion; it is inverted rather than deleted so the harness still names
  // the contract. REL-1 (#586) refills the slot with a v2 `defineRelations()`
  // manifest under ADR-044.
  assertAbsent(
    entityFile,
    new RegExp(`${camelCase(pluralName)}Relations\\s*=\\s*relations\\(`),
    'entity: no v1 relations() const (DRZ-1)',
  );
  assertAbsent(
    entityFile,
    /import\s*\{[^}]*\brelations\b[^}]*\}\s*from\s*'drizzle-orm'/,
    'entity: no drizzle-orm root `relations` import (DRZ-1)',
  );
  assertContains(
    entityFile,
    /import \{ type InferSelectModel \} from 'drizzle-orm';/,
    'entity: type-only drizzle-orm root import',
  );

  if (hasRole) {
    // Role enum declared in fixture
    assertContains(entityFile, /role.*pgEnum|pgEnum.*role/, 'entity: role pgEnum');
  }

  // ── Repository file ──────────────────────────────────────────────────────
  const repoFile = reads(`${junctionDir}/${junctionName}.repository.ts`);

  // #374: junctions now extend JunctionIntegrationRepository (which extends BaseRepository)
  // to inherit the inbound-integration write surface (integrationUpsertOne/etc.).
  assertContains(repoFile, /extends JunctionIntegrationRepository</, 'repo: extends JunctionIntegrationRepository');
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
  const svcFile = reads(`${junctionDir}/${junctionName}.service.ts`);

  assertContains(svcFile, /extends WithAnalytics\(\s*BaseService</, 'service: extends WithAnalytics(BaseService<');
  assertContains(svcFile, /protected override readonly entityName/, 'service: entityName override');
  assertContains(svcFile, /@Optional\(\)\s*@Inject\(EVENT_BUS\)/, 'service: @Optional() EVENT_BUS injection');

  // ── CGP-60: junction service body emits the 4 canonical methods ─────────
  assertContains(svcFile, /async\s+attach\s*\(/, 'service: attach() method emitted');
  assertContains(svcFile, /async\s+detach\s*\(/, 'service: detach() method emitted');
  assertContains(svcFile, /async\s+listAssoc\s*\(/, 'service: listAssoc() method emitted');
  assertContains(svcFile, /async\s+setPrimary\s*\(/, 'service: setPrimary() method emitted');

  // CGP-60: list() must use two single-table queries — no Drizzle `with: {`
  assertAbsent(svcFile, /\bwith:\s*\{/, 'service: no Drizzle `with: {` in junction service');

  // CGP-60: junction service must inject left + right repos for `list`
  assertContains(
    svcFile,
    new RegExp(`private readonly \\w+Repo:\\s*${leftPascal}Repository`),
    'service: injects LeftRepository',
  );
  assertContains(
    svcFile,
    new RegExp(`private readonly \\w+Repo:\\s*${rightPascal}Repository`),
    'service: injects RightRepository',
  );

  // ── CGP-60: parent service fan-out (rendered by the parents, JUNC-0) ───
  const leftParentSvc = reads(`${P.modules}/${pluralize(leftEnt)}/${leftEnt}.service.ts`);
  const rightParentSvc = reads(`${P.modules}/${pluralize(rightEnt)}/${rightEnt}.service.ts`);

  // Left parent — verb-flat for attach/detach, flat-noun for list/setPrimary
  assertContains(leftParentSvc, new RegExp(`attach${rightPascal}\\s*\\(`), `left parent: attach${rightPascal}`);
  assertContains(leftParentSvc, new RegExp(`detach${rightPascal}\\s*\\(`), `left parent: detach${rightPascal}`);
  assertContains(leftParentSvc, new RegExp(`${pluralize(rightEnt)}List\\s*\\(`), `left parent: ${pluralize(rightEnt)}List`);
  assertContains(leftParentSvc, new RegExp(`${pluralize(rightEnt)}SetPrimary\\s*\\(`), `left parent: ${pluralize(rightEnt)}SetPrimary`);

  // Right parent — verb-flip for addTo/removeFrom, flat-noun for list/setPrimary
  assertContains(rightParentSvc, new RegExp(`addTo${leftPascal}\\s*\\(`), `right parent: addTo${leftPascal}`);
  assertContains(rightParentSvc, new RegExp(`removeFrom${leftPascal}\\s*\\(`), `right parent: removeFrom${leftPascal}`);
  assertContains(rightParentSvc, new RegExp(`${pluralize(leftEnt)}List\\s*\\(`), `right parent: ${pluralize(leftEnt)}List`);
  assertContains(rightParentSvc, new RegExp(`${pluralize(leftEnt)}SetPrimary\\s*\\(`), `right parent: ${pluralize(leftEnt)}SetPrimary`);

  // Coexistence: contact.service.ts (right parent in the `junction`
  // scenario) carries #358's belongs_to `account()` method AND #60's
  // junction fan-out methods. Both must be present after junction
  // codegen — the implicit coexistence test for CGP-60.
  if (scenario === 'junction' && rightEnt === 'contact') {
    assertContains(rightParentSvc, /async\s+account\s*\(/, 'right parent: #358 account() coexists');
  }

  log(`assertions passed: ${scenario}`);
}

/**
 * #624: the junction's package-owned runtime imports follow the runtime mode —
 * `@shared/<relpath>` vendored, `@pattern-stack/codegen/runtime/<relpath>`
 * under `package`. `@shared/database/*` is consumer-local in both modes.
 */
function assertRuntimeSpecifiers(
  generatedSrc: string,
  scenario: Scenario,
  runtime: RuntimeMode,
): void {
  const { junctionName } = SCENARIO_META[scenario];
  const pluralName = pluralize(junctionName);
  const files = [
    `${P.modules}/${pluralName}/${junctionName}.repository.ts`,
    `${P.modules}/${pluralName}/${junctionName}.service.ts`,
  ];
  const packageOwned = /'@shared\/(?:base-classes|constants|types)\//;
  const packageForm = /'@pattern-stack\/codegen\/runtime\/(?:base-classes|constants|types)\//;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(generatedSrc, rel), 'utf8');
    if (runtime === 'package') {
      assertAbsent(src, packageOwned, `${rel}: no @shared/* package-owned import (package, #624)`);
      assertContains(src, packageForm, `${rel}: package-form runtime import (#624)`);
    } else {
      assertAbsent(src, packageForm, `${rel}: no package-form import (vendored)`);
      assertContains(src, packageOwned, `${rel}: @shared/* runtime import (vendored)`);
    }
  }
  log(`runtime specifier assertions passed: ${runtime}`);
}

// Naive pluralize for parent dirs (matches Hygen's pluralize for our fixtures).
function pluralize(s: string): string {
  if (s.endsWith('y')) return s.slice(0, -1) + 'ies';
  return s + 's';
}

function assertBarrelIncludes(generatedSrc: string, pluralName: string): void {
  const modulesBarrel = path.join(generatedSrc, P.generated, 'modules.ts');
  const schemaBarrel = path.join(generatedSrc, P.generated, 'schema.ts');

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

/**
 * REL-1 (#586) — the junction's four derived edges in the v2 manifest.
 *
 * A junction contributes more than the `.through()` hop: each parent also gets
 * a row-level edge to the junction table (where role / temporal / provenance
 * columns live), and the junction table gets its own two `belongs_to` edges.
 * `tsc` above proves the manifest compiles and the boot gate below proves
 * `defineRelations()` accepts it at runtime; these pin the SHAPE so a
 * regression names itself.
 */
function assertJunctionRelations(
  generatedSrc: string,
  junctionName: string,
  leftEnt: string,
  rightEnt: string,
): void {
  const manifestPath = path.join(generatedSrc, P.generated, 'relations.ts');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`relations manifest not found: ${manifestPath}`);
  }
  const manifest = fs.readFileSync(manifestPath, 'utf8');

  const leftPlural = pluralize(leftEnt);
  const rightPlural = pluralize(rightEnt);
  const junctionVar = camelCase(pluralize(junctionName));
  const leftFk = camelCase(`${leftEnt}_id`);
  const rightFk = camelCase(`${rightEnt}_id`);

  // The many-to-many hop, on BOTH parents.
  assertContains(
    manifest,
    new RegExp(
      `${rightPlural}: r\\.many\\.${rightPlural}\\(\\{ from: r\\.${leftPlural}\\.id\\.through\\(r\\.${junctionVar}\\.${leftFk}\\), to: r\\.${rightPlural}\\.id\\.through\\(r\\.${junctionVar}\\.${rightFk}\\) \\}\\)`,
    ),
    `relations manifest: ${leftPlural}.${rightPlural} through ${junctionVar}`,
  );
  assertContains(
    manifest,
    new RegExp(
      `${leftPlural}: r\\.many\\.${leftPlural}\\(\\{ from: r\\.${rightPlural}\\.id\\.through\\(r\\.${junctionVar}\\.${rightFk}\\), to: r\\.${leftPlural}\\.id\\.through\\(r\\.${junctionVar}\\.${leftFk}\\) \\}\\)`,
    ),
    `relations manifest: ${rightPlural}.${leftPlural} through ${junctionVar}`,
  );

  // The row-level edge from each parent to the junction table itself.
  assertContains(
    manifest,
    new RegExp(
      `${junctionVar}: r\\.many\\.${junctionVar}\\(\\{ from: r\\.${leftPlural}\\.id, to: r\\.${junctionVar}\\.${leftFk} \\}\\)`,
    ),
    `relations manifest: ${leftPlural}.${junctionVar} rows`,
  );

  // The junction's own belongs_to edges — NOT NULL FK columns, so not optional.
  assertContains(
    manifest,
    new RegExp(
      `${leftEnt}: r\\.one\\.${leftPlural}\\(\\{ from: r\\.${junctionVar}\\.${leftFk}, to: r\\.${leftPlural}\\.id, optional: false \\}\\)`,
    ),
    `relations manifest: ${junctionVar}.${leftEnt}`,
  );

  log(`relations manifest assertions passed: ${junctionVar}`);
}

/**
 * PATH-0 (#566 / #612): with every path non-default, nothing may land at a
 * default location — init, the subsystem installs, entity and junction codegen
 * all resolve from `paths.*`.
 */
function assertCustomLayout(projectDir: string): void {
  for (const stray of ['src', 'entities']) {
    if (fs.existsSync(path.join(projectDir, stray))) {
      throw new Error(`layout custom: '${stray}/' was created at the project root — a scaffold ignored paths.*`);
    }
  }
  for (const rel of [
    `${P.backendSrc}/app.module.ts`,
    `${P.backendSrc}/main.ts`,
    `${P.backendSrc}/worker.ts`,
    `${P.backendSrc}/schema.ts`,
    `${P.generated}/modules.ts`,
    `${P.generated}/subsystems.ts`,
    `${P.entities}/opportunity.yaml`,
  ]) {
    if (!fs.existsSync(path.join(projectDir, rel))) {
      throw new Error(`layout custom: expected ${rel}`);
    }
  }
  const main = fs.readFileSync(path.join(projectDir, P.backendSrc, 'main.ts'), 'utf8');
  if (!main.includes('JOBS — Embedded worker mode')) {
    throw new Error(`layout custom: the jobs main.ts hook did not land in ${P.backendSrc}/main.ts`);
  }

  // PATH-1 (#645): every clean-lite-ps module lives under `paths.modules_dir`,
  // and nothing under the default `<backend_src>/modules`.
  if (fs.existsSync(path.join(projectDir, P.backendSrc, 'modules'))) {
    throw new Error(`layout custom: '${P.backendSrc}/modules/' was created — an emitter ignored paths.modules_dir`);
  }
  const { entity, plural, mixin } = CUSTOM_LAYOUT_APP_PATTERN;
  const barrel = fs.readFileSync(path.join(projectDir, P.generated, 'modules.ts'), 'utf8');
  const fromBarrel = path.posix.relative(P.generated, P.modules);
  for (const mod of ['opportunities', 'contacts', plural]) {
    assertContains(
      barrel,
      new RegExp(`from '${fromBarrel.replace(/\./g, '\\.')}/${mod}/${mod}\\.module'`),
      `modules barrel imports ${mod} from ${P.modules}`,
    );
  }
  // PATH-1: the app pattern under `<backend_src>/patterns/` loaded through the
  // derived default glob — the ledger repository applies its mixin.
  const ledgerRepo = fs.readFileSync(path.join(projectDir, P.modules, plural, `${entity}.repository.ts`), 'utf8');
  assertContains(ledgerRepo, new RegExp(`${mixin}\\(`), `${entity} repository applies ${mixin} (app pattern loaded)`);
  assertContains(
    ledgerRepo,
    /from '@modules\/capabilities\/with-audited'/,
    `${entity} repository imports the mixin through @modules/*`,
  );
  log('layout assertions passed: custom');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUNC-0 (#678) — regeneration assertions
// ---------------------------------------------------------------------------

/** Both parents' service + module files, project-relative. */
function parentFiles(scenario: Scenario): string[] {
  const { leftEnt, rightEnt } = SCENARIO_META[scenario];
  return [leftEnt, rightEnt].flatMap((e) => [
    `${P.modules}/${pluralize(e)}/${e}.service.ts`,
    `${P.modules}/${pluralize(e)}/${pluralize(e)}.module.ts`,
  ]);
}

function readParents(projectDir: string, scenario: Scenario): Map<string, string> {
  return new Map(
    parentFiles(scenario).map((rel) => [rel, fs.readFileSync(path.join(projectDir, rel), 'utf8')]),
  );
}

/** Every parent file byte-identical to `expected`; names each one that is not. */
function assertParentsIdentical(
  projectDir: string,
  scenario: Scenario,
  expected: Map<string, string>,
  label: string,
): void {
  const drifted = [...readParents(projectDir, scenario)]
    .filter(([rel, src]) => src !== expected.get(rel))
    .map(([rel]) => rel);
  if (drifted.length > 0) {
    throw new Error(`[${label}] parent files are not byte-identical: ${drifted.join(', ')}`);
  }
  log(`parents byte-identical: ${label}`);
}

function runCli(args: string, cwd: string): void {
  const r = runSilent(`bun ${CLI_PATH} ${args}`, cwd);
  if (r.code !== 0) {
    throw new Error(`codegen ${args} exited ${r.code}\n${r.out}\n${r.err}`);
  }
}

async function main(): Promise<number> {
  log(`smoke-junction scenario=${scenarioArg} runtime=${runtimeArg} layout=${layoutArg}`);

  let exitCode = 0;
  let result: Awaited<ReturnType<typeof bootstrapJunctionProject>> | null = null;

  try {
    result = await bootstrapJunctionProject({
      scenario: scenarioArg,
      runtime: runtimeArg,
      layout: layoutArg,
      log,
    });

    // 8. bunx tsc --noEmit --skipLibCheck
    log('running bunx tsc --noEmit --skipLibCheck');
    const tsc = runSilent('bunx tsc --noEmit --skipLibCheck', result.projectDir);
    const consumerErrors = tscGateErrors({ code: tsc.code, output: tsc.out + tsc.err }, result.projectDir);
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

      assertJunctionEmission(result.projectDir, scenarioArg);
      assertBarrelIncludes(result.projectDir, pluralName);
      const { leftEnt, rightEnt } = SCENARIO_META[scenarioArg];
      assertJunctionRelations(result.projectDir, junctionName, leftEnt, rightEnt);
      assertRuntimeSpecifiers(result.projectDir, scenarioArg, runtimeArg);
      if (layoutArg === 'custom') assertCustomLayout(result.projectDir);
    }

    // 10. DI-resolution gate — boot the generated AppModule. `tsc` + grep
    // cannot catch a junction module that typechecks but fails to resolve its
    // injected parent repos at runtime (the wiring regression fixed in 0.7.8).
    // NestFactory.create + init instantiates the whole graph, so an unresolved
    // cross-module dependency throws here, not on a consumer's first boot.
    if (exitCode === 0) {
      log('booting AppModule (NestFactory DI resolution gate)');
      // CFG-1: the custom layout declares non-default `jobs.pools`; the booted
      // app's JOB_POOL_CONFIG must carry them. GEN-0: and the
      // `jobs.extensions.drizzle` set after install, via JOBS_LISTEN_NOTIFY.
      const boot = runArgv(
        [
          'bun',
          path.join(import.meta.dir, 'verify-boot.ts'),
          result.projectDir,
          `${P.backendSrc}/app.module.ts`,
          ...(layoutArg === 'custom'
            ? ['--expect-pools', JSON.stringify(CUSTOM_LAYOUT_BOOT_CONFIG.jobsPools), '--expect-listen-notify']
            : []),
        ],
        result.projectDir,
      );
      if (boot.code !== 0) {
        console.error(boot.out);
        console.error(boot.err);
        logError('AppModule boot failed — DI graph did not resolve');
        exitCode = 1;
      } else {
        for (const line of boot.out.trim().split('\n')) log(line);
        log('boot OK (AppModule DI graph resolves)');
      }
    }

    // 10b. GEN-0 (#652) — the standalone worker.ts was emitted (emit-once) by
    // `subsystem install jobs` BEFORE the custom layout set
    // `jobs.extensions.drizzle`; after regeneration its resolved
    // `JobWorkerModule` options must carry the new value.
    if (exitCode === 0 && layoutArg === 'custom') {
      log('loading worker.ts (GEN-0: the worker options follow the config)');
      const { jobsDrizzle, jobsPools } = CUSTOM_LAYOUT_BOOT_CONFIG;
      const worker = runArgv(
        [
          'bun',
          path.join(import.meta.dir, 'verify-worker.ts'),
          result.projectDir,
          `${P.backendSrc}/worker.ts`,
          JSON.stringify({
            drizzle: { listenNotify: jobsDrizzle.listen_notify, pollIntervalMs: jobsDrizzle.poll_interval_ms },
            pools: jobsPools,
          }),
        ],
        result.projectDir,
      );
      if (worker.code !== 0) {
        console.error(worker.out);
        console.error(worker.err);
        logError('worker.ts does not carry the regenerated jobs options');
        exitCode = 1;
      } else {
        log(worker.out.trim());
      }
    }

    // 11. CFG-1 (#643) — run the generated main.ts and assert the non-default
    // `openapi.*` / `auth.devAllowAnonymous` reached the running app. The app
    // never reads codegen.config.yaml; these arrive through the generated
    // `<generated>/app-config.ts`. main.ts wires the auth boot-fail check only
    // in package mode (vendored defers it to `project upgrade-auth`).
    if (exitCode === 0 && layoutArg === 'custom') {
      log('running main.ts (CFG-1: boot config reaches the app)');
      const { openapi } = CUSTOM_LAYOUT_BOOT_CONFIG;
      const run = runArgv(
        [
          'bun',
          path.join(import.meta.dir, 'verify-main.ts'),
          result.projectDir,
          `${P.backendSrc}/main.ts`,
          JSON.stringify(openapi),
          ...(runtimeArg === 'package' ? ['--expect-anonymous-warning'] : []),
        ],
        result.projectDir,
      );
      if (run.code !== 0) {
        console.error(run.out);
        console.error(run.err);
        logError('main.ts did not serve the configured boot values');
        exitCode = 1;
      } else {
        log(run.out.trim());
      }
    }

    // 12. JUNC-0 (#678) — round trip + removal. The parents after
    // entity → junction are the reference: `entity new` again, then
    // `junction new` again, must leave all four byte-identical (before JUNC-0
    // the second `entity new` deleted the injected fan-out, silently). Then
    // delete the junction YAML: the next `entity new` drops its fan-out from
    // both parents, and the project still typechecks.
    let reference: Map<string, string> | null = null;
    if (exitCode === 0) {
      const dir = result.projectDir;
      reference = readParents(dir, scenarioArg);
      log('JUNC-0: entity new --all again');
      runCli('entity new --all --force', dir);
      assertParentsIdentical(dir, scenarioArg, reference, 'entity → junction → entity');
      log('JUNC-0: junction new --all again');
      runCli('junction new --all --force', dir);
      assertParentsIdentical(dir, scenarioArg, reference, 'entity → junction → entity → junction');

      const { junctionName } = SCENARIO_META[scenarioArg];
      fs.rmSync(path.join(dir, 'junctions', `${junctionName}.yaml`));
      log(`JUNC-0: removed junctions/${junctionName}.yaml; entity new --all`);
      runCli('entity new --all --force', dir);
      const junctionPascal = pascalCase(junctionName);
      for (const [rel, src] of readParents(dir, scenarioArg)) {
        assertAbsent(src, new RegExp(junctionPascal), `${rel}: no ${junctionPascal} after the junction YAML is removed`);
        assertAbsent(src, /forwardRef/, `${rel}: no forwardRef after the junction YAML is removed`);
      }
      const tscAfter = runSilent('bunx tsc --noEmit --skipLibCheck', dir);
      const afterErrors = tscGateErrors({ code: tscAfter.code, output: tscAfter.out + tscAfter.err }, dir);
      if (afterErrors.length > 0) {
        for (const line of afterErrors) console.error(line);
        logError(`${afterErrors.length} typecheck errors after removing the junction YAML`);
        exitCode = 1;
      } else {
        log('JUNC-0: removal OK (fan-out gone from both parents, tsc OK)');
      }
    }

    // 13. JUNC-0 order swap — a second project with the junction YAMLs present
    // before the first `entity new`. The parents must already equal step 12's
    // reference after that first `entity new` (no `junction new` yet — the
    // order-independence claim), and still after `junction new`.
    if (exitCode === 0 && reference) {
      log('JUNC-0: order swap — bootstrapping with junction YAMLs before entity new');
      const swapped = await bootstrapJunctionProject({
        scenario: scenarioArg,
        runtime: runtimeArg,
        layout: layoutArg,
        junctionsFirst: true,
        afterEntityNew: (dir) =>
          assertParentsIdentical(dir, scenarioArg, reference!, 'junction YAMLs → entity (before junction new)'),
        log,
      });
      try {
        assertParentsIdentical(swapped.projectDir, scenarioArg, reference, 'junction YAMLs → entity → junction');
      } finally {
        swapped.cleanup();
      }
    }

  } catch (err: unknown) {
    logError(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    exitCode = 1;
  } finally {
    if (result) result.cleanup();
  }

  if (exitCode === 0) {
    log(`smoke-junction PASS (${scenarioArg}/${runtimeArg}/${layoutArg})`);
  } else {
    log(`smoke-junction FAIL (${scenarioArg}/${runtimeArg}/${layoutArg})`);
  }
  return exitCode;
}

main().then((code) => process.exit(code));
