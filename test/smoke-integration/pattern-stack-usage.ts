/**
 * The integrations module as a consumer uses it (S-3), compiled with the pattern-stack leg's project: a run is read by
 * `<surface>.<entity>.<provider>`, and the adapters system hands out each provider's adapter. Not run (no database).
 */
import type { IntegrationRunner } from '@pattern-stack/codegen/runtime/subsystems/integration/core';
import type { composeApp } from './compose';
import type { ContactIntegrationProjection } from './modules/contacts/contact.repository';
import type { SalesforceCrmAdapter } from './integrations/crm/adapters/salesforce/salesforce-crm.adapter';

export async function syncContacts(app: ReturnType<typeof composeApp>, subscriptionId: string): Promise<void> {
  const run: IntegrationRunner<ContactIntegrationProjection> = app.module('integrations').crm.contact.salesforce;
  await run.execute({
    subscription: { id: subscriptionId, domain: 'contact' },
    userId: 'system',
    provider: 'salesforce',
    direction: 'inbound',
    action: 'poll',
  });
  const adapter: SalesforceCrmAdapter = app.system('crmAdapters').adapters.salesforce;
  void adapter.capabilities;
  void app.system('crmAdapters').sources();
}
