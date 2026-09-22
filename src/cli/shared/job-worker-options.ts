/**
 * The job worker's backend/extension options, from `codegen.config.yaml`
 * `jobs:` — ONE builder for both worker processes (GEN-0, #652; charter I1):
 *
 *   - the embedded worker, `JobWorkerModule.forRoot({ mode: 'embedded', … })`
 *     in `<generated>/subsystems.ts` (`subsystem-barrel-generator.ts`);
 *   - the standalone worker, `jobWorkerOptions` in `<generated>/app-config.ts`
 *     (`app-config-generator.ts`), which the emit-once `worker.ts` imports.
 *
 * Each file serialises the value in its own style; neither restates the rule.
 */

/**
 * Camel-cased shape of the drizzle jobs backend extension knobs that flow into
 * the generated `forRoot` calls. Snake_case YAML keys map 1:1 to these.
 */
export type DrizzleJobsExt = {
	listenNotify?: boolean;
	pollIntervalMs?: number;
	staleSweeperIntervalMs?: number;
	staleThresholdMs?: number;
	claimHeartbeatIntervalMs?: number;
};

/**
 * LISTEN-NOTIFY-1 / CLAIM-HB-1 — extract the drizzle extension knobs from
 * `jobs.extensions.drizzle` (`listen_notify`, `poll_interval_ms`,
 * `stale_sweeper_interval_ms`, `stale_threshold_ms`,
 * `claim_heartbeat_interval_ms`) and map them to the camelCase runtime shape.
 * Returns `undefined` when no knob is set (so the generated call stays minimal
 * and off-by-default). Only the drizzle/default backend reads these.
 */
export function drizzleJobsExtensions(
	backend: string,
	cfg: Record<string, unknown> | undefined,
): DrizzleJobsExt | undefined {
	if (backend !== 'drizzle') return undefined;
	const drizzle = (cfg?.extensions as { drizzle?: Record<string, unknown> } | undefined)
		?.drizzle;
	if (!drizzle) return undefined;
	const out: DrizzleJobsExt = {};
	if (typeof drizzle.listen_notify === 'boolean') out.listenNotify = drizzle.listen_notify;
	if (typeof drizzle.poll_interval_ms === 'number')
		out.pollIntervalMs = drizzle.poll_interval_ms;
	if (typeof drizzle.stale_sweeper_interval_ms === 'number')
		out.staleSweeperIntervalMs = drizzle.stale_sweeper_interval_ms;
	if (typeof drizzle.stale_threshold_ms === 'number')
		out.staleThresholdMs = drizzle.stale_threshold_ms;
	if (typeof drizzle.claim_heartbeat_interval_ms === 'number')
		out.claimHeartbeatIntervalMs = drizzle.claim_heartbeat_interval_ms;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The worker's `backend` + `domainModuleExtensions`, as a value:
 *
 *   - drizzle (default), no knobs → `{}`
 *   - drizzle + knobs             → `{ domainModuleExtensions: { drizzle: {…camelCase} } }`
 *     (`JobWorkerModule` threads `listenNotify` — the listener — and
 *     `pollIntervalMs` into each spawned `JobWorker`, and forwards them to its
 *     inner `JobsDomainModule`)
 *   - bullmq                      → `{ backend: 'bullmq', domainModuleExtensions?: { bullmq: {…} } }`
 *     (BULLMQ-1: snake_case keys, the runtime `BullMqExtensionsConfig` shape)
 */
export function jobWorkerBackendOptions(
	cfg: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const backend = (cfg?.backend as string | undefined) ?? 'drizzle';
	if (backend === 'bullmq') {
		const bullExt = (cfg?.extensions as { bullmq?: Record<string, unknown> } | undefined)?.bullmq;
		return bullExt
			? { backend: 'bullmq', domainModuleExtensions: { bullmq: bullExt } }
			: { backend: 'bullmq' };
	}
	const drizzle = drizzleJobsExtensions(backend, cfg);
	return drizzle ? { domainModuleExtensions: { drizzle } } : {};
}
