/**
 * Junction test bootstrap helper.
 *
 * Spins up a fresh tmp project, installs pinned peer deps, runs
 * `codegen project init`, copies fixture entities + junctions, and runs
 * `codegen entity new --all --force` followed by `codegen junction new --all --force`.
 *
 * Used by:
 *   - test/junction/*.test.ts        (snapshot tests — read emitted files)
 *   - test/smoke/run-smoke-junction.ts (compile + grep gate)
 *
 * Set KEEP_SMOKE_DIR=1 to preserve the tmp dir after cleanup() is called.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

export const VALID_SCENARIOS = ['junction', 'junction-cross-domain'] as const;
export type Scenario = (typeof VALID_SCENARIOS)[number];

export const VALID_ARCHITECTURES = ['clean-lite-ps', 'clean'] as const;
export type Architecture = (typeof VALID_ARCHITECTURES)[number];

export interface ScenarioMeta {
  junctionName: string;
  leftEnt: string;
  rightEnt: string;
  hasRole: boolean;
}

export const SCENARIO_META: Record<Scenario, ScenarioMeta> = {
  'junction':              { junctionName: 'opportunity_contact',  leftEnt: 'opportunity', rightEnt: 'contact',  hasRole: true  },
  'junction-cross-domain': { junctionName: 'opportunity_activity', leftEnt: 'opportunity', rightEnt: 'activity', hasRole: false },
};

export const FIXTURES_DIR_MAP: Record<Scenario, string> = {
  'junction':              path.join(REPO_ROOT, 'test', 'smoke', 'fixtures-junction'),
  'junction-cross-domain': path.join(REPO_ROOT, 'test', 'smoke', 'fixtures-junction-cross-domain'),
};

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

export interface BootstrapOptions {
  scenario: Scenario;
  architecture: Architecture;
  log?: (msg: string) => void;
}

export interface BootstrapResult {
  projectDir: string;
  scenario: Scenario;
  architecture: Architecture;
  /** Reads the contents of a file emitted into the tmp project (relative to projectDir). */
  emittedFile(relPath: string): string;
  /** Removes the tmp dir unless KEEP_SMOKE_DIR=1 is set. */
  cleanup(): void;
}

function writeCodegenConfig(tmpDir: string, architecture: Architecture): void {
  const configPath = path.join(tmpDir, 'codegen.config.yaml');
  const content = [
    'generate:',
    `  architecture: ${architecture}`,
    'paths:',
    '  backend_src: src',
    '  entities: entities',
    '  generated: src/generated',
  ].join('\n') + '\n';
  fs.writeFileSync(configPath, content);
}

export async function bootstrapJunctionProject(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { scenario, architecture } = opts;
  const log = opts.log ?? (() => {});

  const fixturesDir = FIXTURES_DIR_MAP[scenario];
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(`Fixtures directory not found: ${fixturesDir}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-smoke-junction-'));
  log(`tmp dir: ${tmpDir}`);

  const run = (cmd: string): void => {
    log(`$ ${cmd}`);
    execSync(cmd, { cwd: tmpDir, stdio: 'inherit', env: { ...process.env } });
  };

  // 1. bun init
  run('bun init -y');

  // 2. install pinned deps
  run(`bun add ${RUNTIME_DEPS.join(' ')}`);
  run(`bun add -D ${DEV_DEPS.join(' ')}`);

  // 3. codegen project init
  run(`bun ${CLI_PATH} project init --yes --with-tsconfig`);

  // override architecture
  writeCodegenConfig(tmpDir, architecture);
  log(`wrote codegen.config.yaml (architecture: ${architecture})`);

  // 4. copy entity fixtures
  const entityFixturesDir = path.join(fixturesDir, 'entities');
  const entitiesDir = path.join(tmpDir, 'entities');
  fs.mkdirSync(entitiesDir, { recursive: true });
  const examplePath = path.join(entitiesDir, 'example.yaml');
  if (fs.existsSync(examplePath)) fs.rmSync(examplePath);
  for (const f of fs.readdirSync(entityFixturesDir)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    fs.copyFileSync(path.join(entityFixturesDir, f), path.join(entitiesDir, f));
    log(`copied entity fixture: ${f}`);
  }

  // 5. codegen entity new --all
  run(`bun ${CLI_PATH} entity new --all --force`);

  // 6. copy junction fixtures
  const junctionFixturesDir = path.join(fixturesDir, 'junctions');
  const junctionsDir = path.join(tmpDir, 'junctions');
  fs.mkdirSync(junctionsDir, { recursive: true });
  for (const f of fs.readdirSync(junctionFixturesDir)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    fs.copyFileSync(path.join(junctionFixturesDir, f), path.join(junctionsDir, f));
    log(`copied junction fixture: ${f}`);
  }

  // 7. codegen junction new --all
  run(`bun ${CLI_PATH} junction new --all --force`);

  const keep = process.env.KEEP_SMOKE_DIR === '1';

  return {
    projectDir: tmpDir,
    scenario,
    architecture,
    emittedFile(relPath: string): string {
      const fullPath = path.join(tmpDir, relPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Expected emitted file not found: ${fullPath}`);
      }
      return fs.readFileSync(fullPath, 'utf8');
    },
    cleanup(): void {
      if (keep) {
        log(`keeping tmp dir (KEEP_SMOKE_DIR=1): ${tmpDir}`);
        return;
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        log(`cleaned up ${tmpDir}`);
      } catch (err: unknown) {
        log(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
