import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConformanceEvidence } from './conformance';

/**
 * Where a real-engine run leaves its proof.
 *
 * The capability matrix is a TypeScript file, because the browser reads it. That makes it trivially
 * editable, which is the problem: somebody could promote a row to ENGINE_VERIFIED in a moment of
 * optimism and nothing would object. So the matrix is checked against this file, which only a
 * conformance run that actually reached a server writes.
 *
 * Committed deliberately. It is the audit trail for the strongest claim the product makes about
 * itself, and a claim whose evidence lives only in a CI log that expires is not much of a claim.
 */

export const EVIDENCE_PATH = path.resolve(process.cwd(), 'evidence/engine-verification.json');

export interface EvidenceFile {
  /** Bumped when the shape changes, so a stale file is noticed rather than misread. */
  schema: 1;
  /** Keyed by engine, so re-running one engine replaces only its own record. */
  runs: Record<string, ConformanceEvidence>;
}

export async function readEvidence(): Promise<EvidenceFile> {
  try {
    const raw = await fs.readFile(EVIDENCE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as EvidenceFile;
    if (parsed.schema !== 1) throw new Error(`Unknown evidence schema ${parsed.schema}`);
    return parsed;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { schema: 1, runs: {} };
    throw err;
  }
}

/**
 * Records one engine's result, replacing any previous run for that engine.
 *
 * Replacing rather than appending on purpose: the question the matrix asks is "does this engine
 * pass now", and a history of passes from older builds would answer a different one.
 */
export async function recordEvidence(evidence: ConformanceEvidence): Promise<void> {
  const file = await readEvidence();
  file.runs[evidence.engine] = evidence;
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}
