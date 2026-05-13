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
const BASELINE_DIR = join(TEST_DIR, 'baseline');
const GEN_DIR = join(TEST_DIR, 'gen');
const TEST_CONFIG = join(FIXTURES_DIR, 'codegen.config.yaml');
const ROOT_CONFIG = join(ROOT, 'codegen.config.yaml');

// Test-specific output paths (must match test/fixtures/codegen.config.yaml)
// These are hardcoded here to avoid circular dependency with config loading
const OUTPUT_PATHS = [
  // Backend paths (packages/api structure from test config)
  'packages/api/src/domain',
  'packages/api/src/application',
  'packages/api/src/infrastructure/persistence',
  'packages/api/src/modules',
  'packages/api/src/presentation',
  // Generated injection tokens (accumulated across entities by the inject template)
  'packages/api/src/constants',
  // Shared packages
  'packages/db/src/entities',
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

  // Seed the constants/tokens.ts anchor file before running codegen.
  // Hygen's inject+append templates cannot create new files — they require
  // the target to already exist. Without this seed, the `_inject-token.ejs.t`
  // template prints "Cannot inject to …/constants/tokens.ts: doesn't exist"
  // and the baseline snapshot omits the file entirely. Seeding it here mirrors
  // what happens in a real project where `project init` creates the file first.
  const constantsDir = join(ROOT, 'packages/api/src/constants');
  mkdirSync(constantsDir, { recursive: true });
  writeFileSync(
    join(constantsDir, 'tokens.ts'),
    '// Generated entity repository tokens\n',
  );

  // Sort fixtures alphabetically so run order is deterministic regardless of
  // the underlying filesystem's `readdir` semantics. Without this, Linux
  // (ext4 insertion-order) and macOS (APFS effectively stable-but-implementation-defined)
  // can process the same fixture set in different orders, producing different
  // output when templates check `targetExists` for cross-entity references.
  const fixtures = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.yaml') && !f.startsWith('codegen.config'))
    .sort();

  // Use env var or compute from script location (works when running from any directory)
  const templatesDir = process.env.CODEGEN_TEMPLATES_DIR || join(CODEGEN_DIR, 'templates');

  // Two-pass generation.
  //
  // The entity `repository.ejs.t` template checks `targetExists` for each
  // relationship — it calls `fs.existsSync('packages/api/src/domain/<target>/<target>.entity.ts')`.
  // When a relationship's target hasn't been generated yet (first pass), the
  // template emits a "Related entities not yet generated" fallback; when it
  // has (second pass), the template emits the full `switch` mapping cases.
  //
  // Users running `codegen entity new --all` iteratively hit the steady state
  // (second-pass shape) quickly in practice. Baselining steady-state output
  // matches the documented contract and avoids baking filesystem-order
  // dependency into the snapshot.
  //
  // The alternative — baselining first-pass output — would require no second
  // pass but would make every generated repository carry the "not yet generated"
  // fallback, which is a less useful documentation artifact. See
  // issue: baseline was previously passing by accident because the buggy ROOT
  // resolution wrote into `/Users/.../Projects/packages/api/` and picked up
  // entity files left over from prior runs.
  const runPass = (label: string) => {
    console.log(`   Pass ${label}:`);
    for (const fixture of fixtures) {
      const yamlPath = join(FIXTURES_DIR, fixture);
      console.log(`     Generating: ${fixture}`);

      try {
        execSync(`HYGEN_TMPLS="${templatesDir}" bunx hygen entity new --yaml "${yamlPath}"`, {
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
  // at a throwaway sandbox and pre-creating a `worker.ts` there so the
  // `unless_exists: true` guard fires.
  const sandbox = join(ROOT, 'test/.jobs-baseline-sandbox');
  mkdirSync(join(sandbox, 'src'), { recursive: true });
  writeFileSync(join(sandbox, 'worker.ts'), '// placeholder — keeps Hygen unless_exists satisfied\n');
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
      `HYGEN_TMPLS="${templatesDir}" bunx hygen subsystem jobs ` +
        `--appName baseline ` +
        `--workerMode embedded ` +
        `--multiTenant ${v.multiTenant} ` +
        `--mainTsPath "${join(sandbox, 'src/main.ts')}" ` +
        `--configPath "${join(sandbox, 'codegen.config.yaml')}" ` +
        `--workerExists true ` +
        `--workerPath "${join(sandbox, 'worker.ts')}" ` +
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
 * Run TypeScript typecheck over the generated packages/api/src output.
 *
 * Uses test/tsconfig.baseline.json which maps @shared/* aliases to the
 * runtime/ subsystem sources so the check runs without a full bun install.
 * The node_modules for NestJS decorators are resolved via test/scaffold/.
 *
 * Runs over the live packages/api/src generated output (not the snapshot),
 * so it must be called after runCodegen() has produced fresh output.
 *
 * This gate catches template regressions (e.g., stale <Class>With imports
 * or missing type exports) that snapshot comparison alone cannot catch —
 * snapshot tests verify the *shape* of generated text; typecheck verifies
 * that the shape actually compiles. CGP-358 validator report surfaced this
 * gap: controller + grouped-index templates emitted <Class>With after the
 * domain type was removed, but no typecheck gate caught it until CI.
 */
function typecheckBaseline() {
  const tsconfig = join(TEST_DIR, 'tsconfig.baseline.json');
  console.log('Typechecking generated clean-pipeline output (packages/api/src)...');
  try {
    execSync(
      `bunx tsc --noEmit --project "${tsconfig}"`,
      { cwd: ROOT, stdio: 'pipe' },
    );
    console.log('Typecheck passed');
  } catch (err: unknown) {
    const error = err as { stdout?: Buffer; stderr?: Buffer };
    const output = [error.stdout?.toString(), error.stderr?.toString()].filter(Boolean).join('\n');
    console.error('Typecheck failed over generated clean-pipeline output:\n' + output);
    process.exit(1);
  }
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
