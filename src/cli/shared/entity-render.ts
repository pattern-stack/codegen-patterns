/**
 * The per-target half of `entity new` — its pre-flight and its hygen loop —
 * shared with `junction new`, which re-renders a junction's two parents through
 * exactly this path (JUNC-0, #678): a parent's service + module carry the
 * junction fan-out, rendered by the parent's own templates, so `junction new`
 * regenerates the parents rather than injecting into them. One render path for
 * an entity, whichever command asks for it.
 *
 * `entity new` = `preflightEntityTargets` + `renderEntityTargets` + its
 * whole-set post-steps (barrels, events, bridge, orchestration, frontend,
 * providers, jobs). `junction new` runs no post-step: none reads the junction
 * set, so the per-entity files it writes are exactly `entity new`'s.
 */

import fs from 'node:fs';

import { loadEntityFromYaml, loadEntitiesFromYaml } from '../../utils/yaml-loader.js';
import { junctionsDirFor } from '../../config/junctions-dir.js';
import { junctionSetIssues, loadJunctionSet } from '../../parser/load-junctions.js';
import { validateRolesForGeneration } from '../../roles/validate-roles.js';
import { loadAppPatternsForCli, patternLoadRejections } from './pattern-globs.js';
import type { Context } from './context.js';
import { invokeEntityNew } from './hygen.js';
import { collectMergedEvents } from './event-codegen-generator.js';
import { validateEntityEmits } from '../../parser/validate-emits.js';
import { inheritanceCounterparts, validateInheritance } from '../../parser/validate-inheritance.js';
import { FrontendConfigSchema, TenancyConfigSchema } from '../../schema/codegen-config.schema.js';
import {
	loadProviderSet,
	resolveTsconfigAliases,
	collectEntitySurfaces,
} from './provider-module-generator.js';
import { loadEntities } from '../../parser/load-entities.js';
import { TablesConfigSchema } from '../../schema/codegen-config.schema.js';
import { sqlTableCollisionMessage, sqlTableCollisions } from '../../config/table-naming.js';
import { junctionTableName } from '../../config/junction-naming.js';
import { findYamlFiles } from '../../utils/find-yaml-files.js';
import type { AnalysisIssue } from '../../analyzer/types.js';
import { projectLayout } from './project-layout.js';
import { loadJobs } from '../../parser/load-jobs.js';
import { jobLoadRejections, jobSubsystemRejections } from './emit-jobs.js';
import { resolveInstalledSubsystems } from './subsystem-detect.js';
import { issueRejections, type RejectionEntry, type RunRejection } from './run-rejections.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode } from '../ui/json.js';

/**
 * List entity YAML files under `dir`, excluding the provider-definitions
 * subtree. When the entities dir IS the `definitions` root, the recursive walk
 * would otherwise pull in `definitions/providers/*.yaml`; passing the providers
 * dir as an exclusion keeps entity discovery to entity files only.
 */
export function listEntityYamls(dir: string, providersDir?: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return findYamlFiles(dir, {
		excludeDirs: providersDir ? [providersDir] : [],
	});
}

export interface EntityTarget {
	file: string;
	name: string;
}

export interface EntityPreflight {
	/** Targets that passed every per-target check — hygen renders these. */
	validated: EntityTarget[];
	/** Per-target rejections (schema, `emits:`, `roles:`). */
	invalid: RunRejection[];
	/** Run-level rejections: the run stops before hygen whatever `--continue-on-error` says. */
	runRejections: RunRejection[];
	emitsErrors: AnalysisIssue[];
	emitsWarnings: AnalysisIssue[];
	/** Loaded once here; `entity new`'s post-steps emit from them. */
	jobLoad: ReturnType<typeof loadJobs>;
	providerSet: ReturnType<typeof loadProviderSet>;
	tsAliases: ReturnType<typeof resolveTsconfigAliases>;
}

/**
 * Every entity YAML in the project's entities directory (plus `extraFiles`)
 * that fails schema validation, as a run-level rejection carrying the entity
 * file and each issue's path and message (#915). Shared by `entity new`,
 * `junction new` (through the pre-flight) and `relationship new`: every
 * command whose post-steps read the whole entity set.
 */
export function entitySetRejections(ctx: Context, extraFiles: string[] = []): RunRejection[] {
	const layout = projectLayout(ctx.cwd, ctx.config);
	const files = new Set([...listEntityYamls(layout.entities, layout.providers), ...extraFiles]);
	const rejections: RunRejection[] = [];
	for (const file of [...files].sort()) {
		const result = loadEntityFromYaml(file);
		if (result.success) continue;
		rejections.push({ file, message: result.error, details: result.details });
	}
	return rejections;
}

/** Every check `entity new` runs before hygen, for `targets` (absolute YAML paths). */
export async function preflightEntityTargets(
	ctx: Context,
	targets: string[],
): Promise<EntityPreflight> {
	// Pre-flight. Three checks can reject a target before hygen runs: the
	// schema (per file), the EVT-7 `emits:` cross-check against the merged
	// event registry, and the CAP-2 `roles:` cross-check. The last two are
	// cross-entity — an emitted event or a role's target lives in another
	// YAML — so neither the schema nor the one-entity hygen prompt can run
	// them. Every rejection keeps its per-issue details (the same diagnostics
	// `entity validate` prints) and is reported in every mode (#627):
	// `--continue-on-error` decides whether the run stops, never whether the
	// reason is shown.
	const validated: Array<{ file: string; name: string }> = [];
	const invalid: Array<{ file: string; message: string; details?: string[] }> =
		[];
	// A YAML that fails the schema is a RUN-level rejection (#915), whichever
	// file it is: the barrels, the relations manifest and every other whole-set
	// post-step read the entity directory, so a set that silently lacks an
	// entity would write a manifest and barrels over it and fail far away, in
	// `tsc`, instead of here. The check covers the whole directory — a single
	// target run, or a run that targets a different, valid entity, is no
	// exception — plus any target outside it.
	const setRejections = entitySetRejections(ctx, targets);
	for (const file of targets) {
		const result = loadEntityFromYaml(file);
		if (result.success) {
			validated.push({ file, name: result.definition.entity.name });
		}
	}

	const entitiesDirForEmits = projectLayout(ctx.cwd, ctx.config).entities;
	const eventsDirForEmits = projectLayout(ctx.cwd, ctx.config).eventsDir;
	const tablePrefix = TablesConfigSchema.parse(ctx.config?.tables ?? {}).prefix;
	const allEntitiesForEmits = loadEntities(entitiesDirForEmits, {
		tablePrefix,
		excludeDirs: [projectLayout(ctx.cwd, ctx.config).providers],
	}).entities;

	// A child imports its base's table and `.enums` module, and a `match:` target's table carries the unique
	// every referrer's composite FK points at, so rendering one alone renders its counterpart too (as
	// `junction new` re-renders a junction's parents): a stale base or target is brought current, and a
	// counterpart that is missing or fails below stops the child. They join `validated` HERE, before the
	// `emits:` and `roles:` checks below read it: a counterpart those checks reject must stop the run before
	// hygen writes the child, not crash hygen on the base after the child is written. `allEntitiesForEmits`
	// holds only entities that already parsed, so a counterpart is valid by construction.
	const alreadyValidated = new Set(validated.map((v) => v.name));
	for (const name of inheritanceCounterparts(allEntitiesForEmits, alreadyValidated)) {
		const counterpart = allEntitiesForEmits.find((e) => e.name === name);
		if (counterpart === undefined) continue;
		validated.push({ file: counterpart.sourcePath, name });
	}
	const validatedNames = new Set(validated.map((v) => v.name));
	const emitsTargetEntities = allEntitiesForEmits.filter((e) =>
		validatedNames.has(e.name),
	);
	const mergedEventsForEmits = collectMergedEvents({
		entitiesDir: entitiesDirForEmits,
		eventsDir: eventsDirForEmits,
	});
	const emitsIssues: AnalysisIssue[] = validateEntityEmits(
		emitsTargetEntities,
		mergedEventsForEmits.events,
	);
	const emitsErrors = emitsIssues.filter((i) => i.severity === 'error');
	const emitsWarnings = emitsIssues.filter(
		(i) => i.severity === 'warning',
	);

	for (const w of emitsWarnings) {
		printWarning(w.message);
	}
	const noEmitsCount = emitsWarnings.filter(
		(w) => w.type === 'no_emits',
	).length;
	if (noEmitsCount > 0) {
		printInfo(`${noEmitsCount} entities missing emits:`);
	}

	// Run-level rejections (JOBS-2): an input every entity's output depends
	// on, so it is not one target's problem and `--continue-on-error` does not
	// apply — the run stops before hygen whatever the flag says.
	const runRejections: RunRejection[] = [...setRejections];

	// App patterns must be in THIS process's registry before the roles
	// pre-flight: a role's target qualifies by declaring an `Actor`
	// capability, which an app may define (and must, until the library ships
	// one). The hygen subprocess loads them for itself; this is the CLI's copy.
	// A file the loader could not register leaves a partial pattern set: the
	// orchestration step would rewrite its root barrel without that module,
	// and a role or `patterns:` entry naming it would resolve against the
	// wrong registry (#664, from the #660 audit).
	runRejections.push(...patternLoadRejections(await loadAppPatternsForCli(ctx), ctx.cwd));

	// Job definitions (RFC-0005 #7) — loaded ONCE, here, so their derived
	// artifacts feed the event + bridge codegen in the SAME pass: each
	// `schedule` arm desugars to a job-private scheduled event merged into the
	// event registry, and every trigger becomes a declarative bridge mapping.
	// The handler files themselves are emitted later (post-assembly). Opt-in:
	// no `definitions/jobs/` ⇒ empty. An invalid job YAML is a run-level
	// rejection (#664): its handler base, scheduled events and bridge triggers
	// feed registries every entity imports, and a previously emitted
	// `<type>.job.generated.ts` would outlive its dropped registrations.
	const { jobsDir, jobHandlers } = projectLayout(ctx.cwd, ctx.config);
	const jobLoad = loadJobs(jobsDir);
	runRejections.push(...jobLoadRejections(jobLoad.issues, jobHandlers));
	// A job's handler base imports the integration subsystem (every arm's
	// `read:` block is a `DetectionConfig`); a project that has not installed it
	// gets a refusal naming the job, the arm and the install command, not a
	// TS2307 in the emitted file (#745).
	runRejections.push(
		...jobSubsystemRejections(
			jobLoad.jobs,
			new Set((await resolveInstalledSubsystems(ctx)).map((s) => s.name)),
			jobsDir,
		),
	);

	// Provider definitions (RFC-0001, Track D) — loaded and cross-validated
	// ONCE, here; the post-step emits from this set. A blocking issue (a YAML
	// that does not load, an unknown surface, a duplicate slug, an
	// unresolvable auth / client import) is a run-level rejection (#666): a
	// provider's module is imported by its surface's adapters module, its
	// change sources feed the surface registry, and its assembly modules are
	// imported by every integrated entity's integration wiring — skipping it
	// would regenerate the entities beside a stale integration layer. The
	// D1 import pre-flight resolves `@app/…#Export` against the consumer
	// tsconfig; with no tsconfig it is skipped (slug / surface checks still run).
	const { providers: providersDir } = projectLayout(ctx.cwd, ctx.config);
	const tsAliases = resolveTsconfigAliases(ctx.cwd);
	const providerSet = loadProviderSet({
		providersDir,
		entitySurfaces: collectEntitySurfaces(
			loadEntitiesFromYaml(listEntityYamls(entitiesDirForEmits, providersDir)).successes.map(
				(s) => s.definition,
			),
		),
		sourceRoot: tsAliases?.sourceRoot,
		aliases: tsAliases?.aliases,
		skipImportCheck: tsAliases === null,
	});
	runRejections.push(...issueRejections(providerSet.issues));

	// The junction set (JUNC-0, #678) — loaded ONCE, here. Every junction is
	// mirrored onto both parents' service + module, which their own templates
	// render from the junction YAMLs, so a junction is an input to two
	// entities' output: a junction file that fails the schema, or names an
	// entity with no YAML, is a run-level rejection (the #666 posture) — never
	// skipped, which would silently drop its fan-out.
	const junctionSet = loadJunctionSet(junctionsDirFor(ctx.cwd));
	runRejections.push(
		...junctionSetIssues(junctionSet, new Set(allEntitiesForEmits.map((e) => e.name))),
	);

	// RFC-0006 (#875): joined-table inheritance. A family is an input to the
	// barrels (`schema.ts`, `modules.ts`) and the relations manifest, which read
	// the WHOLE directory — so a cross-entity violation (R1–R10, M1–M5) in ANY
	// entity is a run-level rejection (the #666 posture), not one target's.
	const frontendSync = FrontendConfigSchema.parse(ctx.config?.frontend ?? {}).sync.mode;
	for (const issue of validateInheritance(allEntitiesForEmits, {
		tenancyColumn: TenancyConfigSchema.parse(ctx.config?.tenancy ?? {}).column,
		syncMode: frontendSync,
	})) {
		runRejections.push({ file: issue.path ?? entitiesDirForEmits, message: `inheritance: ${issue.message}` });
	}

	// TABLE-0: one SQL table, one owning definition — entities and junctions
	// share the database's namespace. `table:` / prefixes let two
	// definitions meet on a table without sharing a plural, which no other
	// check sees; emitting both would be two `pgTable('…')` over one table.
	const tableCollisions = sqlTableCollisions([
		...allEntitiesForEmits.map((e) => ({ table: e.table, owner: `entity '${e.name}'`, file: e.sourcePath })),
		...junctionSet.junctions.map((j) => ({
			table: junctionTableName(j.tableSource, tablePrefix),
			owner: `junction '${j.name}'`,
			file: j.file,
		})),
	]);
	for (const c of tableCollisions) {
		runRejections.push({
			file: c.owners[0]!.file,
			message: sqlTableCollisionMessage(c),
			details: c.owners.map((o) => `${o.owner}: ${o.file}`),
		});
	}

	// Reuses the entity set the emits pre-flight already loaded. A bad role is
	// a generation-time error (the ADR-041 §4 posture).
	const roleErrors = validateRolesForGeneration({
		targets: emitsTargetEntities,
		entities: allEntitiesForEmits,
		junctions: junctionSet.junctions,
	});

	// An entity with an `emits:` or `roles:` error is not generated: the
	// hygen prompt assumes both blocks are valid.
	const rejectedNames = new Set<string>();
	for (let i = validated.length - 1; i >= 0; i--) {
		const v = validated[i]!;
		const ownEmits = emitsErrors.filter((e) => e.entity === v.name);
		const ownRoles = roleErrors.filter((e) => e.entity === v.name);
		if (ownEmits.length === 0 && ownRoles.length === 0) continue;
		const blocks = [
			...(ownEmits.length > 0 ? ['emits:'] : []),
			...(ownRoles.length > 0 ? ['roles:'] : []),
		];
		invalid.push({
			file: v.file,
			message: `${blocks.join(' and ')} validation failed`,
			details: [...ownEmits, ...ownRoles].map((e) => e.message),
		});
		validated.splice(i, 1);
		rejectedNames.add(v.name);
	}

	// A child (or a `match:` referrer) whose base (target) was rejected is rejected with it, and so is whatever
	// depends on THAT one: it is rendered from the rejected YAML, so rendering it beside a rejected counterpart is
	// the half run this pre-flight exists to prevent (`--continue-on-error` keeps independent entities going, not
	// dependent ones). Repeated to a fixpoint — an inheritance chain is longer than one hop.
	for (let changed = true; changed; ) {
		changed = false;
		for (let i = validated.length - 1; i >= 0; i--) {
			const v = validated[i]!;
			const blockers = inheritanceCounterparts(allEntitiesForEmits, new Set([v.name])).filter((c) => rejectedNames.has(c));
			if (blockers.length === 0) continue;
			const named = blockers.map((b) => `'${b}'`).join(', ');
			invalid.push({
				file: v.file,
				message: `its base / match: target ${named} failed validation`,
				details: [`'${v.name}' is rendered from the YAML of ${named}, so it is not generated until that validates.`],
			});
			validated.splice(i, 1);
			rejectedNames.add(v.name);
			changed = true;
		}
	}

	return {
		validated,
		invalid,
		runRejections,
		emitsErrors,
		emitsWarnings,
		jobLoad,
		providerSet,
		tsAliases,
	};
}

/**
 * Render each validated target through hygen (`entity new`). Stops at the first
 * failure unless `continueOnError`.
 *
 * Every invocation receives the names of the whole batch as `--renderSet`
 * (#815), so a `has_many` onto an entity rendered later in the batch is wired
 * on a clean tree: composition does not depend on render order. `entity new`
 * and `junction new` both inherit this.
 */
export function renderEntityTargets(
	ctx: Context,
	validated: EntityTarget[],
	opts: { continueOnError: boolean },
): { succeeded: string[]; failed: RejectionEntry[] } {
	const succeeded: string[] = [];
	const failed: RejectionEntry[] = [];
	const renderSet = validated.map((v) => v.name);
	for (const v of validated) {
		if (!isJsonMode()) {
			printInfo(`generating ${v.name}`);
		}
		const res = invokeEntityNew(v.file, renderSet, ctx.cwd, ctx.configPath);
		if (res.ok) {
			succeeded.push(v.name);
			if (!isJsonMode()) printSuccess(`${v.name}`);
		} else {
			failed.push({
				name: v.name,
				file: v.file,
				message: res.stderr ?? 'Hygen invocation failed',
				details: [],
			});
			if (!isJsonMode()) printError(`${v.name} — ${res.stderr ?? 'failed'}`);
			if (!opts.continueOnError) break;
		}
	}
	return { succeeded, failed };
}
