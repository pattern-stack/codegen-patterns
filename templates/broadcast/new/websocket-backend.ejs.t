---
to: src/infrastructure/broadcast/websocket-broadcast.backend.ts
force: true
---
import { Injectable, Logger } from '@nestjs/common'
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'
import type {
  BroadcastBackend,
  BroadcastHandler,
} from './broadcast-backend.interface'

interface SubscribePayload {
  channels: string[]
}

interface UnsubscribePayload {
  channels: string[]
}

interface BroadcastMessage {
  channel: string
  event: string
  payload: Record<string, unknown>
}

/**
 * WebSocket-based broadcast backend using Socket.IO.
 * Clients connect and subscribe to channels to receive real-time domain events.
 *
 * Protocol:
 *   Client → Server: { "subscribe": ["session", "agent"] }
 *   Client → Server: { "unsubscribe": ["session"] }
 *   Server → Client: { "channel": "session", "event": "session.running", "payload": {...} }
 */
@Injectable()
@WebSocketGateway({
  path: '<%= websocketPath %>',
  cors: {
    origin: '<%= corsOrigin %>',
    credentials: <%= corsCredentials %>,
  },
})
export class WebSocketBroadcastBackend
  implements BroadcastBackend, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WebSocketBroadcastBackend.name)

  @WebSocketServer()
  private server!: Server

  /** channel -> set of subscribed sockets */
  private channelSubscribers = new Map<string, Set<Socket>>()

  /** socket -> set of channels subscribed to */
  private socketChannels = new Map<Socket, Set<string>>()

  /** server-side handlers for channels */
  private handlers = new Map<string, Set<BroadcastHandler>>()

  private closed = false

  readonly supportsPush = true

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`)
    this.socketChannels.set(client, new Set())
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`)

    // Remove client from all channel subscriptions
    const channels = this.socketChannels.get(client)
    if (channels) {
      for (const channel of channels) {
        const subscribers = this.channelSubscribers.get(channel)
        if (subscribers) {
          subscribers.delete(client)
          if (subscribers.size === 0) {
            this.channelSubscribers.delete(channel)
          }
        }
      }
    }
    this.socketChannels.delete(client)
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribePayload,
  ): { subscribed: string[] } {
    const channels = data?.channels ?? []
    const subscribedChannels: string[] = []

    for (const channel of channels) {
      if (typeof channel !== 'string' || channel.length === 0) {
        continue
      }

      // Add to channel subscribers
      let subscribers = this.channelSubscribers.get(channel)
      if (!subscribers) {
        subscribers = new Set()
        this.channelSubscribers.set(channel, subscribers)
      }
      subscribers.add(client)

      // Track which channels this socket is subscribed to
      const socketChans = this.socketChannels.get(client)
      if (socketChans) {
        socketChans.add(channel)
      }

      subscribedChannels.push(channel)
      this.logger.debug(`Client ${client.id} subscribed to channel: ${channel}`)
    }

    return { subscribed: subscribedChannels }
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: UnsubscribePayload,
  ): { unsubscribed: string[] } {
    const channels = data?.channels ?? []
    const unsubscribedChannels: string[] = []

    for (const channel of channels) {
      if (typeof channel !== 'string' || channel.length === 0) {
        continue
      }

      // Remove from channel subscribers
      const subscribers = this.channelSubscribers.get(channel)
      if (subscribers) {
        subscribers.delete(client)
        if (subscribers.size === 0) {
          this.channelSubscribers.delete(channel)
        }
      }

      // Remove from socket's channel list
      const socketChans = this.socketChannels.get(client)
      if (socketChans) {
        socketChans.delete(channel)
      }

      unsubscribedChannels.push(channel)
      this.logger.debug(
        `Client ${client.id} unsubscribed from channel: ${channel}`,
      )
    }

    return { unsubscribed: unsubscribedChannels }
  }

  async broadcast(
    channel: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.closed) {
      throw new Error('Broadcast backend is closed')
    }

    const message: BroadcastMessage = {
      channel,
      event: eventType,
      payload,
    }

    // Send to WebSocket clients
    const subscribers = this.channelSubscribers.get(channel)
    if (subscribers && subscribers.size > 0) {
      for (const socket of subscribers) {
        socket.emit('broadcast', message)
      }
      this.logger.debug(
        `Broadcast to ${subscribers.size} clients on channel "${channel}": ${eventType}`,
      )
    }

    // Call server-side handlers
    const channelHandlers = this.handlers.get(channel)
    if (channelHandlers && channelHandlers.size > 0) {
      const promises = Array.from(channelHandlers).map((handler) =>
        handler(eventType, payload).catch((error) => {
          this.logger.error(
            `Handler error on channel "${channel}": ${error.message}`,
          )
        }),
      )
      await Promise.all(promises)
    }
  }

  async subscribe(channel: string, handler: BroadcastHandler): Promise<void> {
    if (this.closed) {
      throw new Error('Broadcast backend is closed')
    }

    let channelHandlers = this.handlers.get(channel)
    if (!channelHandlers) {
      channelHandlers = new Set()
      this.handlers.set(channel, channelHandlers)
    }
    channelHandlers.add(handler)
  }

  async unsubscribe(channel: string): Promise<void> {
    this.handlers.delete(channel)
  }

  async healthCheck(): Promise<boolean> {
    return !this.closed && this.server !== undefined
  }

  async close(): Promise<void> {
    this.closed = true

    // Disconnect all clients
    for (const socket of this.socketChannels.keys()) {
      socket.disconnect(true)
    }

    this.channelSubscribers.clear()
    this.socketChannels.clear()
    this.handlers.clear()
  }

  /**
   * Get statistics about current connections (for monitoring)
   */
  getStats(): {
    totalConnections: number
    channelCounts: Record<string, number>
  } {
    const channelCounts: Record<string, number> = {}
    for (const [channel, subscribers] of this.channelSubscribers) {
      channelCounts[channel] = subscribers.size
    }

    return {
      totalConnections: this.socketChannels.size,
      channelCounts,
    }
  }
}
