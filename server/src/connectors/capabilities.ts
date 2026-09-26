import { isStagedConnection, type ConnectionType, type ConnectorCapabilities } from '../../../shared/domain';
import { DATAVERSE_CAPABILITIES, SQL_CAPABILITIES, STAGED_CAPABILITIES } from './types';

/**
 * What a connection of this type can do. Used by the API, the UI and the planning services.
 *
 * The staged branch is not cosmetic: without it an imported file would fall through to the SQL
 * capabilities and advertise `supportsWrite: true`, which is how a spreadsheet ends up offered as a
 * migration target.
 */
export function capabilitiesFor(type: ConnectionType): ConnectorCapabilities {
  if (type === 'DATAVERSE') return DATAVERSE_CAPABILITIES;
  if (isStagedConnection(type)) return STAGED_CAPABILITIES;
  return SQL_CAPABILITIES;
}
