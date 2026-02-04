---
to: src/infrastructure/broadcast/broadcast-bridge.listener.ts
force: true
---
import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { WebSocketBroadcastBackend } from './websocket-broadcast.backend'
import { Channels } from './channel'
<% eventImports.forEach((imp) => { -%>

// <%= imp.file.charAt(0).toUpperCase() + imp.file.slice(1).replace('.events', '') %> Events
import {
<% imp.events.forEach((event, idx) => { -%>
  <%= event %>,
<% }); -%>
} from '../../domain/events/<%= imp.file %>'
<% }); -%>

/**
 * Bridge between domain events (via EventEmitter2) and WebSocket broadcast.
 * Listens to domain events and broadcasts them to subscribed WebSocket clients.
 */
@Injectable()
export class BroadcastBridgeListener {
  private readonly logger = new Logger(BroadcastBridgeListener.name)

  constructor(private readonly broadcast: WebSocketBroadcastBackend) {}
<% Object.entries(bridgeEventsByChannel).forEach(([channel, events]) => { -%>

  // ============================================================
  // <%= channel.charAt(0).toUpperCase() + channel.slice(1) %> Events
  // ============================================================
<% events.forEach((event) => { -%>

  @OnEvent(<%= event.className %>.eventName)
  async handle<%= event.className %>(event: <%= event.className %>): Promise<void> {
    await this.broadcastSafe(Channels.<%= channel.toUpperCase() %>, <%= event.className %>.eventName, {
<% event.fields.forEach((field) => { -%>
<% if (event.transforms[field]) { -%>
      <%= field %>: <%= event.transforms[field] %>,
<% } else { -%>
      <%= field %>: event.<%= field %>,
<% } -%>
<% }); -%>
    })
  }
<% }); -%>
<% }); -%>

  // ============================================================
  // Helper
  // ============================================================

  private async broadcastSafe(
    channel: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.broadcast.broadcast(channel, eventType, payload)
    } catch (error) {
      this.logger.error(
        `Failed to broadcast ${eventType} on channel ${channel}: ${error}`,
      )
    }
  }
}
