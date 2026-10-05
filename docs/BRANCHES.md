# Branches, and which one a deployment came from

Three facts, because each has been guessed wrong at least once:

1. **`product-reset` is where product development happens.** It was created from `17d23873da9d`, the tip
   of `phase-4-pilot-hardening`, with no rewriting — the two names pointed at the same commit at the
   moment of the split.
2. **`phase-4-pilot-hardening` is RETIRED.** It is kept, not deleted. It is the head of open PR #1 and the
   subject of several documents, and the branch object is the cheapest part of that history to preserve.
   Nothing should be committed to it.
3. **`main` is the default branch and the integration baseline.** Every commit on `main` is an ancestor of
   `product-reset`; nothing has landed on `main` that the working branch lacks.

## How code is expected to reach `main`

By pull request, from `product-reset`. Because `main` is a strict ancestor, the merge is a fast-forward —
there is nothing to reconcile, only something to review. CI (`.github/workflows/verify.yml`) runs on every
pull request and on pushes to `main`; it is not tied to any working branch's name, which is why renaming
the working branch required no change to it.

Open PR #1 proposes `phase-4-pilot-hardening → main` and predates the split. Its content is identical to
what a `product-reset → main` pull request would contain, since both branches started from the same
commit. It is left as it is: closing or retargeting it is a judgement about the integration plan, not part
of renaming a branch.

## Where a deployment's provenance comes from

The QA service has **no git source**. `service.repoTriggers` is empty and the service instance's `source`
is null, so no branch is watched and no commit to any branch becomes a deployment by itself. A deployment
happens only when somebody uploads a working directory with `railway up`. This is worth stating plainly
because it is the opposite of the usual arrangement, and people reason about it as though a branch were
being tracked.

That leaves nothing on the platform that knows which commit an image was built from. `.git` is excluded by
`.dockerignore`, so the image cannot work it out either. Two variables carry it — `BUILD_COMMIT` and
`BUILD_BRANCH`, read by [`server/src/build-info.ts`](../server/src/build-info.ts) and reported by
`/api/settings` to a signed-in user.

Those variables were maintained by hand, and a hand-maintained fact drifts: QA went on reporting a branch
it was no longer built from. **Use [`scripts/deploy.mjs`](../scripts/deploy.mjs)**, which reads both values
from the repository it is about to upload and refuses to deploy at all if it cannot describe the upload
truthfully — a dirty working tree, a detached HEAD, or a commit that is not on a remote. Provenance that is
derived cannot disagree with what was deployed; provenance that is typed eventually does.

Setting `BUILD_BRANCH` by hand is not a fix for a wrong value. It is how the wrong value got there.
