# Scale envelope

What this platform has been measured doing, what follows from those measurements, and where the
honest answer is "we do not know". Three labels are used throughout and they mean exactly one thing
each:

| Label            | Means                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MEASURED**     | A number from a run that happened. The measurement, the host and the date are recorded in `evidence/scale-measurements.json` or `evidence/engine-verification.json`. |
| **EXTRAPOLATED** | Arithmetic from a MEASURED figure, with the assumption stated. Not a promise.                                                                                        |
| **UNKNOWN**      | Nobody has run it. Says so rather than estimating.                                                                                                                   |

A pilot should read the UNKNOWN rows first. They are the ones that decide whether a pilot is a
pilot or a research project.

## What was measured, and on what

`evidence/scale-measurements.json`, 2026-10-01, on a Windows x64 host with 8 CPUs and 32 GB, Node
24.14.1, against PGlite — the platform's own embedded PostgreSQL. It measures the platform's
bookkeeping: the identity map written for every record, the pages read back, the memory held while
doing it.

It deliberately does **not** measure anybody's source or target. Read and write throughput against
Dataverse, SQL Server or any other real system belongs to that system, and in practice it is the
slower half by a wide margin. A platform that can account for 12,000 records a second is not a
platform that can migrate 12,000 records a second.

| Records | Identity map written | Counts for a report | Identity map read back, paged | Peak heap while reading |
| ------: | -------------------: | ------------------: | ----------------------------: | ----------------------: |
|  10,000 |     0.9 s (11,700/s) |                9 ms |                        0.07 s |                 24.9 MB |
|  50,000 |     3.9 s (12,800/s) |               17 ms |                        0.26 s |                 64.3 MB |
| 200,000 |    16.4 s (12,200/s) |               62 ms |                        0.98 s |                 65.2 MB |
| 500,000 |    39.3 s (12,700/s) |              276 ms |                        2.74 s |                 67.7 MB |

All MEASURED. Two things in that table matter more than the rest:

**Write throughput is flat.** About 12,500 identity rows a second at every size, so the platform's
own cost per record does not get worse as the table grows.

**Memory is flat from 50,000 records up.** 64.3, 65.2, 67.7 MB across a tenfold increase. The
validation path holds one page at a time and lets it go, so what grows with the table is the clock,
not the memory.

For comparison, the same data loaded the way validation used to load it — the whole identity map for
a table, at once:

| Records | Whole map loaded | Heap held |
| ------: | ---------------: | --------: |
|  10,000 |           0.17 s |   16.0 MB |
|  50,000 |           0.76 s |   80.8 MB |
| 200,000 |           2.99 s |  296.9 MB |

MEASURED, and linear at roughly 1.5 KB per record. That line is why the shape above matters:
**EXTRAPOLATED**, at 1.5 KB per record, ten million records would have needed about 15 GB of heap to
validate one table — on a path that also held every source record, every target record and every
difference at the same time. The feature worked on every table small enough not to need it.

## The envelope, table by table

Sizes are per table, which is the unit that matters: a plan with twenty tables of 50,000 records is
not a million-record table.

| Table size                  | Migration                                                                                           | Validation at STANDARD depth (5,000 records)                                                           | Validation at FULL depth                                                                                                             | Verdict                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Up to 10,000**            | MEASURED end to end, in the test suite and in the demo.                                             | MEASURED.                                                                                              | MEASURED (1,415 records, every page, in `tests/integration/validation-at-volume.test.ts`).                                           | Supported.                                                             |
| **10,000 – 500,000**        | EXTRAPOLATED from flat 12,500/s bookkeeping. The source and target are the limit, not the platform. | MEASURED — the cap means the cost is the same whatever the table holds.                                | EXTRAPOLATED: ~2.7 s to walk 500,000 identity rows, plus one read per 500 records from each side.                                    | Supported, with the caveat that the time is the connector's, not ours. |
| **500,000 – 5,000,000**     | EXTRAPOLATED. Resume exists and is tested, so a failure at hour six does not start again.           | EXTRAPOLATED. Still bounded by the cap.                                                                | EXTRAPOLATED, and this is where "it will finish" stops being the same claim as "somebody will wait for it".                          | Plan for it; measure before promising a window.                        |
| **5,000,000 – 100,000,000** | UNKNOWN. Nothing of this size has been run.                                                         | EXTRAPOLATED: the cap makes the validation cost independent of the table, so this is the depth to use. | UNKNOWN, and the aggregate reconciliation exists precisely because record-level comparison at this size is not the right instrument. | Not claimed. Aggregates and a sampled depth are the honest offer.      |

## What is bounded, and what is not

Bounded — measured or enforced by a test:

- **Record comparison** runs in batches of 500, with references resolved and differences tallied
  inside the batch. `tests/integration/validation-at-volume.test.ts` watches the width of every read
  and fails if any single request asks for more than one batch.
- **Reported counts** come from `GROUP BY outcome`: five numbers whatever the table holds.
- **Listed differences** stop at 2,000 per table, before they reach memory. The counts stay
  complete, and the report says "showing 2,000 of 40,000" rather than quietly showing 2,000.
- **Duplicate attribution** asks about the ≤250 sampled identifiers rather than the run's whole map.
- **The two second passes** (deferred lookups, audit stamping) page with a keyset cursor on
  `sourceId`, 1,000 rows at a time.
- **Resume** probes with a count and then one indexed lookup per page, so a first attempt pays
  nothing for the question.

Not bounded, and worth knowing before a large pilot:

- **Aggregate reconciliation needs a target this run owns.** A total over a target holding records
  the run did not write answers a different question, so it reports NOT VERIFIED instead. A top-up
  migration into a populated target cannot have this evidence in its current form.
- **Validation holds one page of records from each side.** Fine for records of ordinary width; a
  table of 500 records each carrying several megabytes of text is a different shape and has not been
  measured.
- **One table at a time.** Tables are validated in sequence, so twenty large tables take twenty
  times as long rather than sharing the wait.

## What is UNKNOWN, stated plainly

- Any single table above 500,000 records, at any depth. Nothing of that size has been run.
- Dataverse throughput at any size. Everything known about Dataverse comes from a simulator written
  to match documented behaviour, which is not a tenant. See `shared/connector-verification.ts`.
- Azure SQL at any size. It shares SQL Server's implementation, and sharing an implementation is not
  evidence.
- Sustained multi-hour runs. Resume is tested; a twelve-hour run is not.
- Wide rows, large binary columns, and tables with hundreds of columns.

## How to re-measure

```
MEASURE_SCALE=1 SCALE_SIZES=10000,50000,200000,500000 \
  NODE_OPTIONS=--expose-gc npx vitest run tests/scale --testTimeout=1800000
```

Writes `evidence/scale-measurements.json`. `TEST_DATABASE_URL` points it at a real PostgreSQL server
instead of PGlite, which is the more representative run for a hosted deployment.

The figures above should be replaced, not supplemented, when the platform changes. A scale document
that accumulates old numbers is a document nobody can act on.
