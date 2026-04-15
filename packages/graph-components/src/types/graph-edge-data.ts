/**
 * Semantic edge data — domain facts, not renderer props.
 * The viewer app maps these to ReactFlow edges (or whatever renderer).
 */
export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  cardinality?: '1:1' | '1:N' | 'N:1' | 'N:M';
  label?: string;
  type: 'fk' | 'junction' | 'inline';
  bidirectional?: boolean;
}
