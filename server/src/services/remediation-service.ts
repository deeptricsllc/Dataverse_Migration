import type { IssueRowDto, PrincipalMappingDto, TableDiff } from '../../../shared/domain';
import type { ComparisonService } from './comparison-service';
import type { RequestContext } from './context';
import type { PlanningService } from './planning-service';
import type { PreflightService } from './preflight-service';
import type { PrincipalService } from './principal-service';

/**
 * Builds the remediation package: every issue a migration team has to fix before executing,
 * gathered from the plan, the schema comparison, the user mapping and the latest preflight,
 * in one flat, exportable shape.
 */
export class RemediationService {
  constructor(
    private readonly planning: PlanningService,
    private readonly comparisons: ComparisonService,
    private readonly principals: PrincipalService,
    private readonly preflight: PreflightService,
  ) {}

  async buildIssueRows(ctx: RequestContext, planId: string): Promise<IssueRowDto[]> {
    const plan = await this.planning.get(ctx, planId);
    const rows: IssueRowDto[] = [];
    const selected = new Set(plan.entities.map((e) => e.logicalName));

    // --- Plan validation issues ---------------------------------------------
    for (const issue of plan.issues) {
      if (issue.acknowledged) continue;
      rows.push({
        severity: issue.severity,
        category: 'Plan validation',
        table: issue.table,
        sourceRecordId: null,
        recordName: null,
        field: issue.field ?? null,
        sourceValue: null,
        targetValue: null,
        issue: issue.message,
        resolution: issue.resolution ?? null,
        suggestedAction: suggestedForCode(issue.code),
      });
    }

    // --- Schema differences for the selected tables --------------------------
    const comparison = plan.comparisonRunId
      ? await this.comparisons.tables(ctx, plan.comparisonRunId).catch(() => [] as TableDiff[])
      : [];
    for (const table of comparison) {
      if (!selected.has(table.logicalName)) continue;
      if (table.status === 'SOURCE_ONLY') {
        rows.push({
          severity: 'BLOCKER',
          category: 'Missing target table',
          table: table.logicalName,
          sourceRecordId: null,
          recordName: null,
          field: null,
          sourceValue: table.displayName,
          targetValue: null,
          issue: `The table ${table.logicalName} does not exist in the target environment.`,
          resolution:
            'Deploy the solution that contains this table to the target, then re-run the comparison.',
          suggestedAction: 'Deploy solution to target',
        });
        continue;
      }
      for (const column of table.columns) {
        if (column.status === 'SOURCE_ONLY') {
          rows.push({
            severity: 'BLOCKER',
            category: 'Missing target column',
            table: table.logicalName,
            sourceRecordId: null,
            recordName: null,
            field: column.logicalName,
            sourceValue: column.sourceType,
            targetValue: null,
            issue: `${column.displayName} (${column.logicalName}) exists in the source but not in the target.`,
            resolution: 'Create the column in the target, or leave the field unmapped to skip its data.',
            suggestedAction: 'Create column in target',
          });
          continue;
        }
        const typeChanged = column.sourceType !== column.targetType;
        if (typeChanged) {
          rows.push({
            severity: 'BLOCKER',
            category: 'Type incompatibility',
            table: table.logicalName,
            sourceRecordId: null,
            recordName: null,
            field: column.logicalName,
            sourceValue: column.sourceType,
            targetValue: column.targetType,
            issue: `${column.logicalName} is ${column.sourceType} in the source and ${column.targetType} in the target.`,
            resolution: 'Align the column types, or unmap the field.',
            suggestedAction: 'Align column type',
          });
        }
        for (const option of column.optionDiff?.sourceOnly ?? []) {
          rows.push({
            severity: 'BLOCKER',
            category: 'Missing choice value',
            table: table.logicalName,
            sourceRecordId: null,
            recordName: null,
            field: column.logicalName,
            sourceValue: `${option.value} (${option.label})`,
            targetValue: null,
            issue: `Choice value ${option.value} "${option.label}" is not defined in the target.`,
            resolution: 'Add the choice value to the target column with the same numeric value.',
            suggestedAction: 'Add choice value to target',
          });
        }
      }
      for (const property of table.differences) {
        if (property.property !== 'PrimaryIdAttribute' && property.property !== 'PrimaryNameAttribute')
          continue;
        rows.push({
          severity: 'WARNING',
          category: 'Table definition difference',
          table: table.logicalName,
          sourceRecordId: null,
          recordName: null,
          field: property.property,
          sourceValue: String(property.source ?? ''),
          targetValue: String(property.target ?? ''),
          issue: `${property.property} differs between source and target.`,
          resolution: 'Review the table definition before migrating records.',
          suggestedAction: 'Review table definition',
        });
      }
    }

    // --- Identity resolution -------------------------------------------------
    const mapping = await this.principals
      .list(ctx, plan.sourceEnvironment.id, plan.targetEnvironment.id)
      .catch(() => null);
    for (const m of mapping?.mappings ?? []) {
      if (m.status === 'AMBIGUOUS') rows.push(identityRow(m, 'Ambiguous user match'));
      else if (m.status === 'UNMATCHED') rows.push(identityRow(m, 'Unresolved user'));
    }

    // --- Preflight results ---------------------------------------------------
    const latest = await this.preflight.latestForPlan(ctx, planId);
    if (latest?.status === 'COMPLETED') {
      const records = await this.preflight.issueRecords(ctx, latest.id);
      for (const r of records) {
        const category =
          r.action === 'CONFLICT'
            ? conflictCategory(r.reasonCode)
            : r.action === 'BLOCKED'
              ? blockedCategory(r.reasonCode)
              : 'Proposed update';
        const severity = r.action === 'UPDATE' ? 'INFO' : 'BLOCKER';
        const changes = r.action === 'UPDATE' ? r.changes.filter((c) => c.action !== 'UNCHANGED') : [];
        if (changes.length) {
          for (const c of changes) {
            rows.push({
              severity,
              category,
              table: r.logicalName,
              sourceRecordId: r.sourceRecordId,
              recordName: r.recordName,
              field: c.field,
              sourceValue: c.sourceValue,
              targetValue: c.targetValue,
              issue: r.reason ?? `${c.displayName} will be updated in the target.`,
              resolution: null,
              suggestedAction: 'Review before executing',
            });
          }
        } else {
          rows.push({
            severity,
            category,
            table: r.logicalName,
            sourceRecordId: r.sourceRecordId,
            recordName: r.recordName,
            field: null,
            sourceValue: null,
            targetValue: r.targetRecordId,
            issue: r.reason ?? r.action,
            resolution: resolutionForReason(r.reasonCode),
            suggestedAction: r.action === 'BLOCKED' ? 'Resolve before executing' : 'Review before executing',
          });
        }
      }
    }

    const order = { BLOCKER: 0, WARNING: 1, INFO: 2 } as const;
    return rows.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));
  }
}

function identityRow(m: PrincipalMappingDto, category: string): IssueRowDto {
  const ambiguous = m.status === 'AMBIGUOUS';
  return {
    severity: 'BLOCKER',
    category,
    table: m.logicalName,
    sourceRecordId: m.source.id,
    recordName: m.source.name,
    field: null,
    sourceValue: m.source.login ?? m.source.email ?? m.source.name,
    targetValue: ambiguous ? m.candidates.map((c) => `${c.name} (${c.id})`).join(' | ') : null,
    issue: ambiguous
      ? `${m.candidates.length} target principals match this source identity, so it was not mapped automatically.`
      : 'No target principal matches this source identity.',
    resolution: ambiguous
      ? 'Choose the correct target on the User mapping page.'
      : 'Create the user in the target, map it manually, or exclude it. Under the STRICT policy its records are blocked.',
    suggestedAction: ambiguous ? 'Choose target identity' : 'Map or exclude identity',
  };
}

const CONFLICT_CATEGORIES: Record<string, string> = {
  AMBIGUOUS_TARGET_MATCH: 'Duplicate target match',
  DUPLICATE_SOURCE_KEY: 'Duplicate business key',
};
const BLOCKED_CATEGORIES: Record<string, string> = {
  PRINCIPAL_UNRESOLVED: 'Unresolved user reference',
  LOOKUP_UNRESOLVED: 'Unresolved lookup',
};
const REASON_RESOLUTIONS: Record<string, string> = {
  AMBIGUOUS_TARGET_MATCH:
    'More than one target record matches. De-duplicate the target, or choose a stricter match strategy.',
  DUPLICATE_SOURCE_KEY:
    'Two source records share the same business key. Fix the source data or change the key.',
  PRINCIPAL_UNRESOLVED:
    'Map the referenced user/team on the User mapping page, or switch the user resolution policy to FALLBACK.',
  LOOKUP_UNRESOLVED: 'Include the referenced table in the plan, or clear the lookup in the source.',
};

const conflictCategory = (code: string | null) => (code && CONFLICT_CATEGORIES[code]) || 'Conflict';
const blockedCategory = (code: string | null) => (code && BLOCKED_CATEGORIES[code]) || 'Blocked record';
const resolutionForReason = (code: string | null) => (code && REASON_RESOLUTIONS[code]) || null;

function suggestedForCode(code: string): string | null {
  if (code.startsWith('PRINCIPALS_') || code === 'FALLBACK_NOT_CONFIGURED') return 'Resolve user mapping';
  if (code.startsWith('ALTERNATE_KEY') || code.startsWith('BUSINESS_KEY')) return 'Review match strategy';
  if (code.startsWith('AUDIT_')) return 'Review audit policy';
  return null;
}
