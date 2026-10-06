/**
 * A count and its noun, agreeing.
 *
 * Trivial, and it exists because the sentences that go wrong without it are the ones a person reads at the
 * worst moment: "1 records cannot be accounted for", "The result of 1 writes is unknown". A product that
 * cannot make a number agree with a noun is not one somebody trusts with a number that matters.
 *
 * Shared rather than duplicated, because the server writes some of these sentences and the browser writes
 * the rest, and two copies is how one of them keeps the bug.
 */
export function describeCount(n: number, noun: string, plural = `${noun}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? noun : plural}`;
}
