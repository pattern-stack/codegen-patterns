---
to: src/infrastructure/broadcast/broadcast-backend.interface.ts
force: true
---
export type BroadcastHandler = (
  eventType: string,
  payload: Record<string, unknown>,
) => Promise<void>

export interface BroadcastBackend {
  /**
   * Broadcast an event to all subscribers of a channel
   */
  broadcast(
    channel: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void>

  /**
   * Subscribe to events on a channel (server-side)
   */
  subscribe(channel: string, handler: BroadcastHandler): Promise<void>

  /**
   * Unsubscribe from a channel (server-side)
   */
  unsubscribe(channel: string): Promise<void>

  /**
   * Whether this backend supports pushing events to clients
   * (WebSocket = true, Memory = false for server-only use)
   */
  readonly supportsPush: boolean

  /**
   * Check if the backend is healthy and connected
   */
  healthCheck(): Promise<boolean>

  /**
   * Clean up resources and close connections
   */
  close(): Promise<void>
}

export const BROADCAST_BACKEND = Symbol('BROADCAST_BACKEND')
