/**
 * Injection token for the job queue.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(JOB_QUEUE) private readonly jobQueue: IJobQueue) {}
 * ```
 */
export const JOB_QUEUE = Symbol('JOB_QUEUE');
