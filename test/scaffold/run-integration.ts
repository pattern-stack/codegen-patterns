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

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SCAFFOLD_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

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
    await $`docker compose -f ${SCAFFOLD_DIR}/docker-compose.yml up -d --wait`.quiet();
    console.log('    Postgres ready');

    // 3. Install scaffold deps
    console.log('==> Installing scaffold dependencies...');
    await $`cd ${SCAFFOLD_DIR} && bun install`.quiet();

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

      await Bun.write(
        configPath,
        'generate:\n  architecture: clean-lite-ps\n  frontend: false\n',
      );

      try {
        await $`cd ${REPO_ROOT} && bun codegen entity test/scaffold/contact-scaffold.yaml`.quiet();
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
      { cwd: REPO_ROOT, stdio: ['inherit', 'inherit', 'inherit'] },
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
      await $`docker compose -f ${SCAFFOLD_DIR}/docker-compose.yml down -v`.quiet();
    }
  }

  process.exit(exitCode);
}

run();
