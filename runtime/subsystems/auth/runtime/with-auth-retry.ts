/**
 * Run `op` with auth-aware retry-once on session-expired errors.
 *
 * Pattern: resolve creds → run op → if `isSessionExpired(e)` → resolve with
 * `forceRefresh: true` → retry → propagate. A second session-expired error
 * on the refreshed token propagates rather than looping, so transient
 * adapter bugs can't hang the caller.
 *
 * Generalisation over the extraction source's SFDC-specific original: the
 * session-expired classifier is injected. Providers mark their session-
 * expired errors (via `instanceof` of a marker class, or by setting a known
 * property) and pass a classifier matching that shape.
 *
 * Default classifier recognises the marker interface `SessionExpiredError`
 * shipped in `session-expired.error.ts` — concrete provider errors that
 * extend it (or set `isSessionExpired === true`) get retried without any
 * further wiring.
 */
import type {
  AuthCredentials,
  IAuthStrategy,
} from '../protocols/auth-strategy';
import { isSessionExpiredError } from './session-expired.error';

export interface WithAuthRetryOptions {
  /**
   * Classifier that decides whether a thrown error is a session-expired
   * signal worth retrying once with a fresh token. Defaults to the marker-
   * interface check in `session-expired.error.ts`.
   */
  isSessionExpired?: (err: unknown) => boolean;
}

export async function withAuthRetry<T>(
  authStrategy: IAuthStrategy,
  connectionId: string,
  op: (credentials: AuthCredentials) => Promise<T>,
  options: WithAuthRetryOptions = {},
): Promise<T> {
  const classify = options.isSessionExpired ?? isSessionExpiredError;

  let creds = await authStrategy.resolve(connectionId);
  try {
    return await op(creds);
  } catch (e) {
    if (!classify(e)) throw e;
    creds = await authStrategy.resolve(connectionId, { forceRefresh: true });
    return op(creds);
  }
}
