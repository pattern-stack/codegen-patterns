---
to: src/infrastructure/broadcast/broadcast.module.ts
force: true
---
import { Module } from '@nestjs/common'
import { WebSocketBroadcastBackend } from './websocket-broadcast.backend'
import { MemoryBroadcastBackend } from './memory-broadcast.backend'
import { BroadcastBridgeListener } from './broadcast-bridge.listener'
import { BROADCAST_BACKEND } from './broadcast-backend.interface'

/**
 * Broadcast module providing WebSocket-based real-time event broadcasting.
 *
 * This module:
 * - Exposes a WebSocket gateway at <%= websocketPath %> for client connections
 * - Bridges domain events (from EventEmitter2) to WebSocket clients
 * - Supports channels: <%= channelNames.join(', ') %>
 *
 * Usage:
 * ```typescript
 * @Module({
 *   imports: [BroadcastModule],
 * })
 * export class AppModule {}
 * ```
 *
 * Client protocol:
 * ```
 * // Subscribe to channels
 * socket.emit('subscribe', { channels: ['session', 'agent'] })
 *
 * // Receive broadcasts
 * socket.on('broadcast', (msg) => {
 *   console.log(msg.channel, msg.event, msg.payload)
 * })
 *
 * // Unsubscribe
 * socket.emit('unsubscribe', { channels: ['session'] })
 * ```
 */
@Module({
  providers: [
    WebSocketBroadcastBackend,
    MemoryBroadcastBackend,
    BroadcastBridgeListener,
    {
      provide: BROADCAST_BACKEND,
      useExisting: WebSocketBroadcastBackend,
    },
  ],
  exports: [
    WebSocketBroadcastBackend,
    MemoryBroadcastBackend,
    BROADCAST_BACKEND,
  ],
})
export class BroadcastModule {}
