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

`evidence/scale-measurements.json`, 2026-10-02, on a Windows x64 host with 8 CPUs and 32 GB, Node
24.14.1, against PGlite — the platform's own embedded PostgreSQL. It measures the platform's
bookkeeping: the identity map written for every record, the pages read back, the memory held while
doing it.

It deliberately does **not** measure anybody's source or target. Read and write throughput against
Dataverse, SQL Server or any other real system belongs to that system, and in practice it is the
slower half by a wide margin. A platform that can account for 9,000 records a second is not a
platform that can migrate 9,000 records a second.

|   Records | Identity map written | Counts for a report | Identity map read back, paged | Peak heap while reading |
| --------: | -------------------: | ------------------: | ----------------------------: | ----------------------: |
|    10,000 |      1.1 s (8,930/s) |                7 ms |                        0.06 s |                 25.3 MB |
|    50,000 |     4.8 s (10,402/s) |               21 ms |                        0.28 s |                 51.9 MB |
|   200,000 |     20.1 s (9,951/s) |               63 ms |                        0.98 s |                 66.1 MB |
|   500,000 |    44.7 s (11,183/s) |              299 ms |                        2.85 s |                 67.1 MB |
| 1,000,000 |    111.2 s (8,991/s) |              999 ms |                        7.91 s |                 69.1 MB |
| 1,500,000 |    260.3 s (5,763/s) |              988 ms |                        7.88 s |                 74.4 MB |

All MEASURED. Three things in that table matter more than the rest, and the first one corrects what
this document used to say.

**Write throughput is not flat. It degrades above a million rows.** The previous version of this
document claimed "about 12,500 identity rows a second at every size", measured only up to 500,000.
Carried to 1,500,000 the rate halves: 11,183/s at 500k, 8,991/s at 1M, 5,763/s at 1.5M — and the
1,500,000 row run took 260 seconds where flat throughput predicts 134. The claim was an extrapolation
wearing a measurement's clothes, and it is withdrawn.

What the degradation is remains open. Writing a million rows into an **in-process** PGlite means index
maintenance competing with the application for one core, which a hosted deployment against a real
PostgreSQL server does not do. So this is the measured floor, not the platform's limit, and the honest
next step is the same suite with `TEST_DATABASE_URL` pointed at a real server. Until then the figure to
plan with is the one measured here.

**Memory is flat, and that is the claim worth having.** 67.1 MB at 500,000 rows, 69.1 at a million,
74.4 at a million and a half — a 10% increase for three times the data. The validation path holds one
page at a time and lets it go, so what grows with the table is the clock and not the heap. A platform
that gets slower is a platform somebody waits for; a platform whose memory grows with the table is one
that stops working at a size nobody chose.

**Reading back stays bounded.** 7.9 seconds to walk a million identity rows in 2,000 pages, and 7.9
seconds again for a million and a half in 3,000 — the same wall clock for 50% more rows, which is more
likely a warm cache on the second run than a real improvement. Treat ~8 seconds per million as the
measurement and do not read a trend into two points.

Run-to-run variance on this host is wide: the 10,000-row write rate was 11,700/s in the previous run
and 8,930/s in this one, on the same machine with the same code. Any single figure here is worth
±25%, which is another reason the old "flat 12,500/s" should never have been stated as flatly as it
was.

For comparison, the same data loaded the way validation used to load it — the whole identity map for
a table, at once:

| Records | Whole map loaded | Heap held |
| ------: | ---------------: | --------: |
|  10,000 |           0.17 s |    3.1 MB |
|  50,000 |           0.86 s |  not read |
| 200,000 |           3.28 s |  293.2 MB |

The 200,000-row figure is the one to read: MEASURED, and about 1.5 KB per record. The smaller two are
noise — the 50,000-row measurement came back as a _negative_ heap delta because a collection ran in the
middle of it, which is a measurement artefact rather than a number, and it is left here as "not read"
instead of being reported as if it meant something. That line is why the shape above matters:
**EXTRAPOLATED**, at 1.5 KB per record, ten million records would have needed about 15 GB of heap to
validate one table — on a path that also held every source record, every target record and every
difference at the same time. The feature worked on every table small enough not to need it.

## The envelope, table by table

Sizes are per table, which is the unit that matters: a plan with twenty tables of 50,000 records is
not a million-record table.

| Table size                  | Migration                                                                                                                                                                                                           | Validation at STANDARD depth (5,000 records)                                                           | Validation at FULL depth                                                                                                                                                      | Verdict                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Up to 10,000**            | MEASURED end to end, in the test suite and in the demo.                                                                                                                                                             | MEASURED.                                                                                              | MEASURED (1,415 records, every page, in `tests/integration/validation-at-volume.test.ts`).                                                                                    | Supported.                                                                  |
| **10,000 – 500,000**        | EXTRAPOLATED from flat 12,500/s bookkeeping. The source and target are the limit, not the platform.                                                                                                                 | MEASURED — the cap means the cost is the same whatever the table holds.                                | EXTRAPOLATED: ~2.7 s to walk 500,000 identity rows, plus one read per 500 records from each side.                                                                             | Supported, with the caveat that the time is the connector's, not ours.      |
| **500,000 – 1,500,000**     | MEASURED for the platform's own bookkeeping, and the rate falls as the table grows: 1.5M identity rows took 260 s where 500k took 45 s. Resume exists and is tested, so a failure at hour six does not start again. | MEASURED — the cap means the cost is the same whatever the table holds.                                | MEASURED for the read: ~8 s to walk a million identity rows, at flat memory. The comparison itself is one read per 500 records from each side, which is the connector's time. | Supported. Measure the window against the real target before promising one. |
| **1,500,000 – 5,000,000**   | EXTRAPOLATED, and downward: the measured rate is falling at 1.5M, so a linear estimate from the small sizes is optimistic.                                                                                          | EXTRAPOLATED. Still bounded by the cap.                                                                | EXTRAPOLATED, and this is where "it will finish" stops being the same claim as "somebody will wait for it".                                                                   | Plan for it; measure before promising a window.                             |
| **5,000,000 – 100,000,000** | UNKNOWN. Nothing of this size has been run.                                                                                                                                                                         | EXTRAPOLATED: the cap makes the validation cost independent of the table, so this is the depth to use. | UNKNOWN, and the aggregate reconciliation exists precisely because record-level comparison at this size is not the right instrument.                                          | Not claimed. Aggregates and a sampled depth are the honest offer.           |

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

- Any single table above 1,500,000 records. That is now the measured boundary; above it nothing has
  been run, and the measured trend says a linear estimate from below it would be optimistic.
- Whether the write slowdown above a million rows is the platform's or PGlite's. The same suite against
  a real PostgreSQL server (`TEST_DATABASE_URL`) answers it, and nobody has run that.
- Dataverse throughput at any size. Everything known about Dataverse comes from a simulator written
  to match documented behaviour, which is not a tenant. See `shared/connector-verification.ts`.
- Azure SQL at any size. It shares SQL Server's implementation, and sharing an implementation is not
  evidence.
- Sustained multi-hour runs. Resume is tested; a twelve-hour run is not.
- Wide rows, large binary columns, and tables with hundreds of columns.

## How to re-measure

```
MEASURE_SCALE=1 SCALE_SIZES=10000,50000,200000,500000,1000000,1500000 \
  NODE_OPTIONS="--expose-gc --max-old-space-size=8192" \
  npx vitest run tests/scale/identity-map.scale.test.ts --testTimeout=5400000
```

Writes `evidence/scale-measurements.json`. `TEST_DATABASE_URL` points it at a real PostgreSQL server
instead of PGlite, which is the more representative run for a hosted deployment.

The figures above should be replaced, not supplemented, when the platform changes. A scale document
that accumulates old numbers is a document nobody can act on.
