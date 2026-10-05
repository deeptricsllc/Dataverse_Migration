/**
 * A realistic legacy dataset, with realistic things wrong with it.
 *
 * ## Why not test1/test2
 *
 * The dataset this product was being demonstrated with was a 46-row project tracker. It proved the
 * mechanics worked and it proved nothing about whether the product is useful, because there was almost
 * nothing in it to find. A migration assessment is only interesting in proportion to the mess it is
 * assessing.
 *
 * So this is a small legacy CRM extract of the kind that actually turns up: four files that disagree with
 * each other, exported by somebody who had to get them out of a system that is being switched off.
 *
 * ## Every problem here is one the engine really detects
 *
 * Each planted issue maps to a rule in `shared/findings.ts`. That is deliberate in both directions —
 * nothing is planted that the product would miss, and nothing is claimed that is not planted. The data is
 * generated from fixed arrays and index arithmetic with no randomness at all, so the same files produce the
 * same findings every time and a test can assert on the counts.
 *
 * **Deliberately not planted:** orphaned references. Orders here do point at customer numbers that no
 * customer has, because that is what a real extract looks like — but there is no cross-table referential
 * rule yet, so no finding is claimed for it. The data is honest about the world; the product is honest
 * about what it can see.
 *
 * No real personal data. Every name, address and email is constructed.
 */

export interface DemoFile {
  filename: string;
  /** CSV, because it is the format a legacy export actually arrives in. */
  content: string;
  /** What this file is for, shown while the demo is being built. */
  description: string;
}

const FIRST = ['Alice', 'Brian', 'Chandra', 'Diane', 'Ewan', 'Fatima', 'Graham', 'Hyun', 'Ingrid', 'Jonas'];
const LAST = [
  'Okafor',
  'Whitfield',
  'Nakamura',
  'Alvarez',
  'Petrov',
  'Haddad',
  'Lindqvist',
  'Mbeki',
  'Costa',
  'Doyle',
];
const COMPANIES = [
  'Northwind Logistics',
  'Contoso Systems',
  'Alpine Foods',
  'Harbour Freight Co',
  'Meridian Health',
  'Bluefin Analytics',
  'Carter & Sons',
  'Delta Manufacturing',
];
const REGIONS = ['North', 'South', 'East', 'West'];
const COUNTRIES = ['United Kingdom', 'UK', 'United States', 'USA', 'Ireland'];
const ORDER_STATUS = ['Open', 'Shipped', 'Cancelled', 'On Hold'];
const CATEGORIES = ['Hardware', 'Software', 'Services', 'Consumables'];

/** Escapes a CSV field only when it needs it, the way a real export does. */
const csv = (rows: (string | number)[][]) =>
  rows
    .map((row) =>
      row
        .map((cell) => {
          const text = String(cell);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    )
    .join('\r\n');

/**
 * Excel's serial for a date, which is what a numeric date column in a real export contains.
 * Day zero is 1899-12-30; see `shared/semantic-types.ts` for why that is not 1900-01-01.
 */
const excelSerial = (iso: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const isoDate = (dayOffset: number) =>
  new Date(Date.UTC(2024, 0, 1) + dayOffset * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------

const CUSTOMER_ROWS = 400;

/**
 * Customers: has a usable key, and almost everything else wrong.
 *
 * Plants: a clean candidate key, an almost-unique email with a handful of real duplicates, invalid
 * addresses, inconsistent phone formats, an entirely empty legacy column, a categorical region, an
 * account reference with leading zeros, trailing whitespace on company names, and amounts carrying a
 * currency symbol.
 */
function customers(): DemoFile {
  const header = [
    'customer_number',
    'company',
    'contact_email',
    'phone',
    'region',
    'country',
    'account_ref',
    'credit_limit',
    'created_on',
    'legacy_notes',
  ];
  const rows: (string | number)[][] = [header];

  for (let i = 0; i < CUSTOMER_ROWS; i++) {
    const company = COMPANIES[i % COMPANIES.length]!;
    // Every eleventh company name carries a trailing space, which is how a real export looks and the
    // single most common reason a match that should have worked does not.
    const companyCell = i % 11 === 0 ? `${company} ` : company;

    // Six rows reuse an earlier customer's address: genuine duplicate people, entered twice.
    const duplicate = i >= 380 && i < 386;
    const emailIndex = duplicate ? i - 300 : i;
    let email = `${FIRST[emailIndex % FIRST.length]!.toLowerCase()}.${LAST[emailIndex % LAST.length]!.toLowerCase()}${emailIndex}@example.com`;
    // Fourteen addresses are malformed — a missing @, a trailing comma, a space in the middle.
    if (i % 29 === 0) email = email.replace('@', ' at ');
    else if (i % 37 === 0) email = `${email},`;

    // Three phone conventions in one column, which is what happens when three people maintain it.
    const phone =
      i % 3 === 0
        ? `+44 20 7946 ${pad(1000 + (i % 8999), 4)}`
        : i % 3 === 1
          ? `(555) ${pad(100 + (i % 899), 3)}-${pad(1000 + (i % 8999), 4)}`
          : `020 7946 ${pad(1000 + (i % 8999), 4)}`;

    rows.push([
      `CUST-${pad(1000 + i, 5)}`,
      companyCell,
      email,
      phone,
      REGIONS[i % REGIONS.length]!,
      COUNTRIES[i % COUNTRIES.length]!,
      // Leading zeros: an identifier written in digits, which a numeric column would destroy.
      pad(i + 1, 6),
      `£${(1000 + i * 37).toLocaleString('en-GB')}.00`,
      isoDate(i % 365),
      // Empty in every single row. Either obsolete, or the notes are somewhere else entirely.
      '',
    ]);
  }
  return {
    filename: 'Customers.csv',
    content: csv(rows),
    description: '400 customer accounts exported from the legacy CRM',
  };
}

/**
 * Contacts: the file with no usable identifier at all.
 *
 * This is the headline critical finding, and it took care to arrange: **every** column has to repeat, or
 * the one that does not becomes a perfectly good business key and the finding correctly disappears. The
 * first draft of this file had a unique date of birth and a unique customer number by accident, and the
 * product was right to say so. Names repeat, the email repeats every sixty rows, the mobile is a shared
 * office number, the date of birth is one of ninety, and there are several contacts per customer.
 *
 * It is also the file carrying obvious personal data, and a mobile number that is usually missing.
 */
function contacts(): DemoFile {
  const header = [
    'first_name',
    'last_name',
    'email',
    'mobile',
    'date_of_birth',
    'job_title',
    'customer_number',
  ];
  const rows: (string | number)[][] = [header];

  for (let i = 0; i < 300; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 3) % LAST.length]!;
    rows.push([
      first,
      last,
      // Repeats every 60 rows: five people share each address, so nothing here identifies a row.
      `${first.toLowerCase()}.${last.toLowerCase()}${i % 60}@example.com`,
      // Missing in roughly 40% of rows, and repeating where present — a shared office number.
      i % 5 < 2 ? '' : `+44 7700 ${pad(900000 + (i % 90), 6)}`,
      // Repeats: a date of birth is not an identifier, and three hundred people share ninety of them here.
      isoDate(-(8000 + (i % 90) * 97)),
      ['Buyer', 'Finance Manager', 'Director', 'Operations Lead'][i % 4]!,
      // Several contacts per customer, which is the whole point of a contacts table.
      `CUST-${pad(1000 + (i % 120), 5)}`,
    ]);
  }
  return {
    filename: 'Contacts.csv',
    content: csv(rows),
    description: '300 contacts, with no reliable identifier of their own',
  };
}

/**
 * Orders: dates stored as numbers, and references that do not all resolve.
 *
 * The date columns are Excel serials, which is the problem that started this whole line of work: they
 * profile as integers and read as 2024 dates. The percentage column carries its sign, so it is text.
 */
function orders(): DemoFile {
  const header = [
    'order_reference',
    'customer_number',
    'order_date',
    'ship_date',
    'status',
    'order_total',
    'discount_pct',
    'notes',
  ];
  const rows: (string | number)[][] = [header];

  for (let i = 0; i < 600; i++) {
    // Twenty-two orders reference a customer number nobody has. Realistic, and not claimed as a finding.
    const orphan = i % 27 === 0;
    const customerIndex = orphan ? 9000 + i : i % CUSTOMER_ROWS;
    rows.push([
      `SO-${pad(50000 + i, 6)}`,
      `CUST-${pad(1000 + customerIndex, 5)}`,
      excelSerial(isoDate(i % 300)),
      excelSerial(isoDate((i % 300) + 3)),
      ORDER_STATUS[i % ORDER_STATUS.length]!,
      (120 + i * 13.5).toFixed(2),
      `${(i % 20) * 0.5}%`,
      i % 50 === 0
        ? 'Customer called twice about this one; the second call is logged in the old ticketing system under a reference nobody can find any more, so this note is the only record of it.'
        : '',
    ]);
  }
  return {
    filename: 'Orders.csv',
    content: csv(rows),
    description: '600 orders, with dates stored as Excel serial numbers',
  };
}

/** Products: a clean key, and one column holding two different kinds of thing. */
function products(): DemoFile {
  const header = ['sku', 'product_name', 'category', 'unit_price', 'description'];
  const rows: (string | number)[][] = [header];

  for (let i = 0; i < 120; i++) {
    rows.push([
      `SKU-${pad(i + 1, 5)}`,
      `${CATEGORIES[i % CATEGORIES.length]} item ${i + 1}`,
      CATEGORIES[i % CATEGORIES.length]!,
      (9.99 + i * 2.5).toFixed(2),
      /**
       * Mostly a short line, and three times a paragraph somebody pasted in.
       *
       * Three rather than every seventeenth, because the finding is about the *spread*: with eight long
       * values in a hundred and twenty the average rises far enough that the longest no longer stands out,
       * and the product correctly says nothing. A real description column has a handful of these.
       *
       * The product number is included so the values vary, which is also what stops this being read as a
       * short fixed list of categories.
       */
      i % 40 === 0
        ? `Replaces the previous generation ${CATEGORIES[i % CATEGORIES.length]!.toLowerCase()} unit, part ${i + 1}. Not compatible with the mounting bracket supplied before 2019, and the firmware has to be updated before first use or the device will not report its serial number correctly to the inventory system. Engineering have asked that this note stays with the record.`
        : `${CATEGORIES[i % CATEGORIES.length]!} line ${i + 1}`,
    ]);
  }
  return {
    filename: 'Products.csv',
    content: csv(rows),
    description: '120 products',
  };
}

/** The dataset, in the order it makes sense to add it. */
export function customerModernizationFiles(): DemoFile[] {
  return [customers(), contacts(), orders(), products()];
}

export const DEMO_ANALYSIS_PROJECT_NAME = 'Customer Data Modernization';
export const DEMO_DATASET_NAME = 'Legacy CRM extract';

/**
 * What this dataset is designed to make the product say.
 *
 * Exported so a test can assert the product finds them, and so the demo script can promise them. If a rule
 * changes and one of these stops appearing, that is a regression in the analysis rather than in the data.
 */
export const EXPECTED_FINDINGS = [
  { rule: 'NO_RELIABLE_KEY', table: 'Contacts', why: 'no column is both unique and populated' },
  { rule: 'CANDIDATE_KEY', table: 'Customers', why: 'customer_number is unique and complete' },
  { rule: 'EMPTY_COLUMN', table: 'Customers', why: 'legacy_notes is empty in all 400 rows' },
  { rule: 'HIGH_NULL_RATE', table: 'Contacts', why: 'mobile is missing in about 40% of rows' },
  { rule: 'WHITESPACE', table: 'Customers', why: 'company names carry a trailing space' },
  { rule: 'INVALID_EMAIL', table: 'Customers', why: 'some addresses are malformed' },
  { rule: 'PHONE_FORMAT', table: 'Customers', why: 'three phone conventions in one column' },
  { rule: 'DATE_AS_NUMBER', table: 'Orders', why: 'order_date and ship_date are Excel serials' },
  { rule: 'IDENTIFIER_AS_TEXT', table: 'Customers', why: 'account_ref has leading zeros' },
  { rule: 'CURRENCY_AS_TEXT', table: 'Customers', why: 'credit_limit carries a currency symbol' },
  { rule: 'PERCENTAGE_AS_TEXT', table: 'Orders', why: 'discount_pct carries a percent sign' },
  { rule: 'CATEGORICAL_VALUES', table: 'Customers', why: 'region is four values across 400 rows' },
  { rule: 'LENGTH_SPREAD', table: 'Products', why: 'description holds both codes and paragraphs' },
  { rule: 'POSSIBLE_PII', table: 'Contacts', why: 'email, mobile and date_of_birth' },
] as const;
