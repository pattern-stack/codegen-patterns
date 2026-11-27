
import { z } from 'zod';

export const CreateCallSchema = z.object({
  accountId: z.guid().meta({ description: 'The id of an existing account (GET /accounts lists them). The example is a placeholder: replace it with a real id before sending.' }),
  callerId: z.guid().nullable().optional().meta({ description: 'The id of an existing contact (GET /contacts lists them). The example is a placeholder: replace it with a real id before sending.' }),
  regardingAccountId: z.guid().meta({ description: 'The id of an existing account (GET /accounts lists them). The example is a placeholder: replace it with a real id before sending.' }),
  subject: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { accountId: '00000000-0000-4000-8000-000000000001', regardingAccountId: '00000000-0000-4000-8000-000000000001', subject: 'Example subject' } });

export type CreateCallDto = z.infer<typeof CreateCallSchema>;
