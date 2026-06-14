/**
 * Jobs definition-kind emitter (RFC-0005, breakdown #7).
 *
 * Compiles a `JobDefinition` (definitions/jobs/*.yaml, validated by #5/#6) into:
 *
 *   1. A seam-split `@JobHandler` skeleton — mirroring `sink-emission-generator.ts`:
 *      - `<type>.job.generated.ts` — `@generated` (regenerated via writeIfChanged):
 *        the `<type>Meta` const (JobHandlerMeta, reflowed from YAML), the per-arm
 *        `DetectionConfig` literals, and an abstract `<Type>JobBase` whose `run()`
 *        loop is concrete and whose per-arm vendor wiring is an author seam.
 *      - `<type>.job.ts` — emit-once (existsSync-skip in the caller): the concrete
 *        `@JobHandler('<type>', <type>Meta) class <Type>Job extends <Type>JobBase`
 *        the author fills.
 *   2. Bridge contributions (`buildJobBridgeTriggers`) — synthetic `ScannedTrigger`s
 *      fed DECLARATIVELY into the bridge registry generator's `extraTriggers` seam
 *      (RFC-0005 fork 1). The decorator's meta carries NO `triggers`; the bridge
 *      mapping is contributed here with a generated `map` string, never round-
 *      tripped through the AST scan.
 *   3. Scheduled events (`buildJobScheduledEvents`) — one job-private domain event
 *      per `schedule` arm (RFC-0005 fork 2 / ADR-039), merged into the event
 *      registry like EMIT-CHANGES. Cadence is job-owned; the emitter generates the
 *      tick event the bridge then fires the job on.
 *
 * Provider/use-case resolution stays author-side (RFC-0005 OQ-4 b — provider is not
 * in the YAML); the per-arm `runArm*` seam is where the author wires the change
 * source (from the regenerated `<type>ArmDetection.<domain>`) into their provider's
 * `ExecuteIntegrationUseCase`.
 *
 * All functions here are PURE (return strings / data); path + write + emit-once
 * logic lives in the caller (#7b, the entity-new post-step).
 */

import { subsystemsImport, runtimeImport, type RuntimeMode } from "./runtime-import";
import type { ScannedTrigger } from "./bridge-registry-generator";
import {
	type EventDefinition,
	DIRECTION_TO_POOL,
} from "../../schema/event-definition.schema";
import type {
	JobDefinition,
	JobArm,
	JobTriggerDef,
} from "../../schema/job-definition.schema";

// ============================================================================
// Names
// ============================================================================

/** snake_case → PascalCase (`drive_poll` → `DrivePoll`). */
function pascalCase(snake: string): string {
	return snake
		.split("_")
		.filter(Boolean)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join("");
}

/** snake_case → camelCase (`drive_poll` → `drivePoll`). */
function camelCase(snake: string): string {
	const pascal = pascalCase(snake);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

interface JobNames {
	jobClass: string; // DrivePollJob
	jobBaseClass: string; // DrivePollJobBase
	metaConst: string; // drivePollMeta
	detectionConst: string; // drivePollArmDetection
	inputType: string; // DrivePollInput
	armResultType: string; // DrivePollArmResult
	baseModule: string; // drive_poll.job.generated (extension-less)
}

function jobNames(jobType: string): JobNames {
	const Pascal = pascalCase(jobType);
	const camel = camelCase(jobType);
	return {
		jobClass: `${Pascal}Job`,
		jobBaseClass: `${Pascal}JobBase`,
		metaConst: `${camel}Meta`,
		detectionConst: `${camel}ArmDetection`,
		inputType: `${Pascal}Input`,
		armResultType: `${Pascal}ArmResult`,
		baseModule: `${jobType}.job.generated`,
	};
}

// ============================================================================
// Input
// ============================================================================

/** Pure input for the job emitters. The caller derives this from the loaded
 *  `JobDefinition` + config; nothing here is path-computed inside the emitter. */
export interface JobEmitInput {
	/** The validated job definition (one `definitions/jobs/*.yaml`). */
	job: JobDefinition;
	/** Runtime mode (ADR-037) — selects the subsystem import specifier. Default `package`. */
	mode?: RuntimeMode;
}

// ============================================================================
// Scheduled-event naming (shared by the bridge + event contributions)
// ============================================================================

/** The schedule arms of a job, paired with their index in `triggers`. */
function scheduleArms(job: JobDefinition): Array<{ index: number; schedule: Extract<JobTriggerDef, { schedule: unknown }>["schedule"] }> {
	const out: Array<{ index: number; schedule: Extract<JobTriggerDef, { schedule: unknown }>["schedule"] }> = [];
	job.triggers.forEach((t, index) => {
		if ("schedule" in t) out.push({ index, schedule: t.schedule });
	});
	return out;
}

/**
 * The generated, job-private scheduled-event type for a schedule arm. One
 * schedule arm → `<job_type>__sched`; multiple → `<job_type>__sched__<index>`
 * (the trigger index, for stability). The `__sched` infix namespaces these away
 * from EMIT-CHANGES (`<entity>_<verb>`) and hand-authored events; snake_case-safe.
 */
function scheduledEventType(jobType: string, triggerIndex: number, totalScheduleArms: number): string {
	return totalScheduleArms <= 1 ? `${jobType}__sched` : `${jobType}__sched__${triggerIndex}`;
}

// ============================================================================
// Bridge contribution — declarative ScannedTriggers (fork 1)
// ============================================================================

/**
 * Build the synthetic `ScannedTrigger`s for one or more jobs, to feed the bridge
 * registry generator's `extraTriggers` seam. Each trigger (schedule or event arm)
 * becomes one job→event bridge mapping with a GENERATED `map` string — never a
 * round-tripped author arrow. The bridge generator validates these (unknown-event,
 * duplicate, audit) alongside the AST-scanned hand-authored triggers.
 *
 * `sourceFile` is the job YAML path (for the generator's error citations).
 */
export function buildJobBridgeTriggers(job: JobDefinition, sourceFile: string): ScannedTrigger[] {
	const total = scheduleArms(job).length;
	return job.triggers.map((trigger, index) => {
		const event =
			"schedule" in trigger
				? scheduledEventType(job.type, index, total)
				: trigger.event;
		return {
			jobType: job.type,
			triggerId: `${job.type}#${index}`,
			event,
			// Generated map: a sync job's start payload is uniform/minimal (RFC-0005
			// fork 3). The bridge inlines this verbatim; keep it self-contained.
			mapSource: "() => ({})",
			sourceFile,
			sourceLine: index + 1,
		};
	});
}

// ============================================================================
// Scheduled-event contribution — one domain event per schedule arm (fork 2)
// ============================================================================

/**
 * Build the job-private scheduled `EventDefinition`s for a job (one per schedule
 * arm). Each is a `tier: domain`, `direction: inbound` event carrying the arm's
 * `schedule:` block — bridge-eligible AND a valid `ScheduledEvent` (the
 * EventScheduler materialises a tick per slot; the bridge fires the job). Merge
 * these into the event registry via the sugar arm (top-level-wins), exactly like
 * EMIT-CHANGES.
 */
export function buildJobScheduledEvents(job: JobDefinition): EventDefinition[] {
	const arms = scheduleArms(job);
	return arms.map(({ index, schedule }) => ({
		type: scheduledEventType(job.type, index, arms.length),
		tier: "domain" as const,
		direction: "inbound" as const,
		// inbound needs no aggregate/source; a time tick has no entity aggregate.
		payload: {},
		retry: { attempts: 3, backoff: "exponential" as const },
		version: 1,
		pool: DIRECTION_TO_POOL.inbound,
		schedule,
		description: `Job-private cadence tick for '${job.type}' (RFC-0005 schedule arm). Generated — do not author.`,
	}));
}

// ============================================================================
// Meta const — JobHandlerMeta reflowed from YAML (the 7 non-trigger fields)
// ============================================================================

/** Render the YAML `scope.from` template (`{{field}}` or a bare field name) as a
 *  `(input) => string` accessor. Index access + cast keeps it compiling against
 *  any `TInput` shape (the field may not be on the minimal generated input). */
function renderScopeFrom(from: string): string {
	const m = /^\{\{\s*(\w+)\s*\}\}$/.exec(from);
	const field = m ? m[1] : from;
	return `(input) => String((input as Record<string, unknown>)[${JSON.stringify(field)}] ?? '')`;
}

function buildMetaLines(job: JobDefinition): string[] {
	const lines: string[] = [];
	if (job.pool !== undefined) lines.push(`  pool: ${JSON.stringify(job.pool)},`);
	if (job.scope !== undefined) {
		lines.push(
			`  scope: { entity: ${JSON.stringify(job.scope.entity)}, from: ${renderScopeFrom(job.scope.from)} },`,
		);
	}
	if (job.retry !== undefined) {
		const r = job.retry;
		const extra = r.nonRetryableErrors ? `, nonRetryableErrors: ${JSON.stringify(r.nonRetryableErrors)}` : "";
		lines.push(`  retry: { attempts: ${r.attempts}, backoff: ${JSON.stringify(r.backoff)}, baseMs: ${r.baseMs}${extra} },`);
	}
	if (job.concurrency !== undefined) {
		// `key` stays a `{{field}}` template string — the runtime evaluates it
		// (keySelectorToTemplate / evaluateKeyTemplate). The function form is not
		// YAML-authorable, so the string form is always emitted.
		lines.push(
			`  concurrency: { key: ${JSON.stringify(job.concurrency.key)}, collisionMode: ${JSON.stringify(job.concurrency.collisionMode)} },`,
		);
	}
	if (job.dedupe !== undefined) {
		lines.push(`  dedupe: { key: ${JSON.stringify(job.dedupe.key)}, windowMs: ${job.dedupe.windowMs} },`);
	}
	if (job.timeoutMs !== undefined) lines.push(`  timeoutMs: ${job.timeoutMs},`);
	if (job.replayFrom !== undefined) lines.push(`  replayFrom: ${JSON.stringify(job.replayFrom)},`);
	return lines;
}

// ============================================================================
// Per-arm detection literals
// ============================================================================

function buildDetectionLines(job: JobDefinition): string[] {
	const lines: string[] = [];
	for (const arm of job.arms) {
		// The `read` block is a parsed DetectionConfig (plain data) — JSON is valid TS.
		const literal = JSON.stringify(arm.read, null, 2)
			.split("\n")
			.map((l, i) => (i === 0 ? l : `\t${l}`))
			.join("\n");
		lines.push(`\t${arm.domain}: ${literal} as DetectionConfig,`);
	}
	return lines;
}

/** Per-arm action for the integration run, derived from the arm kind (the schema
 *  cross-arm invariant guarantees realtime⇒webhook, poll/reconcile⇒poll). */
function armAction(arm: JobArm): "poll" | "webhook" {
	return arm.kind === "realtime" ? "webhook" : "poll";
}

// ============================================================================
// Emitters
// ============================================================================

/** Emit the `@generated` base file (`<type>.job.generated.ts`). */
export function generateJobHandlerBase(input: JobEmitInput): string {
	const { job } = input;
	const mode = input.mode ?? "package";
	const n = jobNames(job.type);
	// Jobs handler symbols (JobHandlerBase/JobContext/JobHandlerMeta/JobHandler) are
	// NOT on the top-level `/subsystems` barrel — they resolve via the deeper
	// `subsystems/jobs/index` path (the same convention jobs-scaffold-locals uses).
	// DetectionConfig IS on the top barrel, so it stays on subsystemsImport.
	const jobsImport = runtimeImport(mode, "subsystems/jobs/index");
	const integrationImport = subsystemsImport(mode, "integration");

	const metaLines = buildMetaLines(job);
	const detectionLines = buildDetectionLines(job);

	const runLines = job.arms.map(
		(arm) =>
			`    results.push(await ctx.step(${JSON.stringify(arm.domain)}, () => this.runArm${pascalCase(arm.domain)}(ctx)));`,
	);
	const seamLines = job.arms.map((arm) => {
		const Pascal = pascalCase(arm.domain);
		return [
			`  /**`,
			`   * Author seam — arm '${arm.domain}' (kind: ${arm.kind}, action: ${armAction(arm)}).`,
			`   * Build a change source from \`${n.detectionConst}.${arm.domain}\` via \`buildChangeSource(...)\``,
			`   * and run your provider's ExecuteIntegrationUseCase with it as \`sourceOverride\``,
			`   * (provider/use-case resolution is author-side — RFC-0005 OQ-4 b).`,
			`   */`,
			`  protected abstract runArm${Pascal}(ctx: JobContext<${n.inputType}>): Promise<${n.armResultType}>;`,
		].join("\n");
	});

	const armKinds = Array.from(new Set(job.arms.map((a) => a.kind)))
		.map((k) => JSON.stringify(k))
		.join(" | ");

	const banner =
		`// @generated by @pattern-stack/codegen from definitions/jobs/${job.type}.yaml — DO NOT EDIT.\n` +
		`// Hand edits are overwritten on re-emit. Regenerate with \`bun run codegen\`.\n` +
		`//\n` +
		`// Two-file seam (RFC-0005 #7, mirrors the sink seam-split):\n` +
		`//   THIS FILE  — @generated base: ${n.metaConst} + ${n.detectionConst} + abstract ${n.jobBaseClass}.\n` +
		`//                A YAML change reflows the meta + detection here on every run.\n` +
		`//   ${job.type}.job.ts — emit-once subclass: \`@JobHandler('${job.type}', ${n.metaConst}) class ${n.jobClass}\`.\n` +
		`//                Fills the per-arm runArm* vendor seams. Author overrides survive regen.\n` +
		`//\n` +
		`// Triggers are NOT on the decorator meta — they are contributed to the bridge\n` +
		`// registry declaratively by the jobs emitter (RFC-0005 fork 1).`;

	return `${banner}
import { JobHandlerBase, type JobContext, type JobHandlerMeta } from '${jobsImport}';
import type { DetectionConfig } from '${integrationImport}';

/** The job's start-payload input. Extend in the subclass if your triggers carry
 *  more than the uniform sync-job fields. */
export interface ${n.inputType} {
  readonly provider?: string;
  readonly tenantId?: string | null;
}

/** Per-arm summary the run loop collects (one per arm, in declaration order). */
export interface ${n.armResultType} {
  readonly domain: string;
  readonly kind: ${armKinds};
  readonly recordsProcessed: number;
}

/** JobHandlerMeta reflowed from the YAML (the non-trigger fields). Imported by the
 *  emit-once subclass into \`@JobHandler('${job.type}', ${n.metaConst})\`. */
export const ${n.metaConst}: JobHandlerMeta<${n.inputType}> = {
${metaLines.join("\n")}
};

/** Per-arm detection configs (the embedded \`read:\` leaf), reflowed from YAML.
 *  Pass an entry into \`buildChangeSource(...)\` in the matching runArm* seam. */
export const ${n.detectionConst} = {
${detectionLines.join("\n")}
};

export abstract class ${n.jobBaseClass} extends JobHandlerBase<${n.inputType}, ${n.armResultType}[]> {
  async run(ctx: JobContext<${n.inputType}>): Promise<${n.armResultType}[]> {
    const results: ${n.armResultType}[] = [];
${runLines.join("\n")}
    return results;
  }

${seamLines.join("\n\n")}
}
`;
}

/** Emit the emit-once author subclass (`<type>.job.ts`). */
export function generateJobHandlerSubclass(input: JobEmitInput): string {
	const { job } = input;
	const mode = input.mode ?? "package";
	const n = jobNames(job.type);
	const jobsImport = runtimeImport(mode, "subsystems/jobs/index");

	const seamImpls = job.arms
		.map((arm) => {
			const Pascal = pascalCase(arm.domain);
			return [
				`  protected async runArm${Pascal}(_ctx: JobContext<${n.inputType}>): Promise<${n.armResultType}> {`,
				`    // TODO(author): build the change source from ${n.detectionConst}.${arm.domain} and run`,
				`    // your provider's ExecuteIntegrationUseCase with it as sourceOverride. See RFC-0005.`,
				`    throw new Error('${n.jobClass}.runArm${Pascal} not implemented');`,
				`  }`,
			].join("\n");
		})
		.join("\n\n");

	return `// Emit-once — author-owned. Regen never overwrites this file.
// The mechanical meta + detection live in ${n.baseModule}.ts and reflow on every run.
// Fill each runArm* seam with your vendor read + ExecuteIntegrationUseCase wiring.
// Source: definitions/jobs/${job.type}.yaml.
import { JobHandler, type JobContext } from '${jobsImport}';
import {
  ${n.jobBaseClass},
  ${n.metaConst},
  ${n.detectionConst},
  type ${n.inputType},
  type ${n.armResultType},
} from './${n.baseModule}';

// Reference the regenerated detection so the import is live even before the seams
// are filled (the author reads ${n.detectionConst}.<domain> per arm).
void ${n.detectionConst};

@JobHandler<${n.inputType}>('${job.type}', ${n.metaConst})
export class ${n.jobClass} extends ${n.jobBaseClass} {
${seamImpls}
}
`;
}
