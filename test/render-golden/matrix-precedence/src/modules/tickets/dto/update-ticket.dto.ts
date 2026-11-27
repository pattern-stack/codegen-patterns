
import { z } from 'zod';
import { CreateTicketSchema } from './create-ticket.dto';

export const UpdateTicketSchema = CreateTicketSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { title: 'Example title' } });

export type UpdateTicketDto = z.infer<typeof UpdateTicketSchema>;
