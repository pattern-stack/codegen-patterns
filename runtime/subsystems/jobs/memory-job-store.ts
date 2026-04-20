/**
 * MemoryJobStore — the shared in-memory backing for the three memory-backend
 * services (ADR-022, JOB-4).
 *
 * Plain class, not `@Injectable()`. Wired as a `useValue` provider in
 * JOB-5's `JobsDomainModule.forRoot({ backend: 'memory' })` so unit tests
 * can keep a direct reference for `beforeEach` resets.
 *
 * All three memory services receive the same `MemoryJobStore` instance via
 * constructor injection; the store owns mutable state, the services are
 * stateless mutators.
 */
import type {
  JobDefinitionRow,
  JobRunRow,
  JobStepRow,
} from './job-orchestration.schema';

export class MemoryJobStore {
  /** Runs keyed by `id` (single source of truth for status/scope/lineage). */
  readonly runs: Map<string, JobRunRow> = new Map();

  /** Steps keyed by `job_run_id`; array order matches insertion order. */
  readonly steps: Map<string, JobStepRow[]> = new Map();

  /** Job definitions keyed by `type` — memory mirror of the `job` table. */
  readonly jobs: Map<string, JobDefinitionRow> = new Map();

  /** Reset everything. Tests call this in `beforeEach`. */
  clear(): void {
    this.runs.clear();
    this.steps.clear();
    this.jobs.clear();
  }
}
