
import { z } from 'zod';

export const CreateTicketSchema = z.object({
  accountId: z.guid().meta({ description: 'The id of an existing account (GET /accounts lists them). The example is a placeholder: replace it with a real id before sending.' }),
  assigneeId: z.guid().meta({ description: 'The id of an existing user (GET /users lists them). The example is a placeholder: replace it with a real id before sending.' }),
  title: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { accountId: '00000000-0000-4000-8000-000000000001', assigneeId: '00000000-0000-4000-8000-000000000001', title: 'Example title' } });

export type CreateTicketDto = z.infer<typeof CreateTicketSchema>;
