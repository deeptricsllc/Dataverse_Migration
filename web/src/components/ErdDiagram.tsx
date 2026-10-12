import type { ErdDto, ErdEdgeDto, ErdNodeDto } from '@shared/domain';
import { useMemo, useState } from 'react';
import { fmtNumber } from '../lib/format';
import { Callout, Checkbox, cx, EmptyState, Pill } from './ui';

/**
 * The analyzed tables, drawn.
 *
 * Laid out left to right by dependency depth, which is the same order a migration loads them in:
 * anything to the left of a table must exist before it. That makes the diagram answer two questions
 * with one picture — how the data fits together, and why the load order is what it is — and it costs
 * nothing extra, because the server derives both from the same dependency analysis.
 *
 * Drawn as SVG rather than with a graph library: the layout is a layered DAG over a few dozen
 * boxes, which is a page of arithmetic, and a library would be a large dependency for it.
 */

const BOX_W = 208;
const BOX_H = 68;
/**
 * Wide enough for the longest column name a label is allowed to show.
 *
 * The label sits in this gap, right-aligned against the arrowhead. At 104 it was narrower than
 * `dtx_regionid (optional)`, so the text ran back over the box in the previous column and read as
 * "gionId (optional)". The gap and the cap on the label are one decision, so they live together.
 */
const GAP_X = 156;
const GAP_Y = 22;
const PAD = 24;
/** Roughly the width of one character at the label's font size. No text metrics in SVG. */
const LABEL_CHAR_W = 5.3;
const MAX_LABEL_CHARS = Math.floor((GAP_X - 18) / LABEL_CHAR_W);

interface Placed extends ErdNodeDto {
  x: number;
  y: number;
}

function layout(nodes: ErdNodeDto[]): { placed: Placed[]; width: number; height: number } {
  const columns = new Map<number, ErdNodeDto[]>();
  for (const node of nodes) {
    const column = columns.get(node.depth) ?? [];
    column.push(node);
    columns.set(node.depth, column);
  }
  const depths = [...columns.keys()].sort((a, b) => a - b);
  const tallest = Math.max(1, ...depths.map((d) => columns.get(d)!.length));

  const placed: Placed[] = [];
  depths.forEach((depth, columnIndex) => {
    const column = columns.get(depth)!;
    // Centre each column against the tallest, so the picture reads as a band rather than a staircase.
    const offset = ((tallest - column.length) * (BOX_H + GAP_Y)) / 2;
    column.forEach((node, row) => {
      placed.push({
        ...node,
        x: PAD + columnIndex * (BOX_W + GAP_X),
        y: PAD + offset + row * (BOX_H + GAP_Y),
      });
    });
  });

  return {
    placed,
    width: PAD * 2 + depths.length * BOX_W + Math.max(0, depths.length - 1) * GAP_X,
    height: PAD * 2 + tallest * BOX_H + Math.max(0, tallest - 1) * GAP_Y,
  };
}

/** A curve from the right edge of one box to the left edge of another. */
function edgePath(from: Placed, to: Placed): string {
  const x1 = from.x + BOX_W;
  const y1 = from.y + BOX_H / 2;
  const x2 = to.x;
  const y2 = to.y + BOX_H / 2;
  const bend = Math.max(28, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export function ErdDiagram({ erd }: { erd: ErdDto }) {
  const [showColumns, setShowColumns] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);

  const { placed, width, height } = useMemo(() => layout(erd.nodes), [erd.nodes]);
  const byName = useMemo(() => new Map(placed.map((p) => [p.logicalName, p])), [placed]);
  /**
   * Each edge worked out once: its curve, and where its label goes.
   *
   * The label sits just before the arrowhead rather than at the middle of the curve, stacked when
   * several references land on the same table. In the middle they piled on top of one another.
   */
  const drawn = useMemo(() => {
    const perTarget = new Map<string, number>();
    erd.edges.forEach((e) => perTarget.set(e.to, (perTarget.get(e.to) ?? 0) + 1));
    const placedSoFar = new Map<string, number>();
    return erd.edges.flatMap((edge) => {
      const from = byName.get(edge.from);
      const to = byName.get(edge.to);
      if (!from || !to) return [];
      const index = placedSoFar.get(edge.to) ?? 0;
      placedSoFar.set(edge.to, index + 1);
      const total = perTarget.get(edge.to) ?? 1;
      const full = `${edge.attribute}${edge.required ? '' : ' (optional)'}`;
      // Truncated rather than allowed to overrun: an unreadable label on top of another table is
      // worse than an elided one, and the full name is in the title beneath the cursor.
      const label = full.length > MAX_LABEL_CHARS ? `${full.slice(0, MAX_LABEL_CHARS - 1)}…` : full;
      return [
        {
          edge,
          key: `${edge.from}-${edge.to}-${edge.attribute}`,
          full,
          d: edgePath(from, to),
          label,
          labelX: to.x - 10,
          labelY: to.y + BOX_H / 2 + (index - (total - 1) / 2) * 13 + 3,
          plateW: label.length * LABEL_CHAR_W + 8,
        },
      ];
    });
  }, [erd.edges, byName]);

  if (erd.nodes.length === 0) {
    return <EmptyState title="Nothing to draw" description="This analysis covered no tables." />;
  }

  /** A table is dimmed when another is hovered and the two are unrelated. */
  const related = (name: string) => {
    if (!hovered) return true;
    if (name === hovered) return true;
    return erd.edges.some(
      (e) => (e.from === hovered && e.to === name) || (e.to === hovered && e.from === name),
    );
  };
  const edgeActive = (e: ErdEdgeDto) => !hovered || e.from === hovered || e.to === hovered;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <p className="max-w-2xl text-sm text-slate-600">
          Left to right is the order things must exist in: a table can only be loaded once everything pointing
          left of it is there. Hover a table to isolate what it touches.
        </p>
        <div className="flex-none">
          <Checkbox checked={showColumns} onChange={setShowColumns} label="Show linking columns" />
        </div>
      </div>

      <div
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
        data-testid="erd"
        // Tells a pointer device this scrolls, and gives a keyboard one somewhere to land. Without
        // it the only clue a wide diagram continues is a box cut off at the edge.
        tabIndex={0}
        role="group"
        aria-label="Entity relationship diagram, scrolls horizontally"
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Entity relationship diagram of ${erd.nodes.length} tables and ${erd.edges.length} relationships`}
        >
          <defs>
            <marker
              id="erd-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#94a3b8" />
            </marker>
            <marker
              id="erd-arrow-on"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#1d4ed8" />
            </marker>
          </defs>

          {drawn.map(({ edge, key, d }) => {
            const on = edgeActive(edge);
            return (
              <path
                key={key}
                d={d}
                fill="none"
                opacity={on ? 1 : 0.15}
                stroke={on && hovered ? '#1d4ed8' : '#94a3b8'}
                strokeWidth={on && hovered ? 2 : 1.25}
                strokeDasharray={edge.deferred ? '5 4' : undefined}
                markerEnd={on && hovered ? 'url(#erd-arrow-on)' : 'url(#erd-arrow)'}
              />
            );
          })}

          {/* After every line, so a line crossing a label cannot be drawn through the words. */}
          {showColumns &&
            drawn.map(({ edge, key, full, label, labelX, labelY, plateW }) => {
              const on = edgeActive(edge);
              return (
                <g key={key} opacity={on ? 1 : 0.15}>
                  {/* The whole reference under the cursor, since a long column name is elided. */}
                  <title>{`${edge.to}.${full} → ${edge.from}`}</title>
                  <rect
                    x={labelX - plateW}
                    y={labelY - 10}
                    width={plateW}
                    height={13}
                    rx={3}
                    fill="#ffffff"
                    opacity={0.92}
                  />
                  <text
                    data-testid="erd-edge-label"
                    x={labelX - 4}
                    y={labelY}
                    textAnchor="end"
                    fontSize="9.5"
                    fontFamily="monospace"
                    fill={on && hovered ? '#1d4ed8' : '#64748b'}
                  >
                    {label}
                  </text>
                </g>
              );
            })}

          {placed.map((node) => {
            const active = related(node.logicalName);
            return (
              <g
                key={node.logicalName}
                opacity={active ? 1 : 0.25}
                onMouseEnter={() => setHovered(node.logicalName)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'default' }}
              >
                <rect
                  x={node.x}
                  y={node.y}
                  width={BOX_W}
                  height={BOX_H}
                  rx={8}
                  fill={node.cycleGroup !== null ? '#fef3c7' : '#ffffff'}
                  stroke={node.logicalName === hovered ? '#1d4ed8' : '#cbd5e1'}
                  strokeWidth={node.logicalName === hovered ? 2 : 1}
                />
                <text x={node.x + 12} y={node.y + 24} fontSize="13" fontWeight="600" fill="#0f172a">
                  {node.displayName.length > 24 ? `${node.displayName.slice(0, 23)}…` : node.displayName}
                </text>
                <text x={node.x + 12} y={node.y + 41} fontSize="10" fill="#64748b" fontFamily="monospace">
                  {node.keyColumn
                    ? `key ${node.keyColumn.length > 22 ? `${node.keyColumn.slice(0, 21)}…` : node.keyColumn}`
                    : 'no single key column'}
                </text>
                <text x={node.x + 12} y={node.y + 57} fontSize="10" fill="#64748b">
                  {fmtNumber(node.recordCount)} rows · {node.columnCount} columns
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-6 rounded-sm border border-slate-300 bg-white" /> table
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-6 rounded-sm border border-amber-300 bg-amber-100" /> in a
          reference cycle
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="28" height="8" aria-hidden>
            <line x1="0" y1="4" x2="28" y2="4" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="5 4" />
          </svg>
          resolved in a second pass
        </span>
        <span className="text-slate-400">
          {erd.nodes.length} table(s) · scroll sideways for the rest when the diagram is wider than the panel
        </span>
      </div>

      {erd.nodes.some((n) => n.cycleGroup !== null) && (
        <Callout tone="warning" title="Some tables reference each other">
          Their order cannot be resolved by looking at the schema alone. A migration writes the records first
          and fills the references that close the cycle in a second pass, which is what the dashed lines are.
        </Callout>
      )}

      {erd.externalReferences.length > 0 && (
        <Callout
          tone="info"
          title={`${erd.externalReferences.length} reference(s) point outside this analysis`}
        >
          <ul className="mt-1 space-y-0.5 text-xs">
            {erd.externalReferences.slice(0, 12).map((r, i) => (
              <li key={i}>
                <span className="font-medium">{r.from}</span>
                <span className={cx('mx-1 font-mono')}>{r.attribute}</span>→{' '}
                <span className="font-medium">{r.to}</span>
              </li>
            ))}
          </ul>
          {erd.externalReferences.length > 12 && (
            <p className="mt-1 text-xs">
              <Pill tone="slate">and {erd.externalReferences.length - 12} more</Pill>
            </p>
          )}
          <p className="mt-2 text-xs">
            Those tables were not analyzed, so the diagram cannot draw them. Include them in an analysis to
            see the whole picture.
          </p>
        </Callout>
      )}
    </div>
  );
}
