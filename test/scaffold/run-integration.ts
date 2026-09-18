#!/usr/bin/env bun
/**
 * Integration test orchestrator.
 *
 * Single command that: starts Docker Postgres, runs codegen,
 * pushes schema, runs tests, and tears down.
 *
 * Usage:
 *   bun test/scaffold/run-integration.ts          # full run
 *   bun test/scaffold/run-integration.ts --skip-codegen  # skip codegen + push (already done)
 *   bun test/scaffold/run-integration.ts --no-teardown   # keep Postgres running after tests
 */
import { $ } from 'bun';
import { composeProjectName, scaffoldEnv } from './harness-env';

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SCAFFOLD_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

// Per-checkout identity. Several agents run gates concurrently in sibling
// worktrees; without this the Compose project name is `scaffold` in all of
// them, so `up` joins someone else's container and `down -v` destroys it
// mid-run. `-p` is passed explicitly on every compose call rather than relying
// on the env var, so teardown can only ever touch what this run created.
const COMPOSE_PROJECT = composeProjectName();
const ENV = scaffoldEnv();

// Every child — drizzle-kit, the codegen CLI, the test runner — reads
// DATABASE_URL, and the compose file reads SCAFFOLD_PG_PORT.
Object.assign(process.env, ENV);

const args = new Set(process.argv.slice(2));
const skipCodegen = args.has('--skip-codegen');
const noTeardown = args.has('--no-teardown');

async function run() {
  let exitCode = 0;

  try {
    // 1. Check Docker
    console.log('==> Checking Docker...');
    const dockerCheck = Bun.spawnSync(['docker', 'info', '--format', '{{.ServerVersion}}']);
    if (dockerCheck.exitCode !== 0) {
      console.error('ERROR: Docker is not running. Start Docker and try again.');
      process.exit(1);
    }
    console.log(`    Docker ${new TextDecoder().decode(dockerCheck.stdout).trim()}`);

    // 2. Start Postgres
    console.log('==> Starting Postgres...');
    console.log(`    project ${COMPOSE_PROJECT} · ${ENV.DATABASE_URL}`);
    await $`docker compose -p ${COMPOSE_PROJECT} -f ${SCAFFOLD_DIR}/docker-compose.yml up -d --wait`.quiet();
    console.log('    Postgres ready');

    // 3. Dependencies: the scaffold declares none of its own and resolves
    //    everything from the repo's node_modules (see justfile `install`), so
    //    the app under test and the generated code it loads share one copy of
    //    each package. `just install` is the prerequisite.

    if (!skipCodegen) {
      // 4. Setup codegen config
      console.log('==> Running codegen...');
      const configPath = `${REPO_ROOT}/codegen.config.yaml`;
      const configBackup = `${configPath}.integration-bak`;
      const existingConfig = Bun.file(configPath);
      const hadConfig = await existingConfig.exists();
      if (hadConfig) {
        await Bun.write(configBackup, existingConfig);
      }

      // The scaffold's aliases pin the layout codegen must emit into:
      //   tsconfig.json  @gen/*   -> <repo root>/*
      //   schema.ts               -> @gen/modules/contacts/contact.entity
      // so emit at the repo root (`backend_src: .`) in clean-lite-ps's flat
      // `modules/<plural>/` layout. Writing only `generate.architecture` sent
      // the output to `app/backend/src/…`, where no alias resolves (GATE-1, #599).
      //
      // `runtime: vendored` selects the `@shared/*` import specifiers in the
      // emitted code, which the scaffold's tsconfig maps onto `runtime/` — the
      // real source. Nothing is vendored into the repo; the only output is
      // `modules/` and `generated/`, both removed in the teardown below.
      await Bun.write(
        configPath,
        [
          'runtime: vendored',
          'generate:',
          '  architecture: clean-lite-ps',
          '  frontend: false',
          'paths:',
          '  backend_src: .',
          '  generated: generated',
          '',
        ].join('\n'),
      );

      try {
        // Invoke the CLI entrypoint directly, as every other harness does.
        // `bun codegen …` resolved a package script that does not exist
        // (package.json has `cdp`; `codegen` is a published bin), and the
        // command shape was pre-noun-verb (GATE-1, #599). `--force` is the
        // same flag every other harness passes: the emit target is throwaway
        // output, and without it the CLI's uncommitted-changes guard (which
        // sees this repo's own working tree, since the emit root is the repo
        // root) refuses to write.
        await $`cd ${REPO_ROOT} && bun src/cli/index.ts entity new test/scaffold/contact-scaffold.yaml --force`.quiet();
        console.log('    Codegen complete');

        // 5. Push schema
        console.log('==> Pushing schema...');
        await $`cd ${SCAFFOLD_DIR} && bun run drizzle-kit push --config drizzle.config.ts`.quiet();
        console.log('    Schema pushed');
      } finally {
        // Restore config
        if (hadConfig) {
          const backup = Bun.file(configBackup);
          await Bun.write(configPath, backup);
          await $`rm -f ${configBackup}`.quiet();
        } else {
          await $`rm -f ${configPath}`.quiet();
        }
      }
    } else {
      console.log('==> Skipping codegen (--skip-codegen)');
    }

    // 6. Run tests
    console.log('==> Running integration tests...');
    const testResult = Bun.spawnSync(
      ['bun', 'test', 'test/scaffold/tests/'],
      {
        cwd: REPO_ROOT,
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env, ...ENV, SCAFFOLD_INTEGRATION: '1' },
      },
    );
    exitCode = testResult.exitCode;

    if (exitCode === 0) {
      console.log('\n==> All integration tests passed');
    } else {
      console.error('\n==> Some tests failed');
    }
  } finally {
    // 7. Teardown
    if (noTeardown) {
      console.log('==> Skipping teardown (--no-teardown)');
    } else {
      console.log('==> Tearing down Postgres...');
      await $`docker compose -p ${COMPOSE_PROJECT} -f ${SCAFFOLD_DIR}/docker-compose.yml down -v`.quiet();

      // Remove the generated consumer from the repo root. This harness is the
      // only thing that writes there, and leaving it behind poisons OTHER
      // gates: `tsconfig.build.json` includes `src/**/*`, so any stray emission
      // under `src/` turns `bun run typecheck` — and therefore `just test-all`
      // — red for everyone afterwards. `.gitignore` hides such output from git
      // but not from tsc, so cleaning up is the actual fix (GATE-1, #599).
      // `--skip-codegen` keeps the tree: that mode exists to iterate on an
      // already-generated scaffold.
      if (!skipCodegen) {
        console.log('==> Removing generated scaffold from the repo root...');
        for (const dir of ['modules', 'generated', 'shared']) {
          await $`rm -rf ${REPO_ROOT}/${dir}`.quiet();
        }
      }
    }
  }

  process.exit(exitCode);
}

run();
