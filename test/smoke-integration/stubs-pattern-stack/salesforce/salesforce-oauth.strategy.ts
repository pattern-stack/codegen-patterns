import type {
	AuthCredentials,
	AuthResolveOptions,
	IAuthStrategy,
} from '@pattern-stack/codegen/runtime/subsystems/auth/core';

// Author-owned OAuth strategy (consumer's responsibility, not codegen's), with no decorator: under
// `wiring: pattern-stack` the provider's factory (`salesforce.provider.factory.ts`) constructs it.
export class SalesforceOAuthStrategy implements IAuthStrategy {
	async resolve(
		_connectionId: string,
		_options?: AuthResolveOptions,
	): Promise<AuthCredentials> {
		throw new Error('stub');
	}
}
