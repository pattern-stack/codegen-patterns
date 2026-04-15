import type { ReactNode } from 'react';
import type { GraphNodeData } from './graph-node-data.js';

// ── Atoms ────────────────────────────────────────────────────────────────────

export interface BadgeProps {
  label: string;
  variant: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info' | 'muted';
  size?: 'sm' | 'md';
  icon?: ReactNode;
}

export interface FieldRowProps {
  name: string;
  type?: string;
  value?: string;
  badge?: 'pk' | 'fk' | 'required' | 'nullable' | 'unique' | 'indexed';
  muted?: boolean;
}

export interface TypePillProps {
  label: string;
  direction?: 'directed' | 'bidirectional' | 'inverse';
  active?: boolean;
  onClick?: () => void;
}

export interface IconProps {
  name:
    | 'entity'
    | 'relationship'
    | 'field'
    | 'key'
    | 'link'
    | 'temporal'
    | 'sourced'
    | 'behavior'
    | 'query'
    | 'person'
    | 'organization'
    | 'opportunity'
    | 'engagement';
  size?: 'sm' | 'md' | 'lg';
}

export interface DirectionIndicatorProps {
  from: string;
  to: string;
  selfReferential?: boolean;
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

// ── Molecules ────────────────────────────────────────────────────────────────

export interface NodeHeaderProps {
  icon: IconProps['name'];
  label: string;
  badge?: BadgeProps;
  subtitle?: string;
  selected?: boolean;
}

export interface FieldListProps {
  fields: FieldRowProps[];
  groups?: { label: string; filter: (f: FieldRowProps) => boolean }[];
  maxVisible?: number;
  compact?: boolean;
}

export interface TypeBadgeRowProps {
  types: TypePillProps[];
  maxVisible?: number;
}

export interface BehaviorBadgeRowProps {
  behaviors: string[];
}

export interface SearchFilterBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  filters: { key: string; label: string; active: boolean; count?: number }[];
  onFilterToggle: (key: string) => void;
}

// ── Organisms ────────────────────────────────────────────────────────────────

export interface GraphNodeProps<T = unknown> {
  data: GraphNodeData<T>;
  selected?: boolean;
  dimmed?: boolean;
  compact?: boolean;
  onClick?: () => void;
  onHover?: (hovering: boolean) => void;
}

export interface DetailPanelProps<T = unknown> {
  node: GraphNodeData<T> | null;
  onClose: () => void;
  width?: number;
}

export interface GraphLegendProps {
  items: { icon: IconProps['name']; label: string; color: string }[];
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
}

export interface StatusBarProps {
  stats: { label: string; value: number | string }[];
  warnings?: string[];
}
