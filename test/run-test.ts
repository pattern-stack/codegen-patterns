#!/usr/bin/env bun
/**
 * Codegen Test Runner
 *
 * Usage:
 *   bun tools/codegen/test/run-test.ts baseline    Capture baseline output
 *   bun tools/codegen/test/run-test.ts generate    Generate to test/gen/
 *   bun tools/codegen/test/run-test.ts compare     Compare gen/ to baseline/
 *   bun tools/codegen/test/run-test.ts full        Run full test (generate + compare)
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
// Repo root — one level up from this file's directory (test/ → repo).
// The legacy three-dots resolution dated back to when this runner lived
// under tools/codegen/test/, and writing to the wrong ROOT contaminated
// the dev machine's enclosing directory with `packages/api/` across every
// run. Fixing it to the correct repo root means every baseline run starts
// pristine — which is what CI has always done and what exposed the
// implicit "populated packages/api from a previous run" assumption the
// old baseline accidentally depended on.
const ROOT = resolve(import.meta.dir, '..');
// Guard: the miscomputed-ROOT bug (three dots instead of two) silently
// wrote generated output into the directory ENCLOSING the repo, which
// accumulated contamination across dev runs and made the baseline
// accidentally pass on macOS while failing on any fresh checkout (CI).
// Assert the repo-shaped invariant so the miscomputation can't silently
// recur.
if (!existsSync(join(ROOT, 'justfile')) || !existsSync(join(ROOT, 'templates'))) {
  throw new Error(
    `ROOT does not look like the codegen-patterns repo root: ${ROOT}\n` +
    `Expected 'justfile' and 'templates/' to exist there.`
  );
}
const CODEGEN_DIR = resolve(import.meta.dir, '..');
const TEST_DIR = import.meta.dir;
const FIXTURES_DIR = join(TEST_DIR, 'fixtures');
// The baseline entity set — closed: every cross-entity reference resolves from
// its target's own YAML here (`paths.entities` in the fixture config, NAME-0).
const ENTITY_FIXTURES_DIR = join(FIXTURES_DIR, 'entities');
const BASELINE_DIR = join(TEST_DIR, 'baseline');
const GEN_DIR = join(TEST_DIR, 'gen');
const TEST_CONFIG = join(FIXTURES_DIR, 'codegen.config.yaml');
const ROOT_CONFIG = join(ROOT, 'codegen.config.yaml');

// Test-specific output paths (must match test/fixtures/codegen.config.yaml)
// These are hardcoded here to avoid circular dependency with config loading
const OUTPUT_PATHS = [
  // The clean-lite-ps module tree (paths.modules_dir, default <backend_src>/modules)
  'packages/api/src/modules',
  // JOB-7: generated scope-entity-type union (post-Hygen step)
  'runtime/subsystems/jobs/generated',
  // EVT-3: generated event-codegen artifacts (types, schemas, registry, bus, index)
  'runtime/subsystems/events/generated',
];

function getAllFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      getAllFiles(fullPath, files);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function cleanGenDir() {
  if (existsSync(GEN_DIR)) {
    rmSync(GEN_DIR, { recursive: true });
  }
  mkdirSync(GEN_DIR, { recursive: true });
}

function setupTestConfig() {
  // Copy test config to ROOT so hygen can find it
  if (existsSync(TEST_CONFIG)) {
    cpSync(TEST_CONFIG, ROOT_CONFIG);
  }
}

function cleanupTestConfig() {
  // Remove test config from ROOT
  if (existsSync(ROOT_CONFIG)) {
    rmSync(ROOT_CONFIG);
  }
}

function captureOutputState(targetDir: string) {
  console.log(`📸 Capturing output state to ${relative(ROOT, targetDir)}/`);

  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true });
  }
  mkdirSync(targetDir, { recursive: true });

  for (const outputPath of OUTPUT_PATHS) {
    const srcPath = join(ROOT, outputPath);
    const destPath = join(targetDir, outputPath);

    if (existsSync(srcPath)) {
      if (srcPath.endsWith('.ts')) {
        // Single file
        mkdirSync(join(destPath, '..'), { recursive: true });
        cpSync(srcPath, destPath);
      } else {
        // Directory
        mkdirSync(destPath, { recursive: true });
        cpSync(srcPath, destPath, { recursive: true });
      }
    }
  }

  console.log('✅ Capture complete');
}

function runCodegen() {
  console.log('🔧 Running codegen for all fixtures...');

  // Set up test config at ROOT
  setupTestConfig();

  // Pristine state — wipe every output path under ROOT so the two-pass
  // generation below genuinely starts from "first run" regardless of what
  // a previous invocation (or the dev's enclosing directory contamination
  // when ROOT was miscomputed) left behind. Mirrors the CI environment,
  // which always starts from a fresh checkout.
  for (const outputPath of OUTPUT_PATHS) {
    const abs = join(ROOT, outputPath);
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true });
    }
  }

  // Sort fixtures alphabetically so run order is deterministic regardless of
  // the underlying filesystem's `readdir` semantics. Without this, Linux
  // (ext4 insertion-order) and macOS (APFS effectively stable-but-implementation-defined)
  // can process the same fixture set in different orders, producing different
  // output when templates check `targetExists` for cross-entity references.
  const fixtures = readdirSync(ENTITY_FIXTURES_DIR)
    .filter(f => f.endsWith('.yaml'))
    .sort();

  // Use env var or compute from script location (works when running from any directory)
  const templatesDir = process.env.CODEGEN_TEMPLATES_DIR || join(CODEGEN_DIR, 'templates');

  // Two-pass generation.
  //
  // The clean-lite-ps prompt includes a belongs_to / has_many target in the
  // repository's imports only when the target's `<entity>.entity.ts` is already
  // on disk (`targetExists` in prompt-extension.js — deliberately a file check,
  // so a single `entity new x.yaml` never imports a sibling that was never
  // generated). The first pass seeds every entity file; the second pass emits
  // the steady state that `entity new --all` reaches, which is what the
  // snapshot documents. Fixtures run sorted, so the output does not depend on
  // the filesystem's readdir order.
  const runPass = (label: string) => {
    console.log(`   Pass ${label}:`);
    for (const fixture of fixtures) {
      const yamlPath = join(ENTITY_FIXTURES_DIR, fixture);
      console.log(`     Generating: ${fixture}`);

      try {
        execSync(`HYGEN_TMPLS="${templatesDir}" bunx --bun hygen entity new --yaml "${yamlPath}"`, {
          cwd: ROOT,
          stdio: 'pipe',
        });
      } catch (error) {
        console.error(`     ❌ Failed: ${fixture}`);
        throw error;
      }
    }
  };

  try {
    runPass('1 (seeds domain entity files for targetExists checks)');
    runPass('2 (final output with all cross-entity references resolved)');
  } finally {
    // Always clean up test config
    cleanupTestConfig();
  }

  console.log('✅ Codegen complete');

  // JOB-7: generate ScopeEntityType union from fixtures (mirrors EntityNewCommand post-step).
  console.log('   Generating: scope-entity-type.ts');
  execSync(
    `bun -e "import { generateScopeEntityType } from './src/cli/shared/scope-entity-type-generator.js'; await generateScopeEntityType({ entitiesDir: '${FIXTURES_DIR}', outputPath: '${join(ROOT, 'runtime/subsystems/jobs/generated/scope-entity-type.ts')}' });"`,
    { cwd: CODEGEN_DIR, stdio: 'pipe' },
  );

  // EVT-3: generate event-codegen artifacts from fixture events + entity
  // `events:` blocks (mirrors EntityNewCommand post-step). Writes five files
  // under runtime/subsystems/events/generated/.
  console.log('   Generating: events/generated/ (types, schemas, registry, bus, index)');
  const eventsFixturesDir = join(FIXTURES_DIR, 'events');
  const eventCodegenOutputDir = join(ROOT, 'runtime/subsystems/events/generated');
  execSync(
    `bun -e "import { generateEventCodegen } from './src/cli/shared/event-codegen-generator.js'; await generateEventCodegen({ entitiesDir: '${FIXTURES_DIR}', eventsDir: '${eventsFixturesDir}', outputDir: '${eventCodegenOutputDir}' });"`,
    { cwd: CODEGEN_DIR, stdio: 'pipe' },
  );

  // JOB-6: render both variants of `job-orchestration.schema.ejs.t` so the
  // baseline captures the scaffold-time `jobs.multi_tenant` conditional in
  // action. Single-tenant must have zero `tenant_id` references; multi-tenant
  // must include the column + its JOB-8 guidance comment. The fixtures land
  // under `runtime/subsystems/jobs/generated/` (already in OUTPUT_PATHS).
  //
  // The non-schema templates are muted by pointing their injection targets
  // at a throwaway sandbox and pre-creating `src/worker.ts` there so the
  // `unless_exists: true` guard fires (#513: worker emits at src/worker.ts).
  const sandbox = join(ROOT, 'test/.jobs-baseline-sandbox');
  mkdirSync(join(sandbox, 'src'), { recursive: true });
  writeFileSync(join(sandbox, 'src/worker.ts'), '// placeholder — keeps Hygen unless_exists satisfied\n');
  // main.ts and codegen.config.yaml are intentionally absent so the inject
  // templates print "Cannot inject" and exit non-zero? They don't: Hygen
  // logs the warning and continues. We verify this in the walkthrough.
  const variantOutputs = [
    {
      label: 'single-tenant',
      multiTenant: 'false',
      out: join(ROOT, 'runtime/subsystems/jobs/generated/job-orchestration.schema.single-tenant.ts'),
    },
    {
      label: 'multi-tenant',
      multiTenant: 'true',
      out: join(ROOT, 'runtime/subsystems/jobs/generated/job-orchestration.schema.multi-tenant.ts'),
    },
  ];
  for (const v of variantOutputs) {
    console.log(`   Generating: job-orchestration.schema (${v.label})`);
    execSync(
      `HYGEN_TMPLS="${templatesDir}" bunx --bun hygen subsystem jobs ` +
        `--appName baseline ` +
        `--multiTenant ${v.multiTenant} ` +
        `--mainTsPath "${join(sandbox, 'src/main.ts')}" ` +
        `--configPath "${join(sandbox, 'codegen.config.yaml')}" ` +
        `--workerExists true ` +
        `--workerPath "${join(sandbox, 'src/worker.ts')}" ` +
        // CFG-1: required by the jobs prompt (worker.ts imports `jobPools`);
        // unused here — `--workerExists true` skips the worker template.
        `--appConfigImport ./generated/app-config ` +
        `--schemaPath "${v.out}" ` +
        // Silence the `mainHookInjected is not defined` EJS error in
        // `templates/subsystem/jobs/main-hook.ejs.t`. The baseline's
        // throwaway sandbox has no main.ts to inject into, so the flag's
        // value is irrelevant; we just need *some* string.
        `--mainHookInjected true`,
      { cwd: ROOT, stdio: 'pipe' },
    );
  }
  // Clean up sandbox — baseline only cares about the two schema files.
  rmSync(sandbox, { recursive: true, force: true });

  // Run biome to format generated files (to match baseline formatting)
  console.log('🎨 Running biome format...');
  try {
    execSync('bun run lint', {
      cwd: ROOT,
      stdio: 'pipe',
    });
  } catch (error) {
    // Lint may fail on new files, but formatting should still apply
    console.log('   (lint completed with warnings)');
  }
  console.log('✅ Format complete');
}

/**
 * Named expectation for #680 — clean-lite-ps ignores a declarative query's
 * `via:` / `select:` options, so contact-v2's two `via: opportunity_contact_link`
 * queries emit repository methods that do not compile. Exact file, exact codes,
 * exact count; asserted present AND sole. Delete this (and its call below) when
 * #680 is fixed — the assertion fails the moment the defect goes away.
 */
const ISSUE_680_EXPECTATION = {
  file: 'packages/api/src/modules/contacts/contact.repository.ts',
  codes: ['TS2322', 'TS7053', 'TS7053'],
};

/**
 * Run TypeScript typecheck over the generated packages/api/src output.
 *
 * Uses test/tsconfig.baseline.json, which maps the vendored-mode `@shared/*`
 * specifiers onto the in-repo runtime/ sources, so it compiles the generated
 * clean-lite-ps module tree (`packages/api/src/modules/**`) without a vendor
 * step. Runs over the live output (not the snapshot), so it must be called
 * after runCodegen().
 *
 * Snapshot comparison verifies the shape of the generated text; this verifies
 * that the shape compiles. Every diagnostic fails the gate except the named
 * #680 expectation above.
 */
function typecheckBaseline() {
  const tsconfig = join(TEST_DIR, 'tsconfig.baseline.json');
  console.log('Typechecking generated clean-lite-ps output (packages/api/src/modules)...');
  let output = '';
  try {
    execSync(`bunx tsc --noEmit --pretty false --project "${tsconfig}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch (err: unknown) {
    const error = err as { stdout?: Buffer; stderr?: Buffer };
    output = [error.stdout?.toString(), error.stderr?.toString()].filter(Boolean).join('\n');
  }
  // Every `error TS` line must parse as a located diagnostic: a global one
  // (e.g. TS5083, a tsconfig error) has no file and fails the gate below.
  const errorLines = output.split('\n').filter((line) => /error TS\d+:/.test(line)).length;
  const diagnostics = output
    .split('\n')
    .map((line) => /^(.+?)\(\d+,\d+\): error (TS\d+):/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: m[1], code: m[2] }));
  const expected = diagnostics.filter((d) => d.file === ISSUE_680_EXPECTATION.file);
  const others = diagnostics.filter((d) => d.file !== ISSUE_680_EXPECTATION.file);
  const expectedCodes = expected.map((d) => d.code).sort();
  const matches680 = JSON.stringify(expectedCodes) === JSON.stringify(ISSUE_680_EXPECTATION.codes);
  if (
    others.length > 0 ||
    !matches680 ||
    errorLines !== diagnostics.length ||
    (output !== '' && diagnostics.length === 0)
  ) {
    console.error('Typecheck failed over generated clean-lite-ps output:\n' + output);
    if (!matches680) {
      console.error(
        `#680 expectation not met: expected exactly ${ISSUE_680_EXPECTATION.codes.join(', ')} in ` +
          `${ISSUE_680_EXPECTATION.file}, got [${expectedCodes.join(', ')}]. If #680 is fixed, delete the expectation.`,
      );
    }
    process.exit(1);
  }
  console.log(`Typecheck passed (only the named #680 expectation: ${ISSUE_680_EXPECTATION.codes.join(', ')})`);
}

function compareFiles(file1: string, file2: string): { match: boolean; diff?: string } {
  if (!existsSync(file1) && !existsSync(file2)) {
    return { match: true };
  }

  if (!existsSync(file1)) {
    return { match: false, diff: `File missing in baseline: ${file1}` };
  }

  if (!existsSync(file2)) {
    return { match: false, diff: `File missing in generated: ${file2}` };
  }

  const content1 = readFileSync(file1, 'utf-8');
  const content2 = readFileSync(file2, 'utf-8');

  if (content1 === content2) {
    return { match: true };
  }

  return {
    match: false,
    diff: `Content differs:\n  Baseline: ${file1}\n  Generated: ${file2}`,
  };
}

function compare(): { passed: boolean; details: string[] } {
  console.log('🔍 Comparing generated output to baseline...');

  const baselineFiles = getAllFiles(BASELINE_DIR);
  const genFiles = getAllFiles(GEN_DIR);

  const baselineRel = new Set(baselineFiles.map(f => relative(BASELINE_DIR, f)));
  const genRel = new Set(genFiles.map(f => relative(GEN_DIR, f)));

  const details: string[] = [];
  let passed = true;

  // Check for missing files in gen
  for (const file of baselineRel) {
    if (!genRel.has(file)) {
      details.push(`❌ Missing in generated: ${file}`);
      passed = false;
    }
  }

  // Check for extra files in gen
  for (const file of genRel) {
    if (!baselineRel.has(file)) {
      details.push(`❌ Extra file in generated: ${file}`);
      passed = false;
    }
  }

  // Compare content of matching files
  for (const file of baselineRel) {
    if (genRel.has(file)) {
      const result = compareFiles(
        join(BASELINE_DIR, file),
        join(GEN_DIR, file)
      );

      if (!result.match) {
        details.push(`❌ Content differs: ${file}`);
        passed = false;
      } else {
        details.push(`✅ ${file}`);
      }
    }
  }

  return { passed, details };
}

// Main
const command = process.argv[2];

switch (command) {
  case 'baseline':
    // Capture current output as baseline
    captureOutputState(BASELINE_DIR);
    console.log('\n📋 Baseline captured. Run "bun test/run-test.ts full" after refactoring to verify.');
    break;

  case 'generate':
    // Clean and generate fresh output
    cleanGenDir();
    runCodegen();
    captureOutputState(GEN_DIR);
    break;

  case 'typecheck':
    // Typecheck the generated output in packages/api/src (does not regenerate)
    typecheckBaseline();
    break;

  case 'compare':
    // Compare gen to baseline
    const { passed, details } = compare();
    console.log('\n--- Results ---');
    for (const detail of details) {
      console.log(detail);
    }
    console.log(`\n${passed ? '✅ All tests passed!' : '❌ Tests failed'}`);
    process.exit(passed ? 0 : 1);
    break;

  case 'full':
    // Full test: generate + typecheck + compare
    cleanGenDir();
    runCodegen();
    typecheckBaseline();
    captureOutputState(GEN_DIR);
    const fullResult = compare();
    console.log('\n--- Results ---');
    for (const detail of fullResult.details) {
      console.log(detail);
    }
    console.log(`\n${fullResult.passed ? '✅ All tests passed!' : '❌ Tests failed'}`);
    process.exit(fullResult.passed ? 0 : 1);
    break;

  default:
    console.log(`
Codegen Test Runner

Usage:
  bun tools/codegen/test/run-test.ts baseline    Capture baseline output
  bun tools/codegen/test/run-test.ts generate    Generate to test/gen/
  bun tools/codegen/test/run-test.ts compare     Compare gen/ to baseline/
  bun tools/codegen/test/run-test.ts full        Run full test (generate + compare)
`);
    process.exit(1);
}
