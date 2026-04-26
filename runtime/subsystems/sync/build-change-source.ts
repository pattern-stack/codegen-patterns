/**
 * Sync subsystem — `buildChangeSource()` runtime factory (#250, ADR-033.1 b).
 *
 * Mode-dispatching constructor for `IChangeSource<T>`. Codegen-emitted
 * provider modules call this from `useFactory` once they've resolved the
 * provider-keyed `fetches[provider]` callback and parsed the per-entity
 * `DetectionConfig`. Switching is on `cfg.mode` so the option-bag shape
 * difference between primitives (`adapter` vs. `queue`) stays internal —
 * consumers pass one fetch callback regardless of mode.
 */
import type { DetectionConfig } from './detection-config.schema';
import type { IChangeSource } from './sync-change-source.protocol';
import type { ChangeMiddleware } from './sync-middleware.protocol';
import {
  PollChangeSource,
  type PollFetchCallback,
} from './poll-change-source';
import {
  WebhookChangeSource,
  type WebhookFetchCallback,
} from './webhook-change-source';

export function buildChangeSource<T>(
  cfg: DetectionConfig,
  fetch: PollFetchCallback<T> | WebhookFetchCallback<T>,
  middlewares: ReadonlyArray<ChangeMiddleware<T>> = [],
): IChangeSource<T> {
  switch (cfg.mode) {
    case 'poll':
      return new PollChangeSource<T>({
        adapter: fetch as PollFetchCallback<T>,
        config: cfg,
        middlewares,
      });
    case 'webhook':
      return new WebhookChangeSource<T>({
        queue: fetch as WebhookFetchCallback<T>,
        config: cfg,
        middlewares,
      });
  }
}
