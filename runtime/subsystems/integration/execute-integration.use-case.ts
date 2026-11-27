/**
 * ExecuteIntegrationUseCase — the integration orchestrator under Nest's DI (SYNC-5).
 *
 * The orchestration is `IntegrationRunner` (`integration-runner.ts`, framework-free, S-3); this class binds its parts
 * to the integration tokens, so a Nest assembly provides it as a class. See the runner for the flow.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { IChangeSource } from './integration-change-source.protocol';
import type { ICursorStore } from './integration-cursor-store.protocol';
import type { IFieldDiffer } from './integration-field-diff.protocol';
import type { IIntegrationSink } from './integration-sink.protocol';
import type { IIntegrationRunRecorder } from './integration-run-recorder.protocol';
import type { IIntegrationChangeEmitter } from './integration-change-emitter.protocol';
import {
  INTEGRATION_CHANGE_EMITTER,
  INTEGRATION_CHANGE_SOURCE,
  INTEGRATION_CURSOR_STORE,
  INTEGRATION_FIELD_DIFFER,
  INTEGRATION_MULTI_TENANT,
  INTEGRATION_RUN_RECORDER,
  INTEGRATION_SINK,
} from './integration.tokens';
import { IntegrationRunner } from './integration-runner';

export type { ExecuteIntegrationInput, ExecuteIntegrationResult } from './integration-runner';

@Injectable()
export class ExecuteIntegrationUseCase<T extends Record<string, unknown>> extends IntegrationRunner<T> {
  constructor(
    @Inject(INTEGRATION_CHANGE_SOURCE) source: IChangeSource<T>,
    @Inject(INTEGRATION_CURSOR_STORE) cursors: ICursorStore,
    @Inject(INTEGRATION_FIELD_DIFFER) differ: IFieldDiffer<T>,
    @Inject(INTEGRATION_SINK) sink: IIntegrationSink<T>,
    @Inject(INTEGRATION_RUN_RECORDER) recorder: IIntegrationRunRecorder,
    @Optional()
    @Inject(INTEGRATION_MULTI_TENANT)
    multiTenant: boolean = false,
    // EMIT-CHANGES seam: bound only by assemblies whose entity opts into `integration.sink.emit_changes: true`.
    @Optional()
    @Inject(INTEGRATION_CHANGE_EMITTER)
    emitter: IIntegrationChangeEmitter | null = null,
  ) {
    super({ source, cursors, differ, sink, recorder, multiTenant, emitter });
  }
}
