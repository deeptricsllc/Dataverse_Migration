import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQL_CONNECTION_TYPES, STAGED_CONNECTION_TYPES, type ConnectionType } from '../../shared/domain';
import {
  CAPABILITY_LABELS,
  CONNECTOR_VERIFICATION,
  ENGINE_PROVABLE,
  levelRank,
  summaryLevel,
  VERIFICATION_LABELS,
  verificationFor,
  type ConnectorCapabilityKey,
  type VerificationLevel,
} from '../../shared/connector-verification';
import { SqlConnector } from '../../server/src/connectors/sql/sql-connector';
import { PostgresConnector } from '../../server/src/connectors/sql/postgres-connector';
import { MysqlConnector } from '../../server/src/connectors/sql/mysql-connector';
import { DemoConnection } from '../../server/src/dataverse/demo/demo-connection';
import { WebApiConnection } from '../../server/src/dataverse/web-api-connection';

/**
 * The capability matrix has to be checkable, or it is marketing.
 *
 * Its purpose is to separate "there is code for this" from "we have run it against the real thing",
 * which only means something if a claim cannot drift away from its evidence. The strongest claim
 * the product makes about itself — ENGINE VERIFIED — is checked here against the file that a
 * conformance run against an actual server writes, and nothing else produces that file.
 *
 * So promoting a row is not an edit to a TypeScript file. It is an edit plus a passing run against
 * a real database, and without the run this suite fails.
 */

interface EvidenceFile {
  schema: number;
  runs: Record<
    string,
    {
      engine: string;
      connectionType: ConnectionType;
      serverVersion: string;
      driver: string;
      ranAt: string;
      capabilities: Partial<Record<ConnectorCapabilityKey, 'PASSED'>>;
    }
  >;
}

function readEvidence(): EvidenceFile {
  const file = path.resolve(process.cwd(), 'evidence/engine-verification.json');
  if (!fs.existsSync(file)) return { schema: 1, runs: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EvidenceFile;
}

describe('connector verification matrix', () => {
  const evidence = readEvidence();
  const byType = new Map(Object.values(evidence.runs).map((r) => [r.connectionType, r]));

  it('covers every connection type the product offers', () => {
    const all: ConnectionType[] = ['DATAVERSE', ...SQL_CONNECTION_TYPES, ...STAGED_CONNECTION_TYPES];
    for (const type of all) {
      expect(CONNECTOR_VERIFICATION[type], `${type} has no verification row`).toBeTruthy();
    }
  });

  it('uses only defined levels and known capabilities', () => {
    for (const [type, row] of Object.entries(CONNECTOR_VERIFICATION)) {
      for (const [capability, level] of Object.entries(row!)) {
        expect(CAPABILITY_LABELS[capability as ConnectorCapabilityKey], capability).toBeTruthy();
        expect(VERIFICATION_LABELS[level!], `${type}.${capability} = ${level}`).toBeTruthy();
      }
    }
  });

  /**
   * The load-bearing assertion of the whole file.
   *
   * Every ENGINE_VERIFIED cell must point at a recorded run against a real server that proved that
   * exact capability. Delete the evidence and this fails; promote a row without running the suite
   * and this fails; claim a capability the suite never exercised and this fails.
   */
  it('refuses an ENGINE VERIFIED claim the evidence does not support', () => {
    for (const [type, row] of Object.entries(CONNECTOR_VERIFICATION)) {
      for (const [capability, level] of Object.entries(row!)) {
        if (level !== 'ENGINE_VERIFIED') continue;
        // The file connector has no external engine to reach: its storage is our own database and
        // the journeys exercise the real import path. The one exception, and it is named.
        if (type === 'FILE') continue;

        const run = byType.get(type as ConnectionType);
        expect(run, `${type}.${capability} claims ENGINE VERIFIED with no recorded run`).toBeTruthy();
        expect(
          run!.capabilities[capability as ConnectorCapabilityKey],
          `${type}.${capability} claims ENGINE VERIFIED but the ${run!.engine} run did not prove it`,
        ).toBe('PASSED');
        expect(run!.serverVersion, `${type} evidence records which server answered`).toBeTruthy();
        expect(run!.driver, `${type} evidence records which driver was used`).toBeTruthy();
      }
    }
  });

  it('never claims a capability the conformance suite cannot demonstrate', () => {
    // Transformations, validation, rollback and resume live above the connector. They are tested
    // hard, against the connector contract rather than against any database, so labelling them
    // engine-verified would borrow credit from a run that did not cover them.
    for (const [type, row] of Object.entries(CONNECTOR_VERIFICATION)) {
      if (type === 'FILE') continue;
      for (const [capability, level] of Object.entries(row!)) {
        if (level !== 'ENGINE_VERIFIED') continue;
        expect(
          ENGINE_PROVABLE,
          `${type}.${capability} is not something a real-engine run can prove`,
        ).toContain(capability as ConnectorCapabilityKey);
      }
    }
  });

  it('never claims duplicate detection a connector cannot do', () => {
    const implementsScan: Record<string, boolean> = {
      SQL_SERVER: typeof SqlConnector.prototype.findDuplicateKeys === 'function',
      AZURE_SQL: typeof SqlConnector.prototype.findDuplicateKeys === 'function',
      POSTGRES: typeof PostgresConnector.prototype.findDuplicateKeys === 'function',
      MYSQL: typeof MysqlConnector.prototype.findDuplicateKeys === 'function',
      DATAVERSE:
        typeof (WebApiConnection.prototype as { findDuplicateKeys?: unknown }).findDuplicateKeys ===
        'function',
    };
    for (const [type, canScan] of Object.entries(implementsScan)) {
      const level = verificationFor(type as ConnectionType, 'duplicateDetection');
      if (!canScan) {
        expect(level, `${type} has no findDuplicateKeys, so it must not claim one`).toBe('NOT_SUPPORTED');
      } else {
        expect(level, `${type} implements findDuplicateKeys and should say so`).not.toBe('NOT_SUPPORTED');
      }
    }
  });

  it('keeps Dataverse simulated, and says so', () => {
    // The flagship target, and there is no tenant in continuous integration. Everything we know
    // about it comes from a simulator written to match documented behaviour, which is not a tenant.
    expect(typeof DemoConnection.prototype.findDuplicateKeys).toBe('function');
    for (const capability of ['read', 'write', 'migration', 'validation'] as const) {
      expect(verificationFor('DATAVERSE', capability)).toBe('SIMULATED');
    }
    expect(verificationFor('DATAVERSE', 'connect')).toBe('REQUIRES_CONFIGURATION');
    expect(summaryLevel('DATAVERSE')).toBe('SIMULATED');
  });

  it('does not let Azure SQL inherit SQL Server evidence', () => {
    // They share an implementation, and sharing an implementation is not evidence. What differs is
    // everything around the query — Entra authentication, firewall rules, enforced encryption,
    // transient faults, throttling — and none of it is exercised by a local container.
    for (const capability of ENGINE_PROVABLE) {
      if (capability === 'connect') continue;
      expect(verificationFor('SQL_SERVER', capability), `SQL Server ${capability}`).toBe('ENGINE_VERIFIED');
      expect(verificationFor('AZURE_SQL', capability), `Azure SQL ${capability} must not borrow it`).not.toBe(
        'ENGINE_VERIFIED',
      );
    }
  });

  it('never marks a read-only source as a migration target', () => {
    for (const type of ['FILE', 'ONEDRIVE', 'SHAREPOINT'] as const) {
      expect(verificationFor(type, 'write')).toBe('NOT_SUPPORTED');
      expect(verificationFor(type, 'upsert')).toBe('NOT_SUPPORTED');
    }
  });

  it('summarises a connector by its weakest meaningful capability', () => {
    // A connector with nine verified capabilities and one simulated one has a simulated capability
    // in it, and a reader glancing at one badge must not be told otherwise.
    const ranks = (type: ConnectionType) =>
      Object.values(CONNECTOR_VERIFICATION[type]!)
        .filter((l): l is VerificationLevel => Boolean(l))
        .filter((l) => l !== 'NOT_SUPPORTED' && l !== 'REQUIRES_CONFIGURATION')
        .map(levelRank);
    for (const type of ['POSTGRES', 'SQL_SERVER', 'MYSQL', 'DATAVERSE'] as const) {
      const summary = summaryLevel(type)!;
      expect(levelRank(summary), `${type} summary is the weakest`).toBe(Math.min(...ranks(type)));
    }
  });
});
