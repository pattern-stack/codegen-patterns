#!/usr/bin/env bun
/**
 * Capability-composition smoke (ADR-041 / CAP-1) — the regression guard the ADR
 * asks for by name: "a 3-capability smoke fixture that tsc-compiles against the
 * published bases … must land with the implementation".
 *
 * WHY THIS EXISTS
 * ---------------
 * ADR-041's decision rests on a hermetic `tsc` spike that *modelled* the
 * repository bases — it never imported the real, drizzle-bearing classes. The
 * baseline snapshots are clean-arch-only and consume no patterns, and no other
 * smoke declares one. So without this harness, nothing anywhere compiles a
 * composed entity, and the emission would be gated by string assertions alone.
 *
 * WHAT IT DOES, per leg
 * ---------------------
 *   1. Fresh tmp project: `bun init` + the pinned peer deps.
 *   2. `codegen project init --runtime <vendored|package>`.
 *   3. Author a realistic consumer capability surface — three `kind:'capability'`
 *      app patterns under the default `src/patterns/*.pattern.ts` glob, and
 *      their mixins under `src/modules/capabilities/` (addressed as
 *      `@modules/…`, a `project init` alias; deliberately NOT `@shared/…`,
 *      which is reserved for the package runtime and gets rewritten in package
 *      mode).
 *   4. `codegen entity new --all --force` over the CAP-1 fixtures, then
 *      `junction new --all` and `relationship new --all`.
 *   5. Assert the three emission shapes ADR-041 §6 specifies, and (NAME-0 /
 *      NAME-1) that every edge onto an irregular-`plural:` entity (`person`)
 *      and a `context:`-nested one (`crew`) — belongs_to, has_many, junction
 *      endpoint, relationship endpoint — addresses it by its own YAML's
 *      naming; that `person`, which both belongs_to and has_many `crew`,
 *      composes one `CrewRepository` (#632); and that the `crew` ↔ `person`
 *      FK cycle compiles (#631).
 *   6. `tsc --noEmit` — FAIL on any diagnostic located in the generated project.
 *   7. Two NEGATIVE gates through the CLI: two spine bases, and a capability
 *      method colliding with a `queries:` method. Both must exit non-zero.
 *
 * SCOPE OF THE FAILURE CHECK
 * --------------------------
 * Diagnostics are scoped by the shared `test/smoke/_consumer-errors.ts` — by
 * LOCATION only, never by message and never by directory (charter I9 / GATE-2).
 *
 * THE TWO LEGS
 * ------------
 * `vendored` compiles the generated tree against the runtime vendored into
 * `src/shared/**`. `package` compiles it against the in-repo `runtime/`
 * sources, aliased through tsconfig `paths` — the package is not `bun add`-ed in
 * checkout mode, and this is the same technique `test/smoke-integration/run.ts`
 * uses. Both matter: the mixin chain is assembled from base classes whose import
 * specifier differs per mode, and `mixinImport` is rewritten per mode too.
 *
 * Set KEEP_SMOKE_DIR=1 to preserve the tmp projects.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumerErrors as scopeToConsumer } from './_consumer-errors';
import { aliasPackageRuntime } from './_package-runtime';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const FIXTURES = path.join(REPO_ROOT, 'test', 'smoke', 'fixtures', 'capability');
const CONSUMER_SRC = path.join(FIXTURES, 'consumer');

const KEEP = process.env.KEEP_SMOKE_DIR === '1';

/** Same pins as `run-smoke.ts` — one drizzle identity across every harness. */
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
];
const DEV_DEPS = ['typescript@5', '@types/bun', '@types/pg@8'];

type Mode = 'vendored' | 'package';

// ---------------------------------------------------------------------------
// Logging / helpers
// ---------------------------------------------------------------------------

const t0 = Date.now();
function log(msg: string): void {
	console.log(`[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);
}
function logError(msg: string): void {
	console.error(`[FAIL] ${msg}`);
}

function run(cmd: string, cwd: string): void {
	log(`$ ${cmd}`);
	execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env } });
}

/** Run a command that is EXPECTED to fail; returns its exit code + output. */
function runExpectingFailure(
	args: string[],
	cwd: string,
): { code: number; output: string } {
	const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf-8' });
	return { code: r.status ?? 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function cleanup(dir: string): void {
	if (KEEP) {
		log(`keeping tmp dir (KEEP_SMOKE_DIR=1): ${dir}`);
		return;
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

function escapeRe(s: string): string {
	return s.replace(/[/@.-]/g, '\\$&');
}

function assertContains(haystack: string, needle: RegExp, source: string): void {
	if (!needle.test(haystack)) {
		throw new Error(
			`Capability smoke assertion failed (${source}): expected ${needle} in:\n${haystack}`,
		);
	}
}

function assertNotContains(haystack: string, needle: RegExp, source: string): void {
	if (needle.test(haystack)) {
		throw new Error(
			`Capability smoke assertion failed (${source}): did NOT expect ${needle} in:\n${haystack}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Consumer capability surface
// ---------------------------------------------------------------------------

/**
 * Copy the checked-in consumer fixtures into the tmp project, substituting the
 * base-classes import prefix for the leg under test. The mixins are the only
 * files whose text differs between legs — everything else, including the
 * pattern definitions and their `@modules/…` mixinImports, is mode-agnostic.
 */
function authorCapabilitySurface(tmpDir: string, mode: Mode): void {
	const prefix =
		mode === 'vendored'
			? '@shared/base-classes'
			: '@pattern-stack/codegen/runtime/base-classes';

	const mixinDir = path.join(tmpDir, 'src', 'modules', 'capabilities');
	fs.mkdirSync(mixinDir, { recursive: true });
	for (const file of fs.readdirSync(path.join(CONSUMER_SRC, 'capabilities'))) {
		const src = fs.readFileSync(path.join(CONSUMER_SRC, 'capabilities', file), 'utf8');
		fs.writeFileSync(
			path.join(mixinDir, file),
			src.replaceAll('__RUNTIME_BASE_CLASSES__', prefix),
		);
	}

	const patternDir = path.join(tmpDir, 'src', 'patterns');
	fs.mkdirSync(patternDir, { recursive: true });
	for (const file of fs.readdirSync(path.join(CONSUMER_SRC, 'patterns'))) {
		fs.copyFileSync(
			path.join(CONSUMER_SRC, 'patterns', file),
			path.join(patternDir, file),
		);
	}
	// Type-level checks against the GENERATED code (CAP-3): compiled by the tsc
	// leg, never run. They sit outside `src/modules/` so the barrel generator
	// never sees them.
	const checksDir = path.join(tmpDir, 'src', 'capability-checks');
	fs.mkdirSync(checksDir, { recursive: true });
	for (const file of fs.readdirSync(path.join(CONSUMER_SRC, 'checks'))) {
		fs.copyFileSync(path.join(CONSUMER_SRC, 'checks', file), path.join(checksDir, file));
	}

	log(`authored capability surface (${mode}: ${prefix}/capability-mixin)`);
}

// ---------------------------------------------------------------------------
// Emission assertions — ADR-041 §6's three shapes
// ---------------------------------------------------------------------------

function assertEmission(tmpDir: string, mode: Mode): void {
	const reads = (rel: string): string =>
		fs.readFileSync(path.join(tmpDir, 'src', rel), 'utf8');
	const baseClasses =
		mode === 'vendored'
			? '@shared/base-classes'
			: '@pattern-stack/codegen/runtime/base-classes';

	// ── account: FOUR capabilities → a generated composed base ───────────────
	const composedBasePath = path.join(
		tmpDir,
		'src/modules/accounts/account.composed-base.ts',
	);
	if (!fs.existsSync(composedBasePath)) {
		throw new Error(
			`expected a composed base at ${composedBasePath} — four capabilities stack on the account fixture (ADR-041 §6)`,
		);
	}
	const composedBase = fs.readFileSync(composedBasePath, 'utf8');
	// Declaration order is `[Group, Integrated, Individual, Audited, Actor]`, so
	// the capability nesting is Group innermost → Actor outermost.
	assertContains(
		composedBase,
		/export abstract class AccountComposedBase extends WithActor\(\n  WithAudited\(\n    WithIndividual\(\n      WithGroup\(\n        IntegratedEntityRepository<\n          Account,\n          typeof accounts,\n          AccountIntegrationWrite,\n          AccountIntegrationProjection\n        >,\n      \),\n    \),\n  \),\n\) \{\}/,
		'account.composed-base.ts mixin chain, rightmost capability outermost',
	);
	assertContains(
		composedBase,
		new RegExp(
			`import \\{ IntegratedEntityRepository \\} from '${baseClasses.replace(/[/@-]/g, '\\$&')}/integrated-entity-repository';`,
		),
		`account.composed-base.ts spine import (${mode} mode)`,
	);
	assertContains(
		composedBase,
		/import \{ WithGroup \} from '@modules\/capabilities\/with-group';/,
		'account.composed-base.ts capability import is the app alias, unrewritten',
	);
	// …while the LIBRARY capability's `@shared/…` mixinImport is rewritten per
	// runtime mode, exactly like a spine base (CAP-3).
	assertContains(
		composedBase,
		new RegExp(`import \\{ WithActor \\} from '${escapeRe(baseClasses)}/with-actor';`),
		`account.composed-base.ts library Actor mixin import (${mode} mode)`,
	);
	// The integration interfaces live in the repository module; the cycle back
	// is type-only, and therefore erased.
	assertContains(
		composedBase,
		/import type \{\s*AccountIntegrationWrite,\s*AccountIntegrationProjection,\s*\} from '\.\/account\.repository';/,
		'account.composed-base.ts type-only import cycle',
	);

	const accountRepo = reads('modules/accounts/account.repository.ts');
	assertContains(
		accountRepo,
		/export class AccountRepository extends AccountComposedBase \{/,
		'account.repository.ts extends the composed base',
	);
	assertContains(
		accountRepo,
		/import \{ AccountComposedBase \} from '\.\/account\.composed-base';/,
		'account.repository.ts composed-base import',
	);
	// ADR-041 §6 config hand-off: the concrete repository fills the property the
	// mixin declares.
	assertContains(
		accountRepo,
		/^  override readonly groupConfig = \{\s*membersColumn: 'status',\s*\} as const;/m,
		'account.repository.ts groupConfig literal',
	);
	// CAP-3: the library `Actor` config is RESOLVED — `members: contacts` (a
	// has_many) becomes the live `contacts` table + its FK key.
	assertContains(
		accountRepo,
		/^  override readonly actorConfig = \{\s*kind: 'group',\s*members: \{\s*table: contacts,\s*foreignKey: 'accountId',\s*\},\s*\} as const;/m,
		'account.repository.ts actorConfig (group, resolved members)',
	);
	assertContains(
		accountRepo,
		/import \{ contacts \} from '\.\.\/contacts\/contact\.entity';/,
		'account.repository.ts imports the member table',
	);
	// The spine is `Integrated` even though it is second in `patterns:` — the
	// integration write surface is the observable proof.
	assertContains(
		accountRepo,
		/export interface AccountIntegrationWrite \{/,
		'account.repository.ts Integrated spine selected out of position 0',
	);

	const accountService = reads('modules/accounts/account.service.ts');
	for (const method of ['members', 'principal', 'auditCount']) {
		assertContains(
			accountService,
			new RegExp(
				`${method}\\(\\s*\\.\\.\\.args: Parameters<AccountRepository\\['${method}'\\]>\\s*\\): ReturnType<AccountRepository\\['${method}'\\]> \\{`,
			),
			`account.service.ts forwarder for '${method}'`,
		);
	}
	assertNotContains(
		accountService,
		/async members\(/,
		'account.service.ts forwarders are not async (a capability method may be sync)',
	);
	// `memberPredicate` returns a Drizzle SQL fragment — repository vocabulary,
	// never forwarded to the service.
	assertNotContains(accountService, /memberPredicate/, 'account.service.ts has no memberPredicate');

	// ── contact: ONE capability → inline extends, no composed-base file ──────
	if (fs.existsSync(path.join(tmpDir, 'src/modules/contacts/contact.composed-base.ts'))) {
		throw new Error(
			'contact declares ONE capability — it must be wrapped inline, with no composed-base file (ADR-041 §6)',
		);
	}
	const contactRepo = reads('modules/contacts/contact.repository.ts');
	assertContains(
		contactRepo,
		/export class ContactRepository extends WithActor\(BaseRepository<Contact, typeof contacts>\) \{/,
		'contact.repository.ts inline capability wrap over the default Base spine',
	);
	assertContains(
		contactRepo,
		new RegExp(`import \\{ WithActor \\} from '${escapeRe(baseClasses)}/with-actor';`),
		`contact.repository.ts library mixin import (${mode} mode)`,
	);
	assertContains(
		contactRepo,
		/^  override readonly actorConfig = \{\s*kind: 'individual',\s*\} as const;/m,
		'contact.repository.ts actorConfig (individual)',
	);

	// ── meeting: CAP-2 roles on an Activity spine ────────────────────────────
	// `one` roles derive FK columns through the existing belongs_to path —
	// `.references()` with the on-delete action, and an index by default.
	const meetingEntity = reads('modules/meetings/meeting.entity.ts');
	assertContains(
		meetingEntity,
		/hostContactId: uuid\('host_contact_id'\)\.references\(\(\): AnyPgColumn => contacts\.id, \{ onDelete: 'restrict' \}\),/,
		'meeting.entity.ts host role FK column (explicit column:)',
	);
	assertContains(
		meetingEntity,
		/aboutAccountId: uuid\('about_account_id'\)\.references\(\(\): AnyPgColumn => accounts\.id, \{ onDelete: 'restrict' \}\),/,
		'meeting.entity.ts about role FK column (<role>_<target>_id default)',
	);
	assertContains(
		meetingEntity,
		/index\('meetings_host_contact_id_idx'\)\.on\(t\.hostContactId\)/,
		'meeting.entity.ts host role FK is indexed by default',
	);
	assertContains(
		meetingEntity,
		/index\('meetings_about_account_id_idx'\)\.on\(t\.aboutAccountId\)/,
		'meeting.entity.ts about role FK is indexed by default',
	);
	// A `many` role names its junction; it contributes no column here.
	assertNotContains(
		meetingEntity,
		/attendees/i,
		'meeting.entity.ts has no column for the many-role',
	);
	// The relation key is the ROLE name, so two roles to one target stay two
	// methods — `host`, not `contact`.
	const meetingService = reads('modules/meetings/meeting.service.ts');
	assertContains(
		meetingService,
		/async host\(meetingId: string\): Promise<Contact \| null>/,
		'meeting.service.ts host(meetingId) — keyed by role',
	);
	assertContains(
		meetingService,
		/async about\(meetingId: string\): Promise<Account \| null>/,
		'meeting.service.ts about(meetingId) — keyed by role',
	);
	// The spine is Activity; Communication layers inline.
	const meetingRepo = reads('modules/meetings/meeting.repository.ts');
	assertContains(
		meetingRepo,
		/export class MeetingRepository extends WithCommunication\(ActivityEntityRepository<Meeting, typeof meetings>\) \{/,
		'meeting.repository.ts Activity spine + Communication capability',
	);
	assertContains(
		meetingRepo,
		new RegExp(`import \\{ WithCommunication \\} from '${escapeRe(baseClasses)}/with-communication';`),
		`meeting.repository.ts library Communication mixin import (${mode} mode)`,
	);
	// CAP-3: `communicationConfig` is generated from `roles:` — one-roles carry
	// the FK CAP-2 derived, the many-role the live junction table.
	assertContains(
		meetingRepo,
		/^  override readonly communicationConfig = \{\s*roles: \{\s*host: \{\s*cardinality: 'one',\s*target: 'contact',\s*column: 'hostContactId',\s*\},\s*attendees: \{\s*cardinality: 'many',\s*target: 'contact',\s*via: \{\s*table: meetingContacts,\s*self: 'meetingId',\s*target: 'contactId',\s*\},\s*\},\s*about: \{\s*cardinality: 'one',\s*target: 'account',\s*column: 'aboutAccountId',\s*\},\s*\},\s*\} as const;/m,
		'meeting.repository.ts communicationConfig from roles:',
	);
	assertContains(
		meetingRepo,
		/import \{ meetingContacts \} from '\.\.\/meeting_contacts\/meeting_contact\.entity';/,
		'meeting.repository.ts imports the junction table',
	);
	for (const method of ['findByRole', 'participants']) {
		assertContains(
			meetingService,
			new RegExp(
				`${method}\\(\\s*\\.\\.\\.args: Parameters<MeetingRepository\\['${method}'\\]>\\s*\\): ReturnType<MeetingRepository\\['${method}'\\]> \\{`,
			),
			`meeting.service.ts forwarder for '${method}'`,
		);
	}

	// ── note: NO pattern → unchanged emission ────────────────────────────────
	const noteRepo = reads('modules/notes/note.repository.ts');
	assertContains(
		noteRepo,
		/export class NoteRepository extends BaseRepository<Note, typeof notes> \{/,
		'note.repository.ts is byte-identical to the pre-CAP-1 shape',
	);
	assertNotContains(noteRepo, /ComposedBase|With[A-Z]/, 'note.repository.ts has no capability trace');
	const noteService = reads('modules/notes/note.service.ts');
	assertNotContains(
		noteService,
		/Capability forwarders/,
		'note.service.ts has no forwarder block',
	);
}

// ---------------------------------------------------------------------------
// `project inspect` resolves app capabilities (CAP-2 review item 1)
// ---------------------------------------------------------------------------

/**
 * The analyzer's roles validator resolves `Actor` / `Communication` by name in
 * the pattern registry. Those are APP patterns in this fixture, so any CLI path
 * that runs the analyzer without first loading app patterns reports a spurious
 * `role_target_not_actor` (and `pattern_unknown`). `entity new` / `entity
 * validate` load them; this pins `project inspect` to doing the same.
 */
function assertProjectInspectSeesAppCapabilities(tmpDir: string, mode: Mode): void {
	const out = path.join(tmpDir, 'inspect.json');
	const r = spawnSync(
		'bun',
		[CLI_PATH, 'project', 'inspect', '--kind', 'analyze', '--format', 'json', '--output', out],
		{ cwd: tmpDir, encoding: 'utf-8' },
	);
	if (!fs.existsSync(out)) {
		throw new Error(`project inspect wrote no report (exit ${r.status}):\n${r.stdout}${r.stderr}`);
	}
	const report = JSON.parse(fs.readFileSync(out, 'utf-8')) as {
		issues: Array<{ severity: string; type: string; entity?: string; message: string }>;
	};
	fs.rmSync(out);
	const errors = report.issues.filter((i) => i.severity === 'error');
	if (errors.length > 0 || r.status !== 0) {
		throw new Error(
			`[${mode}] project inspect over the capability fixture must report zero errors (exit ${r.status}):\n` +
				errors.map((e) => `  ${e.type} ${e.entity ?? ''}: ${e.message}`).join('\n'),
		);
	}
	log(`[${mode}] project inspect OK — app capabilities resolved, zero errors`);
}

// ---------------------------------------------------------------------------
// NAME-0 — cross-entity names come from the target's own YAML (#630 / #611)
// ---------------------------------------------------------------------------

/**
 * `person` declares `plural: persons` (`pluralize` says `people`); `crew`
 * declares `context: org` (folder `modules/org/crews/`). Every edge onto them —
 * belongs_to, has_many, and the `crew_person` junction's endpoints and parent
 * injects — must use that naming. `tsc` proves the imports resolve; these pin
 * the exact paths, so a regression names the edge that broke.
 */
function assertTargetNaming(tmpDir: string): void {
	const reads = (rel: string): string =>
		fs.readFileSync(path.join(tmpDir, 'src/modules', rel), 'utf8');
	const expectImport = (file: string, line: string): void =>
		assertContains(reads(file), new RegExp(`^${escapeRe(line)}$`, 'm'), file);

	// belongs_to — irregular plural (from inside a context) and nested target
	expectImport('org/crews/crew.entity.ts', "import { persons } from '../../persons/person.entity';");
	assertContains(reads('org/crews/crew.entity.ts'), /\.references\(\(\): AnyPgColumn => persons\.id/, 'crew.entity.ts FK table');
	expectImport('shifts/shift.entity.ts', "import { crews } from '../org/crews/crew.entity';");
	// has_many — irregular plural and nested target
	expectImport('squads/squad.service.ts', "import { PersonRepository } from '../persons/person.repository';");
	expectImport('persons/person.service.ts', "import { CrewRepository } from '../org/crews/crew.repository';");
	// junction — both endpoints, both directions, and the parent injects
	expectImport('crew_people/crew_person.entity.ts', "import { crews } from '../org/crews/crew.entity';");
	expectImport('crew_people/crew_person.entity.ts', "import { persons } from '../persons/person.entity';");
	expectImport('crew_people/crew_people.module.ts', "import { PersonsModule } from '../persons/persons.module';");
	expectImport('org/crews/crews.module.ts', "import { CrewPeopleModule } from '../../crew_people/crew_people.module';");
	expectImport('persons/persons.module.ts', "import { CrewPeopleModule } from '../crew_people/crew_people.module';");
	// The counterparty import and crew's own belongs_to import are one line —
	// the inject's skip_if only dedupes them when both use the same path.
	const crewService = reads('org/crews/crew.service.ts');
	const personTypeImports = crewService.match(/^import type \{ Person \} from '\.\.\/\.\.\/persons\/person\.entity';$/gm) ?? [];
	if (personTypeImports.length !== 1) {
		throw new Error(`crew.service.ts: expected one Person type import, found ${personTypeImports.length}`);
	}

	// relationship (NAME-1, #633) — both endpoints from their own YAML
	expectImport('crew_assignments/crew_assignment.entity.ts', "import { persons } from '../persons/person.entity';");
	expectImport('crew_assignments/crew_assignment.entity.ts', "import { crews } from '../org/crews/crew.entity';");

	// #632 — `person` belongs_to AND has_many `crew`: one repository, once.
	const countLines = (file: string, line: string): number =>
		(reads(file).match(new RegExp(`^${escapeRe(line)}$`, 'gm')) ?? []).length;
	for (const [file, line] of [
		['persons/person.service.ts', "import { CrewRepository } from '../org/crews/crew.repository';"],
		['persons/person.service.ts', '    private readonly crewRepo: CrewRepository,'],
		['persons/persons.module.ts', "import { CrewRepository } from '../org/crews/crew.repository';"],
		['persons/persons.module.ts', '    CrewRepository,'],
	] as const) {
		const n = countLines(file, line);
		if (n !== 1) throw new Error(`${file}: expected exactly one \`${line.trim()}\` (#632), found ${n}`);
	}

	// #631 — `crew.lead` ↔ `person.crew` is an FK cycle; every FK callback is annotated.
	assertContains(reads('persons/person.entity.ts'), /\.references\(\(\): AnyPgColumn => crews\.id/, 'person.entity.ts FK table');

	for (const file of [
		'org/crews/crew.entity.ts',
		'org/crews/crew.service.ts',
		'squads/squad.service.ts',
		'crew_people/crew_person.entity.ts',
		'crew_people/crew_person.service.ts',
		'crew_assignments/crew_assignment.entity.ts',
	]) {
		assertNotContains(reads(file), /\bpeople\/person\b|'\.\.\/crews\//, `${file} (re-derived target path)`);
	}
}

// ---------------------------------------------------------------------------
// Negative gates — ADR-041 §2 and §4 must FAIL generation, not warn
// ---------------------------------------------------------------------------

function assertNegativeGates(tmpDir: string): void {
	const cases: Array<{ fixture: string; expect: RegExp; label: string }> = [
		{
			fixture: 'two-spines.yaml',
			expect: /inheritable spine bases \(Integrated, Activity\)/,
			label: 'two spine bases (ADR-041 §2)',
		},
		{
			fixture: 'role-target-not-actor.yaml',
			expect: /Role 'about' targets 'note', which does not declare the 'Actor' capability/,
			label: 'role targeting a non-Actor entity (CAP-2)',
		},
		{
			fixture: 'roles-without-communication.yaml',
			expect: /declares 'roles:' but not the 'Communication' capability/,
			label: 'roles: without the Communication capability (CAP-2)',
		},
		{
			fixture: 'method-collision.yaml',
			expect: /Method 'findByEmail' is contributed by capability 'Colliding' and the entity's `queries:` block/,
			label: 'capability × queries: method collision (ADR-041 §4)',
		},
	];

	for (const c of cases) {
		const dest = path.join(tmpDir, 'entities', c.fixture);
		fs.copyFileSync(path.join(FIXTURES, 'negative', c.fixture), dest);
		const res = runExpectingFailure(
			['bun', CLI_PATH, 'entity', 'new', path.join('entities', c.fixture), '--force'],
			tmpDir,
		);
		fs.rmSync(dest);
		if (res.code === 0) {
			throw new Error(
				`negative gate '${c.label}' did NOT fail generation — exit 0.\n${res.output}`,
			);
		}
		if (!c.expect.test(res.output)) {
			throw new Error(
				`negative gate '${c.label}' failed for the wrong reason — expected ${c.expect} in:\n${res.output}`,
			);
		}
		log(`negative gate OK — ${c.label} (exit ${res.code})`);
	}
}

// ---------------------------------------------------------------------------
// ADR-041.1 — an app pattern cannot reuse a library pattern's name
// ---------------------------------------------------------------------------

/**
 * Before CAP-3 an app `Actor` silently shadowed the library one (the lookup is
 * app-first). It is now a load error, reported by the CLI — which also proves
 * the CLI registers the library patterns BEFORE loading the app's.
 */
function assertLibraryNameIsNotShadowed(tmpDir: string): void {
	const file = path.join(tmpDir, 'src', 'patterns', 'shadow.pattern.ts');
	fs.writeFileSync(
		file,
		[
			'export const ShadowActorPattern = {',
			"\tname: 'Actor',",
			"\tkind: 'capability' as const,",
			"\tmixin: 'WithShadow',",
			"\tmixinImport: '@modules/capabilities/with-shadow',",
			'};',
			'',
		].join('\n'),
	);
	const res = runExpectingFailure(
		['bun', CLI_PATH, 'entity', 'new', path.join('entities', 'note.yaml'), '--force'],
		tmpDir,
	);
	fs.rmSync(file);
	if (!/Pattern 'Actor' in src\/patterns\/shadow\.pattern\.ts reuses the name of a library pattern/.test(res.output)) {
		throw new Error(
			`an app pattern named 'Actor' must be refused as a library-name reuse (ADR-041.1):\n${res.output}`,
		);
	}
	log('library-name reuse refused — the app pattern was not registered');
}

// ---------------------------------------------------------------------------
// One leg
// ---------------------------------------------------------------------------

async function leg(mode: Mode): Promise<number> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegen-smoke-cap-${mode}-`));
	log(`[${mode}] tmp dir: ${tmpDir}`);
	let exitCode = 0;

	try {
		run('bun init -y', tmpDir);
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);
		run(`bun ${CLI_PATH} project init --yes --with-tsconfig --runtime ${mode}`, tmpDir);
		if (mode === 'package') {
			aliasPackageRuntime(tmpDir);
			log('aliased @pattern-stack/codegen/runtime/* → in-repo runtime sources');
		}

		authorCapabilitySurface(tmpDir, mode);

		const entitiesDir = path.join(tmpDir, 'entities');
		fs.mkdirSync(entitiesDir, { recursive: true });
		const examplePath = path.join(entitiesDir, 'example.yaml');
		if (fs.existsSync(examplePath)) fs.rmSync(examplePath);
		for (const f of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.yaml'))) {
			fs.copyFileSync(path.join(FIXTURES, f), path.join(entitiesDir, f));
		}

		// CAP-2: the `attendees` many-role names the `meeting_contact` junction.
		// The junction YAML is AUTHORED before generation — `entity new`'s roles
		// pre-flight resolves `via:` against `junctions/` — and generated by its
		// own command afterwards. The role validates against the file; it never
		// emits the junction.
		const junctionsDir = path.join(tmpDir, 'junctions');
		fs.mkdirSync(junctionsDir, { recursive: true });
		for (const f of fs.readdirSync(path.join(FIXTURES, 'junctions'))) {
			fs.copyFileSync(path.join(FIXTURES, 'junctions', f), path.join(junctionsDir, f));
		}

		// NAME-1 (#633): a first-class relationship over the irregular-plural
		// `person` and the `context:`-nested `crew`.
		const relationshipsDir = path.join(tmpDir, 'relationships');
		fs.mkdirSync(relationshipsDir, { recursive: true });
		for (const f of fs.readdirSync(path.join(FIXTURES, 'relationships'))) {
			fs.copyFileSync(path.join(FIXTURES, 'relationships', f), path.join(relationshipsDir, f));
		}

		run(`bun ${CLI_PATH} entity new --all --force`, tmpDir);
		run(`bun ${CLI_PATH} junction new --all --force`, tmpDir);
		run(`bun ${CLI_PATH} relationship new --all --force`, tmpDir);

		assertProjectInspectSeesAppCapabilities(tmpDir, mode);

		log(`[${mode}] asserting ADR-041 emission shapes`);
		assertEmission(tmpDir, mode);
		assertTargetNaming(tmpDir);
		log(`[${mode}] emission OK`);

		log(`[${mode}] running bunx tsc --noEmit --skipLibCheck`);
		const tsc = spawnSync('bunx', ['tsc', '--noEmit', '--skipLibCheck'], {
			cwd: tmpDir,
			encoding: 'utf-8',
		});
		const scoped = scopeToConsumer(`${tsc.stdout ?? ''}${tsc.stderr ?? ''}`, tmpDir);
		// Both legs, zero expectations: the junction and the relationship resolve
		// their package-owned runtime imports by mode (#624).
		const errors = scoped;
		if (errors.length > 0) {
			for (const line of errors) console.error(line);
			logError(`[${mode}] ${errors.length} typecheck errors in consumer-emitted code`);
			exitCode = 1;
		} else {
			log(`[${mode}] tsc OK — the composed tree compiles against the real bases`);
		}

		if (exitCode === 0) {
			log(`[${mode}] asserting negative gates`);
			assertNegativeGates(tmpDir);
			assertLibraryNameIsNotShadowed(tmpDir);
		}
	} catch (err: unknown) {
		logError(err instanceof Error ? err.message : String(err));
		exitCode = 1;
	} finally {
		cleanup(tmpDir);
	}

	log(`[${mode}] capability smoke ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
	return exitCode;
}

async function main(): Promise<number> {
	const vendored = await leg('vendored');
	const pkg = await leg('package');
	const code = vendored === 0 && pkg === 0 ? 0 : 1;
	log(code === 0 ? 'capability smoke PASS (both runtime modes)' : 'capability smoke FAIL');
	return code;
}

main().then((code) => process.exit(code));
