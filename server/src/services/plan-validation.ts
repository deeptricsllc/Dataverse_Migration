import {
  auditFlags,
  auditNeedsImpersonation,
  auditNeedsPrincipals,
  type AutomationInfo,
  DependencyAnalysisDto,
  DiffStatus,
  MatchStrategy,
  PlanIssue,
  PlanOptions,
  TableDiff,
} from '../../../shared/domain';
import { SYSTEM_MANAGED_COLUMNS, isKeyUsable, type TableMetadata } from '../../../shared/metadata';
import type { MappingProposal } from './mapping';
import { isRequiredLevel } from './mapping';

export interface PlanValidationEntity {
  logicalName: string;
  source: TableMetadata | undefined;
  target: TableMetadata | undefined;
  schemaStatus: DiffStatus | null;
  tableDiff: TableDiff | null;
  mappings: Pick<MappingProposal, 'sourceField' | 'targetField' | 'status' | 'reason' | 'isLookup'>[];
  sourceCount: number | null;
  targetCount: number | null;
  matchStrategy: MatchStrategy;
  alternateKey: string | null;
  businessKeyFields: string[];
  automation: AutomationInfo | null;
  audit?: {
    ownerField: string | null;
    createdOnField: string | null;
    createdByField: string | null;
    modifiedByField: string | null;
    overriddenCreatedOnField: string | null;
    touchField: { source: string; target: string } | null;
  } | null;
}

export interface PlanValidationInput {
  entities: PlanValidationEntity[];
  dependencies: DependencyAnalysisDto;
  options: PlanOptions;
  bypassAllowed: boolean;
  /** Principal mapping state for ownership / audit preservation. */
  principals?: { total: number; unmatched: number; ambiguous: number; canImpersonate: boolean | null };
}

const MAPPED = new Set(['AUTO_MAPPED', 'MANUAL']);

/** Produces BLOCKER / WARNING / INFO issues for a migration plan. Pure and deterministic. */
export function validatePlan(input: PlanValidationInput): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (i: PlanIssue) => issues.push(i);

  if (input.entities.length === 0) {
    add({
      severity: 'BLOCKER',
      code: 'NO_TABLES_SELECTED',
      table: null,
      message: 'Select at least one table to migrate.',
    });
  }

  for (const e of input.entities) {
    const t = e.logicalName;
    if (!e.source) {
      add({
        severity: 'BLOCKER',
        code: 'TABLE_MISSING_IN_SOURCE',
        table: t,
        message: `${t} does not exist in the source environment.`,
      });
      continue;
    }
    if (!e.target) {
      add({
        severity: 'BLOCKER',
        code: 'TABLE_MISSING_IN_TARGET',
        table: t,
        message: `${e.source.displayName} (${t}) does not exist in the target environment.`,
        resolution: 'Deploy the table to the target (solution import) or remove it from the plan.',
      });
      continue;
    }
    if (e.source.primaryIdAttribute !== e.target.primaryIdAttribute) {
      add({
        severity: 'BLOCKER',
        code: 'PRIMARY_KEY_MISMATCH',
        table: t,
        message: `Primary key differs (${e.source.primaryIdAttribute} vs ${e.target.primaryIdAttribute}).`,
      });
    }

    // Required target columns that nothing maps into.
    const mappedTargets = new Set(e.mappings.filter((m) => MAPPED.has(m.status)).map((m) => m.targetField));
    for (const ta of e.target.attributes) {
      if (!isRequiredLevel(ta.requiredLevel) || ta.isPrimaryId || ta.attributeOf) continue;
      if (!ta.isValidForCreate || SYSTEM_MANAGED_COLUMNS.has(ta.logicalName)) continue;
      if (ta.logicalName === 'statecode' || ta.logicalName === 'statuscode') continue;
      if (!mappedTargets.has(ta.logicalName)) {
        add({
          severity: 'BLOCKER',
          code: 'REQUIRED_TARGET_COLUMN_UNMAPPED',
          table: t,
          field: ta.logicalName,
          message: `Required target column ${ta.displayName} (${ta.logicalName}) has no mapped source column.`,
          resolution: 'Map a source column to it in Field Mapping, or change the requirement in the target.',
        });
      }
    }

    const unmapped = e.mappings.filter((m) => m.status === 'UNMAPPED');
    if (unmapped.length) {
      add({
        severity: 'INFO',
        code: 'UNMAPPED_COLUMNS',
        table: t,
        message: `${unmapped.length} source column(s) will not be migrated: ${unmapped.map((m) => m.sourceField).join(', ')}.`,
        resolution: 'Map them manually if their data is needed in the target.',
      });
    }
    for (const m of e.mappings.filter((x) => x.status === 'INCOMPATIBLE')) {
      add({
        severity: 'WARNING',
        code: 'INCOMPATIBLE_COLUMN',
        table: t,
        field: m.sourceField,
        message: `${m.sourceField} is incompatible with the target and will not be migrated: ${m.reason}`,
      });
    }

    // Breaking column-level schema differences on columns that are migrated.
    const mappedSource = new Set(e.mappings.filter((m) => MAPPED.has(m.status)).map((m) => m.sourceField));
    for (const col of e.tableDiff?.columns ?? []) {
      if (!mappedSource.has(col.logicalName)) continue;
      for (const d of col.differences.filter((x) => x.breaking)) {
        add({
          severity: 'WARNING',
          code: `SCHEMA_${d.property.toUpperCase()}`,
          table: t,
          field: col.logicalName,
          message: `${col.displayName}: ${d.note ?? `${d.property} differs`}`,
          resolution: 'Records violating the target definition will fail individually and be reported.',
        });
      }
    }

    if (e.matchStrategy === 'ALTERNATE_KEY') {
      const key = e.alternateKey ? e.target.keys.find((k) => k.logicalName === e.alternateKey) : undefined;
      if (!key) {
        add({
          severity: 'BLOCKER',
          code: 'ALTERNATE_KEY_MISSING',
          table: t,
          message: `Alternate key ${e.alternateKey ?? '(none)'} is not defined in the target.`,
          resolution: 'Choose a key that exists in both environments or match by record id.',
        });
      } else if (!isKeyUsable(key)) {
        add({
          severity: 'BLOCKER',
          code: 'ALTERNATE_KEY_NOT_ACTIVE',
          table: t,
          message: `The alternate key ${key.logicalName} has index status ${key.status}; its uniqueness is not enforced yet, so it cannot be used to match records safely.`,
          resolution:
            'Wait for the key index to become Active in the target, or choose another match strategy.',
        });
      } else {
        const unmappedKeyAttrs = key.attributes.filter((a) => !mappedTargets.has(a));
        if (unmappedKeyAttrs.length) {
          add({
            severity: 'BLOCKER',
            code: 'ALTERNATE_KEY_UNMAPPED',
            table: t,
            message: `Alternate key columns are not mapped: ${unmappedKeyAttrs.join(', ')}.`,
          });
        }
      }
    }

    if (e.matchStrategy === 'BUSINESS_KEY') {
      const fields = e.businessKeyFields ?? [];
      if (fields.length === 0) {
        add({
          severity: 'BLOCKER',
          code: 'BUSINESS_KEY_NOT_CONFIGURED',
          table: t,
          message: 'Matching by business key is selected but no columns are configured.',
          resolution: 'Choose the columns that identify a record uniquely, or match by record id.',
        });
      } else {
        const unmapped = fields.filter((f) => !mappedTargets.has(f));
        if (unmapped.length) {
          add({
            severity: 'BLOCKER',
            code: 'BUSINESS_KEY_UNMAPPED',
            table: t,
            message: `Business key columns are not mapped: ${unmapped.join(', ')}.`,
          });
        }
        const namedOnly = fields.length === 1 && fields[0] === e.target.primaryNameAttribute;
        add({
          severity: namedOnly ? 'WARNING' : 'INFO',
          code: 'BUSINESS_KEY_UNIQUENESS',
          table: t,
          message: namedOnly
            ? `Matching on the display name column ${fields[0]} alone is risky: Dataverse does not enforce its uniqueness. Duplicates are reported as conflicts and never written.`
            : `Records are matched on ${fields.join(' + ')}. Dataverse does not enforce uniqueness for this combination; duplicates are reported as conflicts and never written.`,
          resolution: 'Run a preflight to see whether any duplicates exist.',
        });
      }
    }

    if (input.options.conflictStrategy === 'CREATE_ONLY' && (e.targetCount ?? 0) > 0) {
      add({
        severity: 'WARNING',
        code: 'TARGET_HAS_DATA_CREATE_ONLY',
        table: t,
        message: `Target already contains ${e.targetCount} record(s). CREATE_ONLY fails for records that already exist.`,
      });
    }
    if (e.sourceCount === 0) {
      add({ severity: 'INFO', code: 'SOURCE_EMPTY', table: t, message: 'Source table has no records.' });
    }
    if (e.automation) {
      const a = e.automation;
      if (!a.detectionSupported) {
        add({
          severity: 'INFO',
          code: 'AUTOMATION_DETECTION_UNAVAILABLE',
          table: t,
          message:
            'Could not inspect plug-ins/workflows for this table. Server-side logic may run on create/update.',
        });
      } else if (a.pluginSteps + a.workflows + a.flows > 0) {
        add({
          severity: 'WARNING',
          code: 'SERVER_SIDE_LOGIC',
          table: t,
          message: `Target runs server-side logic on this table (${a.pluginSteps} plug-in step(s), ${a.workflows} classic workflow(s), ${a.flows} flow(s)). It will execute for migrated records.`,
          resolution: 'Review side effects (emails, integrations, auto-numbering) before executing.',
        });
      }
    }
  }

  for (const node of input.dependencies.nodes) {
    for (const edge of node.dependsOn) {
      if (edge.kind === 'NOT_SELECTED') {
        add({
          severity: edge.required ? 'WARNING' : 'INFO',
          code: 'DEPENDENCY_NOT_SELECTED',
          table: node.logicalName,
          field: edge.attribute,
          message: `${node.displayName} requires ${edge.to} via ${edge.attribute}, which is not selected. Only references to ${edge.to} records that already exist in the target will resolve.`,
          resolution: `Add ${edge.to} to the plan if its records must be migrated.`,
        });
      } else if (edge.kind === 'MISSING_IN_TARGET') {
        add({
          severity: edge.required ? 'BLOCKER' : 'WARNING',
          code: 'DEPENDENCY_MISSING_IN_TARGET',
          table: node.logicalName,
          field: edge.attribute,
          message: `${edge.attribute} references ${edge.to}, which does not exist in the target.`,
        });
      }
    }
  }
  for (const cycle of input.dependencies.cycles) {
    if (!cycle.resolvable) {
      add({
        severity: 'BLOCKER',
        code: 'UNRESOLVABLE_CIRCULAR_DEPENDENCY',
        table: cycle.tables[0],
        message: `Circular dependency through required lookups: ${cycle.tables.join(' ↔ ')}.`,
        resolution:
          'Make one of the lookups optional in the target or migrate these tables with a custom sequence.',
      });
    } else {
      add({
        severity: 'INFO',
        code: 'CIRCULAR_DEPENDENCY_TWO_PASS',
        table: cycle.tables[0],
        message: `Circular dependency ${cycle.tables.join(' ↔ ')} handled in two passes; deferred: ${cycle.deferredEdges
          .map((e) => `${e.from}.${e.attribute}`)
          .join(', ')}.`,
      });
    }
  }

  if (input.options.bypassCustomBusinessLogic) {
    add({
      severity: input.bypassAllowed ? 'WARNING' : 'BLOCKER',
      code: 'BUSINESS_LOGIC_BYPASS',
      table: null,
      message: input.bypassAllowed
        ? 'Custom synchronous and asynchronous plug-ins will be bypassed. Requires the prvBypassCustomBusinessLogic privilege in the target. This action is audited.'
        : 'Bypassing custom business logic is disabled for this installation (ALLOW_BUSINESS_LOGIC_BYPASS) or your role.',
    });
  }
  if (input.options.suppressFlowTriggers) {
    add({
      severity: 'WARNING',
      code: 'FLOW_TRIGGERS_SUPPRESSED',
      table: null,
      message: 'Power Automate flows triggered by Dataverse events will not run for migrated records.',
    });
  }
  // ---------------------------------------------------------------------------
  // Identity resolution and audit preservation policies
  // ---------------------------------------------------------------------------
  const flags = auditFlags(input.options.auditPolicy);
  const identityNeeded = auditNeedsPrincipals(input.options.auditPolicy);
  const p = input.principals;

  if (identityNeeded) {
    if (!p || p.total === 0) {
      add({
        severity: 'BLOCKER',
        code: 'PRINCIPALS_NOT_MAPPED',
        table: null,
        message:
          'Ownership/audit preservation is enabled but users have not been mapped for this environment pair.',
        resolution: 'Open User mapping and load the directories.',
      });
    } else {
      if (p.ambiguous > 0) {
        add({
          severity: 'BLOCKER',
          code: 'PRINCIPALS_AMBIGUOUS',
          table: null,
          message: `${p.ambiguous} source user(s)/team(s) match more than one target principal. Ambiguous identities are never resolved automatically.`,
          resolution: 'Choose the correct target on the User mapping page, or exclude the identity.',
        });
      }
      if (p.unmatched > 0) {
        if (input.options.userResolutionPolicy === 'STRICT') {
          add({
            severity: 'BLOCKER',
            code: 'PRINCIPALS_UNRESOLVED_STRICT',
            table: null,
            message: `${p.unmatched} of ${p.total} source users/teams have no approved target mapping. Under the STRICT policy their records are blocked instead of being reassigned.`,
            resolution:
              'Map or exclude each identity on the User mapping page, or switch the user resolution policy to FALLBACK and choose a fallback identity.',
          });
        } else if (!input.options.fallbackPrincipal) {
          add({
            severity: 'BLOCKER',
            code: 'FALLBACK_NOT_CONFIGURED',
            table: null,
            message:
              'The FALLBACK user resolution policy is selected but no fallback identity has been chosen. Ownership is never silently reassigned to the executing user.',
            resolution: 'Choose a fallback target user or team in the plan options.',
          });
        } else {
          add({
            severity: 'WARNING',
            code: 'PRINCIPALS_FALLBACK',
            table: null,
            message: `${p.unmatched} of ${p.total} source users/teams have no approved mapping. Their records will be attributed to ${input.options.fallbackPrincipal.name}, and every substitution is recorded per record.`,
            resolution: 'Run a preflight to see exactly how many records and fields are affected.',
          });
        }
      }
    }
  }

  if (auditNeedsImpersonation(input.options.auditPolicy)) {
    const canImpersonate = p?.canImpersonate;
    add({
      severity: canImpersonate === false ? 'BLOCKER' : canImpersonate === true ? 'WARNING' : 'BLOCKER',
      code: 'AUDIT_IMPERSONATION',
      table: null,
      message:
        canImpersonate === true
          ? 'Records are written while impersonating the mapped source users so that created by / modified by match the source. Every write is audited.'
          : canImpersonate === false
            ? 'PRESERVE_ATTRIBUTION requires the "Act on Behalf of Another User" privilege (prvActOnBehalfOfAnotherUser) in the target, which this account does not have. Microsoft requires it to be assigned directly, not through a team.'
            : 'The impersonation privilege has not been verified for this target. Run the check before executing.',
      resolution:
        canImpersonate === true
          ? undefined
          : 'Open User mapping and run the impersonation check, or choose the STANDARD audit policy.',
    });
    add({
      severity: 'INFO',
      code: 'MODIFIED_ON_NOT_PRESERVABLE',
      table: null,
      message: 'Modified on always becomes the migration time: Dataverse does not allow it to be written.',
    });
    const records = input.entities.reduce((n, e) => n + (e.sourceCount ?? 0), 0);
    add({
      severity: 'INFO',
      code: 'AUDIT_EXTRA_WRITE',
      table: null,
      message: `Audit mode: Preserve attribution. Records: ${records.toLocaleString()}. Additional "modified by" writes: approximately ${records.toLocaleString()} (one extra update per migrated record).`,
    });
  }

  for (const e of input.entities) {
    if (!e.audit) continue;
    if (flags.owner && !e.audit.ownerField) {
      add({
        severity: 'INFO',
        code: 'OWNERSHIP_NOT_APPLICABLE',
        table: e.logicalName,
        message:
          'This table has no owner column (organization-owned); ownership preservation does not apply.',
      });
    }
    if (flags.createdOn && !e.audit.overriddenCreatedOnField) {
      add({
        severity: 'WARNING',
        code: 'CREATED_ON_NOT_PRESERVABLE',
        table: e.logicalName,
        message:
          'The target does not expose overriddencreatedon for this table; created on will be the migration time.',
      });
    }
    if (flags.modifiedBy && !e.audit.touchField) {
      add({
        severity: 'WARNING',
        code: 'MODIFIED_BY_NOT_PRESERVABLE',
        table: e.logicalName,
        message: 'No writable mapped column is available to re-stamp "modified by" for this table.',
      });
    }
  }

  if (flags.createdOn) {
    add({
      severity: 'INFO',
      code: 'CREATED_ON_PRIVILEGE',
      table: null,
      message:
        'Backdating created on uses overriddencreatedon, which requires the "Override Created on or Created by for Records during Data Import" privilege (prvOverrideCreatedOnCreatedBy) in the target.',
    });
  }

  if (input.options.conflictStrategy === 'SYNC') {
    add({
      severity: 'INFO',
      code: 'SYNC_STRATEGY',
      table: null,
      message:
        'Sync: missing records are created, changed records are updated field by field, and identical records are left untouched (no Dataverse write, so their modified on / modified by stay as they are).',
    });
  }
  if (input.options.conflictStrategy === 'UPSERT') {
    add({
      severity: 'WARNING',
      code: 'UPSERT_OVERWRITES',
      table: null,
      message: 'UPSERT overwrites mapped columns of records that already exist in the target.',
    });
  }
  return issues;
}

export const countBySeverity = (issues: PlanIssue[], severity: PlanIssue['severity']) =>
  issues.filter((i) => i.severity === severity).length;
