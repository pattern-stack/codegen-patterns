---
to: src/infrastructure/broadcast/memory-broadcast.backend.ts
force: true
---
import { Injectable } from '@nestjs/common'
import type {
  BroadcastBackend,
  BroadcastHandler,
} from './broadcast-backend.interface'

/**
 * In-memory broadcast backend for testing and single-process scenarios.
 * Events are delivered synchronously to registered handlers.
 */
@Injectable()
export class MemoryBroadcastBackend implements BroadcastBackend {
  private handlers = new Map<string, Set<BroadcastHandler>>()
  private closed = false

  readonly supportsPush = false

  async broadcast(
    channel: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.closed) {
      throw new Error('Broadcast backend is closed')
    }

    const channelHandlers = this.handlers.get(channel)
    if (!channelHandlers || channelHandlers.size === 0) {
      return
    }

    const promises = Array.from(channelHandlers).map((handler) =>
      handler(eventType, payload).catch((error) => {
        console.error(
          `[MemoryBroadcast] Handler error on channel "${channel}":`,
          error,
        )
      }),
    )

    await Promise.all(promises)
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
    return !this.closed
  }

  async close(): Promise<void> {
    this.closed = true
    this.handlers.clear()
  }

  /**
   * Get the number of handlers for a channel (for testing)
   */
  getHandlerCount(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0
  }

  /**
   * Get all subscribed channels (for testing)
   */
  getChannels(): string[] {
    return Array.from(this.handlers.keys())
  }
}
