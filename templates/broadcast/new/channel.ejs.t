---
to: src/infrastructure/broadcast/channel.ts
force: true
---
import type { BroadcastBackend, BroadcastHandler } from './broadcast-backend.interface'

/**
 * Channel wrapper providing a scoped API for broadcasting and subscribing
 * to events on a specific channel.
 *
 * @example
 * ```typescript
 * const sessionChannel = new Channel(backend, 'session')
 * await sessionChannel.emit('session.running', { sessionId: '123', appUrl: 'http://...' })
 * ```
 */
export class Channel {
  constructor(
    private readonly backend: BroadcastBackend,
    public readonly name: string,
  ) {}

  /**
   * Emit an event to all subscribers of this channel
   */
  async emit(eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.backend.broadcast(this.name, eventType, payload)
  }

  /**
   * Subscribe to events on this channel (server-side)
   */
  async subscribe(handler: BroadcastHandler): Promise<void> {
    await this.backend.subscribe(this.name, handler)
  }

  /**
   * Unsubscribe all handlers from this channel (server-side)
   */
  async unsubscribe(): Promise<void> {
    await this.backend.unsubscribe(this.name)
  }
}

/**
 * Predefined channel names for domain events
 */
export const Channels = {
<% channels.forEach((ch) => { -%>
  <%= ch.constName %>: '<%= ch.name %>',
<% }); -%>
} as const

export type ChannelName = (typeof Channels)[keyof typeof Channels]

/**
 * Factory for creating channel instances
 */
export class ChannelFactory {
  constructor(private readonly backend: BroadcastBackend) {}

  /**
   * Create a channel instance for the given name
   */
  channel(name: string): Channel {
    return new Channel(this.backend, name)
  }
<% channels.forEach((ch) => { -%>

  /**
   * Get the <%= ch.name %> events channel
   */
  <%= ch.name %>(): Channel {
    return this.channel(Channels.<%= ch.constName %>)
  }
<% }); -%>
}
