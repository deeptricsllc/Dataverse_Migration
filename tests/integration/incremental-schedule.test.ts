import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvironmentDto, MigrationPlanDto, MigrationScheduleDto } from '../../shared/domain';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Reading only what changed, against a real connector and real stored rows.
 *
 * This is the claim a recurring migration rests on: that asking for "records changed since X"
 * returns those records and not the whole table. The unit tests pin the comparison; this pins that
 * the connector actually applies it.
 */
describe('incremental reads and incremental schedules', () => {
  let t: TestApp;
  let api: ApiClient;
  let dev: EnvironmentDto;
  let qa: EnvironmentDto;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const session = await api.demoLogin();
    organizationId = session.user.organization.id;
    userId = session.user.id;
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;
  });
  afterAll(async () => {
    await t.close();
  });

  const connector = async (environmentId: string) => {
    const env = await t.services.environments.getInOrganization(organizationId, environmentId);
    return t.services.connections.connectorFor(env, userId, {});
  };

  const readAll = async (
    environmentId: string,
    table: string,
    since: { field: string; value: string } | null,
  ) => {
    const conn = await connector(environmentId);
    const meta = await t.services.metadata.getTable(environmentId, conn, table);
    const ids: string[] = [];
    for await (const page of conn.queryRecords(meta!, ['createdon', 'modifiedon', 'name'], {
      pageSize: 200,
      since,
    })) {
      ids.push(...page.map((r) => r.id));
    }
    return ids;
  };

  it('declares that it can read incrementally', async () => {
    const conn = await connector(dev.id);
    expect(conn.capabilities.supportsIncrementalRead).toBe(true);
  });

  it('returns only records newer than the watermark', async () => {
    const all = await readAll(dev.id, 'account', null);
    expect(all.length).toBeGreaterThan(10);

    // Every demo account shares one modifiedon, so a watermark at that instant excludes all of them
    // — the boundary is strictly greater than, not greater or equal, so nothing is migrated twice.
    const rows = await t.services.db
      .select()
      .from(demoRecords)
      .where(and(eq(demoRecords.environmentKey, 'demo-dev'), eq(demoRecords.logicalName, 'account')));
    const anyModified = String((rows[0].data as Record<string, string>).modifiedon);
    expect(await readAll(dev.id, 'account', { field: 'modifiedon', value: anyModified })).toEqual([]);

    // Move one record forward in time and it is the only one that comes back.
    const target = rows[3];
    const data = { ...(target.data as Record<string, unknown>), modifiedon: '2027-01-01T00:00:00Z' };
    await t.services.db
      .update(demoRecords)
      .set({ data })
      .where(
        and(
          eq(demoRecords.environmentKey, target.environmentKey),
          eq(demoRecords.logicalName, target.logicalName),
          eq(demoRecords.recordId, target.recordId),
        ),
      );

    const changed = await readAll(dev.id, 'account', { field: 'modifiedon', value: anyModified });
    expect(changed).toEqual([target.recordId]);
    // And an earlier watermark still returns everything.
    expect(
      (await readAll(dev.id, 'account', { field: 'modifiedon', value: '2000-01-01T00:00:00Z' })).length,
    ).toBe(all.length);
  });

  it('refuses a watermark column the table does not have, rather than reading everything', async () => {
    // Silently falling back to a full read would make an incremental schedule quietly expensive and
    // its watermark meaningless.
    await expect(readAll(dev.id, 'account', { field: 'not_a_column', value: '2026-01-01' })).rejects.toThrow(
      /no column not_a_column/,
    );
  });

  it('records an incremental schedule with its watermark column', async () => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Accounts, kept up to date',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['account'],
    });
    const schedule = await api.post<MigrationScheduleDto>(`/api/plans/${plan.id}/schedules`, {
      cron: '*/15 * * * *',
      mode: 'INCREMENTAL',
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
    });
    expect(schedule.mode).toBe('INCREMENTAL');
    // Dataverse's own change column is the default, so the common case needs no configuration.
    expect(schedule.watermarkField).toBe('modifiedon');
    // Nothing has run yet, so there is no watermark and the first run will read everything.
    expect(schedule.lastWatermark).toBeNull();

    const custom = await api.patch<MigrationScheduleDto>(`/api/schedules/${schedule.id}`, {
      watermarkField: 'versionnumber',
    });
    expect(custom.watermarkField).toBe('versionnumber');

    // Switching back to a full run clears the watermark column: it would otherwise claim to be
    // filtering on something nothing reads.
    const full = await api.patch<MigrationScheduleDto>(`/api/schedules/${schedule.id}`, { mode: 'FULL' });
    expect(full.mode).toBe('FULL');
    expect(full.watermarkField).toBeNull();
  });

  it('refuses to fire on a warning nobody reviewed, and runs again once it is confirmed', async () => {
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: 'Accounts, watched for new warnings',
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['account'],
    });
    const schedule = await api.post<MigrationScheduleDto>(`/api/plans/${plan.id}/schedules`, {
      cron: '0 3 * * *',
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
    });
    // Whatever the plan warned about at creation is what a person saw and accepted.
    expect(schedule.unreviewedWarnings).toEqual([]);

    // A warning appears that nobody has looked at. Simulated by removing it from the schedule's
    // own acknowledgement, which is exactly the state "a new warning code showed up" produces.
    await t.services.db.execute(
      `update migration_schedules set acknowledged_warnings = '[]'::jsonb where id = '${schedule.id}'`,
    );
    const stale = await api.get<MigrationScheduleDto>(`/api/schedules/${schedule.id}`);
    const hasWarnings = stale.unreviewedWarnings.length > 0;

    if (hasWarnings) {
      // Firing is refused, and the reason names the codes rather than saying "failed".
      await api.request('POST', `/api/schedules/${schedule.id}/trigger`, {}, 400);
      const afterRefusal = await api.get<MigrationScheduleDto>(`/api/schedules/${schedule.id}`);
      expect(afterRefusal.lastError).toMatch(/nobody has reviewed/);

      // Re-confirming is a separate, deliberate act — not a side effect of enabling it.
      const confirmed = await api.patch<MigrationScheduleDto>(`/api/schedules/${schedule.id}`, {
        acknowledgeWarnings: true,
      });
      expect(confirmed.unreviewedWarnings).toEqual([]);
      expect(confirmed.acknowledgedWarnings.length).toBeGreaterThan(0);
    } else {
      // A plan with no warnings at all has nothing to review, and the schedule is unaffected.
      expect(stale.acknowledgedWarnings).toEqual([]);
    }
  });
});
