import { Injectable } from '@nestjs/common';

// Author-owned provider client (consumer's responsibility, not codegen's).
// Referenced by `salesforce.yaml` via
// `client.class: '@app/integrations/providers/salesforce/salesforce.client#SalesforceClient'`.
@Injectable()
export class SalesforceClient {}
