// CONSUMER-OWNED, not generated.
//
// `locations.frontendCollectionsAuth` (default import `@/lib/collections/auth`)
// names the module the emitted collections and api client import
// `frontend.auth.function` from — `getAuthorizationHeader` by default
// (ADR-043). Supplying it keeps the smoke on the DEFAULT auth path rather than
// switching it off, so the emitted `Authorization:` header lines are compiled
// too.
export function getAuthorizationHeader(): string {
	return 'Bearer smoke';
}
