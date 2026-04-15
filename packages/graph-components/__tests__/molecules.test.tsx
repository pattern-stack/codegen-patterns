import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { NodeHeader } from '../src/molecules/NodeHeader.js';
import { FieldList } from '../src/molecules/FieldList.js';
import { TypeBadgeRow } from '../src/molecules/TypeBadgeRow.js';
import { BehaviorBadgeRow } from '../src/molecules/BehaviorBadgeRow.js';
import { SearchFilterBar } from '../src/molecules/SearchFilterBar.js';

describe('NodeHeader', () => {
  it('should render with icon and label', () => {
    const el = createElement(NodeHeader, { icon: 'entity', label: 'Person' });
    expect(el.props.icon).toBe('entity');
    expect(el.props.label).toBe('Person');
  });

  it('should accept badge and subtitle', () => {
    const el = createElement(NodeHeader, {
      icon: 'entity',
      label: 'Person',
      subtitle: 'persons',
      badge: { label: 'synced', variant: 'primary' as const },
      selected: true,
    });
    expect(el.props.subtitle).toBe('persons');
    expect(el.props.badge?.label).toBe('synced');
    expect(el.props.selected).toBe(true);
  });
});

describe('FieldList', () => {
  it('should render fields', () => {
    const fields = [
      { name: 'id', type: 'uuid', badge: 'pk' as const },
      { name: 'name', type: 'string', badge: 'required' as const },
      { name: 'created_at', type: 'timestamp', muted: true },
    ];
    const el = createElement(FieldList, { fields });
    expect(el.props.fields).toHaveLength(3);
  });

  it('should accept maxVisible and compact', () => {
    const fields = [
      { name: 'id', type: 'uuid' },
      { name: 'name', type: 'string' },
      { name: 'email', type: 'string' },
    ];
    const el = createElement(FieldList, { fields, maxVisible: 2, compact: true });
    expect(el.props.maxVisible).toBe(2);
    expect(el.props.compact).toBe(true);
  });

  it('should accept groups', () => {
    const fields = [
      { name: 'id', type: 'uuid', badge: 'pk' as const },
      { name: 'name', type: 'string' },
      { name: 'created_at', type: 'timestamp', muted: true },
    ];
    const groups = [
      { label: 'Keys', filter: (f: { badge?: string }) => f.badge === 'pk' },
      { label: 'Data', filter: (f: { badge?: string }) => f.badge !== 'pk' },
    ];
    const el = createElement(FieldList, { fields, groups });
    expect(el.props.groups).toHaveLength(2);
  });
});

describe('TypeBadgeRow', () => {
  it('should render types', () => {
    const types = [
      { label: 'employed_by', direction: 'directed' as const },
      { label: 'manages', direction: 'inverse' as const },
    ];
    const el = createElement(TypeBadgeRow, { types });
    expect(el.props.types).toHaveLength(2);
  });

  it('should accept maxVisible', () => {
    const types = [
      { label: 'a' },
      { label: 'b' },
      { label: 'c' },
    ];
    const el = createElement(TypeBadgeRow, { types, maxVisible: 2 });
    expect(el.props.maxVisible).toBe(2);
  });
});

describe('BehaviorBadgeRow', () => {
  it('should render behaviors', () => {
    const el = createElement(BehaviorBadgeRow, {
      behaviors: ['timestamps', 'soft_delete', 'user_tracking'],
    });
    expect(el.props.behaviors).toHaveLength(3);
  });

  it('should handle empty behaviors', () => {
    const el = createElement(BehaviorBadgeRow, { behaviors: [] });
    expect(el.props.behaviors).toHaveLength(0);
  });
});

describe('SearchFilterBar', () => {
  it('should render with query and filters', () => {
    const filters = [
      { key: 'entities', label: 'Entities', active: true, count: 5 },
      { key: 'relationships', label: 'Relationships', active: false, count: 3 },
    ];
    const el = createElement(SearchFilterBar, {
      query: 'person',
      onQueryChange: () => {},
      filters,
      onFilterToggle: () => {},
    });
    expect(el.props.query).toBe('person');
    expect(el.props.filters).toHaveLength(2);
  });
});
