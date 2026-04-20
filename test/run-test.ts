#!/usr/bin/env bun
/**
 * Codegen Test Runner
 *
 * Usage:
 *   bun test/run-test.ts baseline    Capture baseline output
 *   bun test/run-test.ts generate    Generate to test/gen/
 *   bun test/run-test.ts compare     Compare gen/ to baseline/
 *   bun test/run-test.ts full        Run full test (generate + compare)
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { loadEntityFromYaml } from '../src/utils/yaml-loader.js';
import { buildDomainGraph, topoSortEntities } from '../src/analyzer/index.js';
import type { ParsedEntity } from '../src/analyzer/types.js';
// run-test.ts lives in <root>/test/ — the script previously sat at
// tools/codegen/test/ which is why a 3-level '../../..' was used. Computing
// the parent of import.meta.dir is robust to the script being moved again.
const ROOT = dirname(import.meta.dir);
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
  // Shared packages
  'packages/db/src/entities',
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

async function runCodegen() {
  console.log('🔧 Running codegen for all fixtures...');

  // Set up test config at ROOT
  setupTestConfig();

  // Determine generation order via the analyzer's topological sort.
  // The codegen template `prompt.js` (checkEntityExists) emits one of two
  // distinct branches depending on whether a `belongs_to` target's domain
  // file already exists on disk — so the order in which fixtures are
  // generated affects the bytes written. readdirSync order is filesystem-
  // dependent (varies between machines), making the baseline non-
  // deterministic. topoSortEntities orders dependents AFTER their targets
  // so dependent entities always see their related entities present.
  //
  // We avoid analyzeDomain here because it strict-validates cross-entity
  // references — the test fixtures intentionally reference entities outside
  // the fixture set (e.g. `account`), which at codegen time become
  // "Related entities not yet generated" branches but aren't errors. We
  // load the entity YAMLs directly and build a minimal graph for the topo
  // sort.
  const yamlFiles = readdirSync(FIXTURES_DIR)
    .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('codegen.config'))
    .map((f) => join(FIXTURES_DIR, f));
  const parsedEntities: ParsedEntity[] = [];
  for (const yamlPath of yamlFiles) {
    const result = loadEntityFromYaml(yamlPath);
    if (!result.success) throw new Error(`Failed to parse ${yamlPath}: ${result.error}`);
    const def = result.definition;
    parsedEntities.push({
      name: def.entity.name,
      plural: def.entity.plural,
      table: def.entity.table,
      folderStructure: def.entity.folder_structure ?? 'nested',
      fields: new Map(),
      relationships: new Map(
        Object.entries(def.relationships ?? {}).map(([name, rel]) => [
          name,
          {
            name,
            type: rel.type,
            target: rel.target,
            foreignKey: rel.foreign_key,
            // Mark resolved=true so the topo sort considers the edge even
            // if the target isn't in the fixture set; targets outside the
            // set are filtered out by topoSortEntities itself.
            resolved: true,
          },
        ]),
      ),
      behaviors: [],
      sourcePath: yamlPath,
    });
  }
  const graph = buildDomainGraph(parsedEntities);
  const { sorted, cycles } = topoSortEntities(parsedEntities, graph);
  if (cycles.length > 0) {
    console.warn(
      `⚠ belongs_to cycle(s) detected — entities in cycles ordered alphabetically: ` +
      cycles.map((c) => c.join(' -> ')).join('; '),
    );
  }

  // Build entity-name -> source-yaml lookup. analyzer drops the .yaml from
  // the source path, but ParsedEntity.sourcePath retains the absolute path,
  // so we can use it directly.
  const fixtures = sorted.map((entity) => entity.sourcePath);

  // Use env var or compute from script location (works when running from any directory)
  const templatesDir = process.env.CODEGEN_TEMPLATES_DIR || join(CODEGEN_DIR, 'templates');

  // Two-pass generation. Pass 1 establishes every entity file on disk so
  // pass 2's has_many relationships can see their targets. Without pass 2,
  // an entity declaring `has_many: foo` only emits the relationship-mapping
  // branch if foo's domain file already existed at generation time — which
  // can't be true on first emission of either side. Topo sort above orders
  // belongs_to dependencies but cannot satisfy has_many in the same pass.
  try {
    for (let pass = 1; pass <= 2; pass++) {
      console.log(`   --- Pass ${pass} ---`);
      for (const yamlPath of fixtures) {
        const fixture = relative(FIXTURES_DIR, yamlPath);
        console.log(`   Generating: ${fixture}`);

        try {
          execSync(`HYGEN_TMPLS="${templatesDir}" bunx hygen entity new --yaml "${yamlPath}"`, {
            cwd: ROOT,
            stdio: 'pipe',
          });
        } catch (error) {
          console.error(`   ❌ Failed: ${fixture}`);
          throw error;
        }
      }
    }
  } finally {
    // Always clean up test config
    cleanupTestConfig();
  }

  console.log('✅ Codegen complete');

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
    console.log('\n📋 Baseline captured. Run "bun tools/codegen/test/run-test.ts full" after refactoring to verify.');
    break;

  case 'generate':
    // Clean and generate fresh output
    cleanGenDir();
    await runCodegen();
    captureOutputState(GEN_DIR);
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
    // Full test: generate + compare
    cleanGenDir();
    await runCodegen();
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
