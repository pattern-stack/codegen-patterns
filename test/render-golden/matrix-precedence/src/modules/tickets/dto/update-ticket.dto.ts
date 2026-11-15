
import { z } from 'zod';
import { CreateTicketSchema } from './create-ticket.dto';

export const UpdateTicketSchema = CreateTicketSchema.partial();

export type UpdateTicketDto = z.infer<typeof UpdateTicketSchema>;
