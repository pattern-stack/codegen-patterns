import type { BehaviorBadgeRowProps } from '../types/component-props.js';
import { Badge } from '../atoms/Badge.js';

export function BehaviorBadgeRow({ behaviors }: BehaviorBadgeRowProps) {
  if (behaviors.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {behaviors.map((behavior) => (
        <Badge key={behavior} label={behavior} variant="muted" size="sm" />
      ))}
    </div>
  );
}
