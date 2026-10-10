import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { stagedTables } from '../db/schema';
import type { environments } from '../db/schema';
import { connectionFamily, isStagedConnection } from '../../../shared/domain';

/**
 * Whether a connection actually resolves to data somebody can analyze.
 *
 * ## The distinction this exists to enforce
 *
 * A **connection** is reusable authenticated access to a system. A **dataset** is concrete content
 * selected from one. Authenticating to SharePoint is not choosing a list; creating a file source is not
 * uploading a file; reaching a SQL server is not picking a table.
 *
 * The product had collapsed the two. A file connection with nothing imported could be added to an analysis
 * project as though it were a dataset, and analysis would be accepted — HTTP 200 — and then fail
 * asynchronously, so the user learned about it as a failure rather than as a choice they had not made yet.
 * That is the wrong answer twice over: it is accepted when it cannot succeed, and it is reported in the
 * vocabulary of a defect.
 *
 * ## Why this is a server rule
 *
 * Because a disabled button is not a rule. The API is the product's contract, and a contract that accepts
 * a request it cannot honour is how empty analyses, zero-record "assessments" and findings about nothing
 * get created. Anything calling this is deciding whether work can begin, so the answer has to be the same
 * whatever asked.
 *
 * ## What it does not do
 *
 * It does not reach across the network. Deciding whether a SQL server is awake is `testConnection`'s job
 * and it can take seconds; this answers the cheaper and more fundamental question — **has anything been
 * selected at all** — from the platform's own records. A connection that passes this check can still turn
 * out to be unreachable, and that is a different error with a different message.
 */

export type DatasetResolution =
  | { resolves: true; describe: string }
  | { resolves: false; reason: DatasetGap; message: string; whatToDo: string };

/** Why a connection is not yet a dataset. Each one has a different thing the user has to go and do. */
export type DatasetGap = 'NO_FILES_IMPORTED' | 'NO_CONTENT_SELECTED' | 'NOT_DISCOVERED' | 'UNAVAILABLE';

type EnvironmentRow = typeof environments.$inferSelect;

/**
 * Can this connection be worked with?
 *
 * Staged sources — uploads, SharePoint, OneDrive — answer from `staged_tables`: content is only there once
 * something was actually imported or selected. Everything else answers from whether the connection has
 * been established at all, because for a database or a Dataverse environment the tables exist on their
 * side whether or not we have looked.
 */
export async function resolveDataset(db: AppDb, env: EnvironmentRow): Promise<DatasetResolution> {
  if (isStagedConnection(env.connectionType)) {
    const rows = await db
      .select({ logicalName: stagedTables.logicalName, rowCount: stagedTables.rowCount })
      .from(stagedTables)
      .where(eq(stagedTables.environmentId, env.id));

    if (rows.length === 0) {
      // An uploaded file source and a SharePoint connection are empty for different reasons, so they get
      // different instructions: one needs a file, the other needs a selection.
      const isUpload = env.connectionType === 'FILE';
      return {
        resolves: false,
        reason: isUpload ? 'NO_FILES_IMPORTED' : 'NO_CONTENT_SELECTED',
        message: isUpload
          ? `${env.displayName} contains no files.`
          : `${env.displayName} is connected. No content is selected.`,
        whatToDo: isUpload
          ? 'Add a file to this connection, then add it to the project.'
          : 'Select a list, library or file, then add it to the project.',
      };
    }
    const records = rows.reduce((sum, r) => sum + r.rowCount, 0);
    return {
      resolves: true,
      describe: `${rows.length} ${rows.length === 1 ? 'table' : 'tables'}, ${records.toLocaleString()} records`,
    };
  }

  /**
   * A Dataverse environment that Microsoft reports as unavailable.
   *
   * Only Dataverse: `dataverse_available` is set from the discovery service's `State`, and every other kind
   * of connection is stored with it `false` because there is no such thing to report. Checking it without
   * asking what kind of connection this is made every SQL Server, Azure SQL, PostgreSQL and MySQL
   * connection permanently "not available" — so none of them could be added to an analysis project at all,
   * while the same connection worked perfectly as a migration source, which reached this code by a
   * different path.
   */
  if (connectionFamily(env.connectionType) === 'DATAVERSE' && env.dataverseAvailable === false) {
    return {
      resolves: false,
      reason: 'UNAVAILABLE',
      message: `${env.displayName} is not available.`,
      whatToDo: 'Test the connection.',
    };
  }

  /**
   * A database or Dataverse connection whose tables we have never been able to see.
   *
   * `connectionStatus` is set by a successful test or discovery. FAILED is the honest "we tried and could
   * not", and it is the one state where offering the connection as a dataset would be a lie. UNKNOWN is
   * untested rather than broken, so it is allowed through — the run will produce a real connection error
   * if it is wrong, which is more useful than refusing on a guess.
   */
  if (env.connectionStatus === 'FAILED') {
    return {
      resolves: false,
      reason: 'UNAVAILABLE',
      message: `The last attempt to reach ${env.displayName} failed.`,
      whatToDo: 'Test the connection. Fix the reported error, then add it to the project.',
    };
  }

  return { resolves: true, describe: env.displayName };
}

/**
 * The same question for several connections at once, for a screen or a precondition check.
 * Returns only the ones that do not resolve, which is what every caller is about to act on.
 */
export async function unresolvableDatasets(
  db: AppDb,
  envs: EnvironmentRow[],
): Promise<{ environment: EnvironmentRow; resolution: Extract<DatasetResolution, { resolves: false }> }[]> {
  const out: { environment: EnvironmentRow; resolution: Extract<DatasetResolution, { resolves: false }> }[] =
    [];
  for (const env of envs) {
    const resolution = await resolveDataset(db, env);
    if (!resolution.resolves) out.push({ environment: env, resolution });
  }
  return out;
}

/** Used by the staged-source service to answer "does this environment hold anything" cheaply. */
export async function stagedContentCount(db: AppDb, environmentId: string): Promise<number> {
  const rows = await db
    .select({ logicalName: stagedTables.logicalName })
    .from(stagedTables)
    .where(and(eq(stagedTables.environmentId, environmentId)));
  return rows.length;
}
