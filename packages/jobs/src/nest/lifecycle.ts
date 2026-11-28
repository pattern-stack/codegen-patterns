import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import type { Registry } from '../index.ts';
import type { JobInputRefs } from './job-input-refs.ts';
import { refFieldsOf } from './job-input-refs.ts';
import {
  JOBS_EXECUTOR,
  JOBS_INPUT_REFS,
  JOBS_REGISTRY,
  JOBS_WORKER,
} from './tokens.ts';

/** What the lifecycle stops: the executor, structurally. */
interface Stoppable {
  stop(): Promise<void>;
  /** The in-process executor's loop; BullMQ's worker is the host's to run. */
  start?(): Promise<void>;
}

/**
 * The refs boot check, as a function: every ref kind a registered job's input names (`jobRef`) must have a registered
 * source that lists options (Start run picks from them), or the boot stops. It checks what the jobs actually name, so
 * a kind no job uses needs no source. A kind only views name is resolved at read time, and a missing source there
 * shows its ids as not found rather than stopping the boot.
 */
export function assertRefSourcesRegistered(
  registry: Registry,
  refs: JobInputRefs,
): void {
  for (const job of registry.list())
    for (const field of refFieldsOf(job.input)) {
      const source = refs.sourceOf(field.kind);
      if (!source)
        throw new Error(
          `job ${job.key} names ref kind ${field.kind} and no module registered a JobInputRefSource for it`,
        );
      if (!source.listOptions)
        throw new Error(
          `job ${job.key} names ref kind ${field.kind} in its input, and that kind lists no options to pick from`,
        );
    }
}

/**
 * The engine's lifecycle in a host. At bootstrap (after every module's constructor, so every domain module's ref
 * source is registered) it runs the refs boot check. Before shutdown it stops the executor (it stops accepting, and the
 * worker's close drains in-flight jobs), so it drains before the host closes its Redis client in
 * `onApplicationShutdown`. The executor accepts from construction: Nest starts the worker in `onModuleInit`, before any
 * bootstrap hook, and a job skipped then would lose its wake-up.
 */
@Injectable()
export class JobEngineLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(
    @Inject(JOBS_EXECUTOR) private readonly executor: Stoppable,
    @Inject(JOBS_REGISTRY) private readonly registry: Registry,
    @Inject(JOBS_INPUT_REFS) private readonly refs: JobInputRefs,
    @Optional() @Inject(JOBS_WORKER) private readonly worker: boolean = false,
  ) {}

  /**
   * After every module's init, so every hook another module attaches (a bridge's, a scheduler's) is in place before
   * the first advance; the in-process executor's loop starts here when this process is a worker.
   */
  async onApplicationBootstrap(): Promise<void> {
    assertRefSourcesRegistered(this.registry, this.refs);
    if (this.worker) await this.executor.start?.();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.executor.stop();
  }
}
