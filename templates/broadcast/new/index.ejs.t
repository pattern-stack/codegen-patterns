---
to: src/infrastructure/broadcast/index.ts
force: true
---
// Interfaces
export type { BroadcastBackend, BroadcastHandler } from './broadcast-backend.interface'
export { BROADCAST_BACKEND } from './broadcast-backend.interface'

// Backends
export { MemoryBroadcastBackend } from './memory-broadcast.backend'
export { WebSocketBroadcastBackend } from './websocket-broadcast.backend'

// Channel API
export { Channel, ChannelFactory, Channels } from './channel'
export type { ChannelName } from './channel'

// Bridge
export { BroadcastBridgeListener } from './broadcast-bridge.listener'

// Module
export { BroadcastModule } from './broadcast.module'
