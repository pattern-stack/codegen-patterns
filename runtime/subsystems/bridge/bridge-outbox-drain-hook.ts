/**
 * BridgeOutboxDrainHook — the event → job bridge as the Nest host's provider (ADR-023, JOBS-3): `BridgeOutboxDrainer`
 * (framework-free, J-1, which documents the drain) over `JobStarter`, the `BRIDGE_DELIVERY_REPO` ledger and the
 * generated `BRIDGE_REGISTRY`, its trigger check at bootstrap. A Nest client error (a 4xx: the budget refusal as
 * `JobsService` maps it) is a trigger fault too.
 */
import { HttpException, Inject, Injectable, type OnApplicationBootstrap, Optional } from '@nestjs/common';

import { JobStarter } from '../jobs/job-starter';
import { BridgeOutboxDrainer } from './bridge-outbox-drainer';
import { BRIDGE_DELIVERY_REPO, BRIDGE_REGISTRY } from './bridge.tokens';
import type { BridgeRegistry, IJobBridge } from './bridge.protocol';

@Injectable()
export class BridgeOutboxDrainHook extends BridgeOutboxDrainer implements OnApplicationBootstrap {
  constructor(
    jobs: JobStarter,
    @Inject(BRIDGE_DELIVERY_REPO) deliveries: IJobBridge,
    @Optional()
    @Inject(BRIDGE_REGISTRY)
    registry: BridgeRegistry = {},
  ) {
    super(jobs, deliveries, registry);
  }

  /** Every trigger names a job this app registers, or the boot stops (`assertTriggersRegistered`). */
  onApplicationBootstrap(): void {
    this.assertTriggersRegistered();
  }

  protected override isTriggerFault(err: unknown): boolean {
    return super.isTriggerFault(err) || (err instanceof HttpException && err.getStatus() < 500);
  }
}
