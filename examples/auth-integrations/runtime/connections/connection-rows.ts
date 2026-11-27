import type { Connection } from './connection.entity';

/**
 * The connection rows the store reads and writes, structurally: the members of the generated `ConnectionService` (what
 * `ConnectionsAuthModule` passes under Nest) and of `ConnectionRepository` (what the pattern-stack `connections`
 * system passes, S-2) that the adapters, the facade and the use cases call. Both satisfy it as generated.
 */
export interface ConnectionRows {
  findById(id: string): Promise<Connection | null>;
  findByUserIdAndProvider(userId: string, provider: string): Promise<Connection | null>;
  findByUserId(userId: string): Promise<Connection[]>;
  create(input: Partial<Connection>): Promise<Connection>;
  update(id: string, input: Partial<Connection>): Promise<Connection>;
}
