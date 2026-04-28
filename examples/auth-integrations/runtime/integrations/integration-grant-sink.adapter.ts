import { Injectable } from '@nestjs/common';
import type {
  IIntegrationGrantSink,
  IntegrationGrantInput,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { CreateOrUpdateFromOAuthGrantUseCase } from './use-cases/create-or-update-from-oauth-grant.use-case';

/**
 * `IIntegrationGrantSink` adapter — pass-through to
 * `CreateOrUpdateFromOAuthGrantUseCase`. The auth subsystem's
 * `AuthController.callback` invokes this after
 * `ProviderStrategy.exchangeCodeForTokens`.
 *
 * This adapter injects the use case directly (not the
 * `IntegrationsService` facade) for symmetry with the reader and
 * token-writer adapters, which also bypass the facade and talk to
 * the codegen-emitted layer directly. The port and the use case share
 * the exact same `IntegrationGrantInput` shape, so no field mapping is
 * needed — encryption, upsert resolution, and status handling all live
 * inside the use case.
 */
@Injectable()
export class IntegrationGrantSinkAdapter implements IIntegrationGrantSink {
  constructor(private readonly useCase: CreateOrUpdateFromOAuthGrantUseCase) {}

  async createOrUpdateFromOAuthGrant(input: IntegrationGrantInput): Promise<void> {
    await this.useCase.execute(input);
  }
}
