import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        graph: {
          entity: 'var(--graph-entity-color)',
          relationship: 'var(--graph-relationship-color)',
          record: 'var(--graph-record-color)',
          'group-base': 'var(--graph-group-base)',
          'group-synced': 'var(--graph-group-synced)',
          'group-activity': 'var(--graph-group-activity)',
          'group-metadata': 'var(--graph-group-metadata)',
          'group-knowledge': 'var(--graph-group-knowledge)',
          'edge-fk': 'var(--graph-edge-fk)',
          'edge-junction': 'var(--graph-edge-junction)',
          'edge-inline': 'var(--graph-edge-inline)',
          'node-bg': 'var(--graph-node-bg)',
          'node-border': 'var(--graph-node-border)',
          'node-selected-border': 'var(--graph-node-selected-border)',
          'panel-bg': 'var(--graph-panel-bg)',
        },
      },
      fontFamily: {
        graph: 'var(--graph-font-family)',
      },
      fontSize: {
        'graph-sm': 'var(--graph-font-size-sm)',
        'graph-md': 'var(--graph-font-size-md)',
        'graph-lg': 'var(--graph-font-size-lg)',
      },
    },
  },
} satisfies Config;
