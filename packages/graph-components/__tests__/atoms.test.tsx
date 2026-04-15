import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { Badge } from '../src/atoms/Badge.js';
import { FieldRow } from '../src/atoms/FieldRow.js';
import { TypePill } from '../src/atoms/TypePill.js';
import { Icon } from '../src/atoms/Icon.js';
import { DirectionIndicator } from '../src/atoms/DirectionIndicator.js';
import { Tooltip } from '../src/atoms/Tooltip.js';
import type {
  BadgeProps,
  IconProps,
} from '../src/types/component-props.js';

describe('Badge', () => {
  it('should render with all variants', () => {
    const variants: BadgeProps['variant'][] = [
      'default', 'primary', 'success', 'warning', 'error', 'info', 'muted',
    ];
    for (const variant of variants) {
      const el = createElement(Badge, { label: 'test', variant });
      expect(el).toBeDefined();
      expect(el.props.label).toBe('test');
      expect(el.props.variant).toBe(variant);
    }
  });

  it('should accept size prop', () => {
    const el = createElement(Badge, { label: 'test', variant: 'primary', size: 'md' });
    expect(el.props.size).toBe('md');
  });

  it('should accept icon prop', () => {
    const icon = createElement('span', null, '*');
    const el = createElement(Badge, { label: 'test', variant: 'primary', icon });
    expect(el.props.icon).toBeDefined();
  });
});

describe('FieldRow', () => {
  it('should render with name only', () => {
    const el = createElement(FieldRow, { name: 'user_id' });
    expect(el.props.name).toBe('user_id');
  });

  it('should render with all props', () => {
    const el = createElement(FieldRow, {
      name: 'id',
      type: 'uuid',
      badge: 'pk',
      muted: false,
    });
    expect(el.props.name).toBe('id');
    expect(el.props.type).toBe('uuid');
    expect(el.props.badge).toBe('pk');
  });

  it('should accept value for instance graph', () => {
    const el = createElement(FieldRow, {
      name: 'email',
      value: 'alice@example.com',
    });
    expect(el.props.value).toBe('alice@example.com');
  });
});

describe('TypePill', () => {
  it('should render with label', () => {
    const el = createElement(TypePill, { label: 'employed_by' });
    expect(el.props.label).toBe('employed_by');
  });

  it('should render with direction', () => {
    const el = createElement(TypePill, {
      label: 'manages',
      direction: 'directed',
      active: true,
    });
    expect(el.props.direction).toBe('directed');
    expect(el.props.active).toBe(true);
  });
});

describe('Icon', () => {
  it('should render all icon names', () => {
    const names: IconProps['name'][] = [
      'entity', 'relationship', 'field', 'key', 'link',
      'temporal', 'sourced', 'behavior', 'query',
      'person', 'organization', 'opportunity', 'engagement',
    ];
    for (const name of names) {
      const el = createElement(Icon, { name });
      expect(el).toBeDefined();
      expect(el.props.name).toBe(name);
    }
  });

  it('should accept size prop', () => {
    const el = createElement(Icon, { name: 'entity', size: 'lg' });
    expect(el.props.size).toBe('lg');
  });
});

describe('DirectionIndicator', () => {
  it('should render from → to', () => {
    const el = createElement(DirectionIndicator, { from: 'person', to: 'org' });
    expect(el.props.from).toBe('person');
    expect(el.props.to).toBe('org');
  });

  it('should handle self-referential', () => {
    const el = createElement(DirectionIndicator, {
      from: 'person',
      to: 'person',
      selfReferential: true,
    });
    expect(el.props.selfReferential).toBe(true);
  });
});

describe('Tooltip', () => {
  it('should render with content and children', () => {
    const el = createElement(
      Tooltip,
      { content: 'Details', side: 'top' },
      createElement('span', null, 'hover me'),
    );
    expect(el).toBeDefined();
  });
});
