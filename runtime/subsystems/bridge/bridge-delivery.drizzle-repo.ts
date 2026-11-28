/**
 * `DrizzleBridgeDeliveries` (framework-free, J-1) as the Nest host's `BRIDGE_DELIVERY_REPO`: the app's Drizzle client
 * and the bridge's multi-tenant flag injected.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';

import { DRIZZLE } from '../../constants/tokens';
import type { DrizzleClient } from '../../types/drizzle';
import { DrizzleBridgeDeliveries } from './bridge-delivery.drizzle-backend';
import { BRIDGE_MULTI_TENANT } from './bridge.tokens';

@Injectable()
export class DrizzleBridgeDeliveryRepo extends DrizzleBridgeDeliveries {
  constructor(
    @Inject(DRIZZLE) db: DrizzleClient,
    @Optional() @Inject(BRIDGE_MULTI_TENANT) multiTenant: boolean = false,
  ) {
    super(db, multiTenant);
  }
}
