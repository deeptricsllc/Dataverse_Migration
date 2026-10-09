import type { AttributeMeta } from './metadata';
import type { SemanticReading } from './semantic-types';
import type { FieldProfileDto, StatisticBasis, TableProfileDto } from './domain';

/**
 * A finding: something true about the data that somebody has to decide about.
 *
 * ## Why this exists separately from the profile
 *
 * Profiling produces measurements — 46 nulls, 42 distinct values, a maximum length of 300. Every one of
 * those is a fact and none of them is a decision. `column_1 has 46 nulls` leaves the reader to work out
 * whether that matters, which means in practice nobody does.
 *
 * A finding carries the measurement *and* the consequence: what was observed, how much is affected, why it
 * matters for a migration, and what to do about it. The test every rule below has to pass is "so what?" —
 * if the answer is only "that is the number", it is a statistic and belongs in the profile, not here.
 *
 * ## Deterministic, and only from evidence
 *
 * Every rule is a pure function of the profile and the metadata. No sampling of opinions, no model, no
 * score pulled out of the air. The same dataset produces the same findings in the same order, which is
 * what makes them testable and what makes a readiness number defensible.
 *
 * Nothing here invents a finding to fill a dashboard. Eight findings that each name a real number beat
 * eighty that restate the schema.
 */

export const FINDING_CATEGORIES = [
  'IDENTITY',
  'DUPLICATES',
  'COMPLETENESS',
  'CONSISTENCY',
  'VALIDITY',
  'TYPE_COMPATIBILITY',
  'RELATIONSHIPS',
  'SCHEMA',
  'PRIVACY',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  IDENTITY: 'Identity & keys',
  DUPLICATES: 'Duplicates',
  COMPLETENESS: 'Completeness',
  CONSISTENCY: 'Consistency',
  VALIDITY: 'Validity',
  TYPE_COMPATIBILITY: 'Type compatibility',
  RELATIONSHIPS: 'Relationships',
  SCHEMA: 'Schema',
  PRIVACY: 'Privacy',
};

export const FINDING_SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface Finding {
  /**
   * Stable across runs of the same dataset, and derived from what the finding is about rather than from
   * a counter — so a finding can be referred to, linked to and compared between two runs.
   */
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  /** A headline a person reads first. Not a rule name. */
  title: string;
  /** One or two sentences, in plain language, naming the actual numbers. */
  summary: string;
  dataset: string;
  table: string;
  /** Empty for a finding about the table as a whole. */
  columns: string[];
  /** How many records are affected. 0 when the finding is about structure rather than rows. */
  affected: number;
  /** Of the records examined. Null when a percentage would be meaningless. */
  affectedPercent: number | null;
  /** The measurements this was derived from, so a sceptical reader can check the reasoning. */
  evidence: string[];
  whyItMatters: string;
  recommendation: string;
  /** What specifically goes wrong during a migration if this is not resolved. */
  migrationImpact: string;
  /**
   * HIGH when the rule is arithmetic on complete evidence. MEDIUM when it rests on a reading, or on a
   * sample rather than the whole table. There is no LOW: a finding we would describe that way is a guess,
   * and a guess beside a fact teaches the reader to discount both.
   */
  confidence: 'HIGH' | 'MEDIUM';
  /** Whether the numbers come from the whole table or a sample. Shown, never hidden. */
  basis: StatisticBasis;
  /**
   * Whether this counts against readiness. **Absent means yes** — a finding is a problem unless it says
   * otherwise, so a new rule cannot accidentally be free.
   *
   * Not everything worth saying is a defect. Finding a usable business key is good news; a column that
   * maps to a choice set is a task; a column that looks personal is a decision for a person. The first
   * version of the readiness model deducted for all three, so **discovering a key made the data look less
   * ready** — which is backwards, and was visible the first time the demo dataset ran.
   */
  deducts?: false;
}

/** A finding counts against readiness unless it explicitly opts out. */
export const findingDeducts = (finding: Finding) => finding.deducts !== false;

export interface FindingsInput {
  /** The connection's display name, as the user named it. */
  dataset: string;
  profile: TableProfileDto;
  /**
   * Column metadata, when it is to hand.
   *
   * Optional, because findings are also computed from a **stored** analysis run, where the only record is
   * the profile. Everything the rules need — the semantic reading and whether the source calls the column
   * required — is therefore carried on the profile's own fields as well, and this is a preference rather
   * than a requirement. A finding about a run has to be reproducible from the run.
   */
  attributes?: AttributeMeta[];
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * A null rate worth raising.
 *
 * Not 1%: a column that is 3% empty is normal, and a product that says so about forty columns has told
 * the reader nothing and cost them the time to read it. 25% is the point at which "this column is
 * sometimes filled in" becomes "this column is mostly not filled in", which is a different fact about the
 * source system and usually a surprise to whoever owns it.
 */
const HIGH_NULL_RATE = 0.25;
/** Nearly unique: close enough that the exceptions are probably data errors rather than the design. */
const NEARLY_UNIQUE = 0.98;
/** A length spread wide enough to suggest two different things are stored in one column. */
const LENGTH_OUTLIER_FACTOR = 8;

/** Rounded here rather than in the UI, so 3.5000000000000004 never reaches a screen or an export. */
const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);
const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** `MEDIUM` for anything measured on a sample: the number is real, its completeness is not. */
const basisConfidence = (basis: StatisticBasis): 'HIGH' | 'MEDIUM' => (basis === 'EXACT' ? 'HIGH' : 'MEDIUM');

const SAMPLE_CAVEAT = (basis: StatisticBasis, examined: number, total: number) =>
  basis === 'EXACT'
    ? `Measured across all ${total.toLocaleString()} records.`
    : `Measured across a sample of ${examined.toLocaleString()} of ${total.toLocaleString()} records, so the count scales rather than being exact.`;

/** Column names that suggest the values are personal. Named, never acted on. */
const PII_NAME =
  /(^|[^a-z])(email|e_mail|phone|mobile|telephone|ssn|nino|national_?insurance|passport|dob|date_?of_?birth|address|postcode|post_?code|zip|salary|iban|sort_?code|account_?number|credit_?card|card_?number)([^a-z]|$)/i;

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Every finding for one table, in severity order.
 *
 * Order is part of the contract: the first thing a reader sees should be the thing that most endangers the
 * migration. Within a severity, findings keep the order the rules produced them in, which is stable.
 */
export function findingsForTable(input: FindingsInput): Finding[] {
  const { dataset, profile } = input;
  const attributes = input.attributes ?? [];
  const byName = new Map(attributes.map((a) => [a.logicalName, a]));
  /** The reading for a column, from the metadata if present and otherwise from the stored profile. */
  const readingFor = (column: string) =>
    byName.get(column)?.semantic ?? profile.fields.find((f) => f.field === column)?.semantic ?? null;
  const requiredLevelFor = (column: string) =>
    byName.get(column)?.requiredLevel ?? profile.fields.find((f) => f.field === column)?.requiredLevel;
  const found: Finding[] = [];
  /**
   * Stable across runs, and derived from the *logical* name rather than the display name — a finding has
   * to keep its identity when a file is renamed, because that is how two runs are compared.
   */
  const id = (rule: string, column?: string) =>
    [dataset, profile.table, column ?? '', rule].map((p) => p.replace(/[|]/g, '')).join('|');

  const examined = profile.examined;
  const total = profile.totalRecords;
  const confidence = basisConfidence(profile.basis);
  const caveat = SAMPLE_CAVEAT(profile.basis, examined, total);

  // --- Identity ------------------------------------------------------------
  const keyCandidates = candidateKeys(profile);
  if (examined > 0 && keyCandidates.length === 0) {
    found.push({
      id: id('NO_RELIABLE_KEY'),
      category: 'IDENTITY',
      severity: 'CRITICAL',
      title: 'No reliable record identifier',
      summary: `No column in ${profile.displayName} that could identify a record is both unique and filled in for every record, so there is nothing that reliably identifies a row.`,
      dataset,
      table: profile.displayName,
      columns: [],
      affected: total,
      affectedPercent: 100,
      evidence: [
        `${plural(profile.columns, 'column')} examined, none of them usable as an identifier.`,
        ...(profile.fields.some((f) => SYNTHETIC_COLUMN.test(f.field))
          ? [
              'A row number was added during import so the rows could be addressed at all. It identifies a row within this import only, and changes if the file is re-exported in a different order.',
            ]
          : []),
        ...nearMisses(profile).map(
          (f) =>
            `${f.field}: ${f.distinctCount?.toLocaleString() ?? '?'} distinct across ${f.examined.toLocaleString()} examined, ${plural(f.nullCount + f.blankCount, 'empty value')}.`,
        ),
        caveat,
      ],
      whyItMatters:
        'Matching a source record to a target record is what stops a migration creating duplicates, and what lets a second run recognise work it has already done. Without a stable identifier there is nothing to match on.',
      recommendation:
        'Choose a business key — one column, or a combination — that is unique and always present, or have the source system supply one before migrating.',
      migrationImpact:
        'Every record would be treated as new on every run, so re-running the migration would duplicate the data rather than update it. Resuming after a failure would do the same.',
      confidence,
      basis: profile.basis,
    });
  }
  for (const candidate of keyCandidates) {
    found.push({
      id: id('CANDIDATE_KEY', candidate.field),
      category: 'IDENTITY',
      severity: 'INFO',
      title: `${candidate.field} looks like a business key`,
      summary: `Every examined value of ${candidate.field} is distinct and populated, which makes it usable for matching records during migration.`,
      dataset,
      table: profile.displayName,
      columns: [candidate.field],
      affected: 0,
      affectedPercent: null,
      evidence: [
        `${candidate.distinctCount?.toLocaleString() ?? '?'} distinct values across ${candidate.examined.toLocaleString()} examined records.`,
        'No empty values.',
        caveat,
      ],
      whyItMatters:
        'A migration needs something to match on. A column that is already unique and complete is the cheapest possible answer, because nothing has to be built or cleaned first.',
      recommendation: `Confirm with the source system's owner that ${candidate.field} is stable — that it is not reassigned or regenerated — and then use it as the match key.`,
      migrationImpact:
        'With this as the match key, re-running the migration updates existing records instead of creating new ones.',
      confidence,
      basis: profile.basis,
      // Good news. Deducting for it made finding a key reduce the readiness score.
      deducts: false,
    });
  }
  if (profile.primaryKeyField && profile.primaryKeyMissing > 0) {
    found.push({
      id: id('KEY_MISSING_VALUES', profile.primaryKeyField),
      category: 'IDENTITY',
      severity: 'CRITICAL',
      title: `${profile.primaryKeyField} is empty in some records`,
      summary: `${plural(profile.primaryKeyMissing, 'record')} have no value in ${profile.primaryKeyField}, the column being used to identify them.`,
      dataset,
      table: profile.displayName,
      columns: [profile.primaryKeyField],
      affected: profile.primaryKeyMissing,
      affectedPercent: pct(profile.primaryKeyMissing, examined),
      evidence: [
        `${profile.primaryKeyMissing.toLocaleString()} of ${examined.toLocaleString()} examined records have no identifier.`,
        caveat,
      ],
      whyItMatters:
        'A record with no identifier cannot be matched, so it cannot be updated and cannot be recognised on a second run.',
      recommendation:
        'Fill in the missing identifiers at source, or exclude these records from the migration deliberately rather than discovering them part-way through it.',
      migrationImpact:
        'These records would be blocked at preflight, or duplicated if the match key is changed to something weaker.',
      confidence,
      basis: profile.basis,
    });
  }

  // --- Duplicates ----------------------------------------------------------
  if (profile.duplicateKeyCount > 0) {
    found.push({
      id: id('DUPLICATE_KEYS'),
      category: 'DUPLICATES',
      severity: 'CRITICAL',
      title: 'Records share the same key',
      summary: `${plural(profile.duplicateKeyCount, 'record')} in ${profile.displayName} share a key value with another record, so the key does not identify a single row.`,
      dataset,
      table: profile.displayName,
      columns: profile.primaryKeyField ? [profile.primaryKeyField] : [],
      affected: profile.duplicateKeyCount,
      affectedPercent: pct(profile.duplicateKeyCount, examined),
      evidence: [
        `${profile.duplicateKeyCount.toLocaleString()} records are part of a group sharing a key.`,
        caveat,
      ],
      whyItMatters:
        'When two source records resolve to the same target record, one of them silently overwrites the other — and the migration reports both as successful.',
      recommendation:
        'Decide which record wins before migrating: merge them at source, or add a column to the key so the two become distinguishable.',
      migrationImpact:
        'The second record of each pair is a conflict. Depending on the strategy it is either blocked or it overwrites the first.',
      confidence,
      basis: profile.basis,
    });
  }
  for (const field of profile.fields) {
    const duplicates = field.duplicateCount ?? 0;
    if (duplicates > 0 && isNearlyUnique(field) && field.field !== profile.primaryKeyField) {
      found.push({
        id: id('NEARLY_UNIQUE_DUPLICATES', field.field),
        category: 'DUPLICATES',
        severity: 'WARNING',
        title: `${field.field} is almost unique, but not quite`,
        summary: `${field.field} is distinct in all but ${plural(duplicates, 'record')}. A column that is 99% unique is usually meant to be unique, which makes the exceptions likely data errors.`,
        dataset,
        table: profile.displayName,
        columns: [field.field],
        affected: duplicates,
        affectedPercent: pct(duplicates, field.examined),
        evidence: [
          `${field.distinctCount?.toLocaleString() ?? '?'} distinct values across ${field.examined.toLocaleString()} examined records.`,
          `${plural(duplicates, 'record')} share a value with another record.`,
          caveat,
        ],
        whyItMatters:
          'If this column was intended as the identifier, the duplicates are the records that will go wrong — and there are few enough of them to fix by hand.',
        recommendation: `Review the ${plural(duplicates, 'record')} that share a value. If they are genuine duplicates, merge them; if the column was never meant to be unique, use something else as the key.`,
        migrationImpact: 'Using this as a match key would make these records conflict with each other.',
        confidence,
        basis: profile.basis,
      });
    }
  }

  // --- Completeness --------------------------------------------------------
  for (const field of profile.fields) {
    if (field.examined === 0) continue;
    const empty = field.nullCount + field.blankCount;
    if (empty >= field.examined) {
      found.push({
        id: id('EMPTY_COLUMN', field.field),
        category: 'COMPLETENESS',
        severity: 'WARNING',
        title: `${field.field} is empty in every record`,
        summary: `${field.field} contains no value in any of the ${field.examined.toLocaleString()} records examined.`,
        dataset,
        table: profile.displayName,
        columns: [field.field],
        affected: field.examined,
        affectedPercent: 100,
        evidence: [
          `All ${field.examined.toLocaleString()} examined records are empty in this column.`,
          caveat,
        ],
        whyItMatters:
          'Migrating a column that holds nothing moves no data. More usefully, it is a signal: either the field is obsolete, or the data everyone assumed was here lives somewhere else.',
        recommendation:
          'Exclude this column from the migration unless the target requires it — and if it does, find out where the values actually are.',
        migrationImpact:
          'None directly. Mapping it wastes effort and adds a column to the target that will stay empty.',
        confidence,
        basis: profile.basis,
      });
      continue;
    }
    const rate = empty / field.examined;
    if (rate >= HIGH_NULL_RATE) {
      const level = requiredLevelFor(field.field);
      const required = level === 'ApplicationRequired' || level === 'SystemRequired';
      found.push({
        id: id('HIGH_NULL_RATE', field.field),
        category: 'COMPLETENESS',
        severity: required ? 'CRITICAL' : 'WARNING',
        title: required
          ? `${field.field} is required but often empty`
          : `${field.field} is empty in ${round1(rate * 100)}% of records`,
        summary: required
          ? `${field.field} is marked required, and ${plural(empty, 'record')} have no value in it.`
          : `${plural(empty, 'record')} of the ${field.examined.toLocaleString()} examined have no value in ${field.field}.`,
        dataset,
        table: profile.displayName,
        columns: [field.field],
        affected: empty,
        affectedPercent: round1(rate * 100),
        evidence: [
          `${empty.toLocaleString()} empty of ${field.examined.toLocaleString()} examined (${round1(rate * 100)}%).`,
          required ? 'The column is marked as required.' : 'The column is not marked as required.',
          caveat,
        ],
        whyItMatters: required
          ? 'A target column that requires a value will reject every record that does not have one, and it will do so part-way through the run.'
          : 'A column this sparse is often either optional in practice or filled in by a process that was missed. Either way it changes what the migrated data means.',
        recommendation: required
          ? 'Supply a value, agree a default, or relax the requirement in the target — before the run rather than during it.'
          : 'Confirm the column is genuinely optional. If it should be populated, find out which process was supposed to fill it.',
        migrationImpact: required
          ? `${plural(empty, 'record')} would be blocked at preflight.`
          : 'The column migrates with its gaps intact, which may surprise whoever uses it afterwards.',
        confidence,
        basis: profile.basis,
      });
    }
  }

  // --- Validity ------------------------------------------------------------
  for (const field of profile.fields) {
    if (field.invalidDateCount > 0) {
      found.push({
        id: id('INVALID_DATES', field.field),
        category: 'VALIDITY',
        severity: 'CRITICAL',
        title: `${field.field} contains values that are not dates`,
        summary: `${plural(field.invalidDateCount, 'value')} in ${field.field} could not be read as a date.`,
        dataset,
        table: profile.displayName,
        columns: [field.field],
        affected: field.invalidDateCount,
        affectedPercent: pct(field.invalidDateCount, field.examined),
        evidence: [
          `${field.invalidDateCount.toLocaleString()} of ${field.examined.toLocaleString()} examined values are not valid dates.`,
          field.minDate && field.maxDate
            ? `The readable values range from ${field.minDate.slice(0, 10)} to ${field.maxDate.slice(0, 10)}.`
            : 'No value in this column could be read as a date.',
          caveat,
        ],
        whyItMatters:
          'A date column that sometimes holds something else is usually two formats mixed together, or a placeholder like 1900-01-01 standing in for "unknown". Both migrate badly and both are easy to miss.',
        recommendation:
          'Look at the values that failed. Decide whether they are a second format to convert, or missing data wearing a disguise.',
        migrationImpact:
          'These records fail at write time unless the value is transformed or the record is excluded.',
        confidence,
        basis: profile.basis,
      });
    }
    if (field.invalidValueCount > 0) {
      found.push({
        id: id('INVALID_VALUES', field.field),
        category: 'VALIDITY',
        severity: 'WARNING',
        title: `${field.field} contains values its type cannot hold`,
        summary: `${plural(field.invalidValueCount, 'value')} in ${field.field} could not be converted to ${field.type}.`,
        dataset,
        table: profile.displayName,
        columns: [field.field],
        affected: field.invalidValueCount,
        affectedPercent: pct(field.invalidValueCount, field.examined),
        evidence: [
          `${field.invalidValueCount.toLocaleString()} of ${field.examined.toLocaleString()} examined values could not be converted.`,
          caveat,
        ],
        whyItMatters:
          'A column that is mostly numbers with a few words in it is a column where something has been entered by hand, and the exceptions usually carry meaning.',
        recommendation:
          'Review the values that failed to convert before deciding on a transformation; they often say what the column is really for.',
        migrationImpact:
          'These records are blocked or lose the value, depending on the transformation chosen.',
        confidence,
        basis: profile.basis,
      });
    }
  }

  // --- Consistency ---------------------------------------------------------
  for (const field of profile.fields) {
    if (field.whitespaceCount > 0) {
      found.push({
        id: id('WHITESPACE', field.field),
        category: 'CONSISTENCY',
        severity: 'WARNING',
        title: `${field.field} has values with stray spaces`,
        summary: `${plural(field.whitespaceCount, 'value')} in ${field.field} begin or end with a space.`,
        dataset,
        table: profile.displayName,
        columns: [field.field],
        affected: field.whitespaceCount,
        affectedPercent: pct(field.whitespaceCount, field.examined),
        evidence: [
          `${field.whitespaceCount.toLocaleString()} of ${field.examined.toLocaleString()} examined values have leading or trailing whitespace.`,
          caveat,
        ],
        whyItMatters:
          '"Acme Ltd" and "Acme Ltd " are different values to every system and the same value to every person. It is the most common reason a match that should have worked does not.',
        recommendation:
          'Trim this column during migration. It is a safe transformation and it costs nothing.',
        migrationImpact:
          'Untrimmed values reduce match accuracy and can create duplicates that look identical on screen.',
        confidence,
        basis: profile.basis,
      });
    }
    const spread = lengthSpread(field);
    if (spread) {
      found.push({
        id: id('LENGTH_SPREAD', field.field),
        category: 'CONSISTENCY',
        severity: 'INFO',
        title: `${field.field} holds values of very different lengths`,
        summary: `Values in ${field.field} run from ${field.minLength} to ${field.maxLength} characters, against an average of ${Math.round(field.averageLength ?? 0)}.`,
        dataset,
        table: profile.displayName,
        columns: [field.field],
        affected: 0,
        affectedPercent: null,
        evidence: [
          `Shortest ${field.minLength}, longest ${field.maxLength}, average ${Math.round(field.averageLength ?? 0)} characters.`,
          caveat,
        ],
        whyItMatters:
          'A spread this wide usually means two different things are being stored in one column — a code and a free-text note, say — which map to different places in the target.',
        recommendation:
          'Look at the longest and shortest values. If they are different kinds of thing, split the column or map them separately.',
        migrationImpact:
          'The longest values may not fit the target column, and would be truncated or rejected.',
        confidence: 'MEDIUM',
        basis: profile.basis,
      });
    }
  }

  // --- Type compatibility, from the semantic readings ----------------------
  for (const field of profile.fields) {
    const reading = readingFor(field.field);
    if (!reading) continue;
    const finding = fromSemantic(id, dataset, profile, field.field, reading, field);
    if (finding) found.push(finding);
  }

  // --- Privacy -------------------------------------------------------------
  const sensitive = profile.fields.filter(
    (f) => PII_NAME.test(f.field) || readingFor(f.field)?.type === 'EMAIL',
  );
  if (sensitive.length > 0) {
    found.push({
      id: id('POSSIBLE_PII'),
      category: 'PRIVACY',
      severity: 'INFO',
      title: 'Columns that look like personal data',
      summary: `${plural(sensitive.length, 'column')} in ${profile.displayName} look like they hold personal information: ${sensitive
        .map((f) => f.field)
        .slice(0, 6)
        .join(', ')}${sensitive.length > 6 ? ', …' : ''}.`,
      dataset,
      table: profile.displayName,
      columns: sensitive.map((f) => f.field),
      affected: 0,
      affectedPercent: null,
      evidence: [
        'Identified from column names and detected value patterns, not from any classification of the data itself.',
        `${plural(sensitive.length, 'column')}: ${sensitive.map((f) => f.field).join(', ')}.`,
      ],
      whyItMatters:
        'Where personal data goes, who can see it afterwards, and whether it should be in a test environment at all are decisions somebody has to make deliberately rather than discover later.',
      recommendation:
        'Confirm these columns before moving them into a non-production environment, and decide whether sample data shown in this product should be masked.',
      migrationImpact:
        'None technically. It is a decision that is cheaper before the migration than after it.',
      confidence: 'MEDIUM',
      basis: profile.basis,
      // Scoring this would penalise a dataset for containing the customer records it exists to contain.
      deducts: false,
    });
  }

  return sortFindings(found);
}

/** Severity first, then the order the rules produced them, which is stable across runs. */
export function sortFindings(findings: Finding[]): Finding[] {
  const rank: Record<FindingSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A column the platform invented rather than read, which cannot identify anything outside this import.
 *
 * File imports add a synthetic row number when the file has no column that identifies a row. It is unique
 * and complete by construction, so without this exclusion it looks like a perfect business key — and the
 * demo dataset proved the point: four files with no natural key between them all reported one, and the
 * single most important finding in the whole assessment silently disappeared.
 *
 * A row number identifies a row within one import. Re-export the file in a different order and every one
 * of them points somewhere else, which is the opposite of what a match key is for.
 */
const SYNTHETIC_COLUMN = /^__/;

/**
 * A column name that reads like an identifier.
 *
 * Uniqueness alone is not enough, and the demo dataset made that obvious: `phone`, `credit_limit` and
 * `order_total` were all unique and complete, so all three were offered as business keys. A monetary
 * amount that happens not to repeat is not an identifier, and suggesting it as one costs the product more
 * credibility than the finding was ever worth.
 */
const KEY_LIKE_NAME =
  /(^|[^a-z])(id|key|code|no|num|number|ref|reference|sku|guid|uuid|account|barcode|isbn|ean)([^a-z]|$)/i;

/**
 * Unique, complete, and plausibly an identifier.
 *
 * The name has to agree, or the column has to have been read as an identifier in its own right (digits
 * with a leading zero, say). A reading that says the column is something else — money, a telephone number,
 * an address — disqualifies it outright, because those are unique by accident rather than by design.
 */
const NOT_A_KEY = new Set(['CURRENCY', 'PERCENTAGE', 'PHONE', 'EMAIL', 'URL', 'EXCEL_SERIAL_DATE']);

/** Plausibly an identifier, before asking whether it is actually unique and complete. */
function couldIdentify(f: FieldProfileDto): boolean {
  if (SYNTHETIC_COLUMN.test(f.field)) return false;
  const reading = f.semantic?.type;
  if (reading && NOT_A_KEY.has(reading)) return false;
  return KEY_LIKE_NAME.test(f.field) || reading === 'IDENTIFIER';
}

function candidateKeys(profile: TableProfileDto): FieldProfileDto[] {
  return profile.fields.filter((f) => {
    if (f.examined === 0 || f.distinctCount === null) return false;
    if (f.distinctCount !== f.examined) return false;
    if (f.nullCount + f.blankCount !== 0) return false;
    return couldIdentify(f);
  });
}

const isNearlyUnique = (f: FieldProfileDto) =>
  f.examined > 0 &&
  f.distinctCount !== null &&
  f.distinctCount / f.examined >= NEARLY_UNIQUE &&
  f.distinctCount !== f.examined;

/**
 * The columns that came closest to being a key, so "there is no key" says what it looked at.
 *
 * Ranked by distinctness alone, this listed whichever columns happened not to repeat -- on a finance
 * export it offered `credit_limit: 60 distinct across 60 examined, 0 empty values` as the evidence
 * for "no column is unique and filled in", which is a sentence refuted by the line beneath it, and
 * it pushed `customer_number` off the end of the list. The column a reader is looking for is the one
 * that was meant to be the key and missed, so plausible identifiers come first and the rest are a
 * fallback for a table that has none.
 */
function nearMisses(profile: TableProfileDto): FieldProfileDto[] {
  const measurable = profile.fields.filter(
    (f) => !SYNTHETIC_COLUMN.test(f.field) && f.examined > 0 && f.distinctCount !== null,
  );
  const byDistinctness = (a: FieldProfileDto, b: FieldProfileDto) =>
    (b.distinctCount ?? 0) / b.examined - (a.distinctCount ?? 0) / a.examined;
  const plausible = measurable.filter(couldIdentify);
  return (plausible.length > 0 ? plausible : measurable).sort(byDistinctness).slice(0, 3);
}

function lengthSpread(field: FieldProfileDto): boolean {
  if (field.maxLength === null || field.averageLength === null || field.minLength === null) return false;
  if (field.maxLength < 40) return false;
  return field.averageLength > 0 && field.maxLength / field.averageLength >= LENGTH_OUTLIER_FACTOR;
}

/**
 * Turns a semantic reading into a finding, where the reading has a migration consequence.
 *
 * Not every reading does. Knowing a column holds web addresses is useful context and not a decision, so it
 * produces no finding — which is the restraint that keeps the list worth reading.
 */
function fromSemantic(
  id: (rule: string, column?: string) => string,
  dataset: string,
  profile: TableProfileDto,
  column: string,
  reading: SemanticReading,
  field: FieldProfileDto | undefined,
): Finding | null {
  const base = {
    dataset,
    table: profile.displayName,
    columns: [column],
    basis: profile.basis,
    confidence: reading.confidence,
  };

  if (reading.type === 'EXCEL_SERIAL_DATE') {
    return {
      ...base,
      id: id('DATE_AS_NUMBER', column),
      category: 'TYPE_COMPATIBILITY',
      severity: 'WARNING',
      title: `${column} holds dates stored as numbers`,
      summary: `${column} is stored as a number, but the values look like Excel serial dates. ${reading.evidence}`,
      affected: field?.examined ?? 0,
      affectedPercent: null,
      evidence: [
        reading.evidence,
        'Storage type and detected meaning differ, so nothing has been converted.',
      ],
      whyItMatters:
        'Migrated as a number, the target gets 45292 instead of a date — and it will accept it without complaint if the target column is numeric. The error is only visible to someone who knows what the value should have been.',
      recommendation: reading.suggestedTransformation ?? 'Confirm the meaning and convert before loading.',
      migrationImpact:
        'Either the write fails because the target wants a date, or it succeeds and stores a meaningless number. The second is worse.',
    };
  }
  if (reading.type === 'EMAIL' && reading.suggestedTransformation) {
    /*
     * `reading.evidence` counts distinct sampled values, because that is what the semantic reader
     * works from. It is the wrong number to publish as "records affected": one misspelling repeated
     * across ten thousand rows is one distinct value and ten thousand records to fix. The profiler
     * counts the records; the sampled figure stays in the evidence, labelled as what it is.
     */
    const sampled = /(\d+) are not/.exec(reading.evidence);
    const distinctBad = sampled ? Number(sampled[1]) : 0;
    const records = field?.invalidEmailCount ?? null;
    const affected = records ?? 0;
    return {
      ...base,
      id: id('INVALID_EMAIL', column),
      category: 'VALIDITY',
      severity: 'WARNING',
      title: `${column} contains addresses that are not valid`,
      summary:
        records === null
          ? `${column} holds email addresses, and ${plural(distinctBad, 'distinct value')} are not formatted as one.`
          : `${column} holds email addresses, and ${plural(records, 'record')} contain a value that is not formatted as one.`,
      affected,
      affectedPercent: records !== null && field ? pct(records, field.examined) : null,
      evidence: [reading.evidence],
      whyItMatters:
        'An invalid address is rejected by some targets and silently accepted by others. Where it is accepted, it becomes an email nobody can send to, discovered by the first campaign that tries.',
      recommendation: reading.suggestedTransformation,
      migrationImpact:
        'These records are blocked where the target validates the format, and migrate as unusable addresses where it does not.',
    };
  }
  if (reading.type === 'PHONE') {
    return {
      ...base,
      id: id('PHONE_FORMAT', column),
      category: 'CONSISTENCY',
      severity: 'INFO',
      title: `${column} uses more than one phone format`,
      summary: `${column} holds telephone numbers written in several different ways.`,
      affected: field?.examined ?? 0,
      affectedPercent: null,
      evidence: [reading.evidence],
      whyItMatters:
        'Inconsistent formatting is harmless to store and costly to match on. If a phone number is ever part of how records are matched or deduplicated, the format decides the answer.',
      recommendation: reading.suggestedTransformation ?? 'Normalise to one format before migrating.',
      migrationImpact:
        'Matching and deduplication on this column will be less accurate than the data allows.',
    };
  }
  if (reading.type === 'CATEGORICAL') {
    return {
      ...base,
      id: id('CATEGORICAL_VALUES', column),
      category: 'TYPE_COMPATIBILITY',
      severity: 'INFO',
      title: `${column} is a short list of values`,
      summary: `${column} only ever holds a small fixed set of values. ${reading.evidence}`,
      affected: 0,
      affectedPercent: null,
      evidence: [reading.evidence],
      whyItMatters:
        'A column like this is usually a choice field in the target. Each source value has to map to a target option, and any value with nowhere to go blocks its records.',
      recommendation: reading.suggestedTransformation ?? 'Map each value to the target choice set.',
      migrationImpact: 'Unmapped values block the records that use them.',
      // A mapping task to do, not a defect in the data.
      deducts: false,
    };
  }
  if (reading.type === 'IDENTIFIER') {
    return {
      ...base,
      id: id('IDENTIFIER_AS_TEXT', column),
      category: 'TYPE_COMPATIBILITY',
      severity: 'INFO',
      title: `${column} is an identifier, not a number`,
      summary: `${column} holds values with leading zeros, which a numeric column cannot preserve.`,
      affected: 0,
      affectedPercent: null,
      evidence: [reading.evidence],
      whyItMatters:
        'Stored as a number, 007 becomes 7 — and nothing reports a difference, because by then the value is the number seven. Comparisons against the source will match and the data will still be wrong.',
      recommendation: reading.suggestedTransformation ?? 'Keep this column as text.',
      migrationImpact: 'A numeric target column would silently drop the leading zeros.',
      // Already correct as text. This is a note so nobody 'fixes' it into a number.
      deducts: false,
    };
  }
  if (reading.type === 'CURRENCY' || reading.type === 'PERCENTAGE') {
    return {
      ...base,
      id: id(reading.type === 'CURRENCY' ? 'CURRENCY_AS_TEXT' : 'PERCENTAGE_AS_TEXT', column),
      category: 'TYPE_COMPATIBILITY',
      severity: 'WARNING',
      title:
        reading.type === 'CURRENCY'
          ? `${column} holds amounts with a currency symbol`
          : `${column} holds percentages with a percent sign`,
      summary: `${column} is stored as text because of the symbol, so it cannot be used as a number without conversion. ${reading.evidence}`,
      affected: field?.examined ?? 0,
      affectedPercent: null,
      evidence: [reading.evidence],
      whyItMatters:
        reading.type === 'CURRENCY'
          ? 'A monetary target column needs a number. The symbol also hides whether every row is the same currency, which no amount of arithmetic afterwards can recover.'
          : 'Whether 15% is stored as 15 or as 0.15 is a decision, and getting it wrong is a factor of a hundred that looks plausible on screen.',
      recommendation: reading.suggestedTransformation ?? 'Convert before loading.',
      migrationImpact: 'The write fails, or the value lands as text in a column that should hold a number.',
    };
  }
  // EMPTY is already covered by the completeness rule, with better evidence. URL needs no decision.
  return null;
}

// ---------------------------------------------------------------------------
// What a person decided about a finding
// ---------------------------------------------------------------------------

/**
 * The engine observes; a person decides. These are the decisions.
 *
 * Deliberately few, and none of them is "dismissed". A finding that somebody waves away without saying
 * why is indistinguishable from one nobody read, and six months later the difference is the whole
 * question. Every status other than OPEN is a position somebody has taken and can be asked about.
 */
export const FINDING_DISPOSITIONS = [
  'OPEN',
  'WILL_FIX',
  'ACCEPTED_RISK',
  'NOT_APPLICABLE',
  'RESOLVED',
] as const;
export type FindingDispositionStatus = (typeof FINDING_DISPOSITIONS)[number];

export const FINDING_DISPOSITION_LABELS: Record<FindingDispositionStatus, string> = {
  OPEN: 'Open',
  WILL_FIX: 'Will fix',
  ACCEPTED_RISK: 'Accepted risk',
  NOT_APPLICABLE: 'Not applicable',
  RESOLVED: 'Resolved',
};

/** What each decision means, so two people choosing between them choose the same way. */
export const FINDING_DISPOSITION_DESCRIPTIONS: Record<FindingDispositionStatus, string> = {
  OPEN: 'Nobody has decided about this yet.',
  WILL_FIX: 'This will be corrected in the source before migrating.',
  ACCEPTED_RISK: 'Understood and accepted as it is. The migration will proceed with this unresolved.',
  NOT_APPLICABLE: 'Real, but it does not matter for this migration — an obsolete field, say.',
  RESOLVED: 'Already corrected. The next analysis should no longer find it.',
};

export interface FindingDisposition {
  findingId: string;
  status: FindingDispositionStatus;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string;
}

/**
 * Whether a decided finding still counts against readiness.
 *
 * A finding somebody has accepted or ruled out is still **shown**, with its evidence intact, because the
 * observation did not stop being true. It stops counting against the score, because the score answers
 * "what is left to deal with" and a decision is how something stops being left to deal with.
 *
 * `WILL_FIX` deliberately still counts. Intending to fix something is not having fixed it, and a readiness
 * figure that improved on a promise would be worth nothing.
 */
export const dispositionSilences = (status: FindingDispositionStatus | undefined) =>
  status === 'ACCEPTED_RISK' || status === 'NOT_APPLICABLE' || status === 'RESOLVED';
