/**
 * AuthModule — DynamicModule factory for the auth subsystem.
 *
 * Wires the two pluggable backends the subsystem ships with:
 *   - `ENCRYPTION_KEY`       → `EnvEncryptionKey` (AES-256-GCM from env)
 *   - `OAUTH_STATE_STORE`    → `InMemoryOAuthStateStore` (dev) / custom Redis impl (prod)
 *
 * The two integration-store ports (`AUTH_INTEGRATION_READER`,
 * `AUTH_INTEGRATION_TOKEN_WRITER`) are deliberately **not** wired by this
 * module — they are always consumer-specific (adapters over the app's own
 * integrations entity/service). Consumers provide them in the module that
 * owns the integrations domain, not here.
 *
 * `IAuthStrategy` implementations are also per-provider and live in the
 * integration module that uses them (`SalesforceModule`, `HubSpotModule`, …).
 * The subsystem provides the abstract base class
 * (`OAuth2RefreshStrategy`) — binding concrete strategies is an app concern.
 *
 * Usage in AppModule:
 * ```typescript
 * AuthModule.forRoot({
 *   encryptionKey: 'env',
 *   oauthStateStore: 'in-memory',
 * });
 * ```
 *
 * Or inject custom providers directly:
 * ```typescript
 * AuthModule.forRoot({
 *   encryptionKey: { useClass: MyKmsEncryptionKey },
 *   oauthStateStore: { useClass: RedisOAuthStateStore },
 * });
 * ```
 *
 * `global: true` means other modules don't need to re-import AuthModule to
 * inject `ENCRYPTION_KEY` / `OAUTH_STATE_STORE`.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ENCRYPTION_KEY, OAUTH_STATE_STORE } from './auth.tokens';
import { EnvEncryptionKey } from './backends/encryption-key/env';
import { InMemoryOAuthStateStore } from './backends/oauth-state-store/in-memory';

type EncryptionKeyChoice =
  | 'env'
  | Omit<Provider, 'provide'>;

type OAuthStateStoreChoice =
  | 'in-memory'
  | Omit<Provider, 'provide'>;

export interface AuthModuleOptions {
  /** `'env'` (default) or a full provider definition (e.g. `{ useClass: MyKmsEncryptionKey }`). */
  encryptionKey?: EncryptionKeyChoice;
  /** `'in-memory'` (default) or a full provider definition for a Redis/DB impl. */
  oauthStateStore?: OAuthStateStoreChoice;
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
  if (choice === 'in-memory') {
    return { provide: OAUTH_STATE_STORE, useClass: InMemoryOAuthStateStore };
  }
  return { provide: OAUTH_STATE_STORE, ...choice } as Provider;
}

@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    const encryptionKeyProvider = resolveEncryptionKeyProvider(
      options.encryptionKey ?? 'env',
    );
    const oauthStateStoreProvider = resolveOAuthStateStoreProvider(
      options.oauthStateStore ?? 'in-memory',
    );

    return {
      module: AuthModule,
      global: true,
      providers: [encryptionKeyProvider, oauthStateStoreProvider],
      exports: [ENCRYPTION_KEY, OAUTH_STATE_STORE],
    };
  }
}
