/** Canonical package namespace for cross-boundary DI token keys. MUST be a hardcoded
 *  constant (NOT derived from package.json) so a vendored copy — which lives inside the
 *  CONSUMER's package — produces the identical key and the two copies share the symbol. */
export const PKG = '@pattern-stack/codegen';
// TODO(token-version): if/when a runtime contract version is adopted, inject it HERE only
//   (e.g. `${PKG}#${ABI}.${area}.${name}`) — this helper is the single chokepoint.
export const tokenKey = (area: string, name: string): string => `${PKG}.${area}.${name}`;
