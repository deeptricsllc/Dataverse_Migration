/**
 * The Dataverse integration's view of the shared connector contract.
 *
 * These types moved to `server/src/connectors/types.ts` when the platform became multi-provider.
 * This module re-exports them so the Dataverse code (and its many imports) keeps working, and so
 * there is exactly one definition of the contract.
 */
export type {
  ConnectionCheck,
  ConnectionTestResult,
  ConnectorCapabilities,
  ConnectorProvider,
  DataverseConnection,
  DiscoveredEnvironment,
  MigrationConnector,
  RecordCount,
  WhoAmI,
  WriteOptions,
  WriteRecord,
} from '../connectors/types';
export { DATAVERSE_CAPABILITIES, SQL_CAPABILITIES } from '../connectors/types';
