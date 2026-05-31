# Consumer Setup — Auth subsystem

> Part of the [Consumer Setup](../CONSUMER-SETUP.md) reference, split out for focused reading. In-project coding agents get the same material (progressively disclosed) from the `subsystems` skill (wiring) under `.claude/skills/`.

## Auth subsystem

The auth subsystem (ADR-031) ships `IAuthStrategy`, the abstract
`OAuth2RefreshStrategy` template-method base, `withAuthRetry`, token-at-rest
encryption (`IEncryptionKey` / `EnvEncryptionKey`), and an OAuth state-store
port. It is a runtime-only library — there is no `subsystem install auth`
command; consumers import the runtime directly and wire it into their
NestJS `AppModule`.

### Install

No scaffold. Import the module in `AppModule`:

```ts
import { AuthModule } from '@pattern-stack/codegen/runtime/subsystems/auth';

@Module({
  imports: [
    DatabaseModule,
    AuthModule.forRoot({
      encryptionKey: 'env',        // or: { useClass: MyKmsEncryptionKey }
      oauthStateStore: 'in-memory', // or: { useClass: RedisOAuthStateStore }
    }),
    // ... other subsystems + GENERATED_MODULES
  ],
})
export class AppModule {}
```

`AuthModule` is `global: true`. It provides `ENCRYPTION_KEY` and
`OAUTH_STATE_STORE` tokens. Defaults: `EnvEncryptionKey` (reads
`INTEGRATION_TOKEN_ENCRYPTION_KEY` from env) and `InMemoryOAuthStateStore`.

### Env vars

- `INTEGRATION_TOKEN_ENCRYPTION_KEY` — 32-byte base64 string. Required when
  `encryptionKey: 'env'`. Generate with `openssl rand -base64 32`.

### Environment setup

The `InMemoryOAuthStateStore` is dev-only (single-process). Production
deployments ship a Redis-backed implementation as a custom provider:

```ts
AuthModule.forRoot({
  oauthStateStore: { useClass: RedisOAuthStateStore },
});
```

Same for `EnvEncryptionKey` — production wants a KMS-backed impl
(`{ useClass: KmsEncryptionKey }`). The subsystem ships the env-backed
default for local dev + CI.

### Implement a provider strategy

Auth strategies are per-provider (Salesforce, HubSpot, Gmail, …) and live
in the integration module, not the subsystem. Each extends
`OAuth2RefreshStrategy` and overrides four hooks:

```ts
import {
  OAuth2RefreshStrategy,
  type ParsedRefreshResponse,
  type DecryptedConnection,
  type AuthCredentials,
} from '@pattern-stack/codegen/runtime/subsystems/auth';

export class SalesforceAuthStrategy extends OAuth2RefreshStrategy {
  protected readonly provider = 'salesforce-crm';
  protected readonly defaultExpiresInSec = 7200;

  protected tokenEndpoint(): string {
    return `https://${this.config.authDomain}/services/oauth2/token`;
  }

  protected refreshBodyExtras(): Record<string, string> {
    return {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    };
  }

  protected parseRefreshResponse(raw: unknown): ParsedRefreshResponse {
    const r = raw as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresInSec: r.expires_in,
    };
  }

  protected buildCredentials(
    accessToken: string,
    connection: DecryptedConnection,
    refreshRaw?: unknown,
  ): AuthCredentials {
    const raw = refreshRaw as { instance_url?: string } | undefined;
    return {
      accessToken,
      instanceUrl:
        raw?.instance_url ??
        (connection.providerMetadata?.['instanceUrl'] as string),
      apiVersion: this.config.apiVersion,
    };
  }
}
```

Register the strategy under a provider-specific token in your integration
module (there is no central `AUTH_STRATEGY` token):

```ts
export const SALESFORCE_AUTH_STRATEGY = Symbol('SALESFORCE_AUTH_STRATEGY');

@Module({
  providers: [
    {
      provide: SALESFORCE_AUTH_STRATEGY,
      useFactory: (reader, writer) =>
        new SalesforceAuthStrategy({
          connectionReader: reader,
          tokenWriter: writer,
          // ... provider config
        }),
      inject: [AUTH_CONNECTION_READER, AUTH_CONNECTION_TOKEN_WRITER],
    },
  ],
  exports: [SALESFORCE_AUTH_STRATEGY],
})
export class SalesforceAuthModule {}
```

### Connection-store ports — app-supplied

`OAuth2RefreshStrategy` depends on two narrow ports that read/write
connection rows. Consumers supply these as thin adapters over whatever
service owns the `connection` entity:

```ts
@Injectable()
export class ConnectionStoreAdapter
  implements IConnectionReader, IConnectionTokenWriter
{
  constructor(
    private readonly service: ConnectionService,
    private readonly refreshUseCase: RefreshConnectionUseCase,
  ) {}

  findByIdDecrypted(id: string) {
    return this.service.findByIdDecrypted(id);
  }

  persistRefresh(update: ConnectionTokenUpdate) {
    return this.refreshUseCase.execute(update);
  }
}

@Module({
  providers: [
    ConnectionStoreAdapter,
    { provide: AUTH_CONNECTION_READER, useExisting: ConnectionStoreAdapter },
    { provide: AUTH_CONNECTION_TOKEN_WRITER, useExisting: ConnectionStoreAdapter },
  ],
  exports: [AUTH_CONNECTION_READER, AUTH_CONNECTION_TOKEN_WRITER],
})
export class ConnectionStoreModule {}
```

The `examples/auth-integrations/definitions/entities/connection.yaml` starter
ships a canonical `connection` entity whose generated service + use case satisfy
these ports out of the box — tracked alongside the integration subsystem roadmap.

### Retry-once on session-expired

`withAuthRetry` wraps an op with resolve → run → force-refresh-on-session-
expired → retry once → propagate. Provider error classes participate by
extending `SessionExpiredError` OR by setting
`isSessionExpired === true` on their instances (duck-typed marker):

```ts
import { withAuthRetry } from '@pattern-stack/codegen/runtime/subsystems/auth';

const result = await withAuthRetry(salesforceAuth, connectionId, (creds) =>
  salesforceClient.listOpportunities(creds),
);
```

A custom classifier is supported via the options third argument when the
marker isn't practical.
