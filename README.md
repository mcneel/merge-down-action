# Merge-down action

This action automates the process of merging changes made to release and development branches _down_ into development branches for future versions.

When a pull request is merged into a release branch (e.g. `1.0`) a new pull request will be generated to merge those changes into the associated developement branch (`1.x`). The new pull request will be merged automatically once the required checks pass (see branch protection settings), unless there are merge conflicts, of course.

The same thing will happen for changes merged into a development branch (e.g. `1.x`), if a branch for the next version exists (`2.x`).

## Inputs

## `token`

**Required** A personal access token with write access to the repository.

The action's `GITHUB_TOKEN` doesn't work, because the required checks won't be triggered for the new branch. This is because [an action in a workflow run can't trigger a new workflow run](https://help.github.com/en/actions/automating-your-workflow-with-github-actions/events-that-trigger-workflows).

<!-- ## Outputs

## `time`

The time we greeted you. -->

## Example usage

```
name: merge_down
on:
  pull_request:
    types: [closed]

jobs:
  run:
    runs-on: ubuntu-latest
    if: github.event.pull_request.merged == true
    steps:
      - uses: mcneel/merge-down-action@v1
        with:
          token: ${{ secrets.PAT }}
```
