# What "equal" means

Validation reports a difference when two values are not equal, so everything it says rests on this
definition. Two Phase 4 bugs lived here and both reported a _difference as a match_, which is the
direction that matters — a false difference is noise, a false match is a silent data loss.

Every rule below is asserted in `tests/unit/semantic-equality.test.ts`, and the highest-risk ones are
checked against real PostgreSQL, MySQL and SQL Server in `tests/engines/conformance.ts`.

## The governing rule

**Comparison is in the target's terms.** The target is where the data lives now and its column is
what somebody will read in five years, so:

1. the source value is put through the **same transformation engine the migration used**, with the
   same rules from the run snapshot — never a second implementation;
2. the result is compared against the target value using the **target column's** metadata.

A consequence worth stating: when a transformation is configured, validation checks that the target
holds the _transformed_ value, not the source value. A deliberately truncating transformation produces
a match, and the fact that information was discarded is reported by the lossy-transformation
acknowledgement rather than by the comparison.

## Type by type

| Type                                                       | Equal means                                                                                       | Deliberate tolerance                                | Limitation                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **String, Memo**                                           | Same text after normalising line endings and trimming the end                                     | CRLF ≡ LF; trailing whitespace ignored; `''` ≡ NULL | A VARCHAR that genuinely lost a trailing space reads as equal. `''` ≡ NULL is right for Dataverse, which stores one as the other, and wrong for SQL-to-SQL where they are two values |
| **Integer, BigInt**                                        | Exact. Compared as scaled integers when both sides are strings                                    | None                                                | A side that arrives as a JavaScript number has already lost precision near 2^53; nothing can recover it                                                                              |
| **Decimal, Money**                                         | Exact when both sides are strings; otherwise equal within half of the column's last decimal place | Differences below the column's own scale            | Same number caveat as above                                                                                                                                                          |
| **Double**                                                 | Equal within half the last declared decimal place, or 1e-9                                        | Yes, necessarily                                    | Floating point has no exact comparison worth having                                                                                                                                  |
| **DateTime**                                               | The same instant, to the second                                                                   | Anything below one second                           | Engines keep different precision — `datetime2(7)` holds 100-nanosecond ticks, Dataverse whole seconds. Comparing finer would fail every migration between them                       |
| **DateTime (DateOnly)**                                    | The same calendar day                                                                             | Time and timezone ignored                           | The rule is the first ten characters, so it assumes ISO order. Every connector here returns ISO                                                                                      |
| **Boolean**                                                | The same truth value, reading `true/1/t/yes` and `false/0/f/no` in any case                       | Text spellings accepted                             | A value it cannot read as a boolean is compared as text rather than guessed at                                                                                                       |
| **Uniqueidentifier, Lookup, Customer, Owner**              | The same identifier, case-insensitively                                                           | Case                                                | A lookup's identity is the record it points at                                                                                                                                       |
| **Picklist, State, Status**                                | The same numeric value                                                                            | None                                                | A choice's _label_ is not compared; a relabelled option with the same value is equal                                                                                                 |
| **MultiSelectPicklist**                                    | The same set                                                                                      | Order ignored                                       | —                                                                                                                                                                                    |
| **JSON (`json`, `jsonb` target)**                          | The same document: key order ignored, array order significant, numbers exact                      | Key order; number formatting                        | A driver that pre-parses the column has already collapsed duplicate keys and rounded long numbers. A document that repeats a key is reported as not comparable                       |
| **Binary (`varbinary`, `bytea`, `blob`, `File`, `Image`)** | The same bytes, up to 8 MiB                                                                       | Buffer / base64 / bytea hex are reconciled          | Past 8 MiB it is reported as not comparable rather than read                                                                                                                         |
| **Everything else**                                        | Structural, by serialisation                                                                      | None                                                | See below                                                                                                                                                                            |

## Where values are compared as exact digits

`Integer`, `BigInt`, `Decimal` and `Money` are compared as scaled integers — not through a double —
**whenever both sides arrive as strings**. Drivers return those columns as strings precisely so the
digits survive, and comparing them exactly is what makes a BIGINT near 2^53 or a `numeric(38,10)`
trustworthy.

When a side arrives as a JavaScript number, the numeric path is used instead. That is deliberate: a
number in hand has already lost whatever it was going to lose, and comparing it exactly would imply a
precision it does not have.

## The third answer: not comparable

Equality used to have two outcomes, so a column nobody could honestly compare had to be called one of
them — and calling it equal is a silent false pass, the one failure mode this product exists to avoid.
There is now a third verdict. `NOT_COMPARABLE` is reported at **column** level, with the reason and how
many records it affected, and those records are still compared on every other column. They count as
matched, because nothing was shown to be wrong with them; what could not be answered is named instead
of being folded into a number that would imply either answer.

`compareValues` in `server/src/services/values.ts` returns it; `tests/unit/value-comparison.test.ts`
holds the behaviour.

## JSON

A `json` or `jsonb` **target** column is compared as a document, not as text. Only the target's type
decides, per the governing rule: a `jsonb` source column migrated into a Dataverse Memo is text now,
and comparing it as text is correct.

`JSON.parse` is not used, because the two things that make this trustworthy are exactly what it throws
away, and both of its losses produce a **false match**:

- **duplicate keys are collapsed silently** — `{"a":1,"a":2}` parses to `{a:2}`, so two documents that
  genuinely differ compare equal, and which value won is a property of the parser rather than of the
  data;
- **numbers become doubles** — `12345678901234567890` and `12345678901234567891` both become
  `1.2345678901234567e19`, so a BIGINT inside a document compares equal to a different one. There is a
  test asserting that `JSON.parse` cannot tell those two apart and that this comparison can.

So `shared/json-compare.ts` parses the text itself. The rules:

| Question         | Answer                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object key order | **Ignored.** `{"a":1,"b":2}` equals `{"b":2,"a":1}`, at every depth                                                                                                                               |
| Array order      | **Significant.** A JSON array is a sequence; `[1,2]` is not `[2,1]`                                                                                                                               |
| Numbers          | Exact decimals, through the same scaled-integer comparison the numeric columns use, with exponents expanded. `1`, `1.0` and `1e0` are equal; two twenty-digit integers are equal only if they are |
| `null`           | A value. A key present and null is not a key that is absent, and is not `""`, `0` or `false`                                                                                                      |
| Strings          | Exact after unescaping. `"\u0041"` equals `"A"`. Nothing is trimmed or case-folded — that is a column's tolerance, and this is content inside a document                                          |
| Duplicate keys   | `NOT_COMPARABLE`, naming the key                                                                                                                                                                  |
| Invalid JSON     | A **difference**, not "not comparable" — the answer is known. One side a document and the other not is a real difference                                                                          |
| Past the limits  | `NOT_COMPARABLE`. 1,000,000 characters, 64 levels, 50,000 values. Byte-identical text is still equal without parsing, so an untouched large document reads as equal rather than unreadable        |

**The limitation.** When a driver returns a `jsonb` column as a parsed object rather than as text —
which `pg` does — duplicate keys have already been collapsed and long numbers have already been
through a double, before this platform sees anything. Nothing can recover that, exactly as nothing can
recover a BIGINT that arrived as a JavaScript number. The comparison is then over what the driver gave
us.

## Binary

A `varbinary`, `binary`, `bytea`, `blob` or `image` column, and Dataverse's `File` and `Image`, are
compared **byte for byte** up to 8 MiB. Past that the answer is `NOT_COMPARABLE` rather than a
comparison that reads an arbitrary amount of data into memory to answer one question about one field.

Byte equality rather than a digest, deliberately: a digest is how you compare bytes you do not both
have — across a network, or against something recorded earlier. Both values are in hand here, so
hashing them would be strictly more work for the same answer and would introduce a collision the
comparison does not need to have. A length difference is reported as a difference without looking
further, which is what a truncation looks like.

The encodings connectors actually return are reconciled: a Buffer from most drivers, base64 from
Dataverse and JSON transports, and PostgreSQL's hex form when `bytea` is read as text. Text in any
other shape is `NOT_COMPARABLE` rather than compared as text.

## The bugs this audit found, and what they were

All four were reporting a difference as a match, and all four are fixed:

| Bug                                | What happened                                                                                                                                                             | Fix                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `Boolean('false')` is `true`       | A target returning a bit column as the text `'false'` compared equal to a source `true`                                                                                   | Recognised spellings, parsed; anything else compared as text |
| Big integers through a double      | `9000000000000001` compared equal to `9000000000000000`                                                                                                                   | Exact scaled-integer comparison when both sides are strings  |
| Wide decimals through a double     | `…890.1234` compared equal to `…890.1235`                                                                                                                                 | The same fix                                                 |
| `precision` read for a SQL decimal | `precision` is decimal places for Dataverse and _total digits_ for SQL, so `numeric(18,2)` got a tolerance of 10⁻¹⁸ and reported differences the column cannot even store | Read `sql.scale` first, falling back to `precision`          |

And two found earlier in the phase, in the aggregate path, for the same reason — an assumption about
what a value means that only running it could settle:

- A **date-only** column's extremes compared as instants: source `2024-05-31 17:00-07` against target
  `2024-06-01 00:00-07` is the same day seven hours apart. Date-only columns are no longer reconciled
  by extreme.
- A **Money(2)** total compared at accumulated float precision: `30024889.949999999985` against
  `30024889.95`. Totals are compared at the column's declared scale.

The pattern in all six: a rule that was correct about the _idea_ and wrong about the _representation_.
The lesson is in how they were found — by running the product against a real engine and reading what it
said, not by reading the code.

## What is not compared

- **Columns the plan does not map.** Validation compares mapped columns; an unmapped column is
  reported as unmapped by plan validation rather than as a difference.
- **System-managed columns.** `createdon` and `modifiedon` are written by the target at insert time
  unless the run was asked to preserve them, in which case they are compared like any other column.
- **Field-secured columns.** Masked before they are ever stored in a report, so there is nothing to
  compare and nothing to leak.
