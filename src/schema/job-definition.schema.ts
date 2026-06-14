import { z } from "zod";
import { DetectionConfigSchema } from "../../runtime/subsystems/integration";

/**
 * Job Definition Schema — the codegen "jobs" definition kind (RFC-0005).
 *
 * Describes a single `definitions/jobs/*.yaml` file: a declarative sync-job
 * profile that the codegen jobs emitter compiles into a `@JobHandler` skeleton.
 * The load-bearing A→B contract (swe-brain ADR-0018): a per-adapter sync-profile
 * object IS a `JobDefinition`. swe-brain authors the YAML; codegen compiles it.
 *
 * Two discriminated unions at two altitudes (ADR-0018 D1+D3):
 *   - arm `kind`  (poll | reconcile | realtime) — the source-USAGE shape, here.
 *   - source `mode` (poll | webhook)            — the embedded `DetectionConfig`
 *     leaf, REUSED verbatim from `runtime/subsystems/integration` (ADR-033),
 *     never redefined.
 *
 * Codegen-side resolutions of the brief's §3 (recorded in RFC-0005):
 *   - The differ knob is named `differ.unignore` — NOT `dedupe.unignore` — so it
 *     does not collide with the runtime `JobHandlerMeta.dedupe` (DedupePolicy
 *     `{ key, windowMs }`), one of the eight handler-meta fields this schema
 *     surfaces. `differ.unignore` maps to `integration.differ.unignore`.
 *   - No `lane` field: it is not a `JobHandlerMeta` field (grep finds it only in
 *     JOB-FN-KEY comments about the concurrency *key*). The execution lane is
 *     `pool`.
 *   - Function-valued `JobHandlerMeta` fields (`scope.from`, `concurrency.key`,
 *     `dedupe.key`, `triggers[].map/when`) are NOT authorable in YAML. The schema
 *     models the DECLARATIVE surface only: `key`/`from` are `{{field}}` template
 *     strings; `triggers[]` declares the `event` (+ optional read-only cadence
 *     mirror) and the emitter generates `map`/`when`.
 *   - No provider/adapter identity field (RFC-0005 OQ-4, decided (b)). Arms carry
 *     only `domain`; provider→use-case resolution stays swe-brain-side (the D5
 *     throwaway `(provider,domain)` registry), revisited when codegen #458 lands.
 *     A single job spans providers, so this is deliberately NOT a top-level field.
 *
 * Cadence is NOT authoritative here (ADR-039 / ADR-0018 D4): it lives on the
 * event YAML `schedule:` block. A trigger may carry an OPTIONAL read-only
 * `cadence` mirror that the cross-ref validator (RFC-0005 / breakdown #8) drift-
 * checks against the referenced event. This schema only shape-checks the mirror;
 * the mirror leaves `align` undefined when omitted (it does NOT default to the
 * event's `true`), so the #8 drift check must compare only author-PROVIDED mirror
 * keys, never a defaulted value, or it will false-positive on every cadence that
 * omits `align`.
 *
 * Strictness boundary: the top level and every arm are `.strict()` (stray keys
 * rejected). The embedded `read:` leaf is the IMPORTED `DetectionConfigSchema`,
 * which is NOT strict (ADR-033 — reused verbatim, never widened), so a typo
 * INSIDE `read:`/`poll:`/`webhook:` (e.g. `eventIdFeld`) is silently stripped, not
 * rejected. The #6 loader / #8 validator / #9 smoke gate is the backstop for
 * read-leaf shape — do not add `.strict()` to the imported leaf.
 */

// ============================================================================
// Enums and constants
// ============================================================================

/** Mirrors `RetryPolicy.backoff` in `runtime/subsystems/jobs/job-handler.base.ts`. */
export const JOB_BACKOFF_STRATEGIES = ["fixed", "exponential"] as const;
export type JobBackoffStrategy = (typeof JOB_BACKOFF_STRATEGIES)[number];

/** Mirrors `ConcurrencyPolicy.collisionMode`. */
export const COLLISION_MODES = ["queue", "reject", "replace"] as const;
export type CollisionMode = (typeof COLLISION_MODES)[number];

/** Mirrors `JobHandlerMeta.replayFrom`. */
export const REPLAY_FROM = ["scratch", "last_step", "last_checkpoint"] as const;
export type ReplayFrom = (typeof REPLAY_FROM)[number];

/** Source-usage shapes (ADR-0018). Discriminant of the `arms[]` union. */
export const ARM_KINDS = ["poll", "reconcile", "realtime"] as const;
export type ArmKind = (typeof ARM_KINDS)[number];

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Duration string for the read-only cadence mirror — identical vocabulary to
 * the event `ScheduleSchema.every` (ADR-039): `'1h'`, `'30m'`, `'15s'`,
 * `'500ms'`, `'1d'`, or a raw millisecond number.
 */
const DURATION_RE = /^\s*[0-9]*\.?[0-9]+\s*(ms|s|m|h|d)\s*$/;

// ============================================================================
// Policy sub-schemas — the declarative (YAML-authorable) projection of the
// corresponding `JobHandlerMeta` policy types.
// ============================================================================

/**
 * `RetryPolicy` (job-handler.base.ts). All four fields surfaced; `backoff` is
 * `fixed | exponential` (jobs), distinct from the events `linear | exponential`.
 */
const RetryPolicySchema = z
	.object({
		attempts: z.number().int().min(0).max(20),
		backoff: z.enum(JOB_BACKOFF_STRATEGIES),
		baseMs: z.number().int().positive(),
		nonRetryableErrors: z.array(z.string().min(1)).optional(),
	})
	.strict();

export type JobRetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * `ConcurrencyPolicy`. `key` is the `{{field}}` template string form only — the
 * `(input) => string` function form is code-authored (persisted as the
 * `FN_KEY_SENTINEL`) and cannot be expressed in YAML.
 */
const ConcurrencyPolicySchema = z
	.object({
		key: z.string().min(1),
		collisionMode: z.enum(COLLISION_MODES),
	})
	.strict();

export type JobConcurrencyPolicy = z.infer<typeof ConcurrencyPolicySchema>;

/**
 * `DedupePolicy` — the runtime job-level dedupe WINDOW (`{ key, windowMs }`).
 * Distinct from `differ.unignore` (below). `key` is the template string form.
 */
const DedupePolicySchema = z
	.object({
		key: z.string().min(1),
		windowMs: z.number().int().positive(),
	})
	.strict();

export type JobDedupePolicy = z.infer<typeof DedupePolicySchema>;

/**
 * `ScopeRef` (job-handler.base.ts). `from` is the `{{field}}` template / field
 * path the emitter compiles into `(input) => string`; the function form is not
 * YAML-authorable.
 */
const ScopeRefSchema = z
	.object({
		entity: z.string().regex(SNAKE_CASE_RE, "scope.entity must be snake_case"),
		from: z.string().min(1),
	})
	.strict();

export type JobScopeRef = z.infer<typeof ScopeRefSchema>;

/**
 * Per-job differ override (ADR-0018 D2). Adds field names back into the
 * DeepEqualDiffer's comparison set for this job, on top of the global
 * `integration.differ.unignore`. The classic case is `deletedAt` so tombstones
 * register as a change. Per-job differ WIRING is deferred (D2); the schema
 * freezes the authoring surface so swe-brain can express it today.
 */
const DifferOverrideSchema = z
	.object({
		// Deliberately `.min(1)`: the runtime `DeepEqualDifferOptions.unignore` accepts
		// `[]` (a harmless no-op), but an empty `differ` block in YAML is meaningless
		// and almost certainly an authoring mistake — reject it rather than silently
		// accept a pointless block. (Schema is intentionally stricter than the runtime.)
		unignore: z.array(z.string().min(1)).min(1),
	})
	.strict();

export type JobDifferOverride = z.infer<typeof DifferOverrideSchema>;

// ============================================================================
// Triggers — the cadence/event LINKAGE (ADR-0018 D4). 0/1/N per job.
// ============================================================================

/**
 * Read-only cadence mirror of the referenced event's `schedule:` block. NON-
 * authoritative: the event YAML wins. A subset of the event `ScheduleSchema`
 * (`every` + `align`); the cross-ref validator (breakdown #8) drift-errors if it
 * disagrees with the event. This schema only shape-checks it.
 */
const CadenceAnnotationSchema = z
	.object({
		every: z.union([
			z
				.string()
				.regex(
					DURATION_RE,
					"trigger.cadence.every must be a duration like '1h', '30m', '15s', '500ms', '1d'",
				),
			z.number().positive().finite(),
		]),
		align: z.boolean().optional(),
	})
	.strict();

export type CadenceAnnotation = z.infer<typeof CadenceAnnotationSchema>;

/**
 * A single trigger arm. `event` cross-refs the generated `eventRegistry` at
 * gen time (breakdown #8). The runtime `JobTrigger.map`/`when` functions are
 * emitter-generated — not authored here.
 */
const TriggerSchema = z
	.object({
		event: z
			.string()
			.regex(SNAKE_CASE_RE, "trigger.event must be a snake_case event type"),
		cadence: CadenceAnnotationSchema.optional(),
	})
	.strict();

export type JobTriggerDef = z.infer<typeof TriggerSchema>;

// ============================================================================
// Arms — the multi-arm composite (ADR-0018 D1+D3). Discriminated on `kind`,
// each embedding a `DetectionConfig` leaf (REUSED, not redefined).
// ============================================================================

/** PollSync — DI-bound adapter walks the delta; cursor ADVANCES. mode: poll. */
const PollArmSchema = z
	.object({
		kind: z.literal("poll"),
		domain: z.string().regex(SNAKE_CASE_RE, "arm.domain must be snake_case"),
		read: DetectionConfigSchema,
	})
	.strict();

/**
 * ReconcileSync — windowed `sourceOverride` (now − window), tombstone
 * inference; cursor WITHHELD (never regress the watermark). mode: poll.
 * `cursorWithheld` is `true` by definition (literal) — a reconcile arm that
 * advanced its cursor would not be a reconcile.
 */
const ReconcileArmSchema = z
	.object({
		kind: z.literal("reconcile"),
		domain: z.string().regex(SNAKE_CASE_RE, "arm.domain must be snake_case"),
		window: z
			.object({ hours: z.number().positive().finite() })
			.strict(),
		cursorWithheld: z.literal(true).optional().default(true),
		read: DetectionConfigSchema,
	})
	.strict();

/**
 * RealtimeSync — webhook-staging drain (claim/ack in the handler), NOT a peer
 * primitive (ADR-0018 D1). Reuses `mode: webhook`. The staging table is
 * consumer-owned (the package refuses to own it).
 */
const RealtimeArmSchema = z
	.object({
		kind: z.literal("realtime"),
		domain: z.string().regex(SNAKE_CASE_RE, "arm.domain must be snake_case"),
		staging: z
			.object({
				table: z.string().min(1),
				pushAccelerate: z.boolean().optional(),
			})
			.strict(),
		read: DetectionConfigSchema,
	})
	.strict();

const ArmSchema = z.discriminatedUnion("kind", [
	PollArmSchema,
	ReconcileArmSchema,
	RealtimeArmSchema,
]);

export type JobArm = z.infer<typeof ArmSchema>;

// ============================================================================
// Top-level schema
// ============================================================================

const JobDefinitionSchemaCore = z
	.object({
		type: z
			.string()
			.regex(SNAKE_CASE_RE, "Job type must be snake_case starting with a letter"),
		// ── JobHandlerMeta surface (8 fields) ──────────────────────────────────
		pool: z.string().min(1).optional(),
		scope: ScopeRefSchema.optional(),
		retry: RetryPolicySchema.optional(),
		concurrency: ConcurrencyPolicySchema.optional(),
		dedupe: DedupePolicySchema.optional(),
		timeoutMs: z.number().int().positive().optional(),
		replayFrom: z.enum(REPLAY_FROM).optional(),
		// `triggers` is the 8th meta field, reshaped to the declarative surface.
		triggers: z.array(TriggerSchema).default([]),
		// ── job-definition additions ───────────────────────────────────────────
		differ: DifferOverrideSchema.optional(),
		arms: z.array(ArmSchema).min(1, "a job must declare at least one arm"),
		description: z.string().optional(),
	})
	.strict();

/**
 * Cross-arm invariant (ADR-0018 D1↔D3): the arm `kind` constrains the embedded
 * source `mode`. A realtime arm drains a `webhook` source; poll/reconcile arms
 * walk a `poll` source. The two-altitude unions are independent everywhere else
 * — a single job freely mixes realtime + poll arms (e.g. `inbound-sync`).
 */
export const JobDefinitionSchema = JobDefinitionSchemaCore.superRefine(
	(data, ctx) => {
		data.arms.forEach((arm, i) => {
			const mode = arm.read.mode;
			if (arm.kind === "realtime" && mode !== "webhook") {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `realtime arm '${arm.domain}' requires read.mode 'webhook' (got '${mode}'). Realtime is a webhook-drain shape (ADR-0018 D1).`,
					path: ["arms", i, "read", "mode"],
				});
			}
			if (
				(arm.kind === "poll" || arm.kind === "reconcile") &&
				mode !== "poll"
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `${arm.kind} arm '${arm.domain}' requires read.mode 'poll' (got '${mode}').`,
					path: ["arms", i, "read", "mode"],
				});
			}
		});
	},
);

export type JobDefinition = z.infer<typeof JobDefinitionSchema>;

// ============================================================================
// Validation helpers
// ============================================================================

export function validateJobDefinition(data: unknown): JobDefinition {
	return JobDefinitionSchema.parse(data);
}

export function safeValidateJobDefinition(data: unknown): {
	success: boolean;
	data?: JobDefinition;
	error?: z.ZodError;
} {
	const result = JobDefinitionSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}
