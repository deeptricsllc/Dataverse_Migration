import { createHash } from 'node:crypto';
import {
  lineageColumnsFor,
  LINEAGE_FILE_PATTERN,
  LINEAGE_OUTCOMES,
  INTEGRITY_DOES_NOT_PROVE,
  INTEGRITY_PROVES,
  REQUIRED_EVIDENCE_FILES,
  SUPPORTED_EVIDENCE_SCHEMA_VERSIONS,
  type EvidenceManifest,
  type EvidenceProblem,
  type EvidenceVerification,
  type EvidenceVerdict,
} from '../../../shared/evidence';
import { readZip } from '../lib/zip';

/**
 * Checks an evidence package against its own manifest.
 *
 * What this establishes is narrow and worth stating in the same breath as the verdict: the files are
 * internally consistent with the manifest that travels with them. Nothing here is a signature. A
 * person who edits `metrics.csv` can recompute its digest and edit the manifest to match, and this
 * will call the result valid — because it is internally consistent, which is all a digest can say.
 *
 * So the verdicts are deliberately not "authentic" and "forged". They are:
 *
 * - **VALID** — every file matches, every count adds up.
 * - **MODIFIED** — something does not match what the manifest records. Changed since it was made, or
 *   not written by this platform.
 * - **INCOMPLETE** — files an evidence package must contain are absent, so there is nothing to
 *   conclude from what is there.
 * - **UNSUPPORTED** — it declares a schema version this build does not read. Not a judgement on the
 *   package.
 * - **UNREADABLE** — not a package.
 *
 * Every problem is reported, not just the first, because somebody fixing one wants to see the rest.
 */
export function verifyEvidencePackage(archive: Buffer): EvidenceVerification {
  const problems: EvidenceProblem[] = [];
  const base = { manifest: null, filesChecked: 0, lineageRowsCounted: null, problems } as const;
  const result = (verdict: EvidenceVerdict, extra: Partial<EvidenceVerification> = {}) => ({
    ...base,
    verdict,
    proves: INTEGRITY_PROVES,
    doesNotProve: INTEGRITY_DOES_NOT_PROVE,
    ...extra,
  });

  let entries: Map<string, Buffer>;
  try {
    entries = readZip(archive);
  } catch (err) {
    problems.push({
      code: 'NOT_A_ZIP',
      path: null,
      detail: err instanceof Error ? err.message : 'The file could not be read as a ZIP archive.',
    });
    return result('UNREADABLE');
  }

  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) {
    problems.push({
      code: 'MANIFEST_MISSING',
      path: 'manifest.json',
      detail: 'A package with no manifest records nothing about what it should contain.',
    });
    return result('INCOMPLETE');
  }

  let manifest: EvidenceManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as EvidenceManifest;
  } catch (err) {
    problems.push({
      code: 'MANIFEST_UNREADABLE',
      path: 'manifest.json',
      detail: `The manifest is not readable JSON: ${err instanceof Error ? err.message : 'unknown'}`,
    });
    return result('UNREADABLE');
  }

  // The version decides how to read everything else, so it is checked before anything else is.
  const version = manifest.evidenceSchemaVersion ?? manifest.schema;
  if (version === undefined) {
    problems.push({
      code: 'SCHEMA_VERSION_MISSING',
      path: 'manifest.json',
      detail: 'The manifest declares no evidence schema version, so its structure cannot be assumed.',
    });
    return result('UNSUPPORTED', { manifest });
  }
  if (!(SUPPORTED_EVIDENCE_SCHEMA_VERSIONS as readonly number[]).includes(version)) {
    problems.push({
      code: 'SCHEMA_VERSION_UNSUPPORTED',
      path: 'manifest.json',
      detail: `This package declares evidence schema ${version}; this build reads ${SUPPORTED_EVIDENCE_SCHEMA_VERSIONS.join(', ')}. The package may be perfectly good and newer than this reader.`,
    });
    return result('UNSUPPORTED', { manifest });
  }

  // Required files, before digests: a package missing metrics is incomplete whatever hashes.
  for (const required of REQUIRED_EVIDENCE_FILES) {
    if (!entries.has(required)) {
      problems.push({
        code: 'REQUIRED_FILE_MISSING',
        path: required,
        detail: `An evidence package must contain ${required}.`,
      });
    }
  }
  const incomplete = problems.some((p) => p.code === 'REQUIRED_FILE_MISSING');

  // Digests. The manifest is the list; a file in the archive that the manifest does not mention is
  // as much of an inconsistency as one it mentions and is missing.
  let filesChecked = 0;
  for (const record of manifest.files ?? []) {
    const bytes = entries.get(record.path);
    if (!bytes) {
      problems.push({
        code: 'FILE_MISSING',
        path: record.path,
        detail: 'The manifest lists this file and the package does not contain it.',
      });
      continue;
    }
    filesChecked++;
    if (bytes.length !== record.bytes) {
      problems.push({
        code: 'SIZE_MISMATCH',
        path: record.path,
        detail: `The manifest records ${record.bytes} bytes and the file holds ${bytes.length}.`,
      });
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== record.sha256) {
      problems.push({
        code: 'DIGEST_MISMATCH',
        path: record.path,
        detail: `The manifest records ${record.sha256.slice(0, 16)}… and the file hashes to ${digest.slice(0, 16)}…, so this file is not the one the manifest describes.`,
      });
    }
    if (record.rows !== undefined) {
      const counted = countDataRows(bytes);
      if (counted !== record.rows) {
        problems.push({
          code: 'ROW_COUNT_MISMATCH',
          path: record.path,
          detail: `The manifest records ${record.rows} data row(s) and the file holds ${counted}.`,
        });
      }
    }
  }
  const listed = new Set((manifest.files ?? []).map((f) => f.path));
  for (const path of entries.keys()) {
    if (path === 'manifest.json' || listed.has(path)) continue;
    problems.push({
      code: 'FILE_EXTRA',
      path,
      detail: 'This file is in the package and not in the manifest, so nothing vouches for it.',
    });
  }

  // Lineage: the chunks must be present, their rows must add up to the declared total, and the
  // columns and outcomes must be the ones the format defines.
  let lineageRowsCounted: number | null = null;
  if (manifest.lineage) {
    lineageRowsCounted = 0;
    for (const [index, path] of manifest.lineage.files.entries()) {
      const bytes = entries.get(path);
      if (!bytes) {
        problems.push({
          code: 'LINEAGE_FILE_MISSING',
          path,
          detail: 'The manifest declares this lineage chunk and the package does not contain it.',
        });
        continue;
      }
      const text = bytes.toString('utf8');
      const lines = text.split('\r\n').filter((l) => l.length > 0);
      const header = (lines[0] ?? '').replace(/^\uFEFF/, '');
      // The columns a package carries depend on the version it declares: schema 3 added the three
      // write-state columns. Checking an older package against the current list would be this product
      // reporting its own earlier evidence as corrupt.
      const expectedColumns = lineageColumnsFor(manifest.evidenceSchemaVersion).join(',');
      if (header !== expectedColumns) {
        problems.push({
          code: 'LINEAGE_COLUMNS_UNEXPECTED',
          path,
          detail: `Expected the columns ${expectedColumns} for a schema ${manifest.evidenceSchemaVersion} package and found "${header.slice(0, 120)}".`,
        });
      }
      const rows = Math.max(0, lines.length - 1);
      lineageRowsCounted += rows;
      const declared = manifest.lineage.rowsPerFile[index];
      if (declared !== undefined && declared !== rows) {
        problems.push({
          code: 'ROW_COUNT_MISMATCH',
          path,
          detail: `The manifest records ${declared} lineage row(s) in this chunk and it holds ${rows}.`,
        });
      }
      // An outcome outside the canonical five means the file was written by something else, or
      // edited. Checked on a sample rather than every row: the digest already covers the content,
      // and this is about the format being what it claims.
      for (const line of lines.slice(1, 51)) {
        const outcome = line.split(',')[6] ?? '';
        if (!(LINEAGE_OUTCOMES as readonly string[]).includes(outcome)) {
          problems.push({
            code: 'LINEAGE_OUTCOME_UNKNOWN',
            path,
            detail: `"${outcome.slice(0, 40)}" is not one of the canonical outcomes ${LINEAGE_OUTCOMES.join(', ')}.`,
          });
          break;
        }
      }
    }
    if (lineageRowsCounted !== manifest.lineage.totalRows) {
      problems.push({
        code: 'LINEAGE_TOTAL_MISMATCH',
        path: null,
        detail: `The manifest declares ${manifest.lineage.totalRows} lineage row(s) in total and the chunks hold ${lineageRowsCounted}.`,
      });
    }
    const sumDeclared = manifest.lineage.rowsPerFile.reduce((n, r) => n + r, 0);
    if (sumDeclared !== manifest.lineage.totalRows) {
      problems.push({
        code: 'LINEAGE_TOTAL_MISMATCH',
        path: 'manifest.json',
        detail: `The manifest's own chunk counts add up to ${sumDeclared} and it declares ${manifest.lineage.totalRows}.`,
      });
    }
  } else {
    // No lineage section, but lineage files present: the manifest is not describing this package.
    for (const path of entries.keys()) {
      if (LINEAGE_FILE_PATTERN.test(path)) {
        problems.push({
          code: 'FILE_EXTRA',
          path,
          detail: 'The package contains lineage chunks and the manifest declares no lineage.',
        });
      }
    }
  }

  /**
   * Incomplete beats modified when both apply.
   *
   * A package missing `metrics.csv` and holding one edited file is first of all not an evidence
   * package: telling somebody it was modified invites them to go looking for the change, when the
   * thing to say is that the package does not contain what it needs to.
   */
  const verdict: EvidenceVerdict = problems.length === 0 ? 'VALID' : incomplete ? 'INCOMPLETE' : 'MODIFIED';
  return {
    verdict,
    manifest,
    problems,
    filesChecked,
    lineageRowsCounted,
    proves: INTEGRITY_PROVES,
    doesNotProve: INTEGRITY_DOES_NOT_PROVE,
  };
}

/**
 * Data rows in a CSV, which is not the same as newlines.
 *
 * A quoted field may contain a line break, so counting separators would under-report a file whose
 * notes column has one. The quote state is tracked instead.
 */
function countDataRows(bytes: Buffer): number {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  let rows = 0;
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not a close.
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
      sawContent = true;
    } else if (!inQuotes && ch === '\n') {
      if (sawContent) rows++;
      sawContent = false;
    } else if (ch !== '\r') {
      sawContent = true;
    }
  }
  if (sawContent) rows++;
  // The first row is the header.
  return Math.max(0, rows - 1);
}
