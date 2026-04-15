import { describe, it, expect } from 'vitest';
import { lightTheme, darkTheme } from '../src/index.js';
import type {
  GraphNodeData,
  GraphEdgeData,
  GraphAdapter,
  GraphTheme,
  BadgeProps,
  FieldRowProps,
  TypePillProps,
  IconProps,
  DirectionIndicatorProps,
  GraphNodeProps,
  DetailPanelProps,
  GraphLegendProps,
  StatusBarProps,
} from '../src/index.js';

describe('GraphNodeData', () => {
  it('should accept a minimal entity node', () => {
    const node: GraphNodeData = {
      id: 'person',
      label: 'Person',
      kind: 'entity',
    };
    expect(node.id).toBe('person');
    expect(node.kind).toBe('entity');
  });

  it('should accept a fully populated entity node', () => {
    const node: GraphNodeData = {
      id: 'person',
      label: 'Person',
      subtitle: 'persons',
      kind: 'entity',
      group: 'synced',
      fields: [
        { name: 'id', type: 'uuid', role: 'pk' },
        { name: 'name', type: 'string', role: 'required' },
        { name: 'created_at', type: 'timestamp', system: true },
      ],
      behaviors: ['timestamps', 'soft_delete'],
      flags: [],
      fieldCount: 3,
      queryCount: 2,
      metadata: { source: 'yaml' },
    };
    expect(node.fields).toHaveLength(3);
    expect(node.behaviors).toContain('timestamps');
  });

  it('should accept a relationship node', () => {
    const node: GraphNodeData = {
      id: 'employment',
      label: 'Employment',
      kind: 'relationship',
      from: 'person',
      to: 'organization',
      selfReferential: false,
      types: [
        { name: 'employed_by', direction: 'directed' },
        { name: 'manages', direction: 'inverse', inverseName: 'managed_by' },
      ],
    };
    expect(node.from).toBe('person');
    expect(node.types).toHaveLength(2);
  });

  it('should accept a generic type parameter', () => {
    interface MyEntity { name: string; table: string }
    const node: GraphNodeData<MyEntity> = {
      id: 'test',
      label: 'Test',
      kind: 'entity',
      source: { name: 'test', table: 'tests' },
    };
    expect(node.source?.name).toBe('test');
  });
});

describe('GraphEdgeData', () => {
  it('should accept a valid edge', () => {
    const edge: GraphEdgeData = {
      id: 'person-org',
      source: 'person',
      target: 'organization',
      type: 'fk',
      cardinality: '1:N',
    };
    expect(edge.type).toBe('fk');
  });

  it('should accept all edge types', () => {
    const types: GraphEdgeData['type'][] = ['fk', 'junction', 'inline'];
    expect(types).toHaveLength(3);
  });
});

describe('Theme presets', () => {
  it('lightTheme should satisfy GraphTheme', () => {
    const theme: GraphTheme = lightTheme;
    expect(theme.entityColor).toBe('#3b82f6');
    expect(theme.fontFamily).toBeDefined();
    expect(theme.fontSize.sm).toBeDefined();
    expect(theme.fontSize.md).toBeDefined();
    expect(theme.fontSize.lg).toBeDefined();
  });

  it('darkTheme should satisfy GraphTheme', () => {
    const theme: GraphTheme = darkTheme;
    expect(theme.entityColor).toBe('#60a5fa');
    expect(theme.nodeBg).toBe('#1e293b');
  });

  it('should have all badge variant colors', () => {
    const variants: BadgeProps['variant'][] = [
      'default', 'primary', 'success', 'warning', 'error', 'info', 'muted',
    ];
    for (const variant of variants) {
      expect(lightTheme.badgeColors[variant]).toBeDefined();
      expect(lightTheme.badgeColors[variant].bg).toBeDefined();
      expect(lightTheme.badgeColors[variant].text).toBeDefined();
      expect(lightTheme.badgeColors[variant].border).toBeDefined();
      expect(darkTheme.badgeColors[variant]).toBeDefined();
    }
  });

  it('should have group colors for all families', () => {
    const families = ['base', 'synced', 'activity', 'metadata', 'knowledge'];
    for (const family of families) {
      expect(lightTheme.groupColors[family]).toBeDefined();
      expect(darkTheme.groupColors[family]).toBeDefined();
    }
  });
});
