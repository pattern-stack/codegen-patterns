/**
 * RequesterContext boundary install — bridges authentication to ambient
 * tenant scoping.
 *
 * This is the missing link that makes `BaseRepository`'s ambient scoping
 * (see `base-classes/tenant-context.ts`) actually engage on HTTP requests:
 * it reads the requester off each request (via the consumer-bound
 * `IUserContext`) and runs the rest of the request inside `withRequester(...)`,
 * so every downstream repository read/write is automatically scoped — no
 * threaded `userId`.
 *
 * ## Wiring (one line in your bootstrap)
 *
 * In `main.ts`, after `NestFactory.create`:
 *
 * ```ts
 * import { installRequesterContext } from './shared/subsystems/auth/middleware/requester-context';
 * const app = await NestFactory.create(AppModule);
 * installRequesterContext(app); // no-op + warn if AUTH_USER_CONTEXT is unbound
 * ```
 *
 * `installRequesterContext` resolves `AUTH_USER_CONTEXT` from the root DI
 * container (so it sees the binding the consumer provides in AppModule) and
 * registers a global Express middleware. Pairs with Swagger's `@ApiBearerAuth`
 * "Authorize" button: paste a token there and every request it sends now flows
 * through this boundary into a scoped repository call.
 *
 * ## Trust + failure model
 *
 * - The middleware TRUSTS whatever `IUserContext` returns — authentication and
 *   authorization (validating the token, deciding which scope a requester may
 *   claim) are the `IUserContext` implementation's job, exactly as for a
 *   hand-threaded `userId`.
 * - When the requester cannot be resolved (no/invalid credentials — e.g. a
 *   public route, or the OAuth callback itself), the request proceeds WITHOUT
 *   an ambient context (`onUnresolved: 'unscoped'`, the default). A
 *   `userTracking` repo in lenient mode then runs unscoped; in strict mode it
 *   throws downstream — which is correct: unauthenticated callers must not
 *   reach scoped data. Set `onUnresolved: 'reject'` to fail the request at the
 *   boundary instead.
 */
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import {
  withRequester,
  type RequesterContext,
} from '../../../base-classes/tenant-context';
import { AUTH_USER_CONTEXT } from '../auth.tokens';
import type { IUserContext } from '../protocols/user-context';

/** Minimal Express-style middleware signature (avoids an `express` dep). */
type NextFn = (err?: unknown) => void;
type RequestHandler = (req: unknown, res: unknown, next: NextFn) => void;

export interface RequesterContextOptions {
  /**
   * What to do when `IUserContext` cannot resolve a requester (throws, or
   * returns no `userId`).
   * - `'unscoped'` (default): proceed without a context — public routes work;
   *   scoped repos run unscoped (lenient) or throw downstream (strict).
   * - `'reject'`: fail the request at the boundary (`next(error)`).
   */
  onUnresolved?: 'unscoped' | 'reject';
}

/**
 * Resolve the ambient context for a request: prefer the richer
 * `resolveRequester` (org/superuser), else derive plain `'user'` scope from
 * `getCurrentUserId`. Returns `undefined` when no requester can be determined.
 */
export async function resolveRequesterContext(
  userContext: IUserContext,
  req: unknown,
): Promise<RequesterContext | undefined> {
  if (typeof userContext.resolveRequester === 'function') {
    const ctx = await userContext.resolveRequester(req);
    return ctx?.userId ? ctx : undefined;
  }
  const userId = await userContext.getCurrentUserId(req);
  return userId ? { userId, organizationId: null } : undefined;
}

/**
 * Build the global middleware. Runs the remainder of the request inside
 * `withRequester(...)` so the ambient context propagates through every `await`
 * to downstream repositories.
 */
export function makeRequesterContextMiddleware(
  userContext: IUserContext,
  options: RequesterContextOptions = {},
): RequestHandler {
  const onUnresolved = options.onUnresolved ?? 'unscoped';
  return (req, _res, next) => {
    resolveRequesterContext(userContext, req).then(
      (ctx) => {
        if (!ctx) {
          next();
          return;
        }
        // als.run executes its callback synchronously; Express dispatches the
        // rest of the pipeline inside next(), so all downstream handlers (and
        // their awaits) inherit this context.
        withRequester(ctx, async () => {
          next();
        });
      },
      (err) => {
        if (onUnresolved === 'reject') {
          next(err);
          return;
        }
        next();
      },
    );
  };
}

/**
 * The consumer's `IUserContext` bound under `AUTH_USER_CONTEXT`, or `null` when
 * nothing is bound (#651). Every "is it bound?" probe goes through here: this
 * helper, and the generated `main.ts` boot-fail check (ADR-043 §4).
 *
 * For an unbound token Nest's `app.get(token, { strict: false })` THROWS
 * `UnknownElementException` — it never returns `undefined`. On an HTTP app
 * created with the default `abortOnError: true`, Nest's exception-zone proxy
 * turns that throw into `process.exit(1)` before any caller can catch it, so
 * the app must be created with `NestFactory.create(AppModule, { abortOnError:
 * false })` — the generated `main.ts` does, and `project upgrade-auth` patches
 * it in. (A symbol token, not `ModuleRef`: a class token breaks when two
 * `@nestjs/core` copies meet, ADR-037.) Any other error propagates.
 */
export function resolveUserContext(app: INestApplicationContext): IUserContext | null {
  try {
    return app.get<IUserContext>(AUTH_USER_CONTEXT, { strict: false }) ?? null;
  } catch (err) {
    // Matched by name: the class lives under `@nestjs/core/errors`, and a
    // package-mode app may hold a second copy of it (ADR-037).
    if (err instanceof Error && err.constructor.name === 'UnknownElementException') return null;
    throw err;
  }
}

/**
 * Register the requester-context boundary on a Nest app. Resolves
 * `AUTH_USER_CONTEXT` from the root container (so it sees the consumer's
 * AppModule binding) and installs the global middleware. No-ops with a warning
 * when `AUTH_USER_CONTEXT` is not bound, so calling it unconditionally in
 * bootstrap is safe.
 */
export function installRequesterContext(
  app: INestApplication,
  options: RequesterContextOptions = {},
): void {
  const userContext = resolveUserContext(app);
  if (!userContext) {
    // eslint-disable-next-line no-console
    console.warn(
      '[auth] installRequesterContext: AUTH_USER_CONTEXT is not bound — ' +
        'request scoping NOT installed. Provide an IUserContext under ' +
        'AUTH_USER_CONTEXT in your AppModule to enable ambient tenant scoping.',
    );
    return;
  }
  app.use(makeRequesterContextMiddleware(userContext, options));
}
