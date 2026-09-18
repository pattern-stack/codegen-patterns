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
import { aliasPackageRuntime } from '../smoke/_package-runtime';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

export const VALID_SCENARIOS = ['junction', 'junction-cross-domain'] as const;
export type Scenario = (typeof VALID_SCENARIOS)[number];

export const VALID_ARCHITECTURES = ['clean-lite-ps', 'clean'] as const;
export type Architecture = (typeof VALID_ARCHITECTURES)[number];

export const VALID_RUNTIMES = ['vendored', 'package'] as const;
export type RuntimeMode = (typeof VALID_RUNTIMES)[number];

/**
 * `default` — the ADR-037 consumer layout (`src/`, `entities/`,
 * `src/generated/`, `src/modules/`). `custom` — every path non-default
 * (PATH-0, #566/#612; PATH-1, #645): `codegen.config.yaml` is written BEFORE
 * `project init`, which must honour it; the events + jobs installs run against
 * it; the clean-lite-ps module tree is `paths.modules_dir`; and an app
 * capability pattern under `<backend_src>/patterns/` is found by the derived
 * default `patterns:` glob (the config declares none).
 */
export const VALID_LAYOUTS = ['default', 'custom'] as const;
export type Layout = (typeof VALID_LAYOUTS)[number];

/** Project-relative paths a layout resolves to. */
export interface LayoutPaths {
  backendSrc: string;
  generated: string;
  entities: string;
  /** `paths.modules_dir` — the clean-lite-ps module tree. */
  modules: string;
}

export const LAYOUT_PATHS: Record<Layout, LayoutPaths> = {
  default: { backendSrc: 'src', generated: 'src/generated', entities: 'entities', modules: 'src/modules' },
  custom: {
    backendSrc: 'apps/backend/src',
    generated: 'apps/backend/src/codegen',
    entities: 'definitions/entities',
    modules: 'apps/backend/src/domain',
  },
};

/**
 * The custom layout's app capability pattern (PATH-1, #645): the pattern file
 * sits under `<backend_src>/patterns/` and the config declares no `patterns:`,
 * so only the derived default glob finds it. Its mixin sits in the module tree
 * and is imported through `@modules/*`, which points at `paths.modules_dir`.
 */
export const CUSTOM_LAYOUT_APP_PATTERN = {
  entity: 'ledger',
  plural: 'ledgers',
  mixin: 'WithAudited',
} as const;

function authorAppPattern(tmpDir: string, runtime: RuntimeMode, paths: LayoutPaths): void {
  const baseClasses =
    runtime === 'vendored' ? '@shared/base-classes' : '@pattern-stack/codegen/runtime/base-classes';
  const patternsDir = path.join(tmpDir, paths.backendSrc, 'patterns');
  const mixinDir = path.join(tmpDir, paths.modules, 'capabilities');
  fs.mkdirSync(patternsDir, { recursive: true });
  fs.mkdirSync(mixinDir, { recursive: true });
  fs.writeFileSync(
    path.join(patternsDir, 'audited.pattern.ts'),
    [
      '// App capability pattern — PATH-1 custom-layout smoke fixture.',
      'export const AuditedPattern = {',
      "  name: 'Audited',",
      "  kind: 'capability' as const,",
      `  mixin: '${CUSTOM_LAYOUT_APP_PATTERN.mixin}',`,
      "  mixinImport: '@modules/capabilities/with-audited',",
      "  forwarderMethods: ['auditCount'],",
      "  description: 'Audit counter — PATH-1 smoke fixture',",
      '};',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(mixinDir, 'with-audited.ts'),
    [
      `import type { RepositoryCtor } from '${baseClasses}/capability-mixin';`,
      '',
      `export function ${CUSTOM_LAYOUT_APP_PATTERN.mixin}<TBase extends RepositoryCtor>(Base: TBase) {`,
      '  abstract class AuditedMixin extends Base {',
      '    async auditCount(): Promise<number> {',
      '      return this.count();',
      '    }',
      '  }',
      '  return AuditedMixin as TBase & typeof AuditedMixin;',
      '}',
      '',
    ].join('\n'),
  );
}

const LEDGER_YAML = [
  '# PATH-1 custom-layout smoke fixture: an entity composing the app capability.',
  'entity:',
  `  name: ${CUSTOM_LAYOUT_APP_PATTERN.entity}`,
  `  plural: ${CUSTOM_LAYOUT_APP_PATTERN.plural}`,
  `  table: ${CUSTOM_LAYOUT_APP_PATTERN.plural}`,
  '  patterns: [Base, Audited]',
  '',
  'fields:',
  '  title:',
  '    type: string',
  '    required: true',
  '',
  'behaviors:',
  '  - timestamps',
  '',
].join('\n');

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
  'drizzle-orm@1.0.0-rc.4',
  'reflect-metadata@0.2',
  'pg@8',
  'zod@3',
  'yaml@2',
];
const DEV_DEPS = ['typescript@5', '@types/bun', '@types/pg@8'];

export interface BootstrapOptions {
  scenario: Scenario;
  architecture: Architecture;
  /**
   * ADR-037 runtime mode. Defaults to `vendored`: the junction snapshots lock
   * the `@shared/*` specifiers. The junction smoke also runs a `package` leg
   * (#624) so the default mode's imports stay compiled.
   */
  runtime?: RuntimeMode;
  /** Path layout (PATH-0). Defaults to `default`. */
  layout?: Layout;
  log?: (msg: string) => void;
}

export interface BootstrapResult {
  projectDir: string;
  scenario: Scenario;
  architecture: Architecture;
  /** The project-relative paths the run used. */
  paths: LayoutPaths;
  /** Reads the contents of a file emitted into the tmp project (relative to projectDir). */
  emittedFile(relPath: string): string;
  /** Removes the tmp dir unless KEEP_SMOKE_DIR=1 is set. */
  cleanup(): void;
}

function writeCodegenConfig(
  tmpDir: string,
  architecture: Architecture,
  runtime: RuntimeMode,
  paths: LayoutPaths,
): void {
  const configPath = path.join(tmpDir, 'codegen.config.yaml');
  const content = [
    // ADR-037 runtime mode (init wrote this too, but this overwrite would
    // otherwise drop it).
    `runtime: ${runtime}`,
    'generate:',
    `  architecture: ${architecture}`,
    'paths:',
    `  backend_src: ${paths.backendSrc}`,
    `  entities: ${paths.entities}`,
    `  generated: ${paths.generated}`,
    // Written only when non-default: the default layout's config is unchanged.
    ...(paths.modules === LAYOUT_PATHS.default.modules ? [] : [`  modules_dir: ${paths.modules}`]),
  ].join('\n') + '\n';
  fs.writeFileSync(configPath, content);
}

export async function bootstrapJunctionProject(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { scenario, architecture } = opts;
  const runtime = opts.runtime ?? 'vendored';
  const layout = opts.layout ?? 'default';
  const paths = LAYOUT_PATHS[layout];
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

  // 3. codegen project init — `--runtime <mode>` (ADR-037). Package mode
  //    vendors nothing; alias the package specifiers to the in-repo runtime.
  //    The custom layout writes its config FIRST: init must place every file
  //    it scaffolds from that config's `paths.*` (#566).
  if (layout === 'custom') {
    writeCodegenConfig(tmpDir, architecture, runtime, paths);
    log(`wrote codegen.config.yaml before init (layout: custom — ${JSON.stringify(paths)})`);
  }
  run(`bun ${CLI_PATH} project init --yes --with-tsconfig --runtime ${runtime}`);
  if (runtime === 'package') {
    aliasPackageRuntime(tmpDir);
    log('aliased @pattern-stack/codegen/runtime/* → in-repo runtime sources');
  }

  if (layout === 'default') {
    // override architecture
    writeCodegenConfig(tmpDir, architecture, runtime, paths);
    log(`wrote codegen.config.yaml (architecture: ${architecture}, runtime: ${runtime})`);
  } else {
    // Subsystem installs against the non-default layout (#566): events, and
    // jobs — #566's repro (`worker.ts` + the `main.ts` hook under backend_src).
    run(`bun ${CLI_PATH} subsystem install events`);
    run(`bun ${CLI_PATH} subsystem install jobs`);
    authorAppPattern(tmpDir, runtime, paths);
    log(`authored app pattern Audited under ${paths.backendSrc}/patterns (mixin under ${paths.modules})`);
  }

  // 4. copy entity fixtures
  const entityFixturesDir = path.join(fixturesDir, 'entities');
  const entitiesDir = path.join(tmpDir, paths.entities);
  fs.mkdirSync(entitiesDir, { recursive: true });
  const examplePath = path.join(entitiesDir, 'example.yaml');
  if (fs.existsSync(examplePath)) fs.rmSync(examplePath);
  for (const f of fs.readdirSync(entityFixturesDir)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    fs.copyFileSync(path.join(entityFixturesDir, f), path.join(entitiesDir, f));
    log(`copied entity fixture: ${f}`);
  }
  if (layout === 'custom') {
    fs.writeFileSync(path.join(entitiesDir, `${CUSTOM_LAYOUT_APP_PATTERN.entity}.yaml`), LEDGER_YAML);
    log(`wrote entity fixture: ${CUSTOM_LAYOUT_APP_PATTERN.entity}.yaml (patterns: [Base, Audited])`);
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
    paths,
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
