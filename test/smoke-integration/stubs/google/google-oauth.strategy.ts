import { Injectable } from '@nestjs/common';
import type {
	AuthCredentials,
	AuthResolveOptions,
	IAuthStrategy,
} from '@pattern-stack/codegen/subsystems';

// Author-owned OAuth strategy (consumer's responsibility, not codegen's).
// Referenced by `google.yaml` via
// `auth.strategy: '@app/integrations/providers/google/google-oauth.strategy#GoogleOAuthStrategy'`.
@Injectable()
export class GoogleOAuthStrategy implements IAuthStrategy {
	async resolve(
		_connectionId: string,
		_options?: AuthResolveOptions,
	): Promise<AuthCredentials> {
		throw new Error('stub');
	}
}
