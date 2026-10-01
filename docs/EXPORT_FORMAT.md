# What an exported file contains, exactly

Every CSV this platform produces is read by a spreadsheet, and a spreadsheet is not a neutral reader:
it executes some cells and reinterprets others. So an export has to choose between being byte-for-byte
faithful and being safe to open, and this document records the choices rather than leaving somebody to
discover them from a file.

Verified by `tests/integration/streaming-exports.test.ts` and `tests/unit/principals-and-csv.test.ts`.

## The format

- **UTF-8 with a byte order mark.** Without the mark Excel reads the file in the local codepage and
  turns `Ünïcödé` into mojibake. The mark costs three bytes and is stripped by every reader that
  matters.
- **CRLF line endings**, per RFC 4180.
- **Quoting** only where it is needed: a cell containing a comma, a double quote, a carriage return or
  a line feed is wrapped in double quotes, and a double quote inside it is doubled. Everything else is
  written as-is.
- **A header row** naming every column.

## Values, and what happens to them

| Value                             | Exported as                      | Why                                                                                                                                |
| --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary text                     | Unchanged                        | —                                                                                                                                  |
| Contains `,` `"` CR or LF         | Quoted, inner quotes doubled     | RFC 4180                                                                                                                           |
| Unicode, accents, CJK, emoji      | Unchanged, byte for byte         | An export is a record of what was stored. Nothing is normalised — `e` + combining acute stays as it was, and is not folded to `é`. |
| Large text                        | Unchanged, whole                 | No truncation. A 100,000-character note exports as 100,000 characters.                                                             |
| Empty string                      | Nothing                          |                                                                                                                                    |
| NULL                              | Nothing                          |                                                                                                                                    |
| Leading `=` `+` `-` `@` tab or CR | **Prefixed with a single quote** | See below                                                                                                                          |

**Empty string and NULL are indistinguishable in a CSV.** That is the format's limit, not a choice,
and it is why validation reports `VALUE_LOST` as its own difference type rather than leaving a reader
to infer it from an exported file. When the distinction matters, the validation report is the place to
look.

## Formula injection, the one transformation

A spreadsheet treats a cell beginning `=`, `+`, `-` or `@` as a formula and evaluates it on open. An
exported value starting with one of those characters is therefore a command that runs on somebody
else's machine — including `=cmd|'/c calc'!A1`, which some spreadsheet software will act on.

**Those cells are prefixed with a single quote (`'`).** Spreadsheets strip it on display, so the value
reads correctly and does not execute. Only the leading character triggers it: `a=b` and `10-20` are
untouched.

The cost, stated plainly: **a negative number exports as text.** `-99.50` becomes `'-99.50`, which a
spreadsheet shows as `-99.50` but treats as a string, so it will not sum a column of negative values
without the reader converting it. The alternative is a cell containing `-2+3` being evaluated as a
formula, and a number that reads correctly is worth more than a number that computes. The underlying
value is never altered — the prefix is added at the moment of writing and the quote is the only
difference.

This is the **only** transformation an export applies. No rounding, no reformatting of dates, no
trimming, no case folding.

## Masked values

Columns marked field-secured are masked before they are ever stored in a report table, so an export
cannot leak them: there is nothing to leak by the time it runs. A masked cell exports as its mask,
and the fact that it is masked is in the validation report rather than inferred from the file.

## Which exports stream

An export whose size grows with the migration is written as its rows are found and is not capped:

| Export                                     | Behaviour                                                           |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `runs/:id/records.csv`                     | Streamed, keyset-paged over the identity map. Every record, no cap. |
| `validations/:id/differences.csv`          | Streamed, keyset-paged. Every difference, no cap.                   |
| Evidence package `lineage/part-NNNNNN.csv` | Streamed in chunks of 50,000 rows inside a streamed ZIP.            |

The rest — plan issues, data quality, comparison tables, principal mappings, validation summary — are
bounded by the number of tables or users rather than by the number of records, and are built in one
piece. They keep the `TRUNCATED` row that states when a limit was reached, because for those a limit
is reachable only in an unusual plan and saying so is better than streaming machinery nobody needs.

Earlier versions capped `records.csv` at 100,000 rows and `differences.csv` at 50,000 with a
`TRUNCATED` line at the bottom. That is gone: a capped export answers a different question from the
one somebody asked.
