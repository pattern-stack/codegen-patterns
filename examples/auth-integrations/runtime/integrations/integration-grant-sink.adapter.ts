import { Injectable } from '@nestjs/common';
import type {
  IIntegrationGrantSink,
  IntegrationGrantInput,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { IntegrationsService } from './integrations.service';

/**
 * `IIntegrationGrantSink` adapter — pass-through to
 * `IntegrationsService.createOrUpdateFromOAuthGrant`. The auth
 * subsystem's `AuthController.callback` invokes this after
 * `ProviderStrategy.exchangeCodeForTokens`.
 *
 * This adapter is intentionally a one-line forwarder. The port and
 * the facade share the exact same `IntegrationGrantInput` shape, so
 * no field mapping is needed — encryption, upsert resolution, and
 * status handling all live inside the use case behind the facade.
 */
@Injectable()
export class IntegrationGrantSinkAdapter implements IIntegrationGrantSink {
  constructor(private readonly integrations: IntegrationsService) {}

  async createOrUpdateFromOAuthGrant(input: IntegrationGrantInput): Promise<void> {
    await this.integrations.createOrUpdateFromOAuthGrant(input);
  }
}
