# Product language standard

The interface uses **ASD-STE100-inspired controlled technical English**. It is not ASD-STE100 certified or
compliant: no formal validation against the specification or its approved vocabulary has taken place, and
claiming otherwise would be the kind of overstatement this standard exists to remove.

This is a product design rule, not a copywriting preference. The audience is data engineers, migration
consultants, solution architects, database administrators and Power Platform professionals. The product
must read like software they use, not like software describing itself to them.

---

## The rule

Every screen communicates four things, in this order:

**State → Evidence → Consequence → Action**

Use the fewest words that say those four things accurately. If a string does none of them, delete it.

## Sentences

One idea per sentence. Active voice unless the actor is unknown or irrelevant.

| Write                               | Not                                                       |
| ----------------------------------- | --------------------------------------------------------- |
| No blockers found.                  | Nothing blocks execution.                                 |
| Review 7 warnings before you start. | These are the things worth knowing before it starts.      |
| The migration skipped 18 records.   | 18 records were skipped during the migration.             |
| The target rejected 42 records.     | 42 records were rejected by the target.                   |
| Select a table.                     | A table must be selected.                                 |
| Select a target.                    | You will need to select a target before you can continue. |

## Terminology

One term for one concept. Do not introduce synonyms for variety.

| Term               | Meaning                                                   | Do not use                  | Example                           |
| ------------------ | --------------------------------------------------------- | --------------------------- | --------------------------------- |
| **Project**        | A body of work: analysis, migration or comparison.        | workspace, job              | `Open the project.`               |
| **Analysis**       | Reading a source to report what is in it. Never writes.   | profiling run, scan         | `Analysis found 12 issues.`       |
| **Migration**      | Moving data from a source to a target.                    | transfer, sync, job         | `Start the migration.`            |
| **Validation**     | Reconciling a target against a source after a run.        | verification, check         | `Validate the run.`               |
| **Connection**     | Reusable access to a system. Holds credentials, not data. | data source, integration    | `Test the connection.`            |
| **Dataset**        | Data selected for a project: a sheet, a table, a list.    | data source, entity, object | `Add a dataset.`                  |
| **Source**         | Where data is read from.                                  | origin, from-system         | `Source: Legacy SQL Server.`      |
| **Target**         | Where data is written to. **Not "destination".**          | destination, target system  | `Target: Production CRM.`         |
| **Mapping**        | A source field paired with a target field.                | field match, link           | `Save the mapping.`               |
| **Transformation** | A rule that changes a value before it is written.         | conversion, formatting      | `3 transformations.`              |
| **Dependency**     | A relationship that decides load order.                   | relation, link              | `2 unresolved dependencies.`      |
| **Finding**        | Something analysis observed about data.                   | insight, issue, observation | `14 findings.`                    |
| **Blocker**        | A condition that makes execution unsafe or invalid.       | critical, error             | `Fix 3 blockers.`                 |
| **Warning**        | A condition worth knowing that does not stop execution.   | caution, notice             | `7 warnings.`                     |
| **Run**            | One execution of a migration.                             | job, batch, attempt         | `Run 15 completed.`               |
| **Attempt**        | One execution of a run. A retry is a new attempt.         | rerun, pass                 | `Attempt 2.`                      |
| **Preflight**      | A dry run that reports what a migration would write.      | simulation, test run        | `Run preflight.`                  |
| **Retry**          | Running the outstanding records of a run again.           | resume, repeat              | `Retry failed records.`           |
| **Audit event**    | A recorded action, with actor and outcome.                | log entry, history item     | `Audit event: Migration started.` |
| **Readiness**      | Whether a migration can execute safely.                   | health, score               | `Readiness: Blocked.`             |

**Connection is not Dataset.** Content must hold the distinction. After authentication succeeds, write
`Connection successful.` then `Select data.` Never `Your data source is connected.`

## Status labels

Short noun or adjective states. Never sentences.

`Not assessed` · `Ready` · `Ready with warnings` · `Blocked` · `Running` · `Completed` ·
`Completed with issues` · `Failed` · `Paused` · `Canceled` · `Needs attention` · `Not tested` ·
`Simulated` · `Not analysed`

## Buttons

A button names its action and its result. Avoid `Continue`, `Next`, `Proceed`, `Submit`, `Done`,
`Get started` where a specific action exists.

`Add dataset` · `Select tables` · `Test connection` · `Save mapping` · `Run preflight` ·
`Start migration` · `Review failures` · `Retry failed records` · `Validate run` · `Export failures`

## Message patterns

### Empty state

```
No datasets
Add data to start the analysis.
[Add dataset]
```

State, then action. No second sentence explaining why the state is normal.

### Error

```
Connection failed
The server rejected the credentials.
Check the user name and password.
[Test connection]
```

What happened. Why, when known. What to do. Never `Oops`, `Uh-oh`, `Unfortunately` or
`Something went wrong` when a precise error exists.

### Warning and blocker

```
Type mismatch
Source: String
Target: Integer
Some values cannot be converted.
Add a transformation or change the mapping.
```

### Finding

```
Finding    No reliable record identifier
Dataset    Contacts
Affected   300 of 300 records
Why it matters   A rerun cannot reliably match existing records. This can create duplicates.
Next action      Select a unique field or field combination.
```

### Readiness

```
Ready with warnings
0 blockers
7 warnings
Next action: Review the warnings before you start.
[Review warnings]
```

### Run result

```
Completed with issues
Attempted  820,114
Succeeded  812,441
Failed       7,673

Primary failure
6,941 records reference a customer that does not exist in the target.
[Review failed records]
```

### Confirmation

```
Change target?
Existing mappings can become invalid.
Historical runs will not change.
[Cancel] [Change target]
```

Action, consequence, decision. No paragraph.

### Destructive action

```
Remove Customers?
Customers will be removed from the current migration scope.
Previous migration runs will remain available.
[Cancel] [Remove dataset]
```

### Connection status

`Connected` · `Needs attention` · `Not tested` · `Simulated`, each with `Last tested <time>` and, when the
system returned one, the message it returned.

### Next action

One imperative sentence naming the action and its object. `Fix 3 blockers.` `Select a target.`

## Headings

Headings identify content: `Migration readiness`, `Source data`, `Target`, `Mapping`, `Dependencies`,
`Run results`, `Failed records`, `Audit`, `Warnings`, `Findings`.

Not: `What you need to know`, `Let's prepare your migration`, `Things to review`, `Worth knowing`.

## Prohibited phrasing

No personification. The product does not think, believe, notice, feel or recommend as a person.
Write `Analysis detected`, `Validation found`, `The target returned`. Not `We noticed`, `We think`,
`It looks like`, `Our AI believes`.

Flagged phrases: `Oops` · `Uh-oh` · `Great!` · `Good news` · `Let's` · `It looks like` · `It seems` ·
`We think` · `We noticed` · `We found that` · `Here's what` · `You're all set` · `Things to consider` ·
`Worth knowing` · `Something went wrong` · `You may want to` · `We recommend that you` ·
`Based on our analysis` · `In order to` · `Successfully completed`

`scripts/content-lint.mjs` flags these in user-facing strings. It skips comments, tests, docs and logs. It
is a guardrail, not proof of language quality.

## Numbers

Consistent formatting for the same kind of information. `1,420 records` · `37 of 400 records` · `9.3%` ·
`18 warnings`. Do not mix `1.4K`, `1,420` and `approximately 1,400` without a reason.

## Technical terms

Use them where they are precise and familiar: primary key, alternate key, foreign key, lookup, upsert,
schema, transformation, dependency. Do not replace a precise term with vague friendly language. Explain a
product-specific term the first time it appears on a screen.

## Clarity over brevity

Controlled English is not cryptic. `TYPE_MISMATCH` alone is worse than the pattern above. Keep the
explanation; remove the prose around it. Use structured data where it communicates the result better than
a sentence.

## Review questions

Every new user-facing string must pass:

1. Is it necessary?
2. Does it use an approved term?
3. Is the sentence short?
4. Does it contain one main idea?
5. Is it active where practical?
6. Does it state facts rather than personality?
7. Is the action clear?
8. Can structured data replace some prose?
9. Does it sound like technical software?
10. Would a migration consultant understand it without a developer explaining it?
