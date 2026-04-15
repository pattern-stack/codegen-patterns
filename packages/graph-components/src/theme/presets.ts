import type { GraphTheme } from './theme.js';

export const lightTheme: GraphTheme = {
  entityColor: '#3b82f6',
  relationshipColor: '#10b981',
  recordColor: '#8b5cf6',

  groupColors: {
    base: '#64748b',
    synced: '#3b82f6',
    activity: '#f59e0b',
    metadata: '#8b5cf6',
    knowledge: '#10b981',
  },

  badgeColors: {
    default: { bg: '#f1f5f9', text: '#475569', border: '#e2e8f0' },
    primary: { bg: '#dbeafe', text: '#1d4ed8', border: '#bfdbfe' },
    success: { bg: '#dcfce7', text: '#15803d', border: '#bbf7d0' },
    warning: { bg: '#fef3c7', text: '#a16207', border: '#fde68a' },
    error: { bg: '#fee2e2', text: '#b91c1c', border: '#fecaca' },
    info: { bg: '#e0f2fe', text: '#0369a1', border: '#bae6fd' },
    muted: { bg: '#f8fafc', text: '#94a3b8', border: '#f1f5f9' },
  },

  edgeFk: '#94a3b8',
  edgeJunction: '#10b981',
  edgeInline: '#3b82f6',

  nodeBg: '#ffffff',
  nodeBorder: '#e2e8f0',
  nodeSelectedBorder: '#3b82f6',
  panelBg: '#ffffff',

  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  fontSize: { sm: '0.75rem', md: '0.875rem', lg: '1rem' },
};

export const darkTheme: GraphTheme = {
  entityColor: '#60a5fa',
  relationshipColor: '#34d399',
  recordColor: '#a78bfa',

  groupColors: {
    base: '#94a3b8',
    synced: '#60a5fa',
    activity: '#fbbf24',
    metadata: '#a78bfa',
    knowledge: '#34d399',
  },

  badgeColors: {
    default: { bg: '#334155', text: '#cbd5e1', border: '#475569' },
    primary: { bg: '#1e3a5f', text: '#93c5fd', border: '#1e40af' },
    success: { bg: '#14532d', text: '#86efac', border: '#166534' },
    warning: { bg: '#451a03', text: '#fcd34d', border: '#78350f' },
    error: { bg: '#450a0a', text: '#fca5a5', border: '#7f1d1d' },
    info: { bg: '#0c4a6e', text: '#7dd3fc', border: '#075985' },
    muted: { bg: '#1e293b', text: '#64748b', border: '#334155' },
  },

  edgeFk: '#64748b',
  edgeJunction: '#34d399',
  edgeInline: '#60a5fa',

  nodeBg: '#1e293b',
  nodeBorder: '#334155',
  nodeSelectedBorder: '#60a5fa',
  panelBg: '#0f172a',

  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  fontSize: { sm: '0.75rem', md: '0.875rem', lg: '1rem' },
};
