import type { BadgeProps } from '../types/component-props.js';

export interface GraphTheme {
  // Node colors by kind
  entityColor: string;
  relationshipColor: string;
  recordColor: string;

  // Group colors (mapped to family/entity type)
  groupColors: Record<string, string>;

  // Badge variants
  badgeColors: Record<BadgeProps['variant'], { bg: string; text: string; border: string }>;

  // Edge colors
  edgeFk: string;
  edgeJunction: string;
  edgeInline: string;

  // Surface
  nodeBg: string;
  nodeBorder: string;
  nodeSelectedBorder: string;
  panelBg: string;

  // Typography
  fontFamily: string;
  fontSize: { sm: string; md: string; lg: string };
}
