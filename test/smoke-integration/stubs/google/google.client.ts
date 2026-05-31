import { Injectable } from '@nestjs/common';

// Author-owned provider client (consumer's responsibility, not codegen's).
// The fixture provider `google.yaml` references this class via
// `client.class: '@app/integrations/providers/google/google.client#GoogleClient'`.
@Injectable()
export class GoogleClient {}
