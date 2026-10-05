/**
 * What a spawned check actually did.
 *
 * Separated from the gate so it can be tested, because the thing it decides is the one thing a release
 * gate must never get wrong: whether a check ran at all. A gate that reports PASSED — or even FAILED —
 * for a process that never started is reporting on nothing, and somebody will read it as a statement
 * about the code.
 *
 * The three cases, from a real `spawnSync` result:
 *
 *   - **never started**: `error` is set (ENOENT, EINVAL) and there is no real `pid`. Not a result.
 *   - **killed**: a `signal`, and `status` is null. Not a result either.
 *   - **ran**: a `pid` and an exit code, which is the only case where the code means anything.
 */

/** @param {{ error?: Error, pid?: number, status?: number | null, signal?: string | null }} result */
export function outcomeOf(result) {
  /*
   * `pid` is 0 on Windows and undefined elsewhere when the spawn itself failed, so neither is compared
   * against a specific value: a process that started always has a real one.
   */
  if (result.error || !result.pid) {
    return {
      ran: false,
      status: 'DID NOT RUN',
      code: undefined,
      detail: result.error ? result.error.message : 'the process never started',
    };
  }
  if (result.status === null || result.status === undefined) {
    return {
      ran: true,
      status: 'FAILED',
      code: -1,
      detail: result.signal ? `killed by ${result.signal}` : 'exited without a status',
    };
  }
  return {
    ran: true,
    status: result.status === 0 ? 'PASSED' : 'FAILED',
    code: result.status,
    detail: undefined,
  };
}
