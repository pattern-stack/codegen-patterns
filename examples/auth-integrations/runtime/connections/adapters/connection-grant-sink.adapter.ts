import { Injectable } from '@nestjs/common';
import type {
  IConnectionGrantSink,
  ConnectionGrantInput,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { CreateOrUpdateFromOAuthGrantUseCase } from '../oauth/use-cases/create-or-update-from-oauth-grant.use-case';

/**
 * `IConnectionGrantSink` adapter — pass-through to
 * `CreateOrUpdateFromOAuthGrantUseCase`. The auth subsystem's
 * `AuthController.callback` invokes this after
 * `IProviderStrategy.exchangeCodeForTokens`.
 *
 * This adapter injects the use case directly (not the
 * `ConnectionsService` facade) for symmetry with the reader and
 * token-writer adapters, which also bypass the facade and talk to
 * the codegen-emitted layer directly. The port and the use case share
 * the exact same `ConnectionGrantInput` shape, so no field mapping is
 * needed — encryption, upsert resolution, and status handling all live
 * inside the use case.
 */
@Injectable()
export class ConnectionGrantSinkAdapter implements IConnectionGrantSink {
  constructor(private readonly useCase: CreateOrUpdateFromOAuthGrantUseCase) {}

  async createOrUpdateFromOAuthGrant(input: ConnectionGrantInput): Promise<void> {
    await this.useCase.execute(input);
  }
}
