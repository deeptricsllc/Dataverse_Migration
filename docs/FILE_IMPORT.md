# Reading a file

The rule for this whole subsystem, and the one every decision below is measured against:

> **A value arrives in the target as it was in the file, unless a mapping or a transformation says
> otherwise. Reading is not a transformation.**

File migration earned its own audit because manual QA found **five** separate bugs in one chain, each in
code that had passing tests. Two more were found writing this document. The failures that matter here are
the quiet ones: a file imports, the counts add up, validation passes, and a value is different.

## What was found, and what it was

| Found                                                                                                                            | Was                                                                                                                                                                                                                                             | Now                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **A comma inside a value of a semicolon- or tab-separated file was replaced with a space.** `Smith, John` became `Smith  John`.  | The reader rewrote the file into comma-separated text before parsing it, which meant doing something about the commas already in the data. What it did was turn them into spaces — silently, before anything else in the product saw the value. | The parser takes the delimiter the file actually uses. The rewrite is gone.                       |
| **A column of digits with leading zeros was inferred as a number.** `007` became `7`.                                            | `INTEGER.test('007')` is true, so a part number, a postcode or an account reference was a number — and nothing downstream reported a difference, because by then the value _was_ seven.                                                         | Digits with a leading zero are an identifier, kept as text, with the reason stated on the column. |
| No column could be mapped                                                                                                        | Writability flags describing _the uploaded file_ were used to judge whether the data could be written                                                                                                                                           | Fixed in Phase 4                                                                                  |
| The key column could not be mapped                                                                                               | It was treated as a platform primary id, which a migration must not supply                                                                                                                                                                      | Fixed in Phase 4                                                                                  |
| The key column's value was dropped on read                                                                                       | —                                                                                                                                                                                                                                               | Fixed in Phase 4                                                                                  |
| Validation could not re-read a source whose ids are not GUIDs                                                                    | —                                                                                                                                                                                                                                               | Fixed in Phase 4                                                                                  |
| A validation that compared nothing reported `PASS: Not verified — No records were examined. Every one of them is in the target.` | A confident pass over an empty comparison                                                                                                                                                                                                       | Fixed in Phase 4, and guarded by Golden Journey G                                                 |

## What the reader does

| Concern                               | Behaviour                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Encoding**                          | UTF-8. A byte-order mark is stripped without eating the first column name.                                                                                             |
| **Delimiter**                         | Sniffed from the first line among comma, semicolon and tab, counting only unquoted characters. Parsed with that delimiter — never rewritten.                           |
| **Quoted values**                     | `"has, comma"`, `"has ""quotes"""` and values containing newlines all read as one value.                                                                               |
| **Duplicate headers**                 | Kept and disambiguated: the second `name` becomes `name 2`. Dropping a column because its heading repeats would lose data a real export has.                           |
| **Empty headers**                     | Become `column_1`, `column_2` by position, so the column stays addressable.                                                                                            |
| **Formula-like values**               | `=1+1` is read as the text `=1+1`. Neutralising belongs to the **export**, where a spreadsheet would evaluate it; on the way in it is a value.                         |
| **NULL vs empty**                     | An empty cell and the words `null`, `n/a`, `none`, `-` count as blank for _type inference_ only. The value stored is what the file held.                               |
| **Leading zeros**                     | Keep the column as text. See above.                                                                                                                                    |
| **GUID-like strings**                 | Inferred as `Uniqueidentifier` only when every value is one.                                                                                                           |
| **Dates**                             | Inferred only when every value parses, and **not** when any value is ambiguous about day and month order — `03/04/2024` keeps the column as text rather than guessing. |
| **Numbers too large to hold exactly** | Kept as text, because a BIGINT past 2^53 through a double is a different number.                                                                                       |
| **Booleans**                          | Inferred from words (`true`/`yes`/`y`), never from `0`/`1` alone: a column of ones and zeroes is as often a count as a flag.                                           |
| **Multiple sheets**                   | One table per sheet. A sheet with no header row, or none with values beneath it, is skipped **and reported** rather than silently dropped.                             |
| **Unicode**                           | Preserved. Column _names_ are reduced to an addressable form; the data is not touched.                                                                                 |
| **Malformed rows**                    | A row shorter than the header reads as blank in the missing columns. A row with **more** cells than the header loses the extras — see the limits below.                |

## The bounds

| Limit                              | Value         | Why                                                                                                                             |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| File size                          | 32 MB         | Past this, an extract belongs in a database connection rather than an upload. The message says so.                              |
| Rows per table                     | 500,000       |                                                                                                                                 |
| Columns                            | 300           |                                                                                                                                 |
| Header search                      | first 20 rows | A title line above the header is normal; twenty is generous and bounded.                                                        |
| Distinct values tracked per column | 100,000       | Past it, uniqueness is reported as unknown rather than guessed — which is what stops a key being chosen from a partial picture. |

All are refusals with a reason, not truncations. A file over the limit is rejected; it is never half-read.

## XML

Supported where a repeating element can be found. Depth and size are bounded by the same file-size limit,
and the element that repeats becomes the table. There is no schema inference beyond the same column rules
above.

## What is still not covered

- **No encoding other than UTF-8.** A Windows-1252 export with accented characters will read as
  mojibake rather than being detected and converted. It is not silently corrupted in a way that looks
  fine — it looks wrong immediately — but it is not handled either.
- **A quoted newline inside the header row** would confuse the delimiter sniff, which looks at the first
  physical line. A header containing a newline is rare; this is recorded rather than fixed.
- **A row with more cells than the header loses the extra ones, silently.** The header defines the
  table, so a wider row is malformed — but it is dropped without a word rather than reported, and a
  reader has no way to know it happened. Verified, not inferred: a three-column header with a
  four-cell row yields three values. Reporting it is the right fix and needs a per-row finding, which
  this subsystem does not have yet.

- **Excel's own type coercion happens before we see the file.** A spreadsheet that stored `007` as the
  number 7 gives us 7. Nothing in this product can recover what the author's spreadsheet already
  discarded; the leading-zero rule protects CSV and text columns, which is where the value survives to
  reach us.

`tests/unit/infer-schema.test.ts` holds the inference and the reader. Golden Journey G
(`tests/golden/g-file-migration.test.ts`) runs the whole chain — upload, mapping, migration, validation —
and checks the values that arrived rather than only the count.
