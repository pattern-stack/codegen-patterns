/**
 * Auth subsystem — `IUserContext` port.
 *
 * Resolves "who is the current user" from a request. The shape is
 * universal; the implementation is always app-specific:
 *
 *   - WorkOS session:   `req.session.user.id`
 *   - JWT bearer:       `decode(req.headers.authorization).sub`
 *   - Test fixture:     hardcoded UUID
 *
 * The auth subsystem cannot ship a default — every app does auth differently —
 * but the port is universal, so the contract ships here. Consumers bind a
 * concrete implementation under the `AUTH_USER_CONTEXT` token in their app
 * module.
 *
 * `req` is typed as `unknown` deliberately: this protocol must not pull a
 * dependency on `express` / `fastify` / NestJS request types. The concrete
 * adapter narrows it (e.g. via a `Request` import).
 */
import type { RequesterContext } from '../../../base-classes/tenant-context';

export interface IUserContext {
  getCurrentUserId(req: unknown): Promise<string>;
  /**
   * Optional richer resolution of the full ambient requester context — the
   * org/superuser dimensions on top of `userId`. When implemented, the
   * `RequesterContextMiddleware` (see `../middleware/requester-context`) uses
   * it verbatim to scope reads/writes; when omitted, the middleware falls back
   * to `{ userId: await getCurrentUserId(req), organizationId: null }` (plain
   * `'user'` scope).
   *
   * Implement this when the app supports org-shared (`'org'`) or admin
   * (`'superuser'`) data visibility — resolve `organizationId` + the
   * `orgUserIds` member list here, at the trust boundary, so repositories stay
   * single-table. AUTHORIZATION (which scope a requester may claim) is the
   * implementation's responsibility; the repo trusts what this returns.
   */
  resolveRequester?(req: unknown): Promise<RequesterContext>;
}
