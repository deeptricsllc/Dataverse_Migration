import { describe, expect, it } from 'vitest';
import { SQL_CONNECTION_TYPES, STAGED_CONNECTION_TYPES, type ConnectionType } from '../../shared/domain';
import {
  CAPABILITY_LABELS,
  CONNECTOR_VERIFICATION,
  VERIFICATION_LABELS,
  verificationFor,
  type ConnectorCapabilityKey,
} from '../../shared/connector-verification';
import { SqlConnector } from '../../server/src/connectors/sql/sql-connector';
import { PostgresConnector } from '../../server/src/connectors/sql/postgres-connector';
import { MysqlConnector } from '../../server/src/connectors/sql/mysql-connector';
import { DemoConnection } from '../../server/src/dataverse/demo/demo-connection';
import { WebApiConnection } from '../../server/src/dataverse/web-api-connection';

/**
 * The capability matrix has to be checkable, or it is marketing.
 *
 * Its whole purpose is to separate "there is code for this" from "we have seen this work", which
 * only means something if the claims cannot drift away from the code. Where a claim is mechanically
 * checkable, it is checked here. Where it is a judgement about evidence — whether a suite really
 * exercised an engine end to end — it is a judgement, and these tests say so rather than pretending
 * to verify it.
 */
describe('connector verification matrix', () => {
  const declared = Object.keys(CONNECTOR_VERIFICATION) as ConnectionType[];

  it('covers every connection type the product offers', () => {
    const all: ConnectionType[] = ['DATAVERSE', ...SQL_CONNECTION_TYPES, ...STAGED_CONNECTION_TYPES];
    for (const type of all) {
      expect(CONNECTOR_VERIFICATION[type], `${type} has no verification row`).toBeTruthy();
    }
  });

  it('uses only defined levels and known capabilities', () => {
    for (const type of declared) {
      for (const [capability, level] of Object.entries(CONNECTOR_VERIFICATION[type]!)) {
        expect(CAPABILITY_LABELS[capability as ConnectorCapabilityKey], capability).toBeTruthy();
        expect(VERIFICATION_LABELS[level!], `${type}.${capability} = ${level}`).toBeTruthy();
      }
    }
  });

  it('never claims duplicate detection a connector cannot do', () => {
    // The mechanical check that matters most right now, because duplicate detection is the newest
    // claim and the one a report turns into a PASS or a NOT VERIFIED.
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

  it('says the demo is simulated rather than verified', () => {
    // The flagship target, and there is no real tenant in continuous integration. Everything we
    // know about Dataverse comes from a simulator written to match documented behaviour, which is
    // not the same as a tenant and must not be presented as one.
    expect(typeof DemoConnection.prototype.findDuplicateKeys).toBe('function');
    for (const capability of ['read', 'write', 'migration', 'validation'] as const) {
      expect(verificationFor('DATAVERSE', capability)).toBe('SIMULATED');
    }
    expect(verificationFor('DATAVERSE', 'connect')).toBe('REQUIRES_CONFIGURATION');
  });

  it('never marks a read-only source as a migration target', () => {
    for (const type of ['FILE', 'ONEDRIVE', 'SHAREPOINT'] as const) {
      expect(verificationFor(type, 'write')).toBe('NOT_SUPPORTED');
      expect(verificationFor(type, 'upsert')).toBe('NOT_SUPPORTED');
    }
  });

  it('does not claim a real engine was exercised when a simulator was', () => {
    // The journeys run against built-in simulators. "Legacy SQL Server (Demo)" is a simulator over
    // the platform's own database, not SQL Server, and no real SQL Server, Azure SQL or MySQL is
    // reached in continuous integration at all. These assertions exist so that promoting any of
    // them to VERIFIED takes a deliberate edit, made by somebody who has the evidence.
    for (const type of ['SQL_SERVER', 'AZURE_SQL', 'MYSQL'] as const) {
      for (const capability of ['connect', 'read', 'write', 'migration', 'validation'] as const) {
        expect(verificationFor(type, capability), `${type} ${capability}`).toBe('IMPLEMENTED');
      }
    }
    // The one exception, and the reason it is one: PGlite is PostgreSQL compiled to WebAssembly,
    // so the catalog queries run against a real pg_catalog.
    expect(verificationFor('POSTGRES', 'schemaDiscovery')).toBe('VERIFIED');
    expect(verificationFor('POSTGRES', 'write')).toBe('IMPLEMENTED');

    // The file connector has no external engine to simulate: its storage is our own database.
    expect(verificationFor('FILE', 'read')).toBe('VERIFIED');
  });
});
