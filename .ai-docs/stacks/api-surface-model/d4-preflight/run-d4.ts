/**
 * D4 (api-surface S1) — does `eav_value_table: true` on a non-Metadata entity
 * generate code that compiles?
 *
 * Scratch-only: scaffolds a consumer project OUTSIDE the repo with the repo's
 * own CLI (read-only use of the checkout), generates four variants of one
 * account/contact pair, and records `entity validate` + `tsc` for each.
 *
 * Usage: bun run-f7.ts <repoRoot> <workDir>
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [repoRoot, workDir] = process.argv.slice(2);
if (!repoRoot || !workDir) throw new Error('usage: bun run-f7.ts <repoRoot> <workDir>');

const CLI = `bun ${path.join(repoRoot, 'src', 'cli', 'index.ts')}`;
const proj = path.join(workDir, 'proj');
const cache = path.join(workDir, 'hygen-cache');
fs.rmSync(proj, { recursive: true, force: true });
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(cache, { recursive: true });

// A private hygen/bunx cache: sibling agents may be running gates in this checkout.
const env = { ...process.env, CODEGEN_HYGEN_CACHE_DIR: cache, NO_COLOR: '1' };

function run(cmd: string): void {
	console.log(`$ ${cmd}`);
	execSync(cmd, { cwd: proj, stdio: 'inherit', env });
}
function capture(cmd: string): { code: number; out: string } {
	const r = spawnSync('sh', ['-c', cmd], { cwd: proj, env, encoding: 'utf8' });
	return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Same pins as test/smoke/run-smoke.ts (RUNTIME_DEPS / DEV_DEPS).
run('bun init -y');
run(
	'bun add @nestjs/common@10 @nestjs/core@10 @nestjs/platform-express@10 @nestjs/swagger@7 ' +
		'@anatine/zod-openapi@2 drizzle-orm@1.0.0-rc.4 @pattern-stack/query-surface@0.3.1 reflect-metadata@0.2 pg@8 zod@3',
);
run('bun add -D typescript@5 @types/bun @types/pg@8');
run(`${CLI} project init --yes --with-tsconfig --runtime vendored`);

const entitiesDir = path.join(proj, 'entities');
fs.mkdirSync(entitiesDir, { recursive: true });
fs.rmSync(path.join(entitiesDir, 'example.yaml'), { force: true });

const FIELD_DEFINITION = `entity:
  name: field_definition
  plural: field_definitions

fields:
  entity_type:
    type: string
    required: true
  key:
    type: string
    required: true

behaviors:
  - timestamps
`;

const fieldValue = (patternLine: string) => `entity:
  name: field_value
  plural: field_values
${patternLine}
eav_value_table: true
eav_definition_table: field_definition

fields:
  entity_type:
    type: string
    required: true
  entity_id:
    type: uuid
    required: true
  field_definition_id:
    type: uuid
    required: true
  user_id:
    type: uuid
    required: true
  value:
    type: json
    required: true

behaviors:
  - timestamps
`;

const VARIANTS = [
  { id: 'W0', what: 'control — field_value declares pattern: Metadata (the documented shape)', fv: fieldValue('  pattern: Metadata') },
  { id: 'W1', what: 'D4 — field_value declares no pattern (Base)', fv: fieldValue('') },
  { id: 'W2', what: 'D4 — field_value declares pattern: Integrated', fv: fieldValue('  pattern: Integrated') },
];

const report: string[] = [];
for (const v of VARIANTS) {
  console.log(`\n================ ${v.id}: ${v.what}`);
  fs.writeFileSync(path.join(entitiesDir, 'field_definition.yaml'), FIELD_DEFINITION);
  fs.writeFileSync(path.join(entitiesDir, 'field_value.yaml'), v.fv);
  fs.rmSync(path.join(proj, 'src', 'modules'), { recursive: true, force: true });
  const validate = capture(`${CLI} entity validate --json`);
  const gen = capture(`${CLI} entity new --all --force`);
  const tsc = capture('bunx tsc --noEmit --skipLibCheck');
  let valid = '?';
  try { const j = JSON.parse(validate.out.slice(validate.out.indexOf('{'))); valid = `valid=${j.valid} errors=${j.errors?.length} warnings=${j.warnings?.length}`; } catch { valid = validate.out.slice(0, 300); }
  const errs = tsc.out.split('\n').filter((l) => /error TS/.test(l));
  report.push(`${v.id} — ${v.what}\n  entity validate: exit ${validate.code} (${valid})\n  entity new --all: exit ${gen.code}\n  tsc: exit ${tsc.code}, ${errs.length} error(s)\n` + errs.slice(0, 8).map((l) => `    ${l}`).join('\n'));
}
console.log('\n\n######## D4 REPORT\n' + report.join('\n\n'));
fs.writeFileSync(path.join(workDir, 'd4-report.txt'), report.join('\n\n') + '\n');
