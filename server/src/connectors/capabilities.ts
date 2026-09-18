import type { ConnectionType, ConnectorCapabilities } from '../../../shared/domain';
import { DATAVERSE_CAPABILITIES, SQL_CAPABILITIES } from './types';

/** What a connection of this type can do. Used by the API, the UI and the planning services. */
export function capabilitiesFor(type: ConnectionType): ConnectorCapabilities {
  return type === 'DATAVERSE' ? DATAVERSE_CAPABILITIES : SQL_CAPABILITIES;
}
