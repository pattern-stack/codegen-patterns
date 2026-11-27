// The smoke's principal source (ID-1), copied over the scaffold `subsystem install identity` writes: the principal is
// the `X-Smoke-Principal` header. A test's sign-in; never an app's (anyone can send a header).
import type { PrincipalSource } from '../shared/subsystems/identity/core';

export const principalSource: PrincipalSource = {
  principalOf: async (request) => request.header('X-Smoke-Principal') ?? null,
};
