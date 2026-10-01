/**
 * Who may do what, in one table.
 *
 * Scattered conditionals are not an authorization model: they are a set of places somebody
 * remembered. The matrix below is the model, the server enforces it on every mutating request
 * before a route handler runs, and the browser reads the same table only to decide what to show.
 * A hidden button is not authorization, so nothing here is trusted on the client side.
 *
 * Four roles, chosen from what a migration team actually contains rather than from an org chart:
 *
 * - **Administrator** — accountable for the workspace. The only role that writes to production,
 *   schedules unattended writes, destroys connections and their stored credentials, or changes who
 *   else is in the workspace.
 * - **Migration operator** — does the work. Plans, maps, transforms, migrates to non-production,
 *   controls and resumes runs. This is what every member used to be, and it stays that way.
 * - **Validator** — checks the work. Reads everything, runs validations, exports evidence, and
 *   changes nothing about the migration itself. The person signing off should not be the person who
 *   can quietly alter a mapping first.
 * - **Auditor** — reads. Including the audit trail and the evidence packages, which is the point of
 *   the role; nothing else.
 */

export const WORKSPACE_ROLES = ['ADMIN', 'MIGRATION_OPERATOR', 'VALIDATOR', 'READ_ONLY'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const ROLE_LABELS: Record<WorkspaceRole, { label: string; summary: string }> = {
  ADMIN: {
    label: 'Administrator',
    summary: 'Everything, including production targets, schedules, connections and membership.',
  },
  MIGRATION_OPERATOR: {
    label: 'Migration operator',
    summary: 'Plans, maps, transforms and migrates to non-production. Cannot change membership.',
  },
  VALIDATOR: {
    label: 'Validator',
    summary: 'Runs validations and exports evidence. Changes nothing about the migration itself.',
  },
  READ_ONLY: {
    label: 'Auditor',
    summary: 'Reads everything, including the audit trail and evidence packages. Changes nothing.',
  },
};

export type Permission =
  /** Any change at all to the workspace. The default a mutating request must clear. */
  | 'workspace:mutate'
  /** Start a validation, or configure how deeply one runs. */
  | 'validation:run'
  /** Start, cancel, pause, resume or re-run a migration. */
  | 'migration:control'
  /** Delete a connection, and with it a stored credential other plans depend on. */
  | 'connections:delete'
  /** Write to a target that is not classified as non-production. */
  | 'production:write'
  /** Create or change a schedule, which keeps writing when nobody is watching. */
  | 'schedules:write'
  /** Reset the workspace, archiving its projects and restoring simulated data. */
  | 'workspace:reset'
  /** Change who is in the workspace and what they may do. */
  | 'members:manage';

/**
 * The matrix. A role has a permission only if it is listed.
 *
 * Reading is not a permission here because every role reads: the workspace boundary already decides
 * who sees what, and a role that could not read would have nothing to do. What differs is what each
 * one may change.
 */
const GRANTS: Record<WorkspaceRole, readonly Permission[]> = {
  ADMIN: [
    'workspace:mutate',
    'validation:run',
    'migration:control',
    'connections:delete',
    'production:write',
    'schedules:write',
    'workspace:reset',
    'members:manage',
  ],
  MIGRATION_OPERATOR: ['workspace:mutate', 'validation:run', 'migration:control'],
  VALIDATOR: ['validation:run'],
  READ_ONLY: [],
};

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

export function permissionsFor(role: WorkspaceRole): readonly Permission[] {
  return GRANTS[role];
}

/**
 * Roles stored before this model existed.
 *
 * `MEMBER` was the only non-administrator role and could do everything an operator can, so that is
 * what it becomes. Reading it as anything weaker would silently take work away from people who had
 * it; reading it as administrator would silently hand out production.
 */
export function normaliseRole(stored: string | null | undefined): WorkspaceRole {
  if (stored === 'ADMIN') return 'ADMIN';
  if (stored === 'MEMBER') return 'MIGRATION_OPERATOR';
  return (WORKSPACE_ROLES as readonly string[]).includes(stored ?? '')
    ? (stored as WorkspaceRole)
    : 'READ_ONLY';
}

/**
 * What a role cannot do, phrased for the person who just tried to do it.
 *
 * Says what the role is for rather than only what it is not, because somebody reading "forbidden"
 * on a button they were given needs to know whether that is a mistake or the design.
 */
export function refusalFor(role: WorkspaceRole, action: string): string {
  const meta = ROLE_LABELS[role];
  return `${action} is not available to a ${meta.label.toLowerCase()}. ${meta.summary}`;
}
