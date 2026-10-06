import { DataverseError } from '../errors';

/**
 * A deliberate failure, armed by hand, against simulated data.
 *
 * Some states a migration tool has to handle cannot be reached by configuring one: a write that commits and
 * whose answer never arrives is caused by a network, not by a plan. Without a way to cause it, the screens
 * that handle it can only ever be demonstrated by writing the state straight into the database — which is a
 * fixture dressed as evidence, and proves that the components render rather than that the product works.
 *
 * So this causes the real thing. The record is inserted, every validation and duplicate check having run,
 * and then the call throws as though the answer were lost in flight. The engine classifies it, records it
 * and reports it exactly as it would a real timeout, because from the engine's side that is what it is.
 *
 * What keeps it from being a liability:
 *
 *   - **It does not exist in production.** The route that arms it is registered only when the deployment is
 *     in demo mode, and it refuses any environment that is not a simulated one. There is no code path from
 *     here to a customer's tenant.
 *   - **It is scoped to the caller's own data.** Arming is keyed on the organization, so one workspace
 *     cannot inject a failure into another's migration.
 *   - **It is explicit.** Nothing is armed by default. A caller names the table and which write to break.
 *   - **It fires once and disarms itself.** There is no state left behind to surprise the next run.
 *   - **It does not bypass anything.** The write happens first. Everything the connector would have
 *     checked, it checked.
 */
export interface ArmedFault {
  organizationId: string;
  environmentKey: string;
  /** The table whose writes are counted. */
  logicalName: string;
  /** Which create of that table to break, counting from one. */
  onNthCreate: number;
  /** Writes of this table seen so far. */
  seen: number;
}

const armed = new Map<string, ArmedFault>();

const keyOf = (organizationId: string, environmentKey: string) => `${organizationId}:${environmentKey}`;

/** Arms one failure. Replaces any fault already armed for the same workspace and environment. */
export function armLostAnswer(fault: Omit<ArmedFault, 'seen'>): ArmedFault {
  const value: ArmedFault = { ...fault, seen: 0 };
  armed.set(keyOf(fault.organizationId, fault.environmentKey), value);
  return value;
}

/** What is armed for this workspace and environment, if anything. */
export function armedFault(organizationId: string, environmentKey: string): ArmedFault | null {
  return armed.get(keyOf(organizationId, environmentKey)) ?? null;
}

/** Disarms whatever is armed. Returns true when something was. */
export function disarm(organizationId: string, environmentKey: string): boolean {
  return armed.delete(keyOf(organizationId, environmentKey));
}

/**
 * Called by the demo connection after a record has been written.
 *
 * Throws when this is the write the caller armed, and disarms itself on the way out so that the next write
 * of the same table behaves normally. The error is a timeout with no response, which is what a lost answer
 * looks like from the engine's side — and `verdictOf` treats it as ambiguous rather than as a refusal,
 * which is the whole point: the record is in the target and nothing can prove it.
 */
export function failIfArmed(organizationId: string, environmentKey: string, logicalName: string): void {
  const fault = armed.get(keyOf(organizationId, environmentKey));
  if (!fault || fault.logicalName !== logicalName) return;
  fault.seen += 1;
  if (fault.seen < fault.onNthCreate) return;
  armed.delete(keyOf(organizationId, environmentKey));
  throw new DataverseError(
    'TIMEOUT',
    'The request timed out. The record may or may not have been written; no response was received.',
    408,
  );
}

/** Clears everything. For tests, so one case cannot arm a fault that fires in the next. */
export function disarmAll(): void {
  armed.clear();
}
