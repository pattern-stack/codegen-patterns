/**
 * Hygen prompt.js - Loads broadcast config and prepares template locals
 *
 * Usage: bunx hygen broadcast new [--yaml broadcast.yaml]
 *
 * If no YAML is provided, generates with sensible defaults.
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'

// ============================================================================
// Default Configuration
// ============================================================================

const defaultConfig = {
  broadcast: {
    name: 'default',
    channels: ['session', 'agent', 'git'],
    websocket: {
      path: '/ws/broadcast',
      cors: {
        origin: '*',
        credentials: true,
      },
    },
    bridge_events: {
      session: [
        'SessionProvisioning',
        'SessionRunning',
        'SessionPaused',
        'SessionTerminating',
        'SessionTerminated',
        'SessionProvisionFailed',
      ],
      agent: [
        'AgentSpawned',
        'AgentStatusChanged',
        'AgentCompleted',
        'AgentFailed',
        'AgentRunStarted',
        'AgentRunCompleted',
        'AgentRunFailed',
      ],
      git: [
        'GitOperationStarted',
        'GitOperationCompleted',
        'GitOperationFailed',
        'GitCommitCreated',
        'GitPushCompleted',
      ],
    },
  },
}

// ============================================================================
// Event Metadata (field mappings for each domain event)
// ============================================================================

const eventMetadata = {
  // Session Events
  SessionProvisioning: {
    eventName: 'session.provisioning',
    channel: 'session',
    file: 'session.events',
    fields: ['sessionId', 'projectId', 'worktreeRef'],
  },
  SessionRunning: {
    eventName: 'session.running',
    channel: 'session',
    file: 'session.events',
    fields: ['sessionId', 'appUrl', 'vncUrl'],
  },
  SessionPaused: {
    eventName: 'session.paused',
    channel: 'session',
    file: 'session.events',
    fields: ['sessionId'],
  },
  SessionTerminating: {
    eventName: 'session.terminating',
    channel: 'session',
    file: 'session.events',
    fields: ['sessionId', 'reason'],
  },
  SessionTerminated: {
    eventName: 'session.terminated',
    channel: 'session',
    file: 'session.events',
    fields: ['sessionId', 'reason'],
  },
  SessionProvisionFailed: {
    eventName: 'session.provision_failed',
    channel: 'session',
    file: 'session.events',
    fields: ['sessionId', 'error', 'step'],
  },

  // Agent Events
  AgentSpawned: {
    eventName: 'agent.spawned',
    channel: 'agent',
    file: 'agent.events',
    fields: ['agentId', 'sessionId', 'name', 'parentAgentId'],
  },
  AgentStatusChanged: {
    eventName: 'agent.status_changed',
    channel: 'agent',
    file: 'agent.events',
    fields: ['agentId', 'previousStatus', 'newStatus'],
  },
  AgentCompleted: {
    eventName: 'agent.completed',
    channel: 'agent',
    file: 'agent.events',
    fields: ['agentId', 'sessionId'],
  },
  AgentFailed: {
    eventName: 'agent.failed',
    channel: 'agent',
    file: 'agent.events',
    fields: ['agentId', 'sessionId', 'error'],
    transforms: { error: 'String(event.error)' },
  },
  AgentRunStarted: {
    eventName: 'agent.run.started',
    channel: 'agent',
    file: 'agent.events',
    fields: ['agentRunId', 'agentId', 'sessionId', 'trigger', 'workingRef'],
  },
  AgentRunCompleted: {
    eventName: 'agent.run.completed',
    channel: 'agent',
    file: 'agent.events',
    fields: ['agentRunId', 'agentId', 'sessionId', 'tokenUsage'],
  },
  AgentRunFailed: {
    eventName: 'agent.run.failed',
    channel: 'agent',
    file: 'agent.events',
    fields: ['agentRunId', 'agentId', 'error'],
    transforms: { error: 'String(event.error)' },
  },

  // Git Events
  GitOperationStarted: {
    eventName: 'git.operation.started',
    channel: 'git',
    file: 'git.events',
    fields: ['operationId', 'sessionId', 'operationType', 'repositoryId'],
  },
  GitOperationCompleted: {
    eventName: 'git.operation.completed',
    channel: 'git',
    file: 'git.events',
    fields: ['operationId', 'sessionId', 'operationType', 'commitSha'],
  },
  GitOperationFailed: {
    eventName: 'git.operation.failed',
    channel: 'git',
    file: 'git.events',
    fields: ['operationId', 'sessionId', 'operationType', 'error'],
  },
  GitCommitCreated: {
    eventName: 'git.commit.created',
    channel: 'git',
    file: 'git.events',
    fields: ['operationId', 'sessionId', 'agentRunId', 'commitSha', 'message', 'filesChanged'],
  },
  GitPushCompleted: {
    eventName: 'git.push.completed',
    channel: 'git',
    file: 'git.events',
    fields: ['operationId', 'sessionId', 'ref', 'remote'],
  },
}

// ============================================================================
// Prompt Export
// ============================================================================

export default {
  prompt: async ({ args }) => {
    let config = defaultConfig

    // Load custom config if provided
    if (args.yaml) {
      const fullPath = path.resolve(process.cwd(), args.yaml)
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Config file not found: ${fullPath}`)
      }
      const content = fs.readFileSync(fullPath, 'utf-8')
      const parsed = yaml.parse(content)
      config = { broadcast: { ...defaultConfig.broadcast, ...parsed.broadcast } }
    }

    const broadcast = config.broadcast

    // Process channels
    const channels = broadcast.channels.map((ch) => ({
      name: ch,
      constName: ch.toUpperCase(),
    }))

    // Process bridge events - group by channel and enrich with metadata
    const bridgeEventsByChannel = {}
    const allBridgeEvents = []
    const eventImportsByFile = {}

    for (const [channel, events] of Object.entries(broadcast.bridge_events)) {
      bridgeEventsByChannel[channel] = []

      for (const eventName of events) {
        const meta = eventMetadata[eventName]
        if (!meta) {
          console.warn(`Warning: Unknown event ${eventName}, skipping`)
          continue
        }

        const eventInfo = {
          className: eventName,
          eventName: meta.eventName,
          channel: meta.channel,
          fields: meta.fields,
          transforms: meta.transforms || {},
        }

        bridgeEventsByChannel[channel].push(eventInfo)
        allBridgeEvents.push(eventInfo)

        // Track imports by file
        if (!eventImportsByFile[meta.file]) {
          eventImportsByFile[meta.file] = []
        }
        eventImportsByFile[meta.file].push(eventName)
      }
    }

    // Convert import map to array for template
    const eventImports = Object.entries(eventImportsByFile).map(([file, events]) => ({
      file,
      events: events.sort(),
    }))

    return {
      // Basic config
      name: broadcast.name,
      websocketPath: broadcast.websocket?.path ?? '/ws/broadcast',
      corsOrigin: broadcast.websocket?.cors?.origin ?? '*',
      corsCredentials: broadcast.websocket?.cors?.credentials ?? true,

      // Channels
      channels,
      channelNames: broadcast.channels,

      // Bridge events
      bridgeEventsByChannel,
      allBridgeEvents,
      eventImports,

      // Convenience flags
      hasSessionEvents: !!bridgeEventsByChannel.session?.length,
      hasAgentEvents: !!bridgeEventsByChannel.agent?.length,
      hasGitEvents: !!bridgeEventsByChannel.git?.length,
    }
  },
}
