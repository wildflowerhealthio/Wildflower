# Adding a Check Area How-To

How to add a new area of pre-merge checks so the `Required` status check waits
on it. For why CI is shaped this way, see the
[Required Check Explanation](./Required%20Check%20Explanation.md).

1. **Write the area's workflow** under `.github/workflows/`, triggered only by
   `workflow_call`:

   ```yaml
   on:
     workflow_call:
   ```

   Give it no `concurrency` block: `ci.yml`'s group already cancels superseded
   runs, including the workflows it calls.

2. **Add a filter** for the area to the `Detect changes` job in `ci.yml`,
   listing every path its checks depend on, plus `.github/workflows/ci.yml` and
   the area's own workflow file. Add the filter's output to the job's `outputs`.

3. **Add a job** to `ci.yml` that calls the workflow, gated on the filter:

   ```yaml
   my-area:
     name: My Area
     needs: changes
     if: needs.changes.outputs.my-area == 'true'
     permissions:
       contents: read
     uses: ./.github/workflows/ci-my-area.yml
   ```

   Grant in `permissions` everything the called workflow's own `permissions`
   block asks for. A called workflow gets no more than its calling job grants.

4. **Add the job to `Required`'s `needs`.** A job left out of that list can fail
   without blocking a merge.

The `main` ruleset requires only `Required`, so it needs no change.
