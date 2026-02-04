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
import {
  TEST_OUTPUT_PATHS,
  INJECTABLE_FILES,
} from '../config/paths.mjs';

const ROOT = resolve(import.meta.dir, '../../..');
const CODEGEN_DIR = resolve(import.meta.dir, '..');
const TEST_DIR = import.meta.dir;
const FIXTURES_DIR = join(TEST_DIR, 'fixtures');
const BASELINE_DIR = join(TEST_DIR, 'baseline');
const GEN_DIR = join(TEST_DIR, 'gen');

// Use centralized path configuration
// See tools/codegen/config/paths.js for definitions
const OUTPUT_PATHS = TEST_OUTPUT_PATHS;

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

  const fixtures = readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.yaml'));

  // Use env var or compute from script location (works when running from any directory)
  const templatesDir = process.env.CODEGEN_TEMPLATES_DIR || join(CODEGEN_DIR, 'templates');

  for (const fixture of fixtures) {
    const yamlPath = join(FIXTURES_DIR, fixture);
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
    runCodegen();
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
    runCodegen();
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
