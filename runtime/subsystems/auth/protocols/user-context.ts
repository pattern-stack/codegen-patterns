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
export interface IUserContext {
  getCurrentUserId(req: unknown): Promise<string>;
}
