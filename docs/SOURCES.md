# Sources

Written for: engineers working on this codebase.

The platform reads from eight kinds of connection. They divide into two groups, and the division is
the important part of the design — not the count.

| Kind                       | Family      | Read | Write  | How it is read            |
| -------------------------- | ----------- | ---- | ------ | ------------------------- |
| Microsoft Dataverse        | `DATAVERSE` | yes  | yes    | Web API, live             |
| SQL Server                 | `SQL`       | yes  | yes    | `mssql`, live             |
| Azure SQL                  | `SQL`       | yes  | yes    | `mssql`, live             |
| PostgreSQL                 | `SQL`       | yes  | yes    | `pg`, live                |
| MySQL / MariaDB            | `SQL`       | yes  | yes    | `mysql2`, live            |
| CSV / Excel upload         | `TABULAR`   | yes  | **no** | Imported, then staged     |
| OneDrive / SharePoint file | `TABULAR`   | yes  | **no** | Fetched via Graph, staged |
| SharePoint list            | `TABULAR`   | yes  | **no** | Fetched via Graph, staged |

## 1. Live versus staged

A database can be asked a question. There is a query planner, an index to page by, a transaction. A
spreadsheet, a file in cloud storage and a SharePoint list have none of that, and pretending
otherwise would mean inventing a keyset pagination over something with no key and no stable order.

So they are **staged**: read once, stored with their provenance, and served by one connector
(`StagedConnector`). The consequences are worth being explicit about.

- **The variety lives in the import.** A CSV has one table, a workbook has one per sheet, a list has
  its own shape. Everything after that is identical, which is why there is one connector rather than
  three.
- **A re-import replaces a table.** A file is a snapshot, and two snapshots concatenated are not a
  bigger snapshot — they are a duplicate of everything that did not change.
- **Rows keep the order the file had.** It is the only order a spreadsheet has, and it is what paging
  and the synthetic row key are built on.
- **Counts are always exact.** The rows are in the platform's own database, so there is no estimate to
  fall back to and no reason to want one.
- **They can never be written to.** `STAGED_CAPABILITIES.supportsWrite` is false, the tables are
  marked views so the planner refuses them as targets, no "Set as target" button is rendered, and the
  connector's write methods refuse. Four places, because one of them will be the one somebody changes.

## 2. Provider families

`ProviderFamily` on `AttributeMeta` — `DATAVERSE`, `SQL` or `TABULAR` — decides whether a value needs
converting when it moves. Within a family the types mean the same thing; between families they do not.

This used to be inferred as `Boolean(source.sql) !== Boolean(target.sql)`, which was true enough with
exactly two families. A third breaks it: a spreadsheet column has no `sql`, so it would have read as
Dataverse, and a Dataverse-to-Dataverse mapping converts nothing — text handed to an integer column, a
label handed to a choice column. Not an error; wrong data, quietly.

Four places depend on it: the mapping verdict, manual-mapping validation, choice-mapping detection and
the type conversion in the transformation engine. A connector that does not state its family is a bug
waiting for its third provider.

## 3. Adding a SQL dialect

`shared.ts` holds what does not depend on which server is answering: row normalization, the
writable-column rules, watermark resolution, schema filtering, and rewriting `@name` placeholders into
whatever positional form a driver wants. `catalog.ts` turns catalog rows into metadata, given a
`SqlTypeVocabulary`.

So a dialect is: catalog queries projecting into the existing row shapes, a type vocabulary, and a
connector with the SQL text and the driver.

1. `<dialect>-catalog.ts` — five queries aliased to `SqlTableRow`, `SqlColumnRow`, `SqlPkRow`,
   `SqlUniqueRow`, `SqlFkRow`, plus `toAttributeType` / `charLength` / `integerRange` /
   `dateTimeBehavior` and an unsupported-type set.
2. `<dialect>-connector.ts` — quoting, paging, insert/update, error mapping, pool.
3. `ConnectionType`, `EnvironmentProvider`, `ConnectorProvider`, `SQL_CONNECTION_TYPES`,
   `DEFAULT_SQL_PORT`, `DEFAULT_SQL_SCHEMA`, `CONNECTION_TYPE_LABELS`, the factory dispatch, the
   `SCHEMES` / `PROVIDERS` maps in `connection-service.ts`, and the UI's icon, tone and hint records.
   Most of those are exhaustive `Record`s, so the compiler lists what is missing.

**The type vocabulary must not be shared.** SQL Server's unsupported list contains `timestamp` because
there it means a row version; in PostgreSQL and MySQL it is a point in time. Sharing that one set
would mark every timestamp column in two dialects unmigratable.

### What differs per dialect, concretely

|                  | SQL Server           | PostgreSQL            | MySQL                         |
| ---------------- | -------------------- | --------------------- | ----------------------------- |
| Quoting          | `[name]`             | `"name"`, doubled `"` | backticks, doubled            |
| Identifier limit | 128                  | 63                    | 64                            |
| Paging           | `TOP (n)`            | `LIMIT n`             | `LIMIT n`                     |
| Placeholders     | `@name`              | `$1…$n`, reused       | `?`, one per occurrence       |
| Key after insert | `OUTPUT INSERTED.x`  | `RETURNING x`         | `insertId` from the header    |
| Schema layer     | `dbo`                | `public`              | none — a schema IS a database |
| Row estimate     | partition statistics | `pg_class.reltuples`  | `TABLE_ROWS`                  |

The placeholder row is the one that bites. PostgreSQL numbers its placeholders, so a name used twice
reuses one position and is bound once. MySQL's `?` are anonymous, so the same name must be bound once
per occurrence — and getting it backwards silently shifts every later parameter.

## 4. Schema inference, for the staged kinds

A file has no schema: a header row, some values, all of them text. So it is inferred, and the
inference is deliberately asymmetric, because the cost of being wrong is not symmetric. Calling text a
number makes every non-numeric row fail at migration time. Calling a number text costs one conversion
the engine already does.

**A column is narrowed only when every non-empty value fits.** One `TBC` in a thousand rows keeps the
column as text, which is the correct answer about that column. Every column reports the reason for its
type, so the guess is inspectable rather than magic.

Cases worth knowing:

- `N/A`, `-`, `NULL`, `(blank)` and friends count as **empty**, not as text that spoils a numeric
  column.
- A column of only `0` and `1` stays an **integer**: it is as often a count as a flag, and reading it
  as a boolean loses the ability to sum it.
- `03/04/2026` stays **text**, because nothing in the file says which number is the day.
- A 20-digit account number stays **text**, because rounding it silently changes an identity.

### What identifies a row

A key column must be unique, never empty **and** named like a key. All three: unique-and-never-empty
alone picks the first text column of a small file by accident, and a key chosen by accident stops
being unique as soon as more rows arrive — after the mapping was built on it.

Otherwise the row's position is its identity (`__row`), which is never mappable anywhere, and the UI
says what that costs: enough to analyse, not enough for a migration to match on if the file is ever
re-exported in a different order.

## 5. OneDrive, SharePoint files and SharePoint lists

`server/src/connectors/staged/graph.ts`. The live call is one thin injected function; everything with a
decision in it sits above it and is tested against a stub.

**Consent is off by default.** `MICROSOFT_FILES_ENABLED` adds `Files.Read.All` and `Sites.Read.All` to
what every user is asked at sign-in, which is a decision for whoever runs the tenant, not a default.
With it off, an import refuses with an explanation rather than failing on a token it was never going to
get. Both scopes are read-only, so the prompt cannot be mistaken for permission to change anything,
and files are read with the signed-in user's own account — you can only import what you could already
open.

**Sharing links** are encoded for `/shares/{id}`: base64url of the URL, `u!` prefixed, padding
stripped. Getting any part of that wrong returns "item not found" for a valid link, which sends
somebody hunting for a permissions problem that does not exist. Three reference forms are accepted and
discriminated explicitly rather than by a regex that happens to match: a sharing link, a Graph
`drives/...` path, and a path in the signed-in user's own drive.

**A list** is read into a header row and rows, then goes through the same inference a spreadsheet does.
Its declared column types are ignored on purpose — a column declared Text routinely holds numbers and
one declared Number routinely holds blanks, so the values are the better evidence. The header is the
**union of every item's fields**, because SharePoint omits a field entirely when it is empty and taking
row one's keys would silently drop every column blank in that row. Person, lookup and multi-choice
fields are flattened to their display value rather than dropped.

A list must be given as `sites/{site-id}/lists/{list-id}`. A browser URL does not contain the list id,
and a display name is not unique enough to look one up safely.

## 6. What is tested, and against what

Being specific, because "the tests pass" means different things here.

### The connector contract

`tests/integration/connector-contract.test.ts` is one behavioural specification every connector must
satisfy. It exists because the platform treats connectors interchangeably — profiling, preflight,
migration and validation all call the same methods and rely on the same guarantees — and until it was
written, nothing asserted that two connectors actually _behave_ alike. A new connector could satisfy
the TypeScript interface while breaking what everything downstream assumes.

It asserts, for every connector: tables are discoverable and describable; an unknown table is an
error rather than an empty result; asking for specific columns returns those and **not** others;
paging returns the same records whatever the page size, with nothing repeated or dropped;
`retrieveByIds` returns exactly what was asked for; `findByFields` finds the record it was given and
respects its limit; an unknown watermark column is refused rather than falling back to a full read;
every column states its provider family; and a read-only connector refuses writes and is marked as a
view.

It was validated by deliberately breaking things and confirming it fails: a projection that returned
an unrequested column, and a keyset predicate that advanced one row short. The first attempt did
**not** catch the projection bug, because the contract asked for every column and the check was
vacuously true — which is why it now requests a strict subset.

Two of those assertions are the ones worth having. A wrong keyset predicate silently drops or repeats
whole pages and shows up almost nowhere else. A watermark column that falls back to a full read makes
an incremental schedule quietly expensive and its watermark meaningless.

### Running it against a real server

The reason this matters more than another unit test: MySQL and the other live drivers are not
"unverifiable" for want of an embedded server. They are one environment variable away from verified,
with the specification already written.

```
TEST_POSTGRES_URL=postgresql://user:pass@host:5432/db npm test
TEST_MYSQL_URL=mysql://user:pass@host:3306/db npm test
TEST_MSSQL_URL=sqlserver://user:pass@host:1433/db npm test
```

The contract finds a table with rows by itself, so no fixture is needed, and it never writes.

### Coverage today

| Connector              | Tested against                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL             | **Real PostgreSQL** for discovery: PGlite is Postgres compiled to WebAssembly, so `pg_catalog` behaves as it does on a server. The driver path needs `TEST_POSTGRES_URL`               |
| CSV / Excel            | **End to end**, including the contract suite and the browser journey                                                                                                                   |
| Dataverse / SQL Server | Demo connectors through the contract suite, plus the existing integration and end-to-end journeys                                                                                      |
| MySQL                  | **Unit plus the contract suite when a server is supplied.** Quoting, binding, the type vocabulary and catalog-to-metadata are covered outright; the driver path needs `TEST_MYSQL_URL` |
| OneDrive / SharePoint  | **Unit only.** Link resolution, sharing-link encoding, list-to-rows shaping and the access diagnosis against a stubbed Graph. The live call needs a real tenant                        |

Where a connector has not been exercised against the real service, that is stated rather than implied
by a green suite. The Graph-backed kinds compensate differently: their connection test performs a real
Graph probe and names which of the four failure modes occurred — the feature is off, nobody consented,
the account lacks the scope, or Graph is unreachable — so the first person with a real tenant gets a
diagnosis rather than something to bisect.
