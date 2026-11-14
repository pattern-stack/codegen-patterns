/**
 * F7 pre-flight (api-surface-plan, REVISION-1 §3) — does a `has_many` onto a
 * target whose FK is NOT a `belongs_to` generate code that compiles?
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

const ACCOUNT = `entity:
  name: account
  plural: accounts

fields:
  name:
    type: string
    required: true

behaviors:
  - timestamps

relationships:
  contacts:
    type: has_many
    target: contact
    foreign_key: account_id
`;

const contact = (tail: string) => `entity:
  name: contact
  plural: contacts

fields:
  account_id:
    type: uuid
    required: true
    index: true
    foreign_key: accounts.id

  email:
    type: string
    required: true

behaviors:
  - timestamps
${tail}`;

const VARIANTS: Array<{ id: string; what: string; contact: string }> = [
	{
		id: 'V0',
		what: 'control — contact declares belongs_to account (FK finder emitted)',
		contact: contact(`
relationships:
  account:
    type: belongs_to
    target: account
    foreign_key: account_id
`),
	},
	{
		id: 'V1',
		what: 'F7 — account_id is a plain field; contact declares no belongs_to and no query',
		contact: contact(''),
	},
	{
		id: 'V2',
		what: 'plain field + a plain `queries: by [account_id]` finder (no belongs_to)',
		contact: contact(`
queries:
  - by: [account_id]
`),
	},
	{
		id: 'V3',
		what: 'belongs_to + a UNIQUE `queries: by [account_id]` (the declarative finder wins the name)',
		contact: contact(`
relationships:
  account:
    type: belongs_to
    target: account
    foreign_key: account_id

queries:
  - by: [account_id]
    unique: true
`),
	},
];

const report: string[] = [];
for (const v of VARIANTS) {
	console.log(`\n================ ${v.id}: ${v.what}`);
	fs.writeFileSync(path.join(entitiesDir, 'account.yaml'), ACCOUNT);
	fs.writeFileSync(path.join(entitiesDir, 'contact.yaml'), v.contact);
	// A clean module tree per variant, so nothing from the previous one survives.
	fs.rmSync(path.join(proj, 'src', 'modules'), { recursive: true, force: true });

	const validate = capture(`${CLI} entity validate --json`);
	const gen = capture(`${CLI} entity new --all --force`);
	const tsc = capture('bunx tsc --noEmit --skipLibCheck');
	const tscErrors = tsc.out
		.split('\n')
		.filter((l) => /error TS\d+/.test(l))
		.filter((l) => !l.includes('node_modules'));

	const svc = path.join(proj, 'src/modules/accounts/account.service.ts');
	const repo = path.join(proj, 'src/modules/contacts/contact.repository.ts');
	const svcCall = fs.existsSync(svc)
		? fs.readFileSync(svc, 'utf8').split('\n').filter((l) => /contactRepo\.|async contacts\(/.test(l))
		: ['<account.service.ts not emitted>'];
	const repoFinders = fs.existsSync(repo)
		? fs.readFileSync(repo, 'utf8').split('\n').filter((l) => /^\s+(async )?findBy[A-Z][A-Za-z]*[<(]/.test(l))
		: ['<contact.repository.ts not emitted>'];

	let valid = 'unparsed';
	try {
		const m = validate.out.match(/\{[\s\S]*\}/);
		if (m) {
			const p = JSON.parse(m[0]);
			valid = `valid=${p.valid} errors=${(p.errors ?? []).length} warnings=${(p.warnings ?? []).length}` +
				((p.errors ?? []).length || (p.warnings ?? []).length
					? `\n      ${[...(p.errors ?? []), ...(p.warnings ?? [])].map((e: { message: string }) => e.message).join('\n      ')}`
					: '');
		}
	} catch {
		valid = validate.out.trim().slice(0, 400);
	}

	report.push(
		`## ${v.id} — ${v.what}`,
		`  entity validate: exit ${validate.code} · ${valid}`,
		`  entity new --all --force: exit ${gen.code}`,
		...(gen.code !== 0 ? [gen.out.trim().split('\n').slice(-12).map((l) => `      ${l}`).join('\n')] : []),
		`  AccountService (the has_many method):`,
		...svcCall.map((l) => `      ${l.trim()}`),
		`  ContactRepository finders emitted:`,
		...(repoFinders.length ? repoFinders.map((l) => `      ${l.trim()}`) : ['      <none>']),
		`  tsc --noEmit --skipLibCheck: exit ${tsc.code} · ${tscErrors.length} error(s) in the project`,
		...tscErrors.map((l) => `      ${l.trim()}`),
		'',
	);
}

const out = report.join('\n');
fs.writeFileSync(path.join(workDir, 'f7-report.txt'), out);
console.log(`\n\n${out}`);
