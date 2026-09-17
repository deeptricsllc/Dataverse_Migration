import type { DependencyAnalysisDto, DependencyEdgeDto, DependencyNodeDto } from '../../../shared/domain';
import { LOOKUP_TYPES, PLATFORM_TABLES, SYSTEM_MANAGED_COLUMNS, type TableMetadata } from '../../../shared/metadata';

export interface DependencyInput {
  /** Tables selected for migration with their source metadata. */
  tables: TableMetadata[];
  /** Logical names that exist in the target environment. */
  targetTables: ReadonlySet<string>;
  /**
   * Optional: lookup columns that are actually migrated per table. When provided, unmapped
   * lookups do not create dependencies.
   */
  mappedLookups?: ReadonlyMap<string, ReadonlySet<string>>;
}

const isRequired = (level: string) => level === 'ApplicationRequired' || level === 'SystemRequired';

/** Extracts dependency edges from lookup columns of the selected tables. */
export function buildEdges(input: DependencyInput): DependencyEdgeDto[] {
  const selected = new Set(input.tables.map((t) => t.logicalName));
  const edges: DependencyEdgeDto[] = [];
  for (const table of input.tables) {
    const mapped = input.mappedLookups?.get(table.logicalName);
    for (const attr of table.attributes) {
      if (!LOOKUP_TYPES.has(attr.type) || attr.attributeOf) continue;
      if (!attr.isValidForCreate && !attr.isValidForUpdate) continue;
      if (mapped ? !mapped.has(attr.logicalName) : SYSTEM_MANAGED_COLUMNS.has(attr.logicalName)) continue;
      for (const to of attr.targets ?? []) {
        let kind: DependencyEdgeDto['kind'];
        if (PLATFORM_TABLES.has(to)) kind = 'PLATFORM';
        else if (to === table.logicalName) kind = 'SELF';
        else if (selected.has(to)) kind = 'IN_SELECTION';
        else if (!input.targetTables.has(to)) kind = 'MISSING_IN_TARGET';
        else kind = 'NOT_SELECTED';
        edges.push({
          from: table.logicalName,
          to,
          attribute: attr.logicalName,
          required: isRequired(attr.requiredLevel),
          kind,
          deferred: false,
        });
      }
    }
  }
  return edges.sort((a, b) => (a.from + a.attribute + a.to).localeCompare(b.from + b.attribute + b.to));
}

/** Tarjan's strongly connected components. Returns components in discovery order. */
export function stronglyConnectedComponents(nodes: string[], adjacency: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const result: string[][] = [];

  // Iterative implementation to avoid stack overflow on large graphs.
  for (const start of nodes) {
    if (indices.has(start)) continue;
    const work: { node: string; i: number }[] = [{ node: start, i: 0 }];
    indices.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.i < neighbors.length) {
        const next = neighbors[frame.i++];
        if (!indices.has(next)) {
          indices.set(next, index);
          low.set(next, index);
          index++;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, indices.get(next)!));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].node;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
        }
        if (low.get(frame.node) === indices.get(frame.node)) {
          const component: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
          } while (w !== frame.node);
          result.push(component.sort());
        }
      }
    }
  }
  return result;
}

/** Finds one cycle among the given edges (restricted to component nodes), or null. */
function findCycle(nodes: string[], edges: DependencyEdgeDto[]): DependencyEdgeDto[] | null {
  const out = new Map<string, DependencyEdgeDto[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const state = new Map<string, 0 | 1 | 2>();
  const path: DependencyEdgeDto[] = [];
  const visit = (n: string): DependencyEdgeDto[] | null => {
    state.set(n, 1);
    for (const e of out.get(n) ?? []) {
      const s = state.get(e.to) ?? 0;
      if (s === 1) {
        const startIdx = path.findIndex((p) => p.from === e.to);
        return [...(startIdx >= 0 ? path.slice(startIdx) : []), e];
      }
      if (s === 0) {
        path.push(e);
        const found = visit(e.to);
        if (found) return found;
        path.pop();
      }
    }
    state.set(n, 2);
    return null;
  };
  for (const n of nodes) {
    if ((state.get(n) ?? 0) === 0) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

export function analyzeDependencies(input: DependencyInput): DependencyAnalysisDto {
  const names = input.tables.map((t) => t.logicalName).sort();
  const displayNames = new Map(input.tables.map((t) => [t.logicalName, t.displayName]));
  const edges = buildEdges(input);
  const graphEdges = edges.filter((e) => e.kind === 'IN_SELECTION' || e.kind === 'SELF');

  const adjacency = new Map<string, string[]>();
  for (const e of graphEdges) adjacency.set(e.from, [...new Set([...(adjacency.get(e.from) ?? []), e.to])]);
  const components = stronglyConnectedComponents(names, adjacency);

  // In-degree from other tables (self-references excluded) guides which edges to defer.
  const inDegree = new Map<string, number>();
  for (const e of graphEdges) if (e.from !== e.to) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);

  const cycleGroupOf = new Map<string, number>();
  const cycles: DependencyAnalysisDto['cycles'] = [];
  let group = 0;
  for (const component of components) {
    const members = new Set(component);
    const intra = graphEdges.filter((e) => members.has(e.from) && members.has(e.to));
    const cyclic = component.length > 1 || intra.some((e) => e.from === e.to);
    if (!cyclic) continue;
    group++;
    component.forEach((n) => cycleGroupOf.set(n, group));

    // Break cycles by deferring nullable lookups to pass 2. Prefer deferring edges leaving the
    // table that most others depend on, so that table is created first.
    let remaining = [...intra];
    const deferred: DependencyEdgeDto[] = [];
    let resolvable = true;
    for (;;) {
      const cycle = findCycle(component, remaining);
      if (!cycle) break;
      const candidates = cycle
        .filter((e) => !e.required)
        .sort(
          (a, b) =>
            (inDegree.get(b.from) ?? 0) - (inDegree.get(a.from) ?? 0) ||
            (a.from + a.attribute).localeCompare(b.from + b.attribute),
        );
      if (candidates.length === 0) {
        resolvable = false;
        break;
      }
      // Defer a single edge (attribute + target table). For polymorphic lookups the other targets
      // are still resolved in pass 1.
      const pick = candidates[0];
      deferred.push(pick);
      remaining = remaining.filter((e) => e !== pick);
    }
    for (const d of deferred) {
      const original = edges.find((e) => e.from === d.from && e.to === d.to && e.attribute === d.attribute);
      if (original) original.deferred = true;
    }
    cycles.push({ group, tables: component, resolvable, deferredEdges: deferred.map((d) => ({ ...d, deferred: true })) });
  }

  // Kahn's algorithm on non-deferred in-selection edges; deterministic alphabetical tie-break.
  const orderEdges = edges.filter((e) => (e.kind === 'IN_SELECTION' || e.kind === 'SELF') && !e.deferred && e.from !== e.to);
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const e of orderEdges) deps.get(e.from)!.add(e.to);
  const order: string[] = [];
  const placed = new Set<string>();
  const hasSelfBlock = new Set(
    edges.filter((e) => e.kind === 'SELF' && !e.deferred).map((e) => e.from),
  );
  for (;;) {
    const ready = names.filter((n) => !placed.has(n) && [...deps.get(n)!].every((d) => placed.has(d)) && !hasSelfBlock.has(n));
    if (ready.length === 0) break;
    const next = ready[0];
    order.push(next);
    placed.add(next);
  }
  const unordered = names.filter((n) => !placed.has(n));

  const nodes: DependencyNodeDto[] = names.map((n) => {
    const dependsOn = edges.filter((e) => e.from === n);
    const dependents = edges.filter((e) => e.to === n && e.from !== n && (e.kind === 'IN_SELECTION'));
    const warnings: string[] = [];
    for (const e of dependsOn) {
      if (e.kind === 'NOT_SELECTED') {
        warnings.push(
          `${e.attribute} references ${e.to}, which is not selected. Values resolve only if matching ${e.to} records already exist in the target${e.required ? ' (required lookup)' : '; unresolved values are left empty'}.`,
        );
      } else if (e.kind === 'MISSING_IN_TARGET') {
        warnings.push(`${e.attribute} references ${e.to}, which does not exist in the target environment.`);
      } else if (e.kind === 'PLATFORM') {
        warnings.push(`${e.attribute} references platform table ${e.to}; resolved by identifier in the target.`);
      } else if (e.deferred) {
        warnings.push(`${e.attribute} → ${e.to} is part of a circular dependency and will be set in pass 2.`);
      }
    }
    if (unordered.includes(n)) {
      warnings.push(
        cycleGroupOf.has(n)
          ? 'Circular dependency through required lookups cannot be resolved automatically.'
          : 'Depends on tables with an unresolved circular dependency.',
      );
    }
    return {
      logicalName: n,
      displayName: displayNames.get(n) ?? n,
      order: order.includes(n) ? order.indexOf(n) + 1 : null,
      dependsOn,
      dependents,
      cycleGroup: cycleGroupOf.get(n) ?? null,
      warnings,
    };
  });

  const missingMap = new Map<string, { table: string; attribute: string; required: boolean }[]>();
  for (const e of edges.filter((x) => x.kind === 'NOT_SELECTED')) {
    missingMap.set(e.to, [...(missingMap.get(e.to) ?? []), { table: e.from, attribute: e.attribute, required: e.required }]);
  }

  return {
    order: [...order, ...unordered],
    nodes,
    cycles,
    missingDependencies: [...missingMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, requiredBy]) => ({ table, requiredBy })),
  };
}
