/**
 * AuthModule — DynamicModule factory for the auth subsystem.
 *
 * Wires the pluggable backends the subsystem ships with:
 *   - `ENCRYPTION_KEY`      → `EnvEncryptionKey` (AES-256-GCM from env)
 *   - `OAUTH_STATE_STORE`   → `MemoryOAuthStateStore` (dev/tests) or
 *                             `DrizzleOAuthStateStore` (prod, requires
 *                             DRIZZLE provider).
 *   - `AUTH_OPTIONS`        → resolved options bag (used by AuthController
 *                             for `redirectUriBase`).
 *
 * The integration-store ports (`AUTH_INTEGRATION_READER`,
 * `AUTH_INTEGRATION_TOKEN_WRITER`, `AUTH_INTEGRATION_GRANT_SINK`),
 * `AUTH_USER_CONTEXT`, and `STRATEGY_REGISTRY` are deliberately **not**
 * wired here — they are always consumer-specific:
 *   - integration-store ports adapt the consumer's `integrations` storage;
 *   - `IUserContext` adapts the app's session/JWT scheme;
 *   - `STRATEGY_REGISTRY` is populated from the per-provider strategy
 *     classes the consumer maintains.
 *
 * Consumers provide them in their app module (or by importing the
 * `auth-integrations` starter, which binds the three integration-store
 * ports off a single canonical entity).
 *
 * Usage in AppModule:
 * ```typescript
 * AuthModule.forRoot({
 *   encryptionKey: 'env',
 *   oauthStateStore: 'memory',          // or 'drizzle'
 *   enableController: true,
 *   redirectUriBase: 'http://localhost:3000',
 * });
 * ```
 *
 * `global: true` means other modules don't need to re-import AuthModule to
 * inject the auth tokens.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  AUTH_OPTIONS,
  ENCRYPTION_KEY,
  OAUTH_STATE_STORE,
} from './auth.tokens';
import { EnvEncryptionKey } from './backends/encryption-key/env';
import { MemoryOAuthStateStore } from './backends/state-store.memory-backend';
import { DrizzleOAuthStateStore } from './backends/state-store.drizzle-backend';
import { AuthController } from './controllers/auth.controller';
import { DRIZZLE } from '../../constants/tokens';
import type { DrizzleClient } from '../../types/drizzle';

type EncryptionKeyChoice =
  | 'env'
  | Omit<Provider, 'provide'>;

type OAuthStateStoreChoice =
  | 'memory'
  | 'drizzle'
  | Omit<Provider, 'provide'>;

export interface AuthModuleOptions {
  /** `'env'` (default) or a full provider definition (e.g. `{ useClass: MyKmsEncryptionKey }`). */
  encryptionKey?: EncryptionKeyChoice;
  /**
   * `'memory'` (default — tests/dev) or `'drizzle'` (prod, requires DRIZZLE
   * provider) or a full provider definition for a custom impl.
   */
  oauthStateStore?: OAuthStateStoreChoice;
  /**
   * Mount `AuthController` (`/auth/:provider/connect` + `/callback`).
   * Default `false` — apps that hand-roll connect/callback (rare) or that
   * use the subsystem only for the refresh path can opt out.
   */
  enableController?: boolean;
  /**
   * Public base URL of the API server. Used to construct per-provider
   * callback URIs as `${redirectUriBase}/auth/:provider/callback`.
   * Required when `enableController: true`.
   */
  redirectUriBase?: string;
}

function resolveEncryptionKeyProvider(choice: EncryptionKeyChoice): Provider {
  if (choice === 'env') {
    return { provide: ENCRYPTION_KEY, useClass: EnvEncryptionKey };
  }
  return { provide: ENCRYPTION_KEY, ...choice } as Provider;
}

function resolveOAuthStateStoreProvider(
  choice: OAuthStateStoreChoice,
): Provider {
  if (choice === 'memory') {
    return { provide: OAUTH_STATE_STORE, useClass: MemoryOAuthStateStore };
  }
  if (choice === 'drizzle') {
    return {
      provide: OAUTH_STATE_STORE,
      useFactory: (db: DrizzleClient | null) => {
        if (!db) {
          throw new Error(
            "AuthModule.forRoot: oauthStateStore: 'drizzle' selected but DRIZZLE provider is not available. " +
              'Ensure DatabaseModule (or another provider exposing DRIZZLE) is imported before AuthModule.forRoot.',
          );
        }
        return new DrizzleOAuthStateStore(db);
      },
      inject: [{ token: DRIZZLE, optional: true }],
    };
  }
  return { provide: OAUTH_STATE_STORE, ...choice } as Provider;
}

@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    const resolved: AuthModuleOptions = {
      encryptionKey: options.encryptionKey ?? 'env',
      oauthStateStore: options.oauthStateStore ?? 'memory',
      enableController: options.enableController ?? false,
      redirectUriBase: options.redirectUriBase,
    };

    if (resolved.enableController && !resolved.redirectUriBase) {
      throw new Error(
        'AuthModule.forRoot: redirectUriBase is required when enableController: true',
      );
    }

    const encryptionKeyProvider = resolveEncryptionKeyProvider(
      resolved.encryptionKey ?? 'env',
    );
    const oauthStateStoreProvider = resolveOAuthStateStoreProvider(
      resolved.oauthStateStore ?? 'memory',
    );
    const optionsProvider: Provider = {
      provide: AUTH_OPTIONS,
      useValue: resolved,
    };

    return {
      module: AuthModule,
      global: true,
      providers: [encryptionKeyProvider, oauthStateStoreProvider, optionsProvider],
      controllers: resolved.enableController ? [AuthController] : [],
      exports: [ENCRYPTION_KEY, OAUTH_STATE_STORE, AUTH_OPTIONS],
    };
  }
}
