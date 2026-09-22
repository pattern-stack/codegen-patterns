#!/usr/bin/env bun
/**
 * `just studio-demo` — build or refresh the Studio demo project.
 *
 *   bun src/studio/demo/cli.ts [targetDir] [--clean] [--no-git] [--no-generate]
 *                              [--database-url <url>]
 *
 * Thin argv wrapper over {@link materializeDemoProject}; the test harness
 * imports that function directly rather than shelling this.
 */

import fs from 'node:fs';
import path from 'node:path';

import { materializeDemoProject } from './materialize.js';

const argv = process.argv.slice(2);
const flags = new Set<string>();
const positional: string[] = [];
let databaseUrl: string | undefined;
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '--database-url') {
		databaseUrl = argv[++i];
	} else if (arg.startsWith('--database-url=')) {
		databaseUrl = arg.slice('--database-url='.length);
	} else if (arg.startsWith('--')) {
		flags.add(arg);
	} else {
		positional.push(arg);
	}
}

const targetDir = path.resolve(positional[0] ?? '.studio-demo');

if (flags.has('--clean') && fs.existsSync(targetDir)) {
	fs.rmSync(targetDir, { recursive: true, force: true });
	console.log(`removed ${targetDir}`);
}

const result = materializeDemoProject({
	targetDir,
	git: !flags.has('--no-git'),
	generate: !flags.has('--no-generate'),
	databaseUrl,
	onLog: (line) => console.log(line),
});

console.log('');
console.log(`Demo project ready: ${result.projectDir}`);
console.log(`  entities:  ${result.entityFiles.length}`);
console.log(`  generated: ${result.generated}`);
console.log(`  git:       ${result.gitInitialized ? 'initialized' : 'already present'}`);
console.log(`  database:  ${result.dbConfigured ? 'drizzle.config.ts + pinned kit' : 'not configured'}`);
console.log('');
console.log(`Next:  just studio ${result.projectDir}`);
